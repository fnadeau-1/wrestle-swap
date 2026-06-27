        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged, sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, collection, addDoc, doc, getDoc, serverTimestamp, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
        import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

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
        const db = getFirestore(app);
        const storage = getStorage(app);
        const auth = getAuth(app);

        let currentUser = null;
        let userStripeAccountId = null;

        // Check if user has Stripe account and shipping address
        async function checkStripeAccount(user) {
            try {
                const userDocRef = doc(db, 'users', user.uid);
                const userDoc = await getDoc(userDocRef);
                const data = userDoc.exists() ? userDoc.data() : {};

                // Check Stripe account
                if (!data.stripeAccountId) {
                    document.getElementById('stripe-warning').classList.add('show');
                    document.getElementById('submit-btn').disabled = true;
                } else {
                    document.getElementById('stripe-warning').classList.remove('show');
                    // Only enable submit if email is also verified — email verification check runs first
                    // and disables the button; we must not re-enable it for unverified users
                    if (user.emailVerified !== false) {
                        document.getElementById('submit-btn').disabled = false;
                    }
                }

                return data.stripeAccountId || null;
            } catch (error) {
                console.error('Error checking account setup:', error);
                return null;
            }
        }

        onAuthStateChanged(auth, async (user) => {
            const menuWrapper = document.getElementById('user-menu-wrapper');

            if (!user) {
                if (menuWrapper) menuWrapper.innerHTML = `
                    <button class="top-bar-btn" onclick="window.location.href='sign-in.html'">Hi! Sign in</button>
                `;
                alert('Please sign in to list items');
                window.location.href = 'sign-in.html';
            } else {
                currentUser = user;

                // Email verification check
                if (!user.emailVerified) {
                    const banner = document.getElementById('email-verify-banner');
                    if (banner) banner.style.display = 'block';
                    document.getElementById('submit-btn').disabled = true;
                    document.getElementById('resend-verify-btn').addEventListener('click', async () => {
                        try {
                            await sendEmailVerification(user);
                            document.getElementById('resend-verify-btn').textContent = 'Email sent!';
                            document.getElementById('resend-verify-btn').disabled = true;
                        } catch (e) {
                            alert('Could not send verification email. Please try again shortly.');
                        }
                    });
                }

                // Update greeting with dropdown
                const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
                const firstName = user.displayName ? user.displayName.split(' ')[0] : user.email.split('@')[0];
                if (menuWrapper) menuWrapper.innerHTML = `
                    <div class="user-menu-container">
                        <button class="top-bar-btn" onclick="window.location.href='profile.html'">Hi, ${esc(firstName)}!</button>
                        <div class="dropdown-menu">
                            <a href="watchlist.html">Watchlist</a>
                            <a href="my-orders.html">Your Orders</a>
                            <a href="listings-manager.html">Your Listings</a>
                            <a href="messages.html">Messages</a>
                        </div>
                    </div>
                `;

                // Check for Stripe account
                userStripeAccountId = await checkStripeAccount(user);
            }
        });

        window.firestoreDB = db;
        window.firebaseStorage = storage;
        window.addDoc = addDoc;
        window.collection = collection;
        window.serverTimestamp = serverTimestamp;
        window.storageRef = ref;
        window.uploadBytes = uploadBytes;
        window.getDownloadURL = getDownloadURL;
        window.getCurrentUser = () => currentUser;
        window.getStripeAccountId = () => userStripeAccountId;
        window.getDocs = getDocs;
        window.query = query;
        window.where = where;

        // Banned keywords — loaded once on page open.
        // Admins can override this list via Firestore: config/bannedItems { keywords: [...] }
        const DEFAULT_BANNED_KEYWORDS = [
            // Weapons
            'gun', 'guns', 'knife', 'knives', 'weapon', 'weapons', 'firearm', 'firearms',
            'ammo', 'ammunition', 'blade', 'sword', 'pistol', 'rifle', 'shotgun',
            'grenade', 'bomb', 'explosive', 'taser',
            // Drugs
            'cocaine', 'heroin', 'meth', 'methamphetamine', 'marijuana', 'cannabis',
            'steroid', 'steroids', 'xanax', 'adderall', 'fentanyl', 'crack', 'ecstasy',
            'mdma', 'ketamine', 'lsd', 'weed',
            // Profanity
            'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'bastard'
        ];
        window.bannedKeywords = DEFAULT_BANNED_KEYWORDS;

        (async function loadBannedKeywords() {
            try {
                const configDoc = await getDoc(doc(db, 'config', 'bannedItems'));
                if (configDoc.exists() && Array.isArray(configDoc.data().keywords)) {
                    window.bannedKeywords = configDoc.data().keywords;
                }
            } catch (e) { /* use default list */ }
        })();
