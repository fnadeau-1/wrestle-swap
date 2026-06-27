        // Initialize Firebase
        const firebaseConfig = {
            apiKey: "AIzaSyBjDNViO7zXGDIT6gN7qP1VLU2H1lZphe0",
            authDomain: "grappletrade.firebaseapp.com",
            projectId: "grappletrade",
            storageBucket: "grappletrade.firebasestorage.app",
            messagingSenderId: "119683736855",
            appId: "1:119683736855:web:0d0bc6cea784290ded8352",
            measurementId: "G-987DNCH23C"
        };

        firebase.initializeApp(firebaseConfig);
        firebase.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider('6Lck5w4tAAAAABZvUgLj4J5zg_CPlK7mQawuk6b6'), true);
        const auth = firebase.auth();
        const db = firebase.firestore();
