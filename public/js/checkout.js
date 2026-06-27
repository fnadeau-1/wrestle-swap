        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

        const firebaseConfig = {
            apiKey: "AIzaSyBjDNViO7zXGDIT6gN7qP1VLU2H1lZphe0",
            authDomain: "grappletrade.firebaseapp.com",
            projectId: "grappletrade",
            storageBucket: "grappletrade.firebasestorage.app",
            messagingSenderId: "119683736855",
            appId: "1:119683736855:web:0d0bc6cea784290ded8352",
            measurementId: "G-987DNCH23C"
        };

        const app = initializeApp(firebaseConfig);
        initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider('6Lck5w4tAAAAABZvUgLj4J5zg_CPlK7mQawuk6b6'), isTokenAutoRefreshEnabled: true });
        const auth = getAuth(app);
        const db = getFirestore(app);

        // Redirect to sign-in if not authenticated
        onAuthStateChanged(auth, (user) => {
            if (!user) {
                const notice = document.getElementById('auth-notice');
                if (notice) notice.style.display = 'flex';
                setTimeout(() => { window.location.href = 'sign-in.html'; }, 2500);
            }
        });

        // Make Firebase available globally
        window.firebaseDb = db;
        window.updateDoc = updateDoc;
        window.getDoc = getDoc;
        window.doc = doc;
        window.serverTimestamp = serverTimestamp;
        window.getIdToken = async () => auth.currentUser ? auth.currentUser.getIdToken() : null;

        // Function to get seller's Stripe account ID
        window.getSellerStripeAccountId = async function(sellerId) {
            try {
                const userRef = doc(db, 'users', sellerId);
                const userDoc = await getDoc(userRef);

                if (userDoc.exists() && userDoc.data().stripeAccountId) {
                    return userDoc.data().stripeAccountId;
                }
                return null;
            } catch (error) {
                console.error('Error fetching seller Stripe account:', error);
                return null;
            }
        };

        // Build seller FROM address from the listing's zipCode field
        window.getSellerAddress = function(listing) {
            const zip = listing.zipCode || listing.zip || '';
            if (!zip) return null;
            return {
                name: listing.sellerName || 'Seller',
                street1: '1 Main St',
                city: 'Unknown',
                state: 'NY',
                zip: zip,
                country: 'US',
                phone: '',
            };
        };
