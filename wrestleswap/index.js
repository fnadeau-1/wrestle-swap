const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { CloudBillingClient } = require("@google-cloud/billing");

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'https://wrestleswap.web.app',
  'https://wrestleswap.firebaseapp.com',
  'https://grappletrade.web.app',
  'https://grappletrade.firebaseapp.com',
  'https://grappletrade.com',
  'https://www.grappletrade.com',
  'http://localhost:5500',
  'http://localhost:5000',
];

admin.initializeApp();

const db = admin.firestore();

// Sanitize and cap string inputs — prevents oversized payloads and injection attempts
function sanitizeString(val, maxLen = 200) {
  if (val == null) return null;
  return String(val).trim().slice(0, maxLen);
}

// Verify Firebase ID token from Authorization header — returns decodedToken or throws
async function verifyAuth(req) {
  const idToken = (req.headers.authorization || '').replace('Bearer ', '');
  if (!idToken) throw Object.assign(new Error('Missing auth token'), { status: 401 });
  return admin.auth().verifyIdToken(idToken);
}

// Shippo rate limit — max 15 calls per user per hour
// Generic rate limiter — stored in rateLimits/{userId} via Admin SDK only (clients blocked by rules)
// key: unique string per limit (e.g. 'shippo', 'dailyPurchase')
// limit: max calls allowed in the window
// windowMs: rolling window length in milliseconds
async function checkRateLimit(userId, key, limit, windowMs) {
  const ref = db.collection('rateLimits').doc(userId);
  const snap = await ref.get();
  const now = Date.now();
  const data = snap.exists ? snap.data() : {};
  const windowStart = data[`${key}WindowStart`] || 0;
  const count       = data[`${key}Count`]       || 0;

  if (now - windowStart < windowMs && count >= limit) {
    throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
  }

  await ref.set(
    now - windowStart >= windowMs
      ? { [`${key}Count`]: 1, [`${key}WindowStart`]: now }
      : { [`${key}Count`]: admin.firestore.FieldValue.increment(1) },
    { merge: true }
  );
}

const ONE_HOUR  = 60 * 60 * 1000;
const ONE_DAY   = 24 * 60 * 60 * 1000;

// Fetch a user's email address by UID (used for email notifications)
async function getUserEmail(uid) {
  if (!uid) return null;
  try {
    const user = await admin.auth().getUser(uid);
    return user.email || null;
  } catch (e) {
    console.error('getUserEmail error for', uid, e.message);
    return null;
  }
}

// Define secrets
const stripeSecret = defineSecret("STRIPE_SKEY");
const shippoSecret = defineSecret("SHIPPO_API_KEY");
const sendgridSecret = defineSecret("SENDGRID_API_KEY_TEST");
const shippoWebhookSecret = defineSecret("SHIPPO_WEBHOOK_SECRET");
// const recaptchaApiKey = defineSecret("RECAPTCHA_API_KEY"); // Uncomment after setting secret

const emails = require('./emails');

// Write an in-app notification to Firestore (fires-and-forgets — never throws)
// idempotencyKey: optional deterministic doc ID — prevents duplicates on retries
async function createNotification(userId, { icon, message, link }, idempotencyKey = null) {
  if (!userId) return;
  try {
    const col = db.collection('notifications').doc(userId).collection('items');
    const ref = idempotencyKey ? col.doc(idempotencyKey) : col.doc();
    await ref.set({
      icon: icon || '🔔',
      message,
      link: link || null,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: false });
  } catch (e) {
    console.error('createNotification error:', e.message);
  }
}

// --- DELETE OLD SOLD PRODUCTS (runs automatically every 30 days) ---
// Converted from HTTP to scheduled — no public endpoint means no abuse vector
exports.deleteSoldProducts = onSchedule({ schedule: 'every 720 hours', maxInstances: 1 }, async (event) => {
  const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);

  const snapshot = await db.collection("products")
    .where("sold", "==", true)
    .where("soldTimestamp", "<=", ninetyDaysAgo)
    .get();

  if (snapshot.empty) {
    console.log('deleteSoldProducts: nothing to delete');
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  console.log(`deleteSoldProducts: removed ${snapshot.size} old sold products`);
});

// Platform fee percentage (10% of product price only)
const PLATFORM_FEE_PERCENT = 0.10;

// Number of seller cancellations before account is suspended
const SELLER_STRIKES_LIMIT = 3;

// --- STRIPE PAYMENT INTENT WITH CONNECT ---
// Shipping costs go to platform, product price (minus 10% fee) goes to seller
exports.createPaymentIntent = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecret, shippoSecret], maxInstances: 20 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!decodedToken.email_verified) {
      return res.status(403).json({ error: 'Please verify your email address before making a purchase.' });
    }

    try {
      await checkRateLimit(decodedToken.uid, 'dailyIntent', 10, ONE_DAY);
    } catch (e) {
      return res.status(429).json({ error: 'You have reached the checkout limit for today. Please try again tomorrow.' });
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      // Never trust amounts or sellerStripeAccountId from the frontend
      const { currency = 'usd', productId, rateObjectId } = req.body;

      if (!productId) {
        return res.status(400).json({ error: 'productId is required' });
      }

      // --- SERVER-SIDE PRICE VALIDATION ---
      // Fetch real price from Firestore — never trust the frontend
      const productDoc = await db.collection('products').doc(productId).get();
      if (!productDoc.exists) {
        return res.status(404).json({ error: 'Product not found' });
      }
      const productData = productDoc.data();
      if (productData.sold) {
        return res.status(400).json({ error: 'This item has already been sold' });
      }

      // Prevent a seller from buying their own listing
      if (productData.userId === decodedToken.uid) {
        return res.status(403).json({ error: 'You cannot purchase your own listing' });
      }

      const productPriceInCents = Math.round((productData.price || 0) * 100);

      // Verify shipping cost server-side via Shippo — never trust client-sent amount
      let shippingInCents = 0;
      if (rateObjectId) {
        const shippoKey = shippoSecret.value();
        const rateRes = await fetch(`https://api.goshippo.com/rates/${rateObjectId}`, {
          headers: { 'Authorization': `ShippoToken ${shippoKey}` },
        });
        if (!rateRes.ok) {
          return res.status(400).json({ error: 'Invalid shipping rate. Please recalculate shipping.' });
        }
        const rate = await rateRes.json();
        shippingInCents = Math.round(parseFloat(rate.amount || 0) * 100);
      }

      const taxInCents = Math.round(productPriceInCents * 0.08);
      const amount = productPriceInCents + shippingInCents + taxInCents;

      // Look up seller's Stripe account from Firestore — never trust the frontend
      let sellerStripeAccountId = null;
      if (productData.userId) {
        const sellerDoc = await db.collection('users').doc(productData.userId).get();
        if (sellerDoc.exists) {
          const sellerData = sellerDoc.data();
          if (sellerData.sellerSuspended) {
            return res.status(403).json({ error: 'This seller is currently suspended and cannot accept payments' });
          }
          if (sellerData.stripeAccountId) {
            sellerStripeAccountId = sellerData.stripeAccountId;
          }
        }
      }

      console.log('Server-verified payment breakdown:');
      console.log('  Product (from Firestore):', productPriceInCents, 'cents');
      console.log('  Shipping:', shippingInCents, 'cents');
      console.log('  Tax:', taxInCents, 'cents');
      console.log('  Total:', amount, 'cents');
      console.log('  Seller Stripe Account (from Firestore):', sellerStripeAccountId);

      // Build payment intent options — always attach productId to metadata
      const paymentIntentOptions = {
        amount,
        currency,
        automatic_payment_methods: { enabled: true },
        metadata: { productId },
      };

      // Escrow model: funds go to platform, seller is paid out only after delivery confirmed.
      // This protects buyers — no destination charge, no immediate transfer to seller.
      if (sellerStripeAccountId && productPriceInCents > 0) {
        const sellerAccount = await stripe.accounts.retrieve(sellerStripeAccountId);
        if (!sellerAccount.payouts_enabled) {
          return res.status(400).json({
            error: 'The seller has not completed their payment account setup. Please contact the seller or try again later.'
          });
        }
        const platformFeeOnProduct = Math.round(productPriceInCents * PLATFORM_FEE_PERCENT);
        const sellerReceivesCents = productPriceInCents - platformFeeOnProduct;

        console.log('Escrow mode — seller paid at confirmed delivery');
        console.log('  Seller receives at delivery:', sellerReceivesCents, 'cents');
        console.log('  Platform fee (10%):', platformFeeOnProduct, 'cents');

        // Store seller payout info in Stripe metadata so completeOrder can save it to Firestore
        paymentIntentOptions.metadata = {
          productId,
          sellerStripeAccountId,
          sellerReceivesCents: String(sellerReceivesCents),
          platformFeeCents: String(platformFeeOnProduct),
          rateObjectId: rateObjectId || '',
        };
      } else {
        console.log('No seller Stripe account — payment stays on platform');
        paymentIntentOptions.metadata = { productId, rateObjectId: rateObjectId || '' };
      }

      const paymentIntent = await stripe.paymentIntents.create(paymentIntentOptions);
      console.log('Payment intent created:', paymentIntent.id);

      return res.status(200).json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      });
    } catch (error) {
      console.error('Stripe Error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// Cancellation fee percentage (5%)
const CANCELLATION_FEE_PERCENT = 0.05;

// --- CANCEL ORDER / REFUND ---
exports.cancelOrder = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecret, shippoSecret, sendgridSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    // Verify Firebase ID token — proves who is making the request
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      await checkRateLimit(decodedToken.uid, 'dailyCancel', 5, ONE_DAY);
    } catch (e) {
      return res.status(429).json({ error: 'You have reached the cancellation limit for today. Please try again tomorrow.' });
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const {
        paymentIntentId,
        productId,
        shippoTransactionId = null
      } = req.body;

      if (!paymentIntentId || !productId) {
        return res.status(400).json({ error: 'paymentIntentId and productId are required' });
      }

      // Verify the caller is the actual buyer of this order
      const productDoc = await db.collection('products').doc(productId).get();
      if (!productDoc.exists) {
        return res.status(404).json({ error: 'Product not found' });
      }
      const productData = productDoc.data();
      if (productData.buyerId !== decodedToken.uid) {
        return res.status(403).json({ error: 'You are not the buyer of this order' });
      }
      if (!productData.sold || productData.cancelled) {
        return res.status(400).json({ error: 'Order is not in a cancellable state' });
      }
      if (productData.trackingNumber || productData.shipped) {
        return res.status(400).json({ error: 'This order has already been shipped and cannot be cancelled. Please use Request Refund instead.' });
      }

      // Retrieve payment intent and verify it belongs to this product
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.metadata.productId !== productId) {
        return res.status(403).json({ error: 'Payment intent does not match this product' });
      }

      if (!paymentIntent.latest_charge) {
        return res.status(400).json({ error: 'No charge found for this payment' });
      }

      const chargeId = paymentIntent.latest_charge;
      const originalAmount = paymentIntent.amount;

      // Calculate 5% cancellation fee on product price only (not shipping or tax)
      const productPriceCents = Math.round((productData.price || 0) * 100);
      const cancellationFee = Math.round(productPriceCents * CANCELLATION_FEE_PERCENT);
      const refundAmount = originalAmount - cancellationFee;

      console.log('Processing buyer cancellation:');
      console.log('  Payment Intent:', paymentIntentId);
      console.log('  Product ID:', productId);
      console.log('  Original amount:', originalAmount);
      console.log('  Cancellation fee (5%):', cancellationFee);
      console.log('  Refund amount:', refundAmount);

      // Create partial refund (minus 5% cancellation fee)
      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: refundAmount,
        reason: 'requested_by_customer',
        metadata: {
          productId,
          cancelledBy: 'buyer',
          cancellationFee,
          originalAmount
        }
      });

      console.log('Refund created:', refund.id);

      // Try to void the Shippo shipping label if provided
      let labelVoided = false;
      if (shippoTransactionId) {
        try {
          const shippoKey = shippoSecret.value();
          const voidResponse = await fetch(`https://api.goshippo.com/transactions/${shippoTransactionId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `ShippoToken ${shippoKey}` }
          });
          if (voidResponse.ok) {
            labelVoided = true;
            console.log('Shipping label voided successfully');
          } else {
            console.log('Could not void shipping label - may already be used');
          }
        } catch (labelError) {
          console.error('Error voiding shipping label:', labelError);
        }
      }

      // Update product status — set active: false so the listing does NOT
      // auto re-appear in the marketplace. Seller must manually reactivate it.
      await db.collection('products').doc(productId).update({
        sold: false,
        active: false,
        soldAt: null,
        soldTimestamp: null,
        soldOrderId: null,
        buyerId: null,
        cancelled: true,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledBy: 'buyer',
        cancellationReason: 'Cancelled by buyer',
        refundId: refund.id
      });
      console.log('Product deactivated — awaiting seller reactivation');

      // Update orders collection record so buyer can still see the cancelled order
      try {
        const ordersSnap = await db.collection('orders').where('productId', '==', productId).limit(1).get();
        if (!ordersSnap.empty) {
          await ordersSnap.docs[0].ref.update({
            cancelled: true,
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            cancelledBy: 'buyer',
            refundId: refund.id,
            refundAmount: refundAmount / 100,
            status: 'cancelled',
          });
        }
      } catch (orderErr) {
        console.error('Order record update error (cancelOrder):', orderErr.message);
      }

      // In-app notification to seller
      await createNotification(productData.userId, {
        icon: '❌',
        message: `A buyer cancelled their order for "${productData.title || 'your item'}". Go to your listings to reactivate it.`,
        link: 'listings-manager.html',
      }, `${productId}_buyercancel_seller`);

      // Email buyer (refund confirmation) and seller (order cancelled)
      try {
        emails.init(sendgridSecret.value());
        const buyerEmail = await getUserEmail(decodedToken.uid);
        const sellerEmail = await getUserEmail(productData.userId);
        const buyerRecord = await admin.auth().getUser(decodedToken.uid);
        const buyerName = buyerRecord.displayName || buyerRecord.email.split('@')[0];
        await Promise.all([
          emails.sendBuyerCancelledToBuyer(buyerEmail, {
            productName: productData.title || 'your item',
            refundAmount: (refundAmount / 100).toFixed(2),
            cancellationFee: (cancellationFee / 100).toFixed(2),
          }),
          emails.sendBuyerCancelledToSeller(sellerEmail, {
            productName: productData.title || 'an item',
            buyerName,
          }),
        ]);
      } catch (emailErr) {
        console.error('Email error (cancelOrder):', emailErr.message);
      }

      return res.status(200).json({
        success: true,
        refundId: refund.id,
        refundAmount: refundAmount,
        cancellationFee: cancellationFee,
        labelVoided: labelVoided,
        message: `Order cancelled. Refunded $${(refundAmount / 100).toFixed(2)} (5% cancellation fee of $${(cancellationFee / 100).toFixed(2)} retained)`
      });

    } catch (error) {
      console.error('Cancellation Error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- SHIPPO SHIPPING RATES ---
exports.shippingRates = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [shippoSecret], maxInstances: 15 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    let authedToken;
    try {
      authedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      await checkRateLimit(authedToken.uid, 'shippo', 15, ONE_HOUR);
    } catch (e) {
      return res.status(429).json({ error: 'Too many shipping rate requests. Please wait before trying again.' });
    }

    try {
      const { Shippo } = require('shippo');
      const shippoKey = shippoSecret.value();
      const shippoClient = new Shippo({ apiKeyHeader: shippoKey });

      const { zipCode, senderAddress } = req.body;

      if (!zipCode || !senderAddress) {
        return res.status(400).json({ error: 'Missing zipCode or senderAddress' });
      }
      if (!/^\d{5}(-\d{4})?$/.test(String(zipCode).trim())) {
        return res.status(400).json({ error: 'Invalid zip code format' });
      }

      const shipment = await shippoClient.shipments.create({
        addressFrom: {
          name: sanitizeString(senderAddress.name, 100) || "Seller",
          street1: sanitizeString(senderAddress.street1, 100),
          city: sanitizeString(senderAddress.city, 100),
          state: sanitizeString(senderAddress.state, 50),
          zip: sanitizeString(senderAddress.zip, 20),
          country: sanitizeString(senderAddress.country, 10) || "US"
        },
        addressTo: {
          name: "Buyer",
          street1: "123 Main St",
          city: "San Francisco",
          state: "CA",
          zip: zipCode,
          country: "US"
        },
        parcels: [{
          length: senderAddress.parcel?.length || "10",
          width: senderAddress.parcel?.width || "10",
          height: senderAddress.parcel?.height || "5",
          distanceUnit: "in",
          weight: senderAddress.parcel?.weight || "2",
          massUnit: "lb"
        }],
        async: false
      });

      return res.status(200).json(shipment.rates);

    } catch (error) {
      console.error('Shippo Error:', error);
      return res.status(500).json({
        error: 'Failed to get shipping rates',
        details: error.message
      });
    }
  }
);

// --- STRIPE CONNECT: Create Connected Account for Sellers ---
exports.createConnectedAccount = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecret], maxInstances: 5 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    // Verify Firebase ID token — only the authenticated user can create their own Connect account
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const { userId, email, returnUrl, refreshUrl } = req.body;

      if (!userId || !email) {
        return res.status(400).json({ error: 'Missing userId or email' });
      }

      // Ensure the authenticated user can only create an account for themselves
      if (decodedToken.uid !== userId) {
        return res.status(403).json({ error: 'You can only create a Stripe account for your own user ID' });
      }

      console.log('Creating Stripe Connect account for user:', userId);

      const userDoc = await db.collection('users').doc(userId).get();
      let stripeAccountId;

      if (userDoc.exists && userDoc.data().stripeAccountId) {
        stripeAccountId = userDoc.data().stripeAccountId;
        console.log('User already has Stripe account:', stripeAccountId);
      } else {
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'US',
          email: email,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_type: 'individual',
        });

        stripeAccountId = account.id;
        console.log('Created new Stripe account:', stripeAccountId);

        await db.collection('users').doc(userId).set({
          stripeAccountId: stripeAccountId,
          email: email,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      const accountLink = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: refreshUrl || 'https://grappletrade.web.app/stripe-express-prompt.html',
        return_url: returnUrl || 'https://grappletrade.web.app/sell.html',
        type: 'account_onboarding',
      });

      console.log('Account link created:', accountLink.url);

      res.json({
        accountId: stripeAccountId,
        url: accountLink.url
      });

    } catch (error) {
      console.error('Error creating connected account:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// --- SHIPPO: Get Shipping Rates (for checkout) ---
exports.shippoGetRates = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [shippoSecret], maxInstances: 15 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    let authedToken;
    try {
      authedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      await checkRateLimit(authedToken.uid, 'shippo', 15, ONE_HOUR);
    } catch (e) {
      return res.status(429).json({ error: 'Too many shipping rate requests. Please wait before trying again.' });
    }

    try {
      const shippoKey = shippoSecret.value();
      const { addressFrom, addressTo, parcel } = req.body;

      if (!addressFrom || !addressTo || !parcel) {
        return res.status(400).json({ error: 'Missing addressFrom, addressTo, or parcel' });
      }
      if (typeof addressFrom !== 'object' || typeof addressTo !== 'object' || typeof parcel !== 'object') {
        return res.status(400).json({ error: 'addressFrom, addressTo, and parcel must be objects' });
      }

      // Sanitize address fields before forwarding to Shippo
      const cleanAddress = (addr) => ({
        name:    sanitizeString(addr.name, 100),
        street1: sanitizeString(addr.street1, 100),
        city:    sanitizeString(addr.city, 100),
        state:   sanitizeString(addr.state, 50),
        zip:     sanitizeString(addr.zip, 20),
        country: sanitizeString(addr.country, 10) || 'US',
      });

      // Create shipment data for Shippo API
      const shipmentData = {
        address_from: cleanAddress(addressFrom),
        address_to:   cleanAddress(addressTo),
        parcels: [parcel],
        async: false
      };

      console.log('Requesting shipping rates from Shippo...', shipmentData);

      // Call Shippo API
      const response = await fetch('https://api.goshippo.com/shipments/', {
        method: 'POST',
        headers: {
          'Authorization': `ShippoToken ${shippoKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(shipmentData)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Shippo API error:', errorData);
        return res.status(response.status).json({
          error: errorData.detail || errorData.error || `Shippo API error: ${response.status}`
        });
      }

      const data = await response.json();
      console.log('Shippo rates received:', data.rates?.length || 0, 'rates');

      return res.status(200).json(data);

    } catch (error) {
      console.error('Shippo Error:', error);
      return res.status(500).json({
        error: 'Failed to get shipping rates',
        details: error.message
      });
    }
  }
);

// --- SHIPPO: Create Shipping Label ---
exports.shippoCreateLabel = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [shippoSecret, sendgridSecret], maxInstances: 5 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Only authenticated sellers can purchase labels
    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const shippoKey = shippoSecret.value();
      const { rateObjectId, labelFileType = 'PDF', async = false, productId: labelProductId } = req.body;

      if (!rateObjectId) {
        return res.status(400).json({ error: 'Missing rateObjectId' });
      }

      console.log('Creating shipping label for rate:', rateObjectId);

      // Call Shippo API to create transaction (purchase label)
      const response = await fetch('https://api.goshippo.com/transactions/', {
        method: 'POST',
        headers: {
          'Authorization': `ShippoToken ${shippoKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rate: rateObjectId,
          label_file_type: labelFileType,
          async: async
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Shippo transaction error:', errorData);
        return res.status(response.status).json({
          error: errorData.detail || errorData.error || `Shippo API error: ${response.status}`
        });
      }

      const transaction = await response.json();
      console.log('Shippo transaction response:', transaction.status);

      // If label created successfully, save tracking info to Firestore product doc
      if (transaction.status === 'SUCCESS' && labelProductId) {
        try {
          // Fetch rate to get the carrier name
          let carrier = null;
          if (rateObjectId) {
            const rateRes = await fetch(`https://api.goshippo.com/rates/${rateObjectId}`, {
              headers: { 'Authorization': `ShippoToken ${shippoKey}` },
            });
            if (rateRes.ok) {
              const rateData = await rateRes.json();
              carrier = rateData.provider ? rateData.provider.toLowerCase() : null;
            }
          }

          const trackingUpdate = {
            shippingLabel: transaction.label_url || null,
            trackingNumber: transaction.tracking_number || null,
            trackingUrl: transaction.tracking_url_provider || null,
            carrier: carrier || null,
            labelCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          await db.collection('products').doc(labelProductId).update(trackingUpdate);

          // Also update the corresponding order doc
          const orderSnaps = await db.collection('orders')
            .where('productId', '==', labelProductId)
            .limit(1)
            .get();
          if (!orderSnaps.empty) {
            await orderSnaps.docs[0].ref.update(trackingUpdate);
          }

          console.log('Saved tracking info to Firestore for product:', labelProductId);
          return res.status(200).json({ ...transaction, carrier });
        } catch (saveErr) {
          console.error('Failed to save tracking to Firestore:', saveErr.message);
          // Still return success — label was created
        }
      }

      return res.status(200).json(transaction);

    } catch (error) {
      console.error('Shippo Label Error:', error);
      return res.status(500).json({
        error: 'Failed to create shipping label',
        details: error.message
      });
    }
  }
);

// --- STRIPE CONNECT: Check Seller Status ---
exports.checkSellerStatus = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    // Must be signed in — users can only check their own account
    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
      }

      if (decodedToken.uid !== userId) {
        return res.status(403).json({ error: 'You can only check your own seller status' });
      }

      const userDoc = await db.collection('users').doc(userId).get();

      if (!userDoc.exists || !userDoc.data().stripeAccountId) {
        return res.json({
          connected: false,
          chargesEnabled: false,
          detailsSubmitted: false
        });
      }

      const stripeAccountId = userDoc.data().stripeAccountId;
      const account = await stripe.accounts.retrieve(stripeAccountId);

      // Persist current Stripe account status to Firestore so settings.html can display it
      await db.collection('users').doc(userId).set({
        stripeChargesEnabled: account.charges_enabled,
        stripePayoutsEnabled: account.payouts_enabled,
        stripeDetailsSubmitted: account.details_submitted,
      }, { merge: true });

      res.json({
        connected: true,
        chargesEnabled: account.charges_enabled,
        detailsSubmitted: account.details_submitted,
        payoutsEnabled: account.payouts_enabled
      });

    } catch (error) {
      console.error('Error checking seller status:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// --- RECAPTCHA ENTERPRISE: Verify Token ---
// NOTE: Uncomment this function after setting RECAPTCHA_API_KEY secret:
// firebase functions:secrets:set RECAPTCHA_API_KEY
/*
exports.verifyRecaptcha = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [recaptchaApiKey], maxInstances: 20 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
      const apiKey = recaptchaApiKey.value();
      const { token, expectedAction } = req.body;

      if (!token) {
        return res.status(400).json({ error: 'Missing reCAPTCHA token' });
      }

      console.log('Verifying reCAPTCHA token for action:', expectedAction);

      // Call reCAPTCHA Enterprise API
      const response = await fetch(
        `https://recaptchaenterprise.googleapis.com/v1/projects/wrestleswap/assessments?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event: {
              token: token,
              expectedAction: expectedAction || 'LIST_ITEM',
              siteKey: '6LcM51YsAAAAAJIK9J6ztDQhKET0FdHvOBZ9p9Ah'
            }
          })
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('reCAPTCHA API error:', errorData);
        return res.status(response.status).json({
          success: false,
          error: errorData.error?.message || 'reCAPTCHA verification failed'
        });
      }

      const data = await response.json();
      console.log('reCAPTCHA assessment:', data);

      // Check if token is valid
      if (!data.tokenProperties?.valid) {
        console.log('Invalid token:', data.tokenProperties?.invalidReason);
        return res.status(400).json({
          success: false,
          error: 'Invalid reCAPTCHA token',
          reason: data.tokenProperties?.invalidReason
        });
      }

      // Check if action matches
      if (data.tokenProperties?.action !== (expectedAction || 'LIST_ITEM')) {
        console.log('Action mismatch:', data.tokenProperties?.action);
        return res.status(400).json({
          success: false,
          error: 'reCAPTCHA action mismatch'
        });
      }

      // Get the risk score (0.0 = bot, 1.0 = human)
      const score = data.riskAnalysis?.score || 0;
      console.log('reCAPTCHA score:', score);

      // Accept if score is above threshold (0.5 is a common threshold)
      if (score < 0.5) {
        return res.status(400).json({
          success: false,
          error: 'reCAPTCHA verification failed - suspected bot activity',
          score: score
        });
      }

      return res.status(200).json({
        success: true,
        score: score
      });

    } catch (error) {
      console.error('reCAPTCHA Error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to verify reCAPTCHA',
        details: error.message
      });
    }
  }
);
*/

// --- COMPLETE ORDER (marks product sold after server-verified payment) ---
exports.completeOrder = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecret, sendgridSecret], maxInstances: 20 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).send('');
    }

    // Verify Firebase ID token
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      await checkRateLimit(decodedToken.uid, 'dailyPurchase', 3, ONE_DAY);
    } catch (e) {
      return res.status(429).json({ error: 'You have reached the purchase limit of 3 items per day. Please try again tomorrow.' });
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const { paymentIntentId, productId, shippingInfo, packageDimensions, buyerShippingAddress } = req.body;

      if (!paymentIntentId || !productId) {
        return res.status(400).json({ error: 'paymentIntentId and productId are required' });
      }

      // Verify payment actually succeeded with Stripe
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Payment has not succeeded' });
      }

      // Verify this payment intent is for this product
      if (paymentIntent.metadata.productId !== productId) {
        return res.status(403).json({ error: 'Payment does not match this product' });
      }

      // Read escrow payout info from Stripe metadata (set server-side by createPaymentIntent)
      const sellerStripeAccountId = paymentIntent.metadata.sellerStripeAccountId || null;
      const sellerReceivesCents = parseInt(paymentIntent.metadata.sellerReceivesCents || 0);
      const savedRateObjectId = paymentIntent.metadata.rateObjectId || null;

      const productRef = db.collection('products').doc(productId);
      let prod = null;
      let shippingCost = 0;

      // Use a transaction to atomically check sold=false and mark sold=true
      // This prevents two buyers from both completing the same order
      try {
        await db.runTransaction(async (t) => {
          const snap = await t.get(productRef);
          if (!snap.exists) throw new Error('Product not found');
          if (snap.data().sold) throw Object.assign(new Error('already_sold'), { code: 'ALREADY_SOLD' });
          prod = snap.data();

          const prodPriceCents = Math.round((prod.price || 0) * 100);
          const taxCents = Math.round(prodPriceCents * 0.08);
          const shippingCents = Math.max(0, paymentIntent.amount - prodPriceCents - taxCents);
          shippingCost = shippingCents / 100;

          const updateData = {
            sold: true,
            soldAt: admin.firestore.FieldValue.serverTimestamp(),
            soldTimestamp: Date.now(),
            soldOrderId: paymentIntentId,
            buyerId: decodedToken.uid,
            shippingCost,
            // Escrow: store seller payout details for later transfer at delivery
            sellerStripeAccountId: sellerStripeAccountId || null,
            sellerReceivesCents: sellerReceivesCents || 0,
          };
          if (savedRateObjectId) updateData.rateObjectId = savedRateObjectId;
          if (shippingInfo) {
            updateData.shippingLabel = shippingInfo.label_url || null;
            updateData.trackingNumber = shippingInfo.tracking_number || null;
            updateData.trackingUrl = shippingInfo.tracking_url_provider || null;
          }
          if (packageDimensions) updateData.packageDimensions = packageDimensions;
          if (buyerShippingAddress) updateData.buyerShippingAddress = buyerShippingAddress;

          t.update(productRef, updateData);
        });
      } catch (txErr) {
        if (txErr.code === 'ALREADY_SOLD') {
          return res.status(409).json({ error: 'This item was just purchased by someone else.' });
        }
        throw txErr;
      }

      console.log('Order completed — product:', productId, 'buyer:', decodedToken.uid);

      // Save order record to orders collection
      try {
        await db.collection('orders').add({
          productId,
          buyerId: decodedToken.uid,
          sellerId: prod.userId || null,
          paymentIntentId,
          productTitle: prod.title || null,
          productPrice: prod.price || null,
          productImages: prod.images || [],
          productCondition: prod.condition || null,
          shippingCost,
          sellerStripeAccountId: sellerStripeAccountId || null,
          sellerReceivesCents: sellerReceivesCents || 0,
          rateObjectId: savedRateObjectId || null,
          shippingLabel: shippingInfo ? (shippingInfo.label_url || null) : null,
          trackingNumber: shippingInfo ? (shippingInfo.tracking_number || null) : null,
          trackingUrl: shippingInfo ? (shippingInfo.tracking_url_provider || null) : null,
          buyerShippingAddress: buyerShippingAddress || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdTimestamp: Date.now(),
          status: 'paid',
        });
      } catch (orderErr) {
        console.error('Order record error:', orderErr.message);
      }

      // In-app notifications (idempotency keys prevent duplicates on retries)
      await Promise.all([
        createNotification(prod.userId, {
          icon: '🛍️',
          message: `New sale! Someone bought your "${prod.title || 'item'}". Ship it within 3 days.`,
          link: 'seller-order-fulfillment.html',
        }, `${paymentIntentId}_seller`),
        createNotification(decodedToken.uid, {
          icon: '✅',
          message: `Order placed for "${prod.title || 'item'}". The seller will ship soon.`,
          link: 'my-orders.html',
        }, `${paymentIntentId}_buyer`),
      ]);

      // Email seller and buyer about the new order
      try {
        emails.init(sendgridSecret.value());
        if (!prod) {
          const freshSnap = await db.collection('products').doc(productId).get();
          prod = freshSnap.data();
        }
        const sellerEmail = await getUserEmail(prod.userId);
        const buyerEmail = await getUserEmail(decodedToken.uid);
        const buyerRecord = await admin.auth().getUser(decodedToken.uid);
        const sellerRecord = prod.userId ? await admin.auth().getUser(prod.userId).catch(() => null) : null;
        const buyerName = buyerRecord.displayName || buyerRecord.email.split('@')[0];
        const sellerName = sellerRecord
          ? (sellerRecord.displayName || sellerRecord.email.split('@')[0])
          : 'the seller';
        await Promise.all([
          emails.sendOrderPlacedSeller(sellerEmail, {
            productName: prod.title || 'your item',
            buyerName,
          }),
          emails.sendOrderPlacedBuyer(buyerEmail, {
            productName: prod.title || 'your item',
            orderId: paymentIntentId,
            sellerName,
          }),
        ]);
      } catch (emailErr) {
        console.error('Email error (completeOrder):', emailErr.message);
      }

      return res.status(200).json({ success: true });

    } catch (error) {
      console.error('completeOrder error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- SELLER CANCEL ORDER (full refund to buyer, strike against seller) ---
exports.sellerCancelOrder = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecret, sendgridSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    // Verify Firebase ID token — must be the seller
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const { productId } = req.body;

      if (!productId) {
        return res.status(400).json({ error: 'productId is required' });
      }

      // Verify caller is the seller of this product
      const productDoc = await db.collection('products').doc(productId).get();
      if (!productDoc.exists) {
        return res.status(404).json({ error: 'Product not found' });
      }
      const productData = productDoc.data();
      if (productData.userId !== decodedToken.uid) {
        return res.status(403).json({ error: 'You are not the seller of this item' });
      }
      if (!productData.sold || productData.cancelled || productData.cancelledAt) {
        return res.status(400).json({ error: 'Order is not in a cancellable state' });
      }

      const paymentIntentId = productData.soldOrderId;
      if (!paymentIntentId) {
        return res.status(400).json({ error: 'No payment found for this order' });
      }

      // Retrieve Stripe charge for this order
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (!paymentIntent.latest_charge) {
        return res.status(400).json({ error: 'No charge found for this payment' });
      }

      // Full refund to buyer — seller is at fault, buyer pays nothing.
      // Escrow model: funds never left the platform so no reverse_transfer needed.
      const refund = await stripe.refunds.create({
        charge: paymentIntent.latest_charge,
        reason: 'requested_by_customer',
        metadata: { productId, cancelledBy: 'seller', sellerUid: decodedToken.uid },
      });
      console.log('Seller cancel: full refund', refund.id, 'for product', productId);

      // Apply seller strike
      const sellerRef = db.collection('users').doc(decodedToken.uid);
      const sellerDoc = await sellerRef.get();
      const sellerData = sellerDoc.exists ? sellerDoc.data() : {};
      const newCount = (sellerData.sellerCancellationCount || 0) + 1;
      const suspended = newCount >= SELLER_STRIKES_LIMIT;
      const strikesRemaining = Math.max(0, SELLER_STRIKES_LIMIT - newCount);

      await sellerRef.set({
        sellerCancellationCount: newCount,
        sellerPenalties: admin.firestore.FieldValue.arrayUnion({
          type: 'seller_cancel',
          productId,
          orderId: paymentIntentId,
          timestamp: Date.now(),
          strikeNumber: newCount
        }),
        ...(suspended ? { sellerSuspended: true } : {})
      }, { merge: true });

      console.log(`Seller ${decodedToken.uid} strike ${newCount}/${SELLER_STRIKES_LIMIT} — suspended: ${suspended}`);

      // Mark product as cancelled and deactivate — seller must manually reactivate
      await db.collection('products').doc(productId).update({
        sold: false,
        active: false,
        soldAt: null,
        soldTimestamp: null,
        soldOrderId: null,
        buyerId: null,
        cancelled: true,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledBy: 'seller',
        cancellationReason: 'Cancelled by seller',
        refundId: refund.id
      });

      // Update orders collection record
      try {
        const ordersSnap = await db.collection('orders').where('productId', '==', productId).limit(1).get();
        if (!ordersSnap.empty) {
          await ordersSnap.docs[0].ref.update({
            cancelled: true,
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            cancelledBy: 'seller',
            refundId: refund.id,
            refundAmount: paymentIntent.amount / 100,
            status: 'cancelled',
          });
        }
      } catch (orderErr) {
        console.error('Order record update error (sellerCancelOrder):', orderErr.message);
      }

      const message = suspended
        ? `Order cancelled. The buyer has been fully refunded. You have reached ${SELLER_STRIKES_LIMIT} cancellations and your selling privileges have been suspended.`
        : `Order cancelled. The buyer has been fully refunded. Strike ${newCount} of ${SELLER_STRIKES_LIMIT} — you have ${strikesRemaining} strike${strikesRemaining !== 1 ? 's' : ''} remaining before you can no longer sell.`;

      // In-app notification to buyer
      await createNotification(productData.buyerId, {
        icon: '↩️',
        message: `The seller cancelled your order for "${productData.title || 'an item'}". You've been fully refunded.`,
        link: 'my-orders.html',
      }, `${productId}_sellercancel_buyer`);

      // Email buyer (full refund) and seller (strike warning)
      try {
        emails.init(sendgridSecret.value());
        const buyerEmail = await getUserEmail(productData.buyerId);
        const sellerEmail = await getUserEmail(decodedToken.uid);
        const sellerRecord = await admin.auth().getUser(decodedToken.uid);
        const sellerName = sellerRecord.displayName || sellerRecord.email.split('@')[0];
        await Promise.all([
          emails.sendSellerCancelledToBuyer(buyerEmail, {
            productName: productData.title || 'your item',
            sellerName,
            refundAmount: (paymentIntent.amount / 100).toFixed(2),
          }),
          emails.sendSellerCancelledToSeller(sellerEmail, {
            productName: productData.title || 'an item',
            strikeCount: newCount,
            strikesRemaining,
            suspended,
          }),
        ]);
      } catch (emailErr) {
        console.error('Email error (sellerCancelOrder):', emailErr.message);
      }

      return res.status(200).json({
        success: true,
        refundId: refund.id,
        refundAmount: paymentIntent.amount,
        sellerCancellationCount: newCount,
        sellerSuspended: suspended,
        strikesRemaining,
        message
      });

    } catch (error) {
      console.error('sellerCancelOrder error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- CHECK OVERDUE ORDERS (runs daily — auto-cancels unshipped orders older than 10 days) ---
// Note: requires a Firestore composite index on (sold ASC, soldTimestamp ASC)
exports.checkOverdueOrders = onSchedule(
  { schedule: 'every 24 hours', secrets: [stripeSecret, sendgridSecret], maxInstances: 1 },
  async (event) => {
    const stripe = require('stripe')(stripeSecret.value());
    const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000);

    console.log('Overdue order check — cutoff:', new Date(tenDaysAgo).toISOString());

    const snapshot = await db.collection('products')
      .where('sold', '==', true)
      .where('soldTimestamp', '<=', tenDaysAgo)
      .get();

    // Filter in JS: exclude already-cancelled and orders that have a tracking number
    const overdueOrders = snapshot.docs.filter(doc => {
      const d = doc.data();
      return !d.cancelled && !d.cancelledAt && !d.trackingNumber;
    });

    console.log(`Found ${overdueOrders.length} overdue unshipped orders`);
    emails.init(sendgridSecret.value());

    let processed = 0;
    let errors = 0;

    for (const doc of overdueOrders) {
      const productId = doc.id;
      const productData = doc.data();

      try {
        // Issue full refund if payment exists
        let refundId = null;
        if (productData.soldOrderId) {
          const paymentIntent = await stripe.paymentIntents.retrieve(productData.soldOrderId);
          if (paymentIntent.latest_charge) {
            // Escrow model: funds never left the platform, simple refund
            const refund = await stripe.refunds.create({
              charge: paymentIntent.latest_charge,
              reason: 'requested_by_customer',
              metadata: { productId, cancelledBy: 'system', reason: 'seller_failed_to_ship' },
            });
            refundId = refund.id;
            console.log(`Overdue refund ${refund.id} for product ${productId}`);
          }
        }

        // Strike the seller
        if (productData.userId) {
          const sellerRef = db.collection('users').doc(productData.userId);
          const sellerDoc = await sellerRef.get();
          const sellerData = sellerDoc.exists ? sellerDoc.data() : {};
          const newCount = (sellerData.sellerCancellationCount || 0) + 1;
          const suspended = newCount >= SELLER_STRIKES_LIMIT;

          await sellerRef.set({
            sellerCancellationCount: newCount,
            sellerPenalties: admin.firestore.FieldValue.arrayUnion({
              type: 'overdue_shipment',
              productId,
              orderId: productData.soldOrderId || null,
              timestamp: Date.now(),
              strikeNumber: newCount
            }),
            ...(suspended ? { sellerSuspended: true } : {})
          }, { merge: true });

          console.log(`Seller ${productData.userId} overdue strike ${newCount} — suspended: ${suspended}`);
        }

        // Mark product cancelled and deactivate — seller must manually reactivate
        await db.collection('products').doc(productId).update({
          sold: false,
          active: false,
          soldAt: null,
          soldTimestamp: null,
          soldOrderId: null,
          buyerId: null,
          cancelled: true,
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancelledBy: 'system',
          cancellationReason: 'Seller failed to ship within 10 days',
          ...(refundId ? { refundId } : {})
        });

        // Update orders collection record
        try {
          const ordersSnap = await db.collection('orders').where('productId', '==', productId).limit(1).get();
          if (!ordersSnap.empty) {
            await ordersSnap.docs[0].ref.update({
              cancelled: true,
              cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
              cancelledBy: 'system',
              ...(refundId ? { refundId } : {}),
              status: 'cancelled',
            });
          }
        } catch (orderErr) {
          console.error(`Order record update error (checkOverdueOrders) for ${productId}:`, orderErr.message);
        }

        // Email buyer and seller about the auto-cancellation
        try {
          const sellerData2 = productData.userId
            ? (await db.collection('users').doc(productData.userId).get()).data() || {}
            : {};
          const strikesRemaining2 = Math.max(0, SELLER_STRIKES_LIMIT - ((sellerData2.sellerCancellationCount || 0) + 1));
          const suspended2 = ((sellerData2.sellerCancellationCount || 0) + 1) >= SELLER_STRIKES_LIMIT;
          const buyerEmail2 = await getUserEmail(productData.buyerId);
          const sellerEmail2 = await getUserEmail(productData.userId);
          const refundDisplay = refundId
            ? (await (async () => {
                try {
                  const r = await stripe.refunds.retrieve(refundId);
                  return (r.amount / 100).toFixed(2);
                } catch (_) { return '0.00'; }
              })())
            : '0.00';
          await Promise.all([
            emails.sendOverdueCancelledToBuyer(buyerEmail2, {
              productName: productData.title || 'your item',
              refundAmount: refundDisplay,
            }),
            emails.sendOverdueCancelledToSeller(sellerEmail2, {
              productName: productData.title || 'an item',
              strikeCount: (sellerData2.sellerCancellationCount || 0) + 1,
              strikesRemaining: strikesRemaining2,
              suspended: suspended2,
            }),
          ]);
        } catch (emailErr) {
          console.error(`Email error (checkOverdueOrders) for ${productId}:`, emailErr.message);
        }

        processed++;
      } catch (err) {
        console.error(`Error processing overdue order ${productId}:`, err.message);
        errors++;
      }
    }

    console.log(`Overdue check complete: ${processed} cancelled, ${errors} errors`);
  }
);

// --- ADMIN: Permanently delete a user account ---
// Deletes Firebase Auth record, Firestore user doc, and username reservation.
// Caller must be authenticated and have isAdmin == true in their Firestore doc.
exports.adminDeleteUser = onRequest(
  { cors: ALLOWED_ORIGINS, maxInstances: 3 },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // Verify caller is authenticated
    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify caller is an admin (double-check server-side — never trust client-only)
    const adminDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!adminDoc.exists || adminDoc.data().isAdmin !== true) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (userId === decodedToken.uid) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    try {
      // 1. Delete Firebase Auth user
      await admin.auth().deleteUser(userId);

      // 2. Delete Firestore user document
      await db.collection('users').doc(userId).delete();

      // 3. Delete username reservation if one exists
      const usernameSnap = await db.collection('usernames')
        .where('userId', '==', userId)
        .get();
      if (!usernameSnap.empty) {
        const batch = db.batch();
        usernameSnap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }

      console.log(`Admin ${decodedToken.uid} deleted user ${userId}`);
      return res.status(200).json({ success: true });

    } catch (error) {
      console.error('adminDeleteUser error:', error);
      // auth/user-not-found means Auth record already gone — still clean up Firestore
      if (error.code === 'auth/user-not-found') {
        await db.collection('users').doc(userId).delete().catch(() => {});
        return res.status(200).json({ success: true, note: 'Auth user not found but Firestore doc removed' });
      }
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- ADMIN: Manually issue a refund for an order ---
// Accepts: productId (required), refundAmount in cents (optional, defaults to full), relist (boolean, default true)
// Caller must be authenticated and have isAdmin == true in their Firestore doc.
exports.adminIssueRefund = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecret], maxInstances: 3 },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // Verify caller is authenticated
    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify caller is an admin (server-side, never trust client)
    const adminDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!adminDoc.exists || adminDoc.data().isAdmin !== true) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { productId, refundAmount, reason = 'requested_by_customer', relist = true } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId is required' });

    const validReasons = ['duplicate', 'fraudulent', 'requested_by_customer'];
    const refundReason = validReasons.includes(reason) ? reason : 'requested_by_customer';

    try {
      const stripe = require('stripe')(stripeSecret.value());

      // Look up the product to get the payment intent ID
      const productRef = db.collection('products').doc(productId);
      const productSnap = await productRef.get();
      if (!productSnap.exists) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const productData = productSnap.data();
      const paymentIntentId = productData.soldOrderId;
      if (!paymentIntentId) {
        return res.status(400).json({ error: 'No payment intent found for this order' });
      }

      // Retrieve charge from Stripe
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (!paymentIntent.latest_charge) {
        return res.status(400).json({ error: 'No charge found for this payment intent' });
      }

      const chargeId = paymentIntent.latest_charge;
      const originalAmount = paymentIntent.amount;

      // Validate refund amount
      const amountToRefund = refundAmount ? parseInt(refundAmount) : originalAmount;
      if (isNaN(amountToRefund) || amountToRefund <= 0 || amountToRefund > originalAmount) {
        return res.status(400).json({ error: `Refund amount must be between 1 and ${originalAmount} cents` });
      }

      // Escrow model: funds never left the platform, simple refund
      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: amountToRefund,
        reason: refundReason,
        metadata: { productId, issuedBy: 'admin', adminUid: decodedToken.uid },
      });

      // Build the Firestore update
      const updatePayload = {
        adminRefundIssued: true,
        adminRefundAmount: amountToRefund,
        adminRefundId: refund.id,
        adminRefundAt: admin.firestore.FieldValue.serverTimestamp(),
        adminRefundIssuedBy: decodedToken.uid,
      };

      if (relist) {
        // Clear sold state so the listing becomes active again
        updatePayload.sold = false;
        updatePayload.buyerId = admin.firestore.FieldValue.delete();
        updatePayload.soldOrderId = admin.firestore.FieldValue.delete();
        updatePayload.soldAt = admin.firestore.FieldValue.delete();
        updatePayload.soldTimestamp = admin.firestore.FieldValue.delete();
      }

      await productRef.update(updatePayload);

      console.log(`Admin ${decodedToken.uid} issued refund ${refund.id} for product ${productId}, amount: ${amountToRefund}, relist: ${relist}`);
      return res.status(200).json({
        success: true,
        refundId: refund.id,
        amount: amountToRefund,
        status: refund.status,
        relisted: relist
      });

    } catch (error) {
      console.error('adminIssueRefund error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- MARK AS SHIPPED (seller confirms shipment, sends tracking email to buyer) ---
exports.markAsShipped = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [sendgridSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { productId, trackingNumber, trackingUrl, carrier } = req.body;
    if (!productId || !trackingNumber) {
      return res.status(400).json({ error: 'Missing productId or trackingNumber' });
    }

    try {
      const productRef = db.collection('products').doc(productId);
      const productSnap = await productRef.get();
      if (!productSnap.exists) return res.status(404).json({ error: 'Product not found' });

      const product = productSnap.data();
      // products store seller as userId (not sellerId)
      if (product.userId !== decodedToken.uid) {
        return res.status(403).json({ error: 'You are not the seller of this product' });
      }
      if (!product.sold) {
        return res.status(400).json({ error: 'This product has not been sold' });
      }

      // Update product doc
      await productRef.update({
        trackingNumber,
        trackingUrl: trackingUrl || null,
        carrier: carrier || null,
        shipped: true,
        shippedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update orders collection record if it exists
      const ordersSnap = await db.collection('orders').where('productId', '==', productId).limit(1).get();
      if (!ordersSnap.empty) {
        await ordersSnap.docs[0].ref.update({
          trackingNumber,
          trackingUrl: trackingUrl || null,
          carrier: carrier || null,
          shipped: true,
          shippedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // In-app notification to buyer
      await createNotification(product.buyerId, {
        icon: '📦',
        message: `Your "${product.title || 'item'}" has shipped! Tracking: ${trackingNumber}`,
        link: 'my-orders.html',
      }, `${productId}_shipped_buyer`);

      // Send tracking email to buyer
      try {
        emails.init(sendgridSecret.value());
        const buyerEmail = await getUserEmail(product.buyerId);
        await emails.sendTrackingToBuyer(buyerEmail, {
          productName: product.title || 'your item',
          trackingNumber,
          trackingUrl: trackingUrl || null,
          carrier: carrier || null,
        });
      } catch (emailErr) {
        console.error('Email error (markAsShipped):', emailErr.message);
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('markAsShipped error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- CONFIRM DELIVERY (buyer confirms receipt, enables review, notifies seller) ---
exports.confirmDelivery = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecret, sendgridSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'Missing productId' });

    try {
      const productRef = db.collection('products').doc(productId);
      const productSnap = await productRef.get();
      if (!productSnap.exists) return res.status(404).json({ error: 'Product not found' });

      const product = productSnap.data();
      if (product.buyerId !== decodedToken.uid) {
        return res.status(403).json({ error: 'You are not the buyer of this product' });
      }
      if (!product.sold) {
        return res.status(400).json({ error: 'This product has not been sold' });
      }

      // Mark delivered
      await productRef.update({
        delivered: true,
        deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update orders collection record if it exists
      const ordersSnap = await db.collection('orders').where('productId', '==', productId).limit(1).get();
      if (!ordersSnap.empty) {
        await ordersSnap.docs[0].ref.update({
          delivered: true,
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Escrow payout: transfer seller's share now that delivery is confirmed
      if (product.sellerStripeAccountId && product.sellerReceivesCents > 0) {
        try {
          const stripe = require('stripe')(stripeSecret.value());
          const transfer = await stripe.transfers.create({
            amount: product.sellerReceivesCents,
            currency: 'usd',
            destination: product.sellerStripeAccountId,
            transfer_group: product.soldOrderId,
            metadata: { productId, reason: 'delivery_confirmed' },
          });
          console.log(`Seller payout: ${product.sellerReceivesCents} cents to ${product.sellerStripeAccountId} — transfer ${transfer.id}`);
          await productRef.update({ sellerPayoutTransferId: transfer.id, sellerPaidOut: true });
        } catch (payoutErr) {
          console.error('Seller payout error (confirmDelivery):', payoutErr.message);
          // Logged for manual review — don't fail the delivery confirmation
        }
      }

      // In-app notifications for delivery
      await Promise.all([
        createNotification(product.userId, {
          icon: '💰',
          message: `Delivery confirmed! Payment for "${product.title || 'your item'}" is on its way.`,
          link: 'listings-manager.html',
        }, `${productId}_delivered_seller`),
        createNotification(product.buyerId, {
          icon: '⭐',
          message: `You received "${product.title || 'your item'}"! Don't forget to leave a review.`,
          link: 'my-orders.html',
        }, `${productId}_delivered_buyer`),
      ]);

      // Send confirmation emails to buyer and seller
      try {
        emails.init(sendgridSecret.value());
        const buyerEmail = await getUserEmail(product.buyerId);
        const sellerEmail = await getUserEmail(product.userId);
        const buyerRecord = product.buyerId ? await admin.auth().getUser(product.buyerId) : null;
        const sellerRecord = product.userId ? await admin.auth().getUser(product.userId) : null;
        const buyerName = buyerRecord?.displayName || 'the buyer';
        const sellerName = sellerRecord?.displayName || 'the seller';

        await Promise.all([
          emails.sendDeliveryConfirmedToBuyer(buyerEmail, {
            productName: product.title || 'your item',
            sellerName,
          }),
          emails.sendDeliveryConfirmedToSeller(sellerEmail, {
            productName: product.title || 'your item',
            buyerName,
          }),
        ]);
      } catch (emailErr) {
        console.error('Email error (confirmDelivery):', emailErr.message);
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('confirmDelivery error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- SHIPPO: Track Shipment ---
exports.trackShipment = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [shippoSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      await checkRateLimit(decodedToken.uid, 'dailyTrack', 20, ONE_DAY);
    } catch (e) {
      return res.status(429).json({ error: 'Too many tracking requests today. Please try again tomorrow.' });
    }

    try {
      const { productId } = req.body;
      if (!productId) return res.status(400).json({ error: 'productId is required' });

      const productDoc = await db.collection('products').doc(productId).get();
      if (!productDoc.exists) return res.status(404).json({ error: 'Product not found' });
      const product = productDoc.data();

      // Only buyer or seller can track
      if (product.buyerId !== decodedToken.uid && product.userId !== decodedToken.uid) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { trackingNumber, carrier } = product;
      if (!trackingNumber || !carrier) {
        return res.status(200).json({ tracking_status: null, tracking_history: [], message: 'No tracking info yet' });
      }

      const shippoKey = shippoSecret.value();
      const trackRes = await fetch(`https://api.goshippo.com/tracks/${carrier}/${trackingNumber}`, {
        headers: { 'Authorization': `ShippoToken ${shippoKey}` },
      });

      if (!trackRes.ok) {
        const err = await trackRes.json().catch(() => ({}));
        return res.status(trackRes.status).json({ error: err.detail || 'Tracking lookup failed' });
      }

      const trackData = await trackRes.json();
      return res.status(200).json(trackData);
    } catch (error) {
      console.error('trackShipment error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- SHIPPO WEBHOOK (auto-confirm delivery when carrier marks package delivered) ---
exports.shippoWebhook = onRequest(
  { cors: false, secrets: [shippoWebhookSecret, stripeSecret, sendgridSecret], maxInstances: 5 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // Validate secret token passed as query param (?token=...)
    const incomingToken = req.query.token;
    if (!incomingToken || incomingToken !== shippoWebhookSecret.value()) {
      console.warn('Shippo webhook: invalid or missing token');
      return res.status(401).send('Unauthorized');
    }

    const payload = req.body;
    const trackingNumber = payload?.data?.tracking_number;
    const status = payload?.data?.tracking_status?.status; // e.g. DELIVERED, TRANSIT, UNKNOWN

    console.log(`Shippo webhook received: tracking=${trackingNumber} status=${status}`);

    // Always acknowledge quickly so Shippo doesn't retry
    res.status(200).send('OK');

    if (!trackingNumber || status !== 'DELIVERED') return;

    try {
      // Find the product with this tracking number that isn't already marked delivered
      const snapshot = await db.collection('products')
        .where('trackingNumber', '==', trackingNumber)
        .where('sold', '==', true)
        .limit(1)
        .get();

      if (snapshot.empty) {
        console.log(`Shippo webhook: no product found for tracking ${trackingNumber}`);
        return;
      }

      const productDoc = snapshot.docs[0];
      const product = productDoc.data();

      if (product.delivered) {
        console.log(`Shippo webhook: product ${productDoc.id} already marked delivered`);
        return;
      }

      // Mark delivered
      await productDoc.ref.update({
        delivered: true,
        deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
        deliverySource: 'shippo_webhook',
      });

      // Update orders collection too
      const ordersSnap = await db.collection('orders').where('productId', '==', productDoc.id).limit(1).get();
      if (!ordersSnap.empty) {
        await ordersSnap.docs[0].ref.update({
          delivered: true,
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Escrow payout: transfer seller's share now that carrier confirmed delivery
      if (product.sellerStripeAccountId && product.sellerReceivesCents > 0 && !product.sellerPaidOut) {
        try {
          const stripe = require('stripe')(stripeSecret.value());
          const transfer = await stripe.transfers.create({
            amount: product.sellerReceivesCents,
            currency: 'usd',
            destination: product.sellerStripeAccountId,
            transfer_group: product.soldOrderId,
            metadata: { productId: productDoc.id, reason: 'delivery_confirmed_shippo' },
          });
          console.log(`Seller payout (shippoWebhook): ${product.sellerReceivesCents} cents to ${product.sellerStripeAccountId} — transfer ${transfer.id}`);
          await productDoc.ref.update({ sellerPayoutTransferId: transfer.id, sellerPaidOut: true });
        } catch (payoutErr) {
          console.error('Seller payout error (shippoWebhook):', payoutErr.message);
        }
      }

      // Send confirmation emails
      try {
        emails.init(sendgridSecret.value());
        const buyerEmail = await getUserEmail(product.buyerId);
        const sellerEmail = await getUserEmail(product.userId);
        const buyerRecord = product.buyerId ? await admin.auth().getUser(product.buyerId).catch(() => null) : null;
        const sellerRecord = product.userId ? await admin.auth().getUser(product.userId).catch(() => null) : null;
        const buyerName = buyerRecord?.displayName || 'the buyer';
        const sellerName = sellerRecord?.displayName || 'the seller';

        await Promise.all([
          emails.sendDeliveryConfirmedToBuyer(buyerEmail, {
            productName: product.title || 'your item',
            sellerName,
          }),
          emails.sendDeliveryConfirmedToSeller(sellerEmail, {
            productName: product.title || 'your item',
            buyerName,
          }),
        ]);
      } catch (emailErr) {
        console.error('Email error (shippoWebhook):', emailErr.message);
      }

      console.log(`Shippo webhook: delivery confirmed for product ${productDoc.id}`);
    } catch (err) {
      console.error('Shippo webhook processing error:', err);
    }
  }
);

// --- BILLING KILL SWITCH ---
// Subscribes to the billing-alerts Pub/Sub topic.
// When actual spend >= budget, disables billing on the project entirely.
// Only fires at 100%+ threshold — lower alert thresholds (e.g. 50%, 75%) are logged but ignored.
//
// REQUIRED IAM (set in Google Cloud Console):
//   Principal: <PROJECT_NUMBER>-compute@developer.gserviceaccount.com
//   Role: roles/billing.projectManager  (granted at the BILLING ACCOUNT level, not project level)
//   Where: Billing → Account Management → Add Principal
const BILLING_PROJECT = 'wrestleswap';

exports.killBillingOnBudgetAlert = onMessagePublished(
  { topic: 'billing-alerts', maxInstances: 1 },
  async (event) => {
    // Pub/Sub message data is base64-encoded JSON
    const data = event.data.message.json;

    const costAmount      = data.costAmount      || 0;
    const budgetAmount    = data.budgetAmount    || 0;
    const alertThreshold  = data.alertThresholdExceeded || 0;
    const budgetName      = data.budgetDisplayName || 'unknown';

    console.log(`Budget alert [${budgetName}]: $${costAmount} spent of $${budgetAmount} budget (threshold: ${(alertThreshold * 100).toFixed(0)}%)`);

    // Only kill billing when actual spend has hit or exceeded 100% of budget
    if (alertThreshold < 1.0 && costAmount < budgetAmount) {
      console.log('Under budget threshold — no action taken.');
      return;
    }

    try {
      const billingClient = new CloudBillingClient();
      const projectName = `projects/${BILLING_PROJECT}`;

      // Check current state before acting
      const [billingInfo] = await billingClient.getProjectBillingInfo({ name: projectName });
      if (!billingInfo.billingEnabled) {
        console.log('Billing already disabled — nothing to do.');
        return;
      }

      // Disable billing by clearing the billing account association
      await billingClient.updateProjectBillingInfo({
        name: projectName,
        projectBillingInfo: { billingAccountName: '' },
      });

      console.log(`BILLING DISABLED on ${BILLING_PROJECT}. Spend: $${costAmount} / Budget: $${budgetAmount}`);

      // Write audit record to Firestore (Admin SDK so this survives even if Firestore rules block clients)
      await db.collection('adminEvents').add({
        type: 'billing_disabled',
        reason: 'budget_exceeded',
        costAmount,
        budgetAmount,
        alertThreshold,
        budgetDisplayName: budgetName,
        disabledAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    } catch (err) {
      console.error('Failed to disable billing:', err.message);
      throw err; // Re-throw so Cloud Functions retries the message
    }
  }
);
