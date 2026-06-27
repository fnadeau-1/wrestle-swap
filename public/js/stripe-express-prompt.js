        let currentUser = null;

        // Check if user is logged in and if they already have a Stripe account
        auth.onAuthStateChanged(async (user) => {
            if (user) {
                currentUser = user;

                // Enable the button since user is logged in
                document.getElementById('createAccountBtn').disabled = false;

                // Check if user already has a Stripe account connected
                try {
                    const userDoc = await db.collection('users').doc(user.uid).get();

                    if (userDoc.exists) {
                        const userData = userDoc.data();

                        if (userData.stripeAccountId) {
                            // Get live status from Stripe API — Firestore cache may be stale
                            // (stripePayoutsEnabled is only written by the webhook, which may not be set up yet)
                            try {
                                const idToken = await user.getIdToken();
                                const resp = await fetch('https://us-central1-grappletrade.cloudfunctions.net/checkSellerStatus', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                                    body: JSON.stringify({ userId: user.uid }),
                                });
                                const status = resp.ok ? await resp.json() : null;
                                const payoutsEnabled = status ? status.payoutsEnabled : userData.stripePayoutsEnabled;

                                if (payoutsEnabled) {
                                    document.getElementById('onboarding-section').style.display = 'none';
                                    document.getElementById('already-connected-section').style.display = 'block';
                                } else {
                                    document.getElementById('onboarding-section').style.display = 'none';
                                    document.getElementById('resume-section').style.display = 'block';
                                    document.getElementById('resumeAccountBtn').addEventListener('click', function() {
                                        document.getElementById('createAccountBtn').click();
                                        document.getElementById('resume-section').style.display = 'none';
                                        document.getElementById('onboarding-section').style.display = 'block';
                                    });
                                }
                            } catch (_) {
                                // Fallback: use cached Firestore value
                                if (userData.stripePayoutsEnabled) {
                                    document.getElementById('onboarding-section').style.display = 'none';
                                    document.getElementById('already-connected-section').style.display = 'block';
                                } else {
                                    document.getElementById('onboarding-section').style.display = 'none';
                                    document.getElementById('resume-section').style.display = 'block';
                                    document.getElementById('resumeAccountBtn').addEventListener('click', function() {
                                        document.getElementById('createAccountBtn').click();
                                        document.getElementById('resume-section').style.display = 'none';
                                        document.getElementById('onboarding-section').style.display = 'block';
                                    });
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error checking user status:', error);
                }
            } else {
                showError('Please sign in to become a seller');
                document.getElementById('createAccountBtn').disabled = true;
            }
        });

        // Button click handler
        document.getElementById('createAccountBtn').addEventListener('click', async function() {
            if (!currentUser) {
                showError('Please sign in first');
                return;
            }

            const button = this;
            const loading = document.getElementById('loading');
            const errorDiv = document.getElementById('error');

            // Reset states
            button.disabled = true;
            button.textContent = 'Processing...';
            loading.classList.add('active');
            errorDiv.classList.remove('active');

            try {
                const CLOUD_FUNCTION_URL = 'https://us-central1-grappletrade.cloudfunctions.net/createConnectedAccount';
                const requestBody = {
                    userId: currentUser.uid,
                    email: currentUser.email,
                    returnUrl: window.location.origin + '/sell.html',
                    refreshUrl: window.location.origin + '/stripe-express-prompt.html'
                };
                const idToken = await currentUser.getIdToken();
                const response = await fetch(CLOUD_FUNCTION_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify(requestBody),
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    let msg = 'Failed to create account';
                    try { msg = JSON.parse(errorText).error || msg; } catch (_) {}
                    throw new Error(msg);
                }

                const data = await response.json();

                if (data.error) {
                    throw new Error(data.error);
                }

                if (!data.url) {
                    throw new Error('No onboarding URL received from server');
                }

                // Redirect to Stripe Connect onboarding
                window.location.href = data.url;

            } catch (error) {
                showError('Failed to connect: ' + error.message);
                button.disabled = false;
                button.textContent = 'Create Stripe Express Account';
                loading.classList.remove('active');
            }
        });

        function showError(message) {
            const errorDiv = document.getElementById('error');
            errorDiv.textContent = message;
            errorDiv.classList.add('active');
        }
