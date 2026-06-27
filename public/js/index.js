        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, collection, query, where, getDocs, orderBy, limit, startAfter } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

        // Handle user greeting with dropdown for signed-in users
        onAuthStateChanged(auth, (user) => {
            const menuWrapper = document.getElementById('user-menu-wrapper');

            if (user) {
                // User is signed in - show dropdown menu
                const firstName = user.displayName ? user.displayName.split(' ')[0] : user.email.split('@')[0];

                // Create the dropdown menu HTML
                menuWrapper.innerHTML = `
                    <div class="user-menu-container">
                        <button class="top-bar-btn" onclick="window.location.href='profile.html'">Hi, ${esc(firstName)}!</button>
                        <div class="dropdown-menu">
                            <a href="watchlist.html">Watchlist</a>
                            <a href="my-orders.html">Your Orders</a>
                            <a href="listings-manager.html">Your Listings</a>
                        </div>
                    </div>
                `;
            } else {
                // User is not signed in - show simple sign-in button
                menuWrapper.innerHTML = `
                    <button class="top-bar-btn" onclick="window.location.href='sign-in.html'">Hi! Sign in</button>
                `;
            }
        });

        const PAGE_SIZE = 12;
        let lastProductDoc = null;
        let allLoaded = false;

        function esc(s) {
            return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function safeUrl(url) {
            if (!url) return '';
            const u = String(url);
            return (u.startsWith('https://') || u.startsWith('http://')) ? u : '';
        }

        function renderProducts(products, append) {
            const container = document.getElementById('products-container');
            const html = products.map(product => {
                const imgSrc = safeUrl(product.images && product.images[0]);
                const imageDisplay = imgSrc
                    ? `<img src="${esc(imgSrc)}" alt="${esc(product.title)}" loading="lazy">`
                    : '<span aria-hidden="true">📦</span>';
                return `
                    <a class="product-card" href="productdetail.html?id=${esc(product.id)}" style="text-decoration:none;color:inherit;">
                        <div class="product-image">${imageDisplay}</div>
                        <div class="product-info">
                            <div class="product-title">${esc(product.title)}</div>
                            <div class="product-price">$${product.price.toFixed(2)}</div>
                            <div class="product-seller">${esc(product.sellerName)}</div>
                        </div>
                    </a>
                `;
            }).join('');
            if (append) {
                container.insertAdjacentHTML('beforeend', html);
            } else {
                container.innerHTML = html;
            }
        }

        // Load products from Firestore
        async function loadProducts(append) {
            const container = document.getElementById('products-container');
            const loading = document.getElementById('loading-products');
            const loadMoreWrapper = document.getElementById('load-more-wrapper');
            const loadMoreBtn = document.getElementById('load-more-btn');

            if (loadMoreBtn) {
                loadMoreBtn.disabled = true;
                loadMoreBtn.textContent = 'Loading...';
            }

            try {
                let q;
                if (lastProductDoc) {
                    q = query(
                        collection(db, 'products'),
                        where('active', '==', true),
                        limit(PAGE_SIZE),
                        startAfter(lastProductDoc)
                    );
                } else {
                    q = query(
                        collection(db, 'products'),
                        where('active', '==', true),
                        limit(PAGE_SIZE)
                    );
                }

                const querySnapshot = await getDocs(q);
                const products = [];

                querySnapshot.forEach((doc) => {
                    const data = doc.data();
                    if (data.sold === true) return;
                    products.push({
                        id: doc.id,
                        title: data.title,
                        price: data.price || 0,
                        sellerName: data.sellerName || 'Unknown Seller',
                        images: data.images || [],
                        condition: data.condition || ''
                    });
                    lastProductDoc = doc;
                });

                loading.style.display = 'none';

                if (!append && products.length === 0) {
                    container.innerHTML = '<p style="text-align: center; color: #707070; padding: 40px;">No products available yet. Be the first to list!</p>';
                    if (loadMoreWrapper) loadMoreWrapper.style.display = 'none';
                    return;
                }

                renderProducts(products, append);

                // Show/hide Load More button
                if (querySnapshot.docs.length < PAGE_SIZE) {
                    allLoaded = true;
                    if (loadMoreWrapper) loadMoreWrapper.style.display = 'none';
                } else {
                    if (loadMoreWrapper) loadMoreWrapper.style.display = 'block';
                    if (loadMoreBtn) {
                        loadMoreBtn.disabled = false;
                        loadMoreBtn.textContent = 'Load More';
                    }
                }

            } catch (error) {
                console.error('Error loading products:', error);
                loading.textContent = 'Error loading products. Please refresh.';
                if (loadMoreBtn) {
                    loadMoreBtn.disabled = false;
                    loadMoreBtn.textContent = 'Load More';
                }
            }
        }

        window.loadMoreProducts = function() {
            if (!allLoaded) loadProducts(true);
        };

        // Load products when page loads
        loadProducts(false);
