const functions = require('firebase-functions');
const stripe = require('stripe')('sk_test_YOUR_SECRET_KEY'); // ← Replace with your Stripe SECRET key
const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp();
}

exports.createConnectedAccount = functions.https.onRequest(async (req, res) => {
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

            // Save to Firestore
            await admin.firestore().collection('users').doc(userId).set({
                stripeAccountId: stripeAccountId,
                email: email,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        // Create account link for onboarding
        const accountLink = await stripe.accountLinks.create({
            account: stripeAccountId,
            refresh_url: refreshUrl,
            return_url: returnUrl,
            type: 'account_onboarding',
        });

        console.log('Account link created');

        res.json({
            accountId: stripeAccountId,
            url: accountLink.url
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});