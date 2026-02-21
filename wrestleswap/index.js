const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

// Define secrets
const stripeSecret = defineSecret("STRIPE_SKEY");
const shippoSecret = defineSecret("SHIPPO_API_KEY");
// const recaptchaApiKey = defineSecret("RECAPTCHA_API_KEY"); // Uncomment after setting secret

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
      const {
        amount,  // Total amount (product + shipping + tax) in cents
        productAmount = 0,  // Product price only in cents
        shippingAmount = 0,  // Shipping cost in cents
        taxAmount = 0,  // Tax in cents
        currency = 'usd',
        sellerStripeAccountId,
        productId
      } = req.body;

      if (!amount) {
        return res.status(400).json({ error: 'Amount is required' });
      }

      console.log('Creating payment intent:');
      console.log('  Total amount:', amount);
      console.log('  Product amount:', productAmount);
      console.log('  Shipping amount:', shippingAmount);
      console.log('  Tax amount:', taxAmount);
      console.log('  Seller Stripe Account ID:', sellerStripeAccountId);

      // Build payment intent options
      const paymentIntentOptions = {
        amount: amount,
        currency: currency,
        automatic_payment_methods: { enabled: true },
      };

      // If seller has a connected Stripe account, use destination charges
      if (sellerStripeAccountId && productAmount > 0) {
        // Platform keeps:
        // 1. 10% of product price (platform fee)
        // 2. 100% of shipping (to pay for labels)
        // 3. Tax (collected for the platform)

        const platformFeeOnProduct = Math.round(productAmount * PLATFORM_FEE_PERCENT);
        const sellerReceives = productAmount - platformFeeOnProduct;

        // Application fee = total amount - what seller receives
        // This includes: platform fee + shipping + tax
        const applicationFeeAmount = amount - sellerReceives;

        console.log('Using Stripe Connect - destination charge');
        console.log('  Platform fee (10% of product):', platformFeeOnProduct);
        console.log('  Shipping (kept by platform):', shippingAmount);
        console.log('  Tax (kept by platform):', taxAmount);
        console.log('  Total application fee:', applicationFeeAmount);
        console.log('  Seller receives:', sellerReceives);

        // Add Stripe Connect parameters
        paymentIntentOptions.application_fee_amount = applicationFeeAmount;
        paymentIntentOptions.transfer_data = {
          destination: sellerStripeAccountId,
        };

        // Add metadata for tracking
        paymentIntentOptions.metadata = {
          productId: productId || 'unknown',
          sellerAccountId: sellerStripeAccountId,
          productAmount: productAmount,
          shippingAmount: shippingAmount,
          taxAmount: taxAmount,
          platformFee: platformFeeOnProduct,
          sellerReceives: sellerReceives,
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
  { cors: true, secrets: [stripeSecret, shippoSecret] },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const {
        paymentIntentId,
        productId,
        reason = 'requested_by_customer',
        cancelledBy = 'buyer', // 'buyer' or 'seller'
        shippoTransactionId = null
      } = req.body;

      if (!paymentIntentId) {
        return res.status(400).json({ error: 'Payment Intent ID is required' });
      }

      console.log('Processing cancellation:');
      console.log('  Payment Intent:', paymentIntentId);
      console.log('  Product ID:', productId);
      console.log('  Cancelled by:', cancelledBy);
      console.log('  Reason:', reason);

      // Get the payment intent to find the charge
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (!paymentIntent.latest_charge) {
        return res.status(400).json({ error: 'No charge found for this payment' });
      }

      const chargeId = paymentIntent.latest_charge;
      const originalAmount = paymentIntent.amount;

      // Calculate 5% cancellation fee
      const cancellationFee = Math.round(originalAmount * CANCELLATION_FEE_PERCENT);
      const refundAmount = originalAmount - cancellationFee;

      console.log('  Original amount:', originalAmount);
      console.log('  Cancellation fee (5%):', cancellationFee);
      console.log('  Refund amount:', refundAmount);

      // Create partial refund (minus 5% cancellation fee)
      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: refundAmount,
        reason: reason,
        metadata: {
          productId: productId || 'unknown',
          cancelledBy: cancelledBy,
          cancellationFee: cancellationFee,
          originalAmount: originalAmount
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
            headers: {
              'Authorization': `ShippoToken ${shippoKey}`,
            }
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
      if (productId) {
        try {
          await db.collection('products').doc(productId).update({
            sold: false,
            soldAt: null,
            soldTimestamp: null,
            soldOrderId: null,
            cancelledAt: new Date(),
            cancelledBy: cancelledBy,
            cancellationReason: reason,
            refundId: refund.id
          });
          console.log('Product status updated - marked as available');
        } catch (dbError) {
          console.error('Error updating product status:', dbError);
        }
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

    try {
      const stripe = require('stripe')(stripeSecret.value());
      const { userId, email, returnUrl, refreshUrl } = req.body;

      if (!userId || !email) {
        return res.status(400).json({ error: 'Missing userId or email' });
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
      const { rateObjectId, labelFileType = 'PDF', async = false } = req.body;

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
