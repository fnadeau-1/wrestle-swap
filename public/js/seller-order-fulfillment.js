        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged, getIdToken } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, doc, getDoc, collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

        // Make Firebase available globally
        window.firebaseDb = db;
        window.getDoc = getDoc;
        window.doc = doc;
        window.getIdToken = () => getIdToken(auth.currentUser, true);
        window._fsCollection = collection;
        window._fsQuery = query;
        window._fsWhere = where;
        window._fsLimit = limit;
        window._fsGetDocs = getDocs;

        const urlProductId = new URLSearchParams(window.location.search).get('productId');

        function showAccessDenied(message) {
            document.querySelector('.container').innerHTML = `
                <div style="text-align:center;padding:80px 20px;background:white;border-radius:8px;margin-top:40px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
                    <div style="font-size:64px;margin-bottom:20px;">🚫</div>
                    <h2 style="font-size:24px;color:#333;margin-bottom:12px;">Access Denied</h2>
                    <p style="color:#707070;margin-bottom:24px;">${message}</p>
                    <a href="listings-manager.html" style="display:inline-block;padding:12px 28px;background:#c41e3a;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Back to My Listings</a>
                </div>
            `;
        }

        // Handle auth state — verify user is signed in AND is the seller of this order
        onAuthStateChanged(auth, async (user) => {
            const menuWrapper = document.getElementById('user-menu-wrapper');

            if (!user) {
                menuWrapper.innerHTML = `
                    <button class="top-bar-btn" onclick="window.location.href='sign-in.html'">Hi! Sign in</button>
                `;
                window.location.href = 'sign-in.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
                return;
            }

            const firstName = user.displayName ? user.displayName.split(' ')[0] : user.email.split('@')[0];
            menuWrapper.innerHTML = `
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

            // Verify this user is the seller of the product
            if (urlProductId) {
                try {
                    const productSnap = await getDoc(doc(db, 'products', urlProductId));
                    if (!productSnap.exists()) {
                        showAccessDenied('This order could not be found.');
                        return;
                    }
                    if (productSnap.data().userId !== user.uid) {
                        showAccessDenied('You are not the seller of this order.');
                        return;
                    }
                    // Ownership confirmed — load the order details
                    window.sellerVerified = true;
                    if (typeof loadOrderDetails === 'function') loadOrderDetails();
                } catch (e) {
                    console.error('Seller verification error:', e);
                    showAccessDenied('Could not verify order ownership. Please try again.');
                }
            }
        });
