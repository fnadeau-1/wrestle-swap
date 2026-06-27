        import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getFirestore, collection, query, where, getDocs, getDoc, doc }
            from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

        const firebaseConfig = {
            apiKey: "AIzaSyBjDNViO7zXGDIT6gN7qP1VLU2H1lZphe0",
            authDomain: "grappletrade.firebaseapp.com",
            projectId: "grappletrade",
            storageBucket: "grappletrade.firebasestorage.app",
            messagingSenderId: "119683736855",
            appId: "1:119683736855:web:0d0bc6cea784290ded8352",
            measurementId: "G-987DNCH23C"
        };
        const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
        const db = getFirestore(app);

        async function tryFirestoreFallback() {
            // Only run if the order-items section still shows the unavailable message
            const orderItems = document.getElementById('order-items');
            if (!orderItems || !orderItems.innerHTML.includes('unavailable')) return;

            const urlParams = new URLSearchParams(window.location.search);
            const paymentIntentId = urlParams.get('id');
            if (!paymentIntentId) return;

            try {
                // Find the order by paymentIntentId
                const q = query(collection(db, 'orders'), where('paymentIntentId', '==', paymentIntentId));
                const snap = await getDocs(q);
                if (snap.empty) return;

                const orderData = snap.docs[0].data();

                // Fetch product details
                let product = null;
                if (orderData.productId) {
                    const prodSnap = await getDoc(doc(db, 'products', orderData.productId));
                    if (prodSnap.exists()) {
                        const p = prodSnap.data();
                        product = {
                            name: p.title || p.name || 'Order Item',
                            condition: p.condition || '',
                            price: p.price || orderData.productPrice || 0,
                            image: (p.images && p.images[0]) || p.image || '📦'
                        };
                    }
                }

                if (!product) {
                    product = {
                        name: orderData.productTitle || 'Order Item',
                        condition: '',
                        price: orderData.productPrice || 0,
                        image: '📦'
                    };
                }

                // Build orderInfo from order record
                const orderInfo = {
                    shippingService: orderData.shippingService || 'Standard Shipping',
                    trackingNumber: orderData.trackingNumber || null,
                    trackingUrl: orderData.trackingUrl || null,
                    subtotal: product.price,
                    shippingCost: orderData.shippingCost || 0,
                    tax: orderData.taxAmount || 0,
                    total: product.price + (orderData.shippingCost || 0) + (orderData.taxAmount || 0)
                };

                // Re-render with real data
                if (typeof displayProduct === 'function') {
                    displayProduct(product, orderInfo);
                }
                if (orderInfo.trackingNumber) {
                    const trackSection = document.getElementById('tracking-section');
                    if (trackSection) trackSection.style.display = 'block';
                    const trackNum = document.getElementById('tracking-number');
                    if (trackNum) trackNum.textContent = orderInfo.trackingNumber;
                    if (orderInfo.trackingUrl) {
                        const trackLink = document.getElementById('track-link');
                        if (trackLink) trackLink.href = orderInfo.trackingUrl;
                    }
                }
                const shippingMethodEl = document.getElementById('shipping-method');
                if (shippingMethodEl) shippingMethodEl.textContent = orderInfo.shippingService;
            } catch (e) {
                console.warn('Firestore fallback failed:', e);
            }
        }

        window.addEventListener('DOMContentLoaded', () => {
            // Run after the main script's loadOrderInfo
            setTimeout(tryFirestoreFallback, 100);
        });
