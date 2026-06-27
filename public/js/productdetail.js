        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove, collection, query, limit, getDocs, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

        window.escapeHtml = function escapeHtml(str) {
            if (!str) return '';
            const d = document.createElement('div');
            d.textContent = str;
            return d.innerHTML;
        }

        let currentUser = null;
        onAuthStateChanged(auth, (user) => {
            const menuWrapper = document.getElementById('user-menu-wrapper');
            if (user) {
                currentUser = user;
                const firstName = user.displayName ? user.displayName.split(' ')[0] : user.email.split('@')[0];
                menuWrapper.innerHTML = `
                    <div class="user-menu-container">
                        <button class="top-bar-btn" onclick="window.location.href='profile.html'">Hi, ${escapeHtml(firstName)}!</button>
                        <div class="dropdown-menu">
                            <a href="watchlist.html">Watchlist</a>
                            <a href="my-orders.html">Your Orders</a>
                            <a href="listings-manager.html">Your Listings</a>
                            <a href="messages.html">Messages</a>
                        </div>
                    </div>
                `;
                // Re-check if this is user's own product after auth state changes
                if (window.currentProduct) {
                    window.checkIfOwnProduct(window.currentProduct);
                }
            } else {
                menuWrapper.innerHTML = `
                    <button class="top-bar-btn" onclick="window.location.href='sign-in.html'">Hi! Sign in</button>
                `;
            }
        });

        window.firebaseAuth = auth;
        window.firebaseDb = db;
        window.getCurrentUser = () => currentUser;
        window.getDoc = getDoc;
        window.setDoc = setDoc;
        window.updateDoc = updateDoc;
        window.arrayUnion = arrayUnion;
        window.arrayRemove = arrayRemove;
        window.doc = doc;
        window.collection = collection;
        window.query = query;
        window.limit = limit;
        window.getDocs = getDocs;
        window.where = where;
        window.serverTimestamp = serverTimestamp;

        window.firebaseReady = true;
        window.dispatchEvent(new Event('firebaseReady'));

        // Re-check own product status when auth changes and product is loaded
        onAuthStateChanged(auth, (user) => {
            if (user && window.currentProduct && window.checkIfOwnProduct) {
                window.checkIfOwnProduct(window.currentProduct);
            }
        });
