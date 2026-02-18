const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const Shippo = require('shippo');

const stripeSecret = defineSecret('STRIPE_SKEY');
const shippoSecret = defineSecret('SHIPPO_API_KEY');

// --- STRIPE PAYMENT INTENT ---
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
      const {amount, currency = 'usd'} = req.body;

      if (!amount) {
        return res.status(400).json({error: 'Amount is required'});
      }

      console.log('Creating payment intent for amount:', amount, 'currency:', currency);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: currency,
        automatic_payment_methods: { enabled: true },
      });

      console.log('Payment intent created:', paymentIntent.id);
      console.log('Client secret length:', paymentIntent.client_secret.length);
      console.log('Client secret starts with:', paymentIntent.client_secret.substring(0, 30));
      console.log('Client secret ends with:', paymentIntent.client_secret.substring(paymentIntent.client_secret.length - 30));

      // Set CORS headers explicitly
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'application/json');

      return res.status(200).json({
        clientSecret: paymentIntent.client_secret,
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
    // 1. Handle CORS preflight (prevents the HTML/DOCTYPE error)
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.status(204).send('');
      return;
    }

    // 2. Only allow POST
    if (req.method !== 'POST') {
      return res.status(405).json({error: 'Method Not Allowed'});
    }

    try {
      const shippoKey = shippoSecret.value();
      
      // 3. Robust Shippo Init (Handles different SDK versions)
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
          street1: "123 Main St", // Standard placeholder for rate calculation
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


// Initialize admin if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}

// Create a Stripe Connect account for sellers
exports.createConnectedAccount = functions.https.onRequest(async (req, res) => {
    // Enable CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        const { userId, email, returnUrl, refreshUrl } = req.body;

        if (!userId || !email) {
            return res.status(400).json({ error: 'Missing userId or email' });
        }

        console.log('Creating Stripe Connect account for user:', userId);

        // Check if user already has a Stripe account
        const userDoc = await admin.firestore().collection('users').doc(userId).get();
        let stripeAccountId;

        if (userDoc.exists() && userDoc.data().stripeAccountId) {
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
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        // Create an account link for onboarding
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
});

// Check if seller has completed onboarding
exports.checkSellerStatus = functions.https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }

        // Get user's Stripe account ID from Firestore
        const userDoc = await admin.firestore().collection('users').doc(userId).get();
        
        if (!userDoc.exists() || !userDoc.data().stripeAccountId) {
            return res.json({ 
                connected: false,
                chargesEnabled: false,
                detailsSubmitted: false
            });
        }

        const stripeAccountId = userDoc.data().stripeAccountId;

        // Check the account status with Stripe
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
});