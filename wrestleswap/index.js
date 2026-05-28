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

// Award Verified Seller / Trusted Trader badges based on completed paid-out sales.
// Called after every successful payout — idempotent (only sets fields that aren't already true).
async function maybeAwardSellerBadges(sellerId) {
  try {
    const sellerRef = db.collection('users').doc(sellerId);
    const sellerSnap = await sellerRef.get();
    if (!sellerSnap.exists) return;
    const seller = sellerSnap.data();
    if (seller.sellerSuspended) return;

    const salesSnap = await db.collection('products')
      .where('userId', '==', sellerId)
      .where('sellerPaidOut', '==', true)
      .get();
    const completedSales = salesSnap.size;

    const updates = {};
    if (!seller.verifiedSeller && completedSales >= 5)  updates.verifiedSeller = true;
    if (!seller.trustedTrader  && completedSales >= 20) updates.trustedTrader  = true;

    if (Object.keys(updates).length > 0) {
      await sellerRef.update(updates);
      console.log(`Badges awarded to ${sellerId}:`, Object.keys(updates).join(', '));
    }
  } catch (err) {
    console.error('maybeAwardSellerBadges error:', err.message);
  }
}

// Define secrets
const stripeSecret = defineSecret("STRIPE_SKEY");
const shippoSecret = defineSecret("SHIPPO_API_KEY");
const sendgridSecret = defineSecret("SENDGRID_API_KEY_TEST");
const shippoWebhookSecret = defineSecret("SHIPPO_WEBHOOK_SECRET");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const stripeAccountWebhookSecret = defineSecret("STRIPE_ACCOUNT_WEBHOOK_SECRET");
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
      const { currency = 'usd', productId, rateObjectId, buyerState, buyerZip } = req.body;

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

      // --- STRIPE TAX: calculate exact tax for buyer's address ---
      let taxInCents = 0;
      let taxCalculationId = null;
      let taxSource = 'fallback_8pct';
      let taxError = null;
      if (buyerState && buyerZip) {
        try {
          // tax_behavior: 'exclusive' = tax is added ON TOP of the price (standard US retail)
          // Shipping must be passed as shipping_cost param, not as a line_item
          const taxCalcParams = {
            currency: 'usd',
            customer_details: {
              address: { country: 'US', state: buyerState.toUpperCase(), postal_code: buyerZip },
              address_source: 'shipping',
            },
            line_items: [
              { amount: productPriceInCents, reference: productId, tax_code: 'txcd_99999999', tax_behavior: 'exclusive' },
            ],
          };
          if (shippingInCents > 0) {
            taxCalcParams.shipping_cost = { amount: shippingInCents, tax_behavior: 'exclusive' };
          }
          const taxCalc = await stripe.tax.calculations.create(taxCalcParams);
          taxInCents = taxCalc.tax_amount_exclusive;
          taxCalculationId = taxCalc.id;
          taxSource = 'stripe_tax';
          console.log('Stripe Tax applied:', taxInCents, 'cents for', buyerState, buyerZip);
        } catch (taxErr) {
          taxError = taxErr.message;
          console.error('Stripe Tax calculation failed — no tax applied. Reason:', taxErr.message);
          taxInCents = 0;
        }
      } else {
        console.warn('No buyerState/buyerZip provided — no tax applied');
        taxInCents = 0;
      }
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
        metadata: { productId, taxAmountCents: String(taxInCents), taxCalculationId: taxCalculationId || '' },
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
          buyerId: decodedToken.uid,
          sellerStripeAccountId,
          sellerReceivesCents: String(sellerReceivesCents),
          platformFeeCents: String(platformFeeOnProduct),
          rateObjectId: rateObjectId || '',
          taxAmountCents: String(taxInCents),
          taxCalculationId: taxCalculationId || '',
        };
      } else {
        // Seller has no connected Stripe account — block purchase so they don't sell without getting paid
        if (productPriceInCents > 0) {
          return res.status(400).json({
            error: 'The seller has not connected their payout account yet. Please contact the seller or check back later.',
          });
        }
        paymentIntentOptions.metadata = { productId, buyerId: decodedToken.uid, rateObjectId: rateObjectId || '', taxAmountCents: String(taxInCents), taxCalculationId: taxCalculationId || '' };
      }

      const paymentIntent = await stripe.paymentIntents.create(paymentIntentOptions);
      console.log('Payment intent created:', paymentIntent.id);

      return res.status(200).json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        taxAmountCents: taxInCents,
        taxSource,
        ...(taxError ? { taxError } : {}),
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

      // Atomically validate order state and acquire cancel lock — prevents double-refund
      // from concurrent cancel requests (same pattern as confirmDelivery payout lock)
      let productData;
      const productRef = db.collection('products').doc(productId);
      try {
        await db.runTransaction(async (t) => {
          const snap = await t.get(productRef);
          if (!snap.exists) throw Object.assign(new Error('Product not found'), { httpStatus: 404 });
          const d = snap.data();
          if (d.buyerId !== decodedToken.uid) throw Object.assign(new Error('You are not the buyer of this order'), { httpStatus: 403 });
          if (!d.sold || d.cancelled || d.cancelInitiated) throw Object.assign(new Error('Order is not in a cancellable state'), { httpStatus: 400 });
          if (d.trackingNumber || d.shipped) throw Object.assign(new Error('This order has already been shipped and cannot be cancelled. Please use Request Refund instead.'), { httpStatus: 400 });
          productData = d;
          t.update(snap.ref, { cancelInitiated: true });
        });
      } catch (txErr) {
        if (txErr.httpStatus) return res.status(txErr.httpStatus).json({ error: txErr.message });
        throw txErr;
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
        cancelInitiated: admin.firestore.FieldValue.delete(),
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
      await checkRateLimit(authedToken.uid, 'shippo', 30, ONE_HOUR);
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
        // Only collect minimum required fields upfront — defer bank/ID verification
        // until the seller is ready to cash out. Reduces signup friction.
        collection_options: { fields: 'eventually_due' },
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
      await checkRateLimit(authedToken.uid, 'shippo', 30, ONE_HOUR);
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
      // phone and email are required by USPS for label creation
      const cleanAddress = (addr) => ({
        name:    sanitizeString(addr.name, 100),
        street1: sanitizeString(addr.street1, 100),
        city:    sanitizeString(addr.city, 100),
        state:   sanitizeString(addr.state, 50),
        zip:     sanitizeString(addr.zip, 20),
        country: sanitizeString(addr.country, 10) || 'US',
        phone:   sanitizeString(addr.phone || '', 30) || undefined,
        email:   sanitizeString(addr.email || '', 100) || undefined,
      });

      // Sanitize parcel — only allow known numeric fields, never forward raw client object
      const cleanParcel = {
        length:        sanitizeString(String(parcel.length  || '10'), 20),
        width:         sanitizeString(String(parcel.width   || '10'), 20),
        height:        sanitizeString(String(parcel.height  || '5'),  20),
        weight:        sanitizeString(String(parcel.weight  || '2'),  20),
        distance_unit: parcel.distance_unit === 'cm' ? 'cm' : 'in',
        mass_unit:     parcel.mass_unit === 'kg' ? 'kg' : 'lb',
      };

      // Create shipment data for Shippo API
      const shipmentData = {
        address_from: cleanAddress(addressFrom),
        address_to:   cleanAddress(addressTo),
        parcels: [cleanParcel],
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
      const { rateObjectId, labelFileType = 'PDF', async: asyncLabel = false, productId: labelProductId } = req.body;

      if (!rateObjectId) {
        return res.status(400).json({ error: 'Missing rateObjectId' });
      }

      // Verify caller owns this product before purchasing a label on their behalf
      if (labelProductId) {
        const productSnap = await db.collection('products').doc(labelProductId).get();
        if (!productSnap.exists) {
          return res.status(404).json({ error: 'Product not found' });
        }
        const productOwnerData = productSnap.data();
        if (productOwnerData.userId !== decodedToken.uid) {
          return res.status(403).json({ error: 'Forbidden: you do not own this listing' });
        }
        if (!productOwnerData.sold) {
          return res.status(400).json({ error: 'Product has not been sold yet' });
        }
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
          async: asyncLabel
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

          // Notify buyer — label is purchased which means shipping is imminent
          try {
            const productSnap2 = await db.collection('products').doc(labelProductId).get();
            if (productSnap2.exists) {
              const pdata = productSnap2.data();
              if (pdata.buyerId) {
                await createNotification(pdata.buyerId, {
                  icon: '📦',
                  message: `Your "${pdata.title || 'item'}" is being prepared for shipment. Tracking: ${transaction.tracking_number || 'pending'}`,
                  link: 'my-orders.html',
                }, `${labelProductId}_label_created_buyer`);
                emails.init(sendgridSecret.value());
                const buyerEmail = await getUserEmail(pdata.buyerId);
                await emails.sendTrackingToBuyer(buyerEmail, {
                  productName: pdata.title || 'your item',
                  trackingNumber: transaction.tracking_number || '',
                  trackingUrl: transaction.tracking_url_provider || null,
                  carrier: carrier || null,
                });
              }
            }
          } catch (notifyErr) {
            console.error('Failed to notify buyer after label creation:', notifyErr.message);
          }

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

      // Verify the authenticated user is the buyer who created this payment intent
      // Prevents order hijacking if an attacker obtains the payment intent ID
      if (paymentIntent.metadata.buyerId && paymentIntent.metadata.buyerId !== decodedToken.uid) {
        return res.status(403).json({ error: 'This payment was not made by your account' });
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
          const taxCents = parseInt(paymentIntent.metadata.taxAmountCents || 0);
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

      // Notify watchlist followers that this item sold
      try {
        emails.init(sendgridSecret.value());
        const watchlistSnap = await db.collection('watchlists').get();
        const notifyPromises = [];
        watchlistSnap.forEach(watchDoc => {
          const watcherId = watchDoc.id;
          const data = watchDoc.data();
          if (watcherId === decodedToken.uid) return; // don't notify the buyer
          if (Array.isArray(data.products) && data.products.includes(productId)) {
            notifyPromises.push(
              createNotification(watcherId, {
                icon: '🔔',
                message: `"${prod.title || 'An item'}" on your watchlist just sold.`,
                link: `search.html${prod.category ? '?category=' + encodeURIComponent(prod.category) : ''}`,
              }, `${productId}_watchlist_${watcherId}_sold`).catch(() => {}),
              getUserEmail(watcherId).then(email =>
                emails.sendWatchlistItemSold(email, {
                  productName: prod.title || 'An item',
                  category: prod.category || '',
                })
              ).catch(() => {})
            );
          }
        });
        await Promise.all(notifyPromises);
      } catch (watchlistErr) {
        console.error('Watchlist notification error (completeOrder):', watchlistErr.message);
      }

      // Clear abandoned cart record if one exists
      try {
        await db.collection('abandonedCarts').doc(`${productId}_${decodedToken.uid}`).delete();
      } catch (_) { /* best-effort */ }

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

      // Atomically validate order state and acquire cancel lock — prevents double-refund
      let productData;
      const productRef2 = db.collection('products').doc(productId);
      try {
        await db.runTransaction(async (t) => {
          const snap = await t.get(productRef2);
          if (!snap.exists) throw Object.assign(new Error('Product not found'), { httpStatus: 404 });
          const d = snap.data();
          if (d.userId !== decodedToken.uid) throw Object.assign(new Error('You are not the seller of this item'), { httpStatus: 403 });
          if (!d.sold || d.cancelled || d.cancelledAt || d.cancelInitiated) throw Object.assign(new Error('Order is not in a cancellable state'), { httpStatus: 400 });
          productData = d;
          t.update(snap.ref, { cancelInitiated: true });
        });
      } catch (txErr) {
        if (txErr.httpStatus) return res.status(txErr.httpStatus).json({ error: txErr.message });
        throw txErr;
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
        cancelInitiated: admin.firestore.FieldValue.delete(),
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
    emails.init(sendgridSecret.value());

    // ── PASS 1: 7-day ship reminders ─────────────────────────────────────────
    const sevenDaysAgo  = Date.now() - (7  * 24 * 60 * 60 * 1000);
    const eightDaysAgo  = Date.now() - (8  * 24 * 60 * 60 * 1000);

    const reminderSnap = await db.collection('products')
      .where('sold', '==', true)
      .where('soldTimestamp', '<=', sevenDaysAgo)
      .where('soldTimestamp', '>=', eightDaysAgo)
      .get();

    const reminderOrders = reminderSnap.docs.filter(doc => {
      const d = doc.data();
      return !d.cancelled && !d.cancelledAt && !d.shipped && !d.shipReminderSent;
    });

    console.log(`7-day reminders: ${reminderOrders.length} orders`);
    for (const rdoc of reminderOrders) {
      const rdata = rdoc.data();
      try {
        const sellerEmail = await getUserEmail(rdata.userId);
        const daysSinceSale = Math.round((Date.now() - (rdata.soldTimestamp || 0)) / (24 * 60 * 60 * 1000));
        await emails.sendShipReminder(sellerEmail, {
          productName: rdata.title || 'your item',
          daysSinceSale,
        });
        await rdoc.ref.update({ shipReminderSent: true });
        await createNotification(rdata.userId, {
          icon: '⚠️',
          message: `Reminder: Ship "${rdata.title || 'your item'}" now — auto-cancel in ${10 - daysSinceSale} days.`,
          link: 'seller-order-fulfillment.html',
        });
      } catch (e) {
        console.error('7-day reminder error:', rdoc.id, e.message);
      }
    }

    const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000);
    console.log('Overdue order check — cutoff:', new Date(tenDaysAgo).toISOString());

    const snapshot = await db.collection('products')
      .where('sold', '==', true)
      .where('soldTimestamp', '<=', tenDaysAgo)
      .get();

    // Filter in JS: exclude already-cancelled and orders that haven't been marked shipped.
    // Use d.shipped (set by markAsShipped) — not trackingNumber, which is saved when a label
    // is purchased but before the item is actually handed to the carrier.
    const overdueOrders = snapshot.docs.filter(doc => {
      const d = doc.data();
      return !d.cancelled && !d.cancelledAt && !d.shipped;
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
        shippedTimestamp: Date.now(), // epoch ms used by auto-release scheduler
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

      // In-app notification back to seller confirming the record was saved
      await createNotification(decodedToken.uid, {
        icon: '✅',
        message: `Shipment recorded for "${product.title || 'your item'}". Buyer has been notified.`,
        link: 'listings-manager.html',
      }, `${productId}_shipped_seller`);

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

      // ── Step 1: Transaction — validate + atomically acquire payout lock ────
      // This prevents double-payout if the auto-release scheduler fires at the same time.
      let product = null;
      let skipPayout = false;

      try {
        await db.runTransaction(async (t) => {
          const snap = await t.get(productRef);
          if (!snap.exists) throw Object.assign(new Error('Product not found'), { httpStatus: 404 });
          const d = snap.data();
          if (d.buyerId !== decodedToken.uid) throw Object.assign(new Error('You are not the buyer of this product'), { httpStatus: 403 });
          if (!d.sold) throw Object.assign(new Error('This product has not been sold'), { httpStatus: 400 });

          product = d;

          if (d.sellerPaidOut || d.payoutInitiated) {
            // Payout already done or in-flight — just mark delivered, skip Stripe call
            skipPayout = true;
            t.update(productRef, {
              delivered: true,
              deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
              deliveredTimestamp: Date.now(),
            });
            return;
          }

          // Acquire payout lock — prevents auto-release scheduler from firing concurrently
          t.update(productRef, {
            delivered: true,
            deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
            deliveredTimestamp: Date.now(),
            payoutInitiated: true,
          });
        });
      } catch (txErr) {
        if (txErr.httpStatus) return res.status(txErr.httpStatus).json({ error: txErr.message });
        throw txErr;
      }

      // ── Step 2: Stripe transfer (must happen outside transaction) ──────────
      if (!skipPayout && product.sellerStripeAccountId && product.sellerReceivesCents > 0) {
        try {
          const stripe = require('stripe')(stripeSecret.value());
          // Idempotency key ensures Stripe deduplicates even if this runs twice
          const transfer = await stripe.transfers.create({
            amount: product.sellerReceivesCents,
            currency: 'usd',
            destination: product.sellerStripeAccountId,
            transfer_group: product.soldOrderId,
            metadata: { productId, reason: 'delivery_confirmed', triggeredBy: 'buyer' },
          }, {
            idempotencyKey: `payout_${productId}`,
          });
          console.log(`Seller payout: ${product.sellerReceivesCents} cents → ${product.sellerStripeAccountId} — transfer ${transfer.id}`);
          await productRef.update({
            sellerPayoutTransferId: transfer.id,
            sellerPaidOut: true,
            sellerPaidOutAt: admin.firestore.FieldValue.serverTimestamp(),
            payoutInitiated: false,
          });
        } catch (payoutErr) {
          // Clear lock so auto-release scheduler can retry on next run
          await productRef.update({ payoutInitiated: false }).catch(() => {});
          console.error('Seller payout error (confirmDelivery):', payoutErr.message);
          // Don't fail delivery confirmation — payout failure is a background issue
        }
      }

      // ── Step 3: Update orders collection ──────────────────────────────────
      const ordersSnap = await db.collection('orders').where('productId', '==', productId).limit(1).get();
      if (!ordersSnap.empty) {
        await ordersSnap.docs[0].ref.update({
          delivered: true,
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'completed',
        });
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

      // Check if seller has earned a badge (fire-and-forget — never blocks response)
      maybeAwardSellerBadges(product.userId).catch(() => {});

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

    if (!trackingNumber) return;

    // For intermediate statuses send a silent in-app ping (no email — avoid spam)
    const TRANSIT_STATUSES = ['PRE_TRANSIT', 'TRANSIT', 'OUT_FOR_DELIVERY'];
    if (status !== 'DELIVERED') {
      if (!TRANSIT_STATUSES.includes(status)) return;
      try {
        const tSnap = await db.collection('products')
          .where('trackingNumber', '==', trackingNumber)
          .where('sold', '==', true)
          .limit(1)
          .get();
        if (!tSnap.empty) {
          const tProduct = tSnap.docs[0].data();
          const statusMessages = {
            PRE_TRANSIT:      'A shipping label has been created for your order.',
            TRANSIT:          'Your order is in transit and on its way!',
            OUT_FOR_DELIVERY: 'Your order is out for delivery today!',
          };
          const icon = status === 'OUT_FOR_DELIVERY' ? '🚚' : '📦';
          if (tProduct.buyerId && statusMessages[status]) {
            await createNotification(tProduct.buyerId, {
              icon,
              message: `"${tProduct.title || 'Your item'}": ${statusMessages[status]}`,
              link: 'my-orders.html',
            });
          }
        }
      } catch (transitErr) {
        console.error('Shippo webhook transit notification error:', transitErr.message);
      }
      return;
    }

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

      const productId = productDoc.id;

      // Atomically mark delivered + acquire payout lock (prevents race with confirmDelivery / autoRelease)
      let skipPayout = false;
      try {
        await db.runTransaction(async (t) => {
          const snap = await t.get(productDoc.ref);
          const d = snap.data();
          if (d.delivered) { skipPayout = true; return; } // already handled
          if (d.sellerPaidOut || d.payoutInitiated) { skipPayout = true; }
          t.update(productDoc.ref, {
            delivered: true,
            deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
            deliveredTimestamp: Date.now(),
            deliverySource: 'shippo_webhook',
            ...(skipPayout ? {} : { payoutInitiated: true }),
          });
        });
      } catch (txErr) {
        console.error(`Shippo webhook transaction error for ${productId}:`, txErr.message);
        return;
      }

      // Update orders collection
      const ordersSnap = await db.collection('orders').where('productId', '==', productId).limit(1).get();
      if (!ordersSnap.empty) {
        await ordersSnap.docs[0].ref.update({
          delivered: true,
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'completed',
        });
      }

      // Escrow payout: transfer seller's share now that carrier confirmed delivery
      if (!skipPayout && product.sellerStripeAccountId && product.sellerReceivesCents > 0) {
        try {
          const stripe = require('stripe')(stripeSecret.value());
          const transfer = await stripe.transfers.create({
            amount: product.sellerReceivesCents,
            currency: 'usd',
            destination: product.sellerStripeAccountId,
            transfer_group: product.soldOrderId,
            metadata: { productId, reason: 'delivery_confirmed_shippo', triggeredBy: 'shippo_webhook' },
          }, {
            idempotencyKey: `payout_${productId}`,
          });
          console.log(`Seller payout (shippoWebhook): ${product.sellerReceivesCents} cents to ${product.sellerStripeAccountId} — transfer ${transfer.id}`);
          await productDoc.ref.update({
            sellerPayoutTransferId: transfer.id,
            sellerPaidOut: true,
            sellerPaidOutAt: admin.firestore.FieldValue.serverTimestamp(),
            payoutInitiated: false,
          });
        } catch (payoutErr) {
          await productDoc.ref.update({ payoutInitiated: false }).catch(() => {});
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

      // In-app notifications (matches confirmDelivery — idempotency keys prevent dupes)
      await Promise.all([
        createNotification(product.userId, {
          icon: '💰',
          message: `Delivery confirmed! Payment for "${product.title || 'your item'}" is on its way.`,
          link: 'listings-manager.html',
        }, `${productId}_delivered_seller`),
        createNotification(product.buyerId, {
          icon: '⭐',
          message: `Your "${product.title || 'item'}" was delivered! Don't forget to leave a review.`,
          link: 'my-orders.html',
        }, `${productId}_delivered_buyer`),
      ]);

      maybeAwardSellerBadges(product.userId).catch(() => {});
      console.log(`Shippo webhook: delivery confirmed for product ${productDoc.id}`);
    } catch (err) {
      console.error('Shippo webhook processing error:', err);
    }
  }
);

// --- STRIPE WEBHOOK (safety net: completes order if client crashed after payment succeeded) ---
// Handles payment_intent.succeeded — marks the product sold and creates the order record
// if completeOrder never ran (e.g. buyer closed the tab right after Stripe confirmed the charge).
// Idempotent: silently skips if the product is already sold.
exports.stripeWebhook = onRequest(
  { cors: false, secrets: [stripeSecret, stripeWebhookSecret, sendgridSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // Verify Stripe signature using raw body
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      const stripe = require('stripe')(stripeSecret.value());
      event = stripe.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecret.value());
    } catch (err) {
      console.error('Stripe webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Acknowledge immediately so Stripe doesn't retry
    res.status(200).send('OK');

    if (event.type !== 'payment_intent.succeeded') return;

    const paymentIntent = event.data.object;
    const productId = paymentIntent.metadata?.productId;
    const buyerId   = paymentIntent.metadata?.buyerId;

    if (!productId || !buyerId) {
      console.warn('stripeWebhook: missing productId or buyerId in metadata', paymentIntent.id);
      return;
    }

    try {
      const productRef = db.collection('products').doc(productId);
      let prod = null;

      // Atomic check-and-mark — prevents double-processing if completeOrder already ran
      try {
        await db.runTransaction(async (t) => {
          const snap = await t.get(productRef);
          if (!snap.exists) throw Object.assign(new Error('Product not found'), { code: 'NOT_FOUND' });
          if (snap.data().sold) throw Object.assign(new Error('already_sold'), { code: 'ALREADY_SOLD' });
          prod = snap.data();

          const sellerStripeAccountId = paymentIntent.metadata.sellerStripeAccountId || null;
          const sellerReceivesCents   = parseInt(paymentIntent.metadata.sellerReceivesCents || 0);
          const savedRateObjectId     = paymentIntent.metadata.rateObjectId || null;
          const prodPriceCents        = Math.round((prod.price || 0) * 100);
          const taxCents              = parseInt(paymentIntent.metadata.taxAmountCents || 0);
          const shippingCents         = Math.max(0, paymentIntent.amount - prodPriceCents - taxCents);

          const updateData = {
            sold: true,
            soldAt: admin.firestore.FieldValue.serverTimestamp(),
            soldTimestamp: Date.now(),
            soldOrderId: paymentIntent.id,
            buyerId,
            shippingCost: shippingCents / 100,
            sellerStripeAccountId: sellerStripeAccountId || null,
            sellerReceivesCents: sellerReceivesCents || 0,
          };
          if (savedRateObjectId) updateData.rateObjectId = savedRateObjectId;

          t.update(productRef, updateData);
        });
      } catch (txErr) {
        if (txErr.code === 'ALREADY_SOLD' || txErr.code === 'NOT_FOUND') {
          console.log(`stripeWebhook: skipping ${productId} — ${txErr.message}`);
          return;
        }
        throw txErr;
      }

      console.log(`stripeWebhook: order completed for product ${productId}, buyer ${buyerId}`);

      const prodPriceCents = Math.round((prod.price || 0) * 100);
      const taxCents       = parseInt(paymentIntent.metadata.taxAmountCents || 0);
      const shippingCents  = Math.max(0, paymentIntent.amount - prodPriceCents - taxCents);

      // Save order record (source flag helps identify webhook-recovered orders in admin)
      try {
        await db.collection('orders').add({
          productId,
          buyerId,
          sellerId: prod.userId || null,
          paymentIntentId: paymentIntent.id,
          productTitle: prod.title || null,
          productPrice: prod.price || null,
          productImages: prod.images || [],
          productCondition: prod.condition || null,
          shippingCost: shippingCents / 100,
          sellerStripeAccountId: paymentIntent.metadata.sellerStripeAccountId || null,
          sellerReceivesCents: parseInt(paymentIntent.metadata.sellerReceivesCents || 0),
          rateObjectId: paymentIntent.metadata.rateObjectId || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdTimestamp: Date.now(),
          status: 'paid',
          source: 'webhook_fallback',
        });
      } catch (orderErr) {
        console.error('stripeWebhook order record error:', orderErr.message);
      }

      // In-app notifications (idempotency keys match completeOrder — safe if both run)
      await Promise.all([
        createNotification(prod.userId, {
          icon: '🛍️',
          message: `New sale! Someone bought your "${prod.title || 'item'}". Ship it within 3 days.`,
          link: 'seller-order-fulfillment.html',
        }, `${paymentIntent.id}_seller`),
        createNotification(buyerId, {
          icon: '✅',
          message: `Order placed for "${prod.title || 'item'}". The seller will ship soon.`,
          link: 'my-orders.html',
        }, `${paymentIntent.id}_buyer`),
      ]);

      // Emails
      try {
        emails.init(sendgridSecret.value());
        const sellerEmail  = await getUserEmail(prod.userId);
        const buyerEmail   = await getUserEmail(buyerId);
        const buyerRecord  = await admin.auth().getUser(buyerId);
        const sellerRecord = prod.userId ? await admin.auth().getUser(prod.userId).catch(() => null) : null;
        const buyerName    = buyerRecord.displayName || buyerRecord.email.split('@')[0];
        const sellerName   = sellerRecord
          ? (sellerRecord.displayName || sellerRecord.email.split('@')[0])
          : 'the seller';
        await Promise.all([
          emails.sendOrderPlacedSeller(sellerEmail, { productName: prod.title || 'your item', buyerName }),
          emails.sendOrderPlacedBuyer(buyerEmail, { productName: prod.title || 'your item', orderId: paymentIntent.id, sellerName }),
        ]);
      } catch (emailErr) {
        console.error('stripeWebhook email error:', emailErr.message);
      }

    } catch (err) {
      console.error('stripeWebhook processing error:', err);
    }
  }
);

// --- REACTIVATE LISTING (seller relists a cancelled item) ---
// Clears all sale/cancellation fields using Admin SDK so Firestore rules don't block it.
exports.reactivateListing = onRequest(
  { cors: ALLOWED_ORIGINS, maxInstances: 10 },
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
      if (product.userId !== decodedToken.uid) {
        return res.status(403).json({ error: 'You are not the owner of this listing' });
      }
      if (!product.cancelled) {
        return res.status(400).json({ error: 'This listing is not cancelled' });
      }

      const del = admin.firestore.FieldValue.delete();
      await productRef.update({
        sold: false,
        active: true,
        cancelled: false,
        buyerId: del,
        soldOrderId: del,
        soldAt: del,
        soldTimestamp: del,
        shippingLabel: del,
        trackingNumber: del,
        trackingUrl: del,
        carrier: del,
        cancelledAt: del,
        cancelledTimestamp: del,
        cancelledBy: del,
        cancellationReason: del,
        refundId: del,
        refundAmount: del,
        rateObjectId: del,
        sellerStripeAccountId: del,
        sellerReceivesCents: del,
        sellerPayoutTransferId: del,
        sellerPaidOut: del,
        packageDimensions: del,
        buyerShippingAddress: del,
        shipped: del,
        shippedAt: del,
        delivered: del,
        deliveredAt: del,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('reactivateListing error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- STRIPE ACCOUNT UPDATED WEBHOOK ---
// Listens for account.updated from Stripe Connect.
// Auto-syncs stripePayoutsEnabled / stripeChargesEnabled to Firestore so
// settings.html and sell.html always reflect the real state.
exports.stripeAccountWebhook = onRequest(
  { cors: false, secrets: [stripeSecret, stripeAccountWebhookSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    let event;
    try {
      const stripe = require('stripe')(stripeSecret.value());
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        stripeAccountWebhookSecret.value()
      );
    } catch (err) {
      console.error('stripeAccountWebhook signature error:', err.message);
      return res.status(400).send('Webhook signature verification failed');
    }

    if (event.type === 'account.updated') {
      const account = event.data.object;
      try {
        // Find user with this Stripe account ID
        const usersSnap = await db.collection('users')
          .where('stripeAccountId', '==', account.id)
          .limit(1)
          .get();

        if (!usersSnap.empty) {
          const userRef = usersSnap.docs[0].ref;
          const payoutsEnabled  = account.payouts_enabled  === true;
          const chargesEnabled  = account.charges_enabled  === true;
          const detailsSubmitted = account.details_submitted === true;

          await userRef.update({
            stripePayoutsEnabled:   payoutsEnabled,
            stripeChargesEnabled:   chargesEnabled,
            stripeDetailsSubmitted: detailsSubmitted,
            stripeAccountUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // If they just completed setup, send a congratulatory in-app notification
          if (payoutsEnabled) {
            await createNotification(usersSnap.docs[0].id, {
              icon: '💳',
              message: 'Your payout account is now active! You can start receiving payments.',
              link: 'sell.html',
            }, `stripe_payouts_enabled_${account.id}`);
          }

          console.log(`stripeAccountWebhook: updated user ${usersSnap.docs[0].id} — payouts:${payoutsEnabled} charges:${chargesEnabled}`);
        } else {
          console.log('stripeAccountWebhook: no user found for account', account.id);
        }
      } catch (err) {
        console.error('stripeAccountWebhook Firestore error:', err.message);
        return res.status(500).send('Internal error');
      }
    }

    return res.status(200).json({ received: true });
  }
);

// --- NOTIFY NEW MESSAGE ---
// Called from messages.html after a message is sent.
// Sends an email + in-app notification to the recipient if they haven't been
// notified in the last 10 minutes for this conversation (rate-limited to avoid spam).
exports.notifyNewMessage = onRequest(
  { cors: ALLOWED_ORIGINS, secrets: [sendgridSecret], maxInstances: 20 },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { conversationId, messagePreview } = req.body;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    try {
      // Rate limit: max 30 message notifications per hour per sender
      await checkRateLimit(decodedToken.uid, 'msgNotify', 30, ONE_HOUR);
    } catch (e) {
      return res.status(200).json({ skipped: 'rate_limit' }); // silent — don't break the send flow
    }

    try {
      const convSnap = await db.collection('conversations').doc(conversationId).get();
      if (!convSnap.exists) return res.status(404).json({ error: 'Conversation not found' });

      const conv = convSnap.data();
      const isBuyer  = conv.buyerId  === decodedToken.uid;
      const recipientId = isBuyer ? conv.sellerId : conv.buyerId;

      if (!recipientId) return res.status(200).json({ skipped: 'no_recipient' });

      // Check if we already notified this recipient for this conv in the last 10 min
      const notifyKey = `msg_${conversationId}_${recipientId}`;
      const rlSnap = await db.collection('rateLimits').doc(recipientId).get();
      const rlData = rlSnap.exists ? rlSnap.data() : {};
      const lastNotify = rlData[notifyKey] || 0;
      if (Date.now() - lastNotify < 10 * 60 * 1000) {
        return res.status(200).json({ skipped: 'recently_notified' });
      }

      // Update the cooldown timestamp for this conversation
      await db.collection('rateLimits').doc(recipientId).set(
        { [notifyKey]: Date.now() },
        { merge: true }
      );

      const senderRecord = await admin.auth().getUser(decodedToken.uid).catch(() => null);
      const senderName = senderRecord
        ? (senderRecord.displayName || senderRecord.email.split('@')[0])
        : 'Someone';

      const preview = String(messagePreview || '').slice(0, 120);
      const convUrl = `https://grappletrade.web.app/messages.html?conv=${conversationId}`;

      await Promise.all([
        createNotification(recipientId, {
          icon: '💬',
          message: `New message from ${senderName}: "${preview}"`,
          link: `messages.html?conv=${conversationId}`,
        }),
        getUserEmail(recipientId).then(email => {
          if (!email) return;
          emails.init(sendgridSecret.value());
          return emails.sendMessageNotification(email, { senderName, messagePreview: preview, conversationUrl: convUrl });
        }),
      ]);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('notifyNewMessage error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- SELF DELETE ACCOUNT ---
// Lets an authenticated user permanently delete their own account.
// Uses Admin SDK to bypass the "requires-recent-login" client restriction.
exports.selfDeleteAccount = onRequest(
  { cors: ALLOWED_ORIGINS, maxInstances: 5 },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const uid = decodedToken.uid;
    try {
      // 1. Delete username reservation
      const usernameSnap = await db.collection('usernames').where('userId', '==', uid).get();
      if (!usernameSnap.empty) {
        const batch = db.batch();
        usernameSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      // 2. Delete Firestore user doc
      await db.collection('users').doc(uid).delete().catch(() => {});
      // 3. Delete Firebase Auth record (must be last — invalidates all tokens)
      await admin.auth().deleteUser(uid);

      console.log('selfDeleteAccount: deleted user', uid);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('selfDeleteAccount error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- GET PRICE SUGGESTIONS ---
// Returns recently sold prices for a given category so sellers can price competitively.
exports.getPriceSuggestions = onRequest(
  { cors: ALLOWED_ORIGINS, maxInstances: 20 },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    // Require auth — prevents unauthenticated scraping of sold price data
    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      await checkRateLimit(decodedToken.uid, 'priceSuggest', 30, ONE_HOUR);
    } catch (e) {
      return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
    }

    const category = String(req.query.category || '').trim().toLowerCase();
    if (!category) return res.status(400).json({ error: 'category is required' });

    try {
      const snap = await db.collection('products')
        .where('category', '==', category)
        .where('sold', '==', true)
        .orderBy('soldTimestamp', 'desc')
        .limit(20)
        .get();

      if (snap.empty) return res.status(200).json({ count: 0, min: null, max: null, avg: null });

      const prices = snap.docs.map(d => parseFloat(d.data().price || 0)).filter(p => p > 0);
      if (prices.length === 0) return res.status(200).json({ count: 0, min: null, max: null, avg: null });

      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const avg = prices.reduce((s, p) => s + p, 0) / prices.length;

      return res.status(200).json({ count: prices.length, min, max, avg: parseFloat(avg.toFixed(2)) });
    } catch (error) {
      console.error('getPriceSuggestions error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- RECORD ABANDONED CART ---
// Called from checkout.html when a user starts the checkout flow.
// A scheduled job later follows up if the purchase wasn't completed.
exports.recordAbandonedCart = onRequest(
  { cors: ALLOWED_ORIGINS, maxInstances: 20 },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId required' });

    try {
      const productSnap = await db.collection('products').doc(productId).get();
      if (!productSnap.exists || productSnap.data().sold) {
        return res.status(200).json({ skipped: 'product_sold_or_missing' });
      }
      const prod = productSnap.data();
      const docId = `${productId}_${decodedToken.uid}`;
      await db.collection('abandonedCarts').doc(docId).set({
        productId,
        userId: decodedToken.uid,
        productTitle: prod.title || null,
        productPrice: prod.price || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdTimestamp: Date.now(),
        emailSent: false,
      }, { merge: false });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('recordAbandonedCart error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- CHECK ABANDONED CARTS ---
// Runs every 6 hours. Sends a follow-up email for carts abandoned 24–48 hours ago.
exports.checkAbandonedCarts = onSchedule(
  { schedule: 'every 6 hours', secrets: [sendgridSecret], maxInstances: 1 },
  async () => {
    emails.init(sendgridSecret.value());
    const now = Date.now();
    const twentyFourHoursAgo = now - ONE_DAY;
    const fortyEightHoursAgo = now - (2 * ONE_DAY);

    const snap = await db.collection('abandonedCarts')
      .where('emailSent', '==', false)
      .where('createdTimestamp', '<=', twentyFourHoursAgo)
      .where('createdTimestamp', '>=', fortyEightHoursAgo)
      .get();

    console.log(`checkAbandonedCarts: ${snap.size} carts to follow up`);
    let sent = 0;
    for (const cartDoc of snap.docs) {
      const cart = cartDoc.data();
      try {
        // Check if item was already purchased
        const prodSnap = await db.collection('products').doc(cart.productId).get();
        if (!prodSnap.exists || prodSnap.data().sold) {
          await cartDoc.ref.delete();
          continue;
        }
        const buyerEmail = await getUserEmail(cart.userId);
        const productUrl = `https://grappletrade.web.app/productdetail.html?id=${cart.productId}`;
        await emails.sendAbandonedCart(buyerEmail, {
          productName: cart.productTitle || 'an item',
          productUrl,
          price: cart.productPrice || 0,
        });
        await cartDoc.ref.update({ emailSent: true, emailSentAt: admin.firestore.FieldValue.serverTimestamp() });
        sent++;
      } catch (e) {
        console.error('checkAbandonedCarts item error:', cartDoc.id, e.message);
      }
    }
    console.log(`checkAbandonedCarts: sent ${sent} follow-up emails`);
  }
);

// --- ESCROW AUTO-RELEASE ---
// Two-phase daily job:
//   Phase 1 (WARN):    Order approaching release threshold → email + notify buyer with 24h window to dispute
//   Phase 2 (RELEASE): Warning was sent 24h+ ago and no dispute filed → transfer funds to seller
//
// Release triggers (whichever comes first):
//   A. delivered=true  AND  3+ days have elapsed since delivery  (Shippo confirmed)
//   B. shipped=true    AND  21+ days have elapsed since shipping (time-based fallback)
//
// Hard blocks that permanently skip an order:
//   disputeOpened, refundRequested, autoReleaseBlocked, cancelled, sellerPaidOut, payoutInitiated
//
// Idempotency: Firestore transaction sets payoutInitiated=true before Stripe call.
//              Stripe idempotencyKey `payout_{productId}` deduplicates at the API level.
exports.autoReleaseOrders = onSchedule(
  { schedule: 'every 24 hours', secrets: [stripeSecret, sendgridSecret], maxInstances: 1 },
  async () => {
    const stripe = require('stripe')(stripeSecret.value());
    emails.init(sendgridSecret.value());

    const now = Date.now();
    const THREE_DAYS_MS    = 3  * 24 * 60 * 60 * 1000;
    const TWENTY_ONE_DAYS_MS = 21 * 24 * 60 * 60 * 1000;
    const ONE_DAY_MS       = 24 * 60 * 60 * 1000;
    const WARN_BEFORE_MS   = ONE_DAY_MS; // warn 24h before release fires

    // Helper: coerce Firestore Timestamp or epoch number to milliseconds
    function toMs(val) {
      if (!val) return 0;
      if (typeof val === 'number') return val;
      if (typeof val.toMillis === 'function') return val.toMillis();
      if (val._seconds != null) return val._seconds * 1000 + Math.floor((val._nanoseconds || 0) / 1e6);
      return 0;
    }

    // Find all candidates: sold + shipped + not paid out + not cancelled
    const snapshot = await db.collection('products')
      .where('sold', '==', true)
      .where('shipped', '==', true)
      .where('sellerPaidOut', '==', false)
      .where('cancelled', '==', false)
      .get();

    // Filter hard blocks in JS (Firestore can't compound-query boolean negations efficiently)
    const candidates = snapshot.docs.filter(doc => {
      const d = doc.data();
      return (
        !d.disputeOpened &&
        !d.refundRequested &&
        !d.autoReleaseBlocked &&
        !d.payoutInitiated &&
        d.sellerStripeAccountId &&
        d.sellerReceivesCents > 0
      );
    });

    console.log(`autoReleaseOrders: ${snapshot.size} sold+shipped, ${candidates.length} eligible candidates`);
    let warned = 0, released = 0, skipped = 0, errors = 0;

    for (const doc of candidates) {
      const productId = doc.id;
      const d = doc.data();

      try {
        const deliveredTs  = toMs(d.deliveredTimestamp) || toMs(d.deliveredAt);
        const shippedTs    = toMs(d.shippedTimestamp)   || toMs(d.shippedAt);
        const warningTs    = toMs(d.autoReleaseWarningTimestamp) || toMs(d.autoReleaseWarningAt);

        const isDelivered        = !!d.delivered;
        const msSinceDelivery    = isDelivered && deliveredTs ? now - deliveredTs : Infinity;
        const msSinceShipped     = shippedTs ? now - shippedTs : Infinity;

        // ── PHASE 2: RELEASE ────────────────────────────────────────────────
        // Warning was already sent AND 24h cooldown has elapsed
        if (d.autoReleaseWarned && warningTs && now - warningTs >= ONE_DAY_MS) {

          // Re-fetch for final hard-block check (buyer may have disputed in the window)
          const fresh = (await doc.ref.get()).data();
          if (
            fresh.disputeOpened   ||
            fresh.refundRequested ||
            fresh.autoReleaseBlocked ||
            fresh.sellerPaidOut   ||
            fresh.payoutInitiated ||
            fresh.cancelled
          ) {
            console.log(`autoRelease Phase 2 SKIPPED (blocked) — ${productId}`);
            skipped++;
            continue;
          }

          // Acquire payout lock inside a transaction
          let lockAcquired = false;
          try {
            await db.runTransaction(async (t) => {
              const snap = await t.get(doc.ref);
              const td = snap.data();
              if (
                td.sellerPaidOut   ||
                td.payoutInitiated ||
                td.disputeOpened   ||
                td.refundRequested ||
                td.autoReleaseBlocked ||
                td.cancelled
              ) {
                return; // another process beat us — skip
              }
              lockAcquired = true;
              t.update(doc.ref, { payoutInitiated: true });
            });
          } catch (txErr) {
            console.error(`autoRelease Phase 2 transaction error — ${productId}:`, txErr.message);
            errors++;
            continue;
          }

          if (!lockAcquired) {
            console.log(`autoRelease Phase 2 lock not acquired — ${productId}`);
            skipped++;
            continue;
          }

          // Verify seller account is still active before transferring
          try {
            const sellerAccount = await stripe.accounts.retrieve(d.sellerStripeAccountId);
            if (!sellerAccount.payouts_enabled) {
              await doc.ref.update({ payoutInitiated: false });
              console.error(`autoRelease Phase 2: seller payouts disabled — ${productId}`);
              const adminEmail = 'support@grappletrade.com';
              await emails.sendAutoReleaseFailedAdmin(adminEmail, {
                productId,
                productName: d.title || 'unknown',
                errorMessage: 'Seller payouts_enabled=false. Manual payout required.',
              }).catch(() => {});
              errors++;
              continue;
            }
          } catch (acctErr) {
            await doc.ref.update({ payoutInitiated: false }).catch(() => {});
            console.error(`autoRelease Phase 2: could not verify seller account — ${productId}:`, acctErr.message);
            errors++;
            continue;
          }

          // Execute the Stripe transfer
          try {
            const transfer = await stripe.transfers.create({
              amount: d.sellerReceivesCents,
              currency: 'usd',
              destination: d.sellerStripeAccountId,
              transfer_group: d.soldOrderId,
              metadata: { productId, reason: 'auto_release', triggeredBy: 'system' },
            }, {
              idempotencyKey: `payout_${productId}`,
            });

            const nowTs = admin.firestore.FieldValue.serverTimestamp();
            await doc.ref.update({
              sellerPayoutTransferId: transfer.id,
              sellerPaidOut: true,
              sellerPaidOutAt: nowTs,
              payoutInitiated: false,
              delivered: true,
              deliveredAt: nowTs,
              deliveredTimestamp: Date.now(),
              autoReleasedAt: nowTs,
              autoReleaseCompleted: true,
            });

            // Sync orders collection
            try {
              const ordSnap = await db.collection('orders').where('productId', '==', productId).limit(1).get();
              if (!ordSnap.empty) {
                await ordSnap.docs[0].ref.update({
                  delivered: true,
                  deliveredAt: nowTs,
                  autoReleasedAt: nowTs,
                  status: 'completed',
                });
              }
            } catch (ordErr) {
              console.error(`autoRelease orders sync error — ${productId}:`, ordErr.message);
            }

            // In-app notifications (idempotency keys prevent duplicates on scheduler retries)
            await Promise.all([
              createNotification(d.userId, {
                icon: '💰',
                message: `Payment for "${d.title || 'your item'}" has been released. Check your Stripe dashboard.`,
                link: 'listings-manager.html',
              }, `${productId}_autorelease_seller`),
              createNotification(d.buyerId, {
                icon: '✅',
                message: `Your order for "${d.title || 'your item'}" has been automatically completed.`,
                link: 'my-orders.html',
              }, `${productId}_autorelease_buyer`),
            ]);

            // Emails
            const [sellerEmail, buyerEmail] = await Promise.all([
              getUserEmail(d.userId),
              getUserEmail(d.buyerId),
            ]);
            await Promise.all([
              emails.sendAutoReleasedSeller(sellerEmail, {
                productName: d.title || 'your item',
                amountDollars: (d.sellerReceivesCents / 100).toFixed(2),
              }),
              emails.sendAutoReleasedBuyer(buyerEmail, {
                productName: d.title || 'your item',
              }),
            ]);

            console.log(`autoRelease Phase 2 SUCCESS — ${productId} transfer ${transfer.id}`);
            released++;

          } catch (payoutErr) {
            // Clear lock so scheduler can retry on next run
            await doc.ref.update({ payoutInitiated: false }).catch(() => {});
            console.error(`autoRelease Phase 2 payout FAILED — ${productId}:`, payoutErr.message);
            const adminEmail = 'support@grappletrade.com';
            await emails.sendAutoReleaseFailedAdmin(adminEmail, {
              productId,
              productName: d.title || 'unknown',
              errorMessage: payoutErr.message,
            }).catch(() => {});
            errors++;
          }

          continue; // done with this doc regardless of outcome
        }

        // ── PHASE 1: WARN ────────────────────────────────────────────────────
        // Skip if warning already sent (even if 24h hasn't elapsed yet — let Phase 2 handle it)
        if (d.autoReleaseWarned) { skipped++; continue; }

        // Check if order is within 24h of either release threshold
        const approachingDeliveryRelease = isDelivered  && msSinceDelivery  >= (THREE_DAYS_MS    - WARN_BEFORE_MS);
        const approachingShippedRelease  = !isDelivered && msSinceShipped   >= (TWENTY_ONE_DAYS_MS - WARN_BEFORE_MS);

        if (!approachingDeliveryRelease && !approachingShippedRelease) {
          skipped++;
          continue;
        }

        // Send 24h warning
        await doc.ref.update({
          autoReleaseWarned: true,
          autoReleaseWarningAt: admin.firestore.FieldValue.serverTimestamp(),
          autoReleaseWarningTimestamp: now,
        });

        const buyerEmail = await getUserEmail(d.buyerId);
        await emails.sendAutoReleaseWarning(buyerEmail, {
          productName: d.title || 'your item',
          hoursRemaining: 24,
          productUrl: 'https://grappletrade.web.app/my-orders.html',
        });

        await createNotification(d.buyerId, {
          icon: '⏰',
          message: `Your order for "${d.title || 'your item'}" will auto-complete in 24 hours. Report a problem now if needed.`,
          link: 'my-orders.html',
        }, `${productId}_autorelease_warning`);

        console.log(`autoRelease Phase 1 WARNING sent — ${productId}`);
        warned++;

      } catch (err) {
        console.error(`autoReleaseOrders unexpected error — ${productId}:`, err.message);
        errors++;
      }
    }

    console.log(`autoReleaseOrders complete — warned:${warned} released:${released} skipped:${skipped} errors:${errors}`);
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
