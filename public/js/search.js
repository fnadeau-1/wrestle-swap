        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, collection, getDocs, query, where, doc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

        // User greeting + load watchlist
        onAuthStateChanged(auth, async (user) => {
            const greeting = document.getElementById('user-greeting');
            if (user) {
                const firstName = user.displayName ? user.displayName.split(' ')[0] : user.email.split('@')[0];
                greeting.textContent = `Hi, ${firstName}!`;
                greeting.href = 'profile.html';
                window._currentUser = user;
                try {
                    const wSnap = await getDocs(collection(db, 'users', user.uid, 'watchlist'));
                    wSnap.forEach(d => window.userWatchlist.add(d.id));
                } catch(e) {}
            } else {
                greeting.textContent = 'Hi! Sign in';
                greeting.href = 'sign-in.html';
                window._currentUser = null;
            }
        });

        // Watchlist toggle
        window._toggleWatchlistFirestore = async (productId, add) => {
            const user = window._currentUser;
            if (!user) { window.location.href = 'sign-in.html'; return; }
            const ref = doc(db, 'users', user.uid, 'watchlist', productId);
            if (add) {
                await setDoc(ref, { addedAt: new Date() });
            } else {
                await deleteDoc(ref);
            }
        };

        window.firestoreDB = db;
        window.getDocs = getDocs;
        window.collection = collection;
        window.query = query;
        window.where = where;
