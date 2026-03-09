const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');
const Shippo = require('shippo');

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp();
}

const stripeSecret = defineSecret('STRIPE_SKEY');
const shippoSecret = defineSecret('SHIPPO_API_KEY');

// Platform fee percentage (10%)
const PLATFORM_FEE_PERCENT = 0.10;

// --- STRIPE PAYMENT INTENT WITH CONNECT ---
exports.createPaymentIntent = onRequest(
  {
    secrets: [stripeSecret],
    cors: true,
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Origin', '*');
      return res.status(204).send('');
    }

    try {
      console.log('Request method:', req.method);
      console.log('Request body:', req.body);

      const stripe = require('stripe')(stripeSecret.value());
      const {currency = 'usd', productId, shippingCost = 0} = req.body;
      // Never trust sellerStripeAccountId from the frontend — look it up server-side

      if (!productId) {
        return res.status(400).json({error: 'productId is required'});
      }

      // --- SERVER-SIDE PRICE VALIDATION ---
      // Never trust amounts from the frontend. Fetch the real price from Firestore.
      const productDoc = await admin.firestore().collection('products').doc(productId).get();
      if (!productDoc.exists) {
        return res.status(404).json({error: 'Product not found'});
      }
      const productData = productDoc.data();
      if (productData.sold) {
        return res.status(400).json({error: 'This item has already been sold'});
      }

      const productPriceInCents = Math.round((productData.price || 0) * 100);
      const shippingInCents = Math.max(0, Math.round((shippingCost || 0) * 100));
      const taxInCents = Math.round(productPriceInCents * 0.08);
      const amount = productPriceInCents + shippingInCents + taxInCents;

      // Look up the seller's Stripe account from Firestore — never trust the frontend
      let sellerStripeAccountId = null;
      const sellerUserId = productData.userId;
      if (sellerUserId) {
        const sellerDoc = await admin.firestore().collection('users').doc(sellerUserId).get();
        if (sellerDoc.exists && sellerDoc.data().stripeAccountId) {
          sellerStripeAccountId = sellerDoc.data().stripeAccountId;
        }
      }

      console.log('Server-verified payment breakdown:');
      console.log('  Product (from Firestore):', productPriceInCents, 'cents');
      console.log('  Shipping:', shippingInCents, 'cents');
      console.log('  Tax:', taxInCents, 'cents');
      console.log('  Total:', amount, 'cents');
      console.log('Seller Stripe Account ID (from Firestore):', sellerStripeAccountId);

      // Build payment intent options
      const paymentIntentOptions = {
        amount: amount,
        currency: currency,
        automatic_payment_methods: { enabled: true },
        // Always store productId so completeOrder can verify it server-side
        metadata: { productId },
      };

      // If seller has a connected Stripe account, use destination charges
      if (sellerStripeAccountId) {
        // Calculate platform fee (10% of the total amount)
        const applicationFeeAmount = Math.round(amount * PLATFORM_FEE_PERCENT);

        console.log('Using Stripe Connect - destination charge');
        console.log('Application fee (platform):', applicationFeeAmount);
        console.log('Seller receives:', amount - applicationFeeAmount);

        // Add Stripe Connect parameters
        paymentIntentOptions.application_fee_amount = applicationFeeAmount;
        paymentIntentOptions.transfer_data = {
          destination: sellerStripeAccountId,
        };

        // Add metadata for tracking
        paymentIntentOptions.metadata = {
          productId: productId || 'unknown',
          sellerAccountId: sellerStripeAccountId,
          platformFee: applicationFeeAmount,
        };
      } else {
        console.log('No seller Stripe account - payment goes to platform');
      }

      const paymentIntent = await stripe.paymentIntents.create(paymentIntentOptions);

      console.log('Payment intent created:', paymentIntent.id);

      // Set CORS headers explicitly
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'application/json');

      return res.status(200).json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        platformFee: sellerStripeAccountId ? Math.round(amount * PLATFORM_FEE_PERCENT) : 0,
      });
    } catch (error) {
      console.error('Stripe Error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- SHIPPO SHIPPING RATES ---
exports.shippingRates = onRequest(
  {
    secrets: [shippoSecret],
    cors: true,
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.status(204).send('');
      return;
    }

    // Only allow POST
    if (req.method !== 'POST') {
      return res.status(405).json({error: 'Method Not Allowed'});
    }

    try {
      const shippoKey = shippoSecret.value();

      // Robust Shippo Init (Handles different SDK versions)
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

// --- CREATE STRIPE CONNECT ACCOUNT FOR SELLERS ---
exports.createConnectedAccount = onRequest(
  {
    secrets: [stripeSecret],
    cors: true,
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Origin', '*');
      res.status(204).send('');
      return;
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const { userId, email, returnUrl, refreshUrl } = req.body;

      if (!userId || !email) {
        return res.status(400).json({ error: 'Missing userId or email' });
      }

      console.log('Creating Stripe Connect account for user:', userId);

      // Check if user already has a Stripe account
      const userDoc = await admin.firestore().collection('users').doc(userId).get();
      let stripeAccountId;

      if (userDoc.exists && userDoc.data().stripeAccountId) {
        // User already has an account, just create a new account link
        stripeAccountId = userDoc.data().stripeAccountId;
        console.log('User already has Stripe account:', stripeAccountId);
      } else {
        // Create a new Stripe Connect Express account
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

        // Save the Stripe account ID to Firestore
        await admin.firestore().collection('users').doc(userId).set({
          stripeAccountId: stripeAccountId,
          email: email,
          stripeCreatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      // Create an account link for onboarding
      const accountLink = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: refreshUrl || 'https://wrestleswap.web.app/stripe-express-prompt.html',
        return_url: returnUrl || 'https://wrestleswap.web.app/profile.html?stripe=success',
        type: 'account_onboarding',
      });

      console.log('Account link created:', accountLink.url);

      res.set('Access-Control-Allow-Origin', '*');
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

// --- CHECK SELLER STRIPE STATUS ---
exports.checkSellerStatus = onRequest(
  {
    secrets: [stripeSecret],
    cors: true,
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Origin', '*');
      res.status(204).send('');
      return;
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
      }

      // Get user's Stripe account ID from Firestore
      const userDoc = await admin.firestore().collection('users').doc(userId).get();

      if (!userDoc.exists || !userDoc.data().stripeAccountId) {
        res.set('Access-Control-Allow-Origin', '*');
        return res.json({
          connected: false,
          chargesEnabled: false,
          detailsSubmitted: false
        });
      }

      const stripeAccountId = userDoc.data().stripeAccountId;

      // Check the account status with Stripe
      const account = await stripe.accounts.retrieve(stripeAccountId);

      res.set('Access-Control-Allow-Origin', '*');
      res.json({
        connected: true,
        chargesEnabled: account.charges_enabled,
        detailsSubmitted: account.details_submitted,
        payoutsEnabled: account.payouts_enabled,
        stripeAccountId: stripeAccountId
      });

    } catch (error) {
      console.error('Error checking seller status:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// --- GET SELLER STRIPE ACCOUNT ID ---
exports.getSellerStripeAccount = onRequest(
  {
    cors: true,
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Origin', '*');
      res.status(204).send('');
      return;
    }

    try {
      const { sellerId } = req.body;

      if (!sellerId) {
        return res.status(400).json({ error: 'Missing sellerId' });
      }

      // Get seller's Stripe account ID from Firestore
      const userDoc = await admin.firestore().collection('users').doc(sellerId).get();

      res.set('Access-Control-Allow-Origin', '*');

      if (!userDoc.exists || !userDoc.data().stripeAccountId) {
        return res.json({
          hasStripeAccount: false,
          stripeAccountId: null
        });
      }

      return res.json({
        hasStripeAccount: true,
        stripeAccountId: userDoc.data().stripeAccountId
      });

    } catch (error) {
      console.error('Error getting seller Stripe account:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// --- COMPLETE ORDER (mark product sold after verified payment) ---
exports.completeOrder = onRequest(
  {
    secrets: [stripeSecret],
    cors: true,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Origin', '*');
      return res.status(204).send('');
    }

    res.set('Access-Control-Allow-Origin', '*');

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

      // Verify the payment actually succeeded with Stripe
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Payment has not succeeded' });
      }

      // Verify the payment intent is for this product
      if (paymentIntent.metadata.productId !== productId) {
        return res.status(403).json({ error: 'Payment does not match this product' });
      }

      // Build the update, storing buyerId so cancelOrder can verify ownership later
      const updateData = {
        sold: true,
        soldAt: admin.firestore.FieldValue.serverTimestamp(),
        soldTimestamp: Date.now(),
        soldOrderId: paymentIntentId,
        buyerId: decodedToken.uid,
      };

      if (shippingInfo) {
        updateData.shippingLabel = shippingInfo.label_url || null;
        updateData.trackingNumber = shippingInfo.tracking_number || null;
        updateData.trackingUrl = shippingInfo.tracking_url_provider || null;
      }

      if (packageDimensions) {
        updateData.packageDimensions = packageDimensions;
      }

      await admin.firestore().collection('products').doc(productId).update(updateData);

      console.log('Product marked as sold:', productId, 'by buyer:', decodedToken.uid);
      return res.status(200).json({ success: true });

    } catch (error) {
      console.error('completeOrder error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// --- CANCEL ORDER (refund + mark cancelled, verified ownership) ---
exports.cancelOrder = onRequest(
  {
    secrets: [stripeSecret],
    cors: true,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Origin', '*');
      return res.status(204).send('');
    }

    res.set('Access-Control-Allow-Origin', '*');

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
      const { paymentIntentId, productId } = req.body;

      if (!paymentIntentId || !productId) {
        return res.status(400).json({ error: 'paymentIntentId and productId are required' });
      }

      // Fetch product and verify the caller is the buyer
      const productDoc = await admin.firestore().collection('products').doc(productId).get();
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

      // Verify the payment intent belongs to this product
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.metadata.productId !== productId) {
        return res.status(403).json({ error: 'Payment intent does not match this product' });
      }

      // Process the refund
      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        reason: 'requested_by_customer',
      });

      // Update product in Firestore via Admin SDK
      await admin.firestore().collection('products').doc(productId).update({
        cancelled: true,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledTimestamp: Date.now(),
        refundId: refund.id,
        refundAmount: refund.amount,
      });

      console.log('Order cancelled:', productId, 'refund:', refund.id);
      return res.status(200).json({
        success: true,
        refundId: refund.id,
        refundAmount: refund.amount,
        message: 'Order cancelled. Refund will be processed within 5-7 business days.',
      });

    } catch (error) {
      console.error('cancelOrder error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);
