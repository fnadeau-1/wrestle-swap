        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteField } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

        // Firebase configuration
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

        let currentUser = null;

        // Wait for auth state to be ready
        onAuthStateChanged(auth, (user) => {
            currentUser = user;

            if (!user) {
                // User not logged in - redirect to sign in
                window.location.href = 'sign-in.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
            } else {
                // User is logged in - load their cart
                window.loadCartFromFirestore();
            }
        });

        // Expose Firebase to global scope for use in regular script
        window.firebaseAuth = auth;
        window.firebaseDb = db;
        window.firebaseDoc = doc;
        window.firebaseGetDoc = getDoc;
        window.firebaseSetDoc = setDoc;
        window.firebaseUpdateDoc = updateDoc;
        window.firebaseDeleteField = deleteField;
        window.getCurrentUser = () => currentUser;
