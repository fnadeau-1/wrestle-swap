import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

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

        function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

        onAuthStateChanged(auth, (user) => {
            const menuWrapper = document.getElementById('user-menu-wrapper');
            if (user) {
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
                    </div>`;
            } else {
                menuWrapper.innerHTML = `<button class="top-bar-btn" onclick="window.location.href='sign-in.html'">Hi! Sign in</button>`;
            }
        });
