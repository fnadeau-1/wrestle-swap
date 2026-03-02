const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

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
const sendgridSecret = defineSecret("SENDGRID_API_KEY");
// const recaptchaApiKey = defineSecret("RECAPTCHA_API_KEY"); // Uncomment after setting secret

const emails = require('./emails');

// --- DELETE SOLD PRODUCTS ---
exports.deleteSoldProducts = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);

    const snapshot = await db.collection("products")
      .where("sold", "==", true)
      .where("soldTimestamp", "<=", ninetyDaysAgo)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        deletedCount: 0,
      });
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    return res.status(200).json({
      success: true,
      deletedCount: snapshot.size,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Platform fee percentage (10% of product price only)
const PLATFORM_FEE_PERCENT = 0.10;

// Number of seller cancellations before account is suspended
const SELLER_STRIKES_LIMIT = 3;

// --- STRIPE PAYMENT INTENT WITH CONNECT ---
// Shipping costs go to platform, product price (minus 10% fee) goes to seller
exports.createPaymentIntent = onRequest(
  { cors: true, secrets: [stripeSecret] },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      // Never trust amounts or sellerStripeAccountId from the frontend
      const { currency = 'usd', productId, shippingCost = 0 } = req.body;

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

      const productPriceInCents = Math.round((productData.price || 0) * 100);
      const shippingInCents = Math.max(0, Math.round((shippingCost || 0) * 100));
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

      if (sellerStripeAccountId && productPriceInCents > 0) {
        const platformFeeOnProduct = Math.round(productPriceInCents * PLATFORM_FEE_PERCENT);
        const sellerReceives = productPriceInCents - platformFeeOnProduct;
        const applicationFeeAmount = amount - sellerReceives;

        console.log('Using Stripe Connect - destination charge');
        console.log('  Platform fee (10% of product):', platformFeeOnProduct);
        console.log('  Total application fee:', applicationFeeAmount);
        console.log('  Seller receives:', sellerReceives);

        paymentIntentOptions.application_fee_amount = applicationFeeAmount;
        paymentIntentOptions.transfer_data = { destination: sellerStripeAccountId };
        paymentIntentOptions.metadata = {
          productId,
          sellerAccountId: sellerStripeAccountId,
          platformFee: platformFeeOnProduct,
          sellerReceives,
        };
      } else {
        console.log('No seller Stripe account - payment goes to platform');
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
  { cors: true, secrets: [stripeSecret, shippoSecret, sendgridSecret] },
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

      // Calculate 5% cancellation fee
      const cancellationFee = Math.round(originalAmount * CANCELLATION_FEE_PERCENT);
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

      // Update product status in Firestore
      await db.collection('products').doc(productId).update({
        sold: false,
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
      console.log('Product status updated - marked as available');

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
  { cors: true, secrets: [shippoSecret] },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
      const Shippo = require('shippo');
      const shippoKey = shippoSecret.value();

      const shippoClient = (typeof Shippo === 'function')
        ? Shippo(shippoKey)
        : new Shippo.Shippo(shippoKey);

      const { zipCode, senderAddress } = req.body;

      if (!zipCode || !senderAddress) {
        return res.status(400).json({ error: 'Missing zipCode or senderAddress' });
      }

      const shipment = await shippoClient.shipment.create({
        address_from: {
          name: senderAddress.name || "Seller",
          street1: senderAddress.street1,
          city: senderAddress.city,
          state: senderAddress.state,
          zip: senderAddress.zip,
          country: senderAddress.country || "US"
        },
        address_to: {
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
          distance_unit: "in",
          weight: senderAddress.parcel?.weight || "2",
          mass_unit: "lb"
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
  { cors: true, secrets: [stripeSecret] },
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
        refresh_url: refreshUrl || 'https://yourwebsite.com/seller-onboarding.html',
        return_url: returnUrl || 'https://yourwebsite.com/seller-dashboard.html',
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
  { cors: true, secrets: [shippoSecret] },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
      const shippoKey = shippoSecret.value();
      const { addressFrom, addressTo, parcel } = req.body;

      if (!addressFrom || !addressTo || !parcel) {
        return res.status(400).json({ error: 'Missing addressFrom, addressTo, or parcel' });
      }

      // Create shipment data for Shippo API
      const shipmentData = {
        address_from: addressFrom,
        address_to: addressTo,
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
  { cors: true, secrets: [shippoSecret, sendgridSecret] },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
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

      // Email buyer with tracking info if we have a productId and a tracking number
      if (labelProductId && transaction.tracking_number) {
        try {
          emails.init(sendgridSecret.value());
          const prodDoc = await db.collection('products').doc(labelProductId).get();
          if (prodDoc.exists) {
            const prod = prodDoc.data();
            const buyerEmail = await getUserEmail(prod.buyerId);
            await emails.sendTrackingToBuyer(buyerEmail, {
              productName: prod.title || 'your item',
              trackingNumber: transaction.tracking_number,
              trackingUrl: transaction.tracking_url_provider || null,
              carrier: transaction.servicelevel?.name || null,
            });
          }
        } catch (emailErr) {
          console.error('Email error (shippoCreateLabel):', emailErr.message);
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
  { cors: true, secrets: [stripeSecret] },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
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
  { cors: true, secrets: [recaptchaApiKey] },
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
  { cors: true, secrets: [stripeSecret, sendgridSecret] },
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
      const stripe = require('stripe')(stripeSecret.value());
      const { paymentIntentId, productId, shippingInfo, packageDimensions } = req.body;

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

      const updateData = {
        sold: true,
        soldAt: admin.firestore.FieldValue.serverTimestamp(),
        soldTimestamp: Date.now(),
        soldOrderId: paymentIntentId,
        buyerId: decodedToken.uid,  // Store for ownership checks (e.g. cancelOrder)
      };

      if (shippingInfo) {
        updateData.shippingLabel = shippingInfo.label_url || null;
        updateData.trackingNumber = shippingInfo.tracking_number || null;
        updateData.trackingUrl = shippingInfo.tracking_url_provider || null;
      }

      if (packageDimensions) {
        updateData.packageDimensions = packageDimensions;
      }

      await db.collection('products').doc(productId).update(updateData);
      console.log('Order completed — product:', productId, 'buyer:', decodedToken.uid);

      // Email seller: new order notification
      try {
        emails.init(sendgridSecret.value());
        const freshProduct = await db.collection('products').doc(productId).get();
        const prod = freshProduct.data();
        const sellerEmail = await getUserEmail(prod.userId);
        const buyerRecord = await admin.auth().getUser(decodedToken.uid);
        const buyerName = buyerRecord.displayName || buyerRecord.email.split('@')[0];
        await emails.sendOrderPlacedSeller(sellerEmail, {
          productName: prod.title || 'your item',
          buyerName,
        });
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
  { cors: true, secrets: [stripeSecret, sendgridSecret] },
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

      // Full refund to buyer — seller is at fault, buyer pays nothing
      const refundOptions = {
        charge: paymentIntent.latest_charge,
        reason: 'requested_by_customer',
        metadata: { productId, cancelledBy: 'seller', sellerUid: decodedToken.uid }
      };
      // Attempt to reverse the transfer so the platform isn't out of pocket.
      // If the seller already paid out, reverse_transfer fails — fall back to platform-funded refund.
      if (paymentIntent.transfer_data && paymentIntent.transfer_data.destination) {
        refundOptions.reverse_transfer = true;
      }
      let refund;
      try {
        refund = await stripe.refunds.create(refundOptions);
      } catch (stripeErr) {
        if (refundOptions.reverse_transfer && stripeErr.code === 'insufficient_funds') {
          console.warn('reverse_transfer failed (seller paid out) — refunding from platform balance');
          delete refundOptions.reverse_transfer;
          refund = await stripe.refunds.create(refundOptions);
        } else {
          throw stripeErr;
        }
      }
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

      // Mark product as cancelled and re-listed (available again)
      await db.collection('products').doc(productId).update({
        sold: false,
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

      const message = suspended
        ? `Order cancelled. The buyer has been fully refunded. You have reached ${SELLER_STRIKES_LIMIT} cancellations and your selling privileges have been suspended.`
        : `Order cancelled. The buyer has been fully refunded. Strike ${newCount} of ${SELLER_STRIKES_LIMIT} — you have ${strikesRemaining} strike${strikesRemaining !== 1 ? 's' : ''} remaining before you can no longer sell.`;

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

// --- CHECK OVERDUE ORDERS (runs daily — auto-cancels unshipped orders older than 14 days) ---
// Note: requires a Firestore composite index on (sold ASC, soldTimestamp ASC)
exports.checkOverdueOrders = onSchedule(
  { schedule: 'every 24 hours', secrets: [stripeSecret, sendgridSecret] },
  async (event) => {
    const stripe = require('stripe')(stripeSecret.value());
    const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);

    console.log('Overdue order check — cutoff:', new Date(fourteenDaysAgo).toISOString());

    const snapshot = await db.collection('products')
      .where('sold', '==', true)
      .where('soldTimestamp', '<=', fourteenDaysAgo)
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
            const refundOptions = {
              charge: paymentIntent.latest_charge,
              reason: 'requested_by_customer',
              metadata: { productId, cancelledBy: 'system', reason: 'seller_failed_to_ship' }
            };
            if (paymentIntent.transfer_data && paymentIntent.transfer_data.destination) {
              refundOptions.reverse_transfer = true;
            }
            let refund;
            try {
              refund = await stripe.refunds.create(refundOptions);
            } catch (stripeErr) {
              if (refundOptions.reverse_transfer && stripeErr.code === 'insufficient_funds') {
                console.warn(`Product ${productId}: reverse_transfer failed, refunding from platform balance`);
                delete refundOptions.reverse_transfer;
                refund = await stripe.refunds.create(refundOptions);
              } else {
                throw stripeErr;
              }
            }
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

        // Mark product cancelled
        await db.collection('products').doc(productId).update({
          sold: false,
          soldAt: null,
          soldTimestamp: null,
          soldOrderId: null,
          buyerId: null,
          cancelled: true,
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancelledBy: 'system',
          cancellationReason: 'Seller failed to ship within 14 days',
          ...(refundId ? { refundId } : {})
        });

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
