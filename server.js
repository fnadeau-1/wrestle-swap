// server.js - Backend server to generate Stripe Express onboarding links
// This needs to run on a server (Node.js) for security reasons

const express = require('express');
const stripe = require('stripe')('sk_test_51SVkt7GuAs8IZaZvjdAQYRqZCr54I15ShQECC2ep1n2XoZejZQ2geOcEM0rrmdeEg7gnHhfzFJVntxt3syhuElUL00JVKsY5ZI');
const cors = require('cors');

const app = express();
app.use(cors()); // Allow requests from your HTML page
app.use(express.json());

// STEP 1: Create a new Stripe Express account for a seller
app.post('/create-connect-account', async (req, res) => {
  try {
    // Create a new Express account
    const account = await stripe.accounts.create({
      type: 'express',
      // Optional: You can add seller email here if you collect it first
      // email: req.body.email,
    });

    console.log('Created account:', account.id);
    res.json({ accountId: account.id });
  } catch (error) {
    console.error('Error creating account:', error);
    res.status(500).json({ error: error.message });
  }
});

// STEP 2: Generate the onboarding link for the seller
app.post('/create-account-link', async (req, res) => {
  try {
    const { accountId } = req.body;

    // Create an account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'http://localhost:3000/reauth', // Where they go if link expires
      return_url: 'http://localhost:3000/success', // Where they go after completing onboarding
      type: 'account_onboarding',
    });

    console.log('Created onboarding link:', accountLink.url);
    res.json({ url: accountLink.url });
  } catch (error) {
    console.error('Error creating account link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Simple success page
app.get('/success', (req, res) => {
  res.send(`
    <html>
      <head><title>Success!</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>✅ Account Setup Complete!</h1>
        <p>Your Stripe Express account has been successfully created.</p>
        <p>You can now start selling on our platform!</p>
        <a href="/" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background: #635bff; color: white; text-decoration: none; border-radius: 6px;">Return to Dashboard</a>
      </body>
    </html>
  `);
});

// Reauth page if link expires
app.get('/reauth', (req, res) => {
  res.send(`
    <html>
      <head><title>Link Expired</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>⚠️ Link Expired</h1>
        <p>Your onboarding link has expired. Please request a new one.</p>
        <a href="/" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background: #635bff; color: white; text-decoration: none; border-radius: 6px;">Get New Link</a>
      </body>
    </html>
  `);
});

// Serve the HTML page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/stripe-express-prompt.html');
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Open your browser and go to http://localhost:3000');
});