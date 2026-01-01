const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');

const stripeSecret = defineSecret('sk_test_51SVkt7GuAs8IZaZvjdAQYRqZCr54I15ShQECC2ep1n2XoZejZQ2geOcEM0rrmdeEg7gnHhfzFJVntxt3syhuElUL00JVKsY5ZI');

exports.createPaymentIntent = onRequest(
  {
    secrets: [stripeSecret],
    cors: true,
  },
  async (req, res) => {
    // Log the entire request for debugging
    console.log('Request method:', req.method);
    console.log('Request body:', JSON.stringify(req.body));

    try {
      // Check if Stripe key exists
      const stripeKey = stripeSecret.value();
      if (!stripeKey) {
        console.error('Stripe secret key is missing!');
        return res.status(500).json({error: 'Server configuration error'});
      }

      console.log('Stripe key exists, length:', stripeKey.length);

      // Initialize Stripe
      const stripe = require('stripe')(stripeKey);
      console.log('Stripe initialized successfully');

      const {amount, currency = 'usd'} = req.body;

      console.log('Creating payment intent for amount:', amount, 'currency:', currency);

      // Create PaymentIntent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: currency,
        automatic_payment_methods: {
          enabled: true,
        },
      });

      console.log('Payment intent created successfully:', paymentIntent.id);
      console.log('Client secret:', paymentIntent.client_secret.substring(0, 20) + '...');

      // Return the client secret
      return res.status(200).json({
        clientSecret: paymentIntent.client_secret,
      });
    } catch (error) {
      console.error('ERROR creating payment intent:');
      console.error('Error message:', error.message);
      console.error('Error type:', error.type);
      console.error('Full error:', JSON.stringify(error));
      
      return res.status(500).json({
        error: error.message || 'Failed to create payment intent',
      });
    }
  }
);