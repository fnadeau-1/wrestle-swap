        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, doc, getDoc, setDoc, updateDoc, arrayRemove, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

        let watchlistItems = [];
        let currentUser = null;

        function esc(s) {
            return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function safeUrl(url) {
            if (!url) return '';
            const u = String(url);
            return (u.startsWith('https://') || u.startsWith('http://')) ? u : '';
        }

        // Update header with user info and dropdown
        onAuthStateChanged(auth, async (user) => {
            const menuWrapper = document.getElementById('user-menu-wrapper');

            if (user) {
                currentUser = user;
                const firstName = user.displayName ? user.displayName.split(' ')[0] : user.email.split('@')[0];

                menuWrapper.innerHTML = `
                    <div class="user-menu-container">
                        <button class="top-bar-btn">Hi, ${esc(firstName)}!</button>
                        <div class="dropdown-menu">
                            <a href="watchlist.html">Watchlist</a>
                            <a href="my-orders.html">Your Orders</a>
                            <a href="listings-manager.html">Your Listings</a>
                            <a href="messages.html">Messages</a>
                        </div>
                    </div>
                `;

                // Load watchlist for signed-in user
                await loadWatchlist(user.uid);
            } else {
                currentUser = null;
                menuWrapper.innerHTML = `
                    <button class="top-bar-btn" onclick="window.location.href='sign-in.html'">Hi! Sign in</button>
                `;

                // Show auth required state
                showAuthRequired();
            }
        });

        // Load watchlist from Firestore
        async function loadWatchlist(userId) {
            const loadingState = document.getElementById('loading-state');
            const authRequired = document.getElementById('auth-required');

            try {
                loadingState.style.display = 'block';
                authRequired.style.display = 'none';

                // Get user's watchlist document
                const watchlistRef = doc(db, 'watchlists', userId);
                const watchlistDoc = await getDoc(watchlistRef);

                if (watchlistDoc.exists()) {
                    const watchlistData = watchlistDoc.data();
                    const productIds = watchlistData.products || [];

                    if (productIds.length === 0) {
                        watchlistItems = [];
                        showEmptyState();
                        return;
                    }

                    // Fetch product details for each item in watchlist
                    watchlistItems = [];
                    for (const productId of productIds) {
                        const productRef = doc(db, 'products', productId);
                        const productDoc = await getDoc(productRef);

                        if (productDoc.exists()) {
                            const productData = productDoc.data();
                            watchlistItems.push({
                                id: productDoc.id,
                                title: productData.title,
                                price: productData.price || 0,
                                condition: productData.condition || 'Used',
                                sellerName: productData.sellerName || 'Unknown Seller',
                                images: productData.images || [],
                                sold: productData.sold || false,
                                active: productData.active !== false,
                                dateAdded: watchlistData.dateAdded || new Date()
                            });
                        }
                    }

                    renderWatchlist();
                } else {
                    // No watchlist document exists yet
                    watchlistItems = [];
                    showEmptyState();
                }

            } catch (error) {
                console.error('Error loading watchlist:', error);
                loadingState.innerHTML = `
                    <div class="loading-text" style="color: #e53238;">
                        Error loading watchlist. Please refresh the page.
                    </div>
                `;
            }
        }

        // Render watchlist items
        function renderWatchlist() {
            const loadingState = document.getElementById('loading-state');
            const container = document.getElementById('watchlist-container');
            const controls = document.getElementById('watchlist-controls');
            const emptyState = document.getElementById('empty-state');

            loadingState.style.display = 'none';
            emptyState.style.display = 'none';

            if (watchlistItems.length === 0) {
                showEmptyState();
                return;
            }

            controls.style.display = 'flex';
            container.style.display = 'grid';

            container.innerHTML = watchlistItems.map(item => {
                const imgSrc = safeUrl(item.images && item.images[0]);
                const imageDisplay = imgSrc
                    ? `<img src="${esc(imgSrc)}" alt="${esc(item.title)}">`
                    : '📦';

                const statusClass = item.sold ? 'status-sold' : 'status-available';
                const statusText = item.sold ? 'Sold' : 'Available';

                return `
                    <div class="watchlist-item" data-id="${item.id}">
                        <button class="remove-btn" onclick="window.removeItem('${item.id}')">✕</button>
                        <div class="item-image">${imageDisplay}</div>
                        <div class="item-details">
                            <div class="item-title" onclick="window.location.href='productdetail.html?id=${item.id}'">${esc(item.title)}</div>
                            <div class="item-condition">${esc(item.condition)}</div>
                            <div class="item-price">$${item.price.toFixed(2)}</div>
                            <div class="item-seller">Seller: ${esc(item.sellerName)}</div>
                            <div class="item-status ${statusClass}">${statusText}</div>
                            <div class="item-actions">
                                <button class="action-btn buy-btn" onclick="window.location.href='productdetail.html?id=${item.id}'" ${item.sold ? 'disabled' : ''}>
                                    ${item.sold ? 'Sold Out' : 'View Item'}
                                </button>
                                <button class="action-btn view-btn" onclick="window.removeItem('${item.id}')">Remove</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            updateItemCount();
        }

        // Remove item from watchlist
        window.removeItem = async function(productId) {
            if (!currentUser) {
                alert('Please sign in to manage your watchlist');
                return;
            }

            if (!confirm('Remove this item from your watchlist?')) {
                return;
            }

            try {
                const watchlistRef = doc(db, 'watchlists', currentUser.uid);

                // Remove product ID from the array
                await updateDoc(watchlistRef, {
                    products: arrayRemove(productId)
                });

                // Update local array
                watchlistItems = watchlistItems.filter(item => item.id !== productId);

                if (watchlistItems.length === 0) {
                    showEmptyState();
                } else {
                    renderWatchlist();
                }

            } catch (error) {
                console.error('Error removing item:', error);
                alert('Failed to remove item. Please try again.');
            }
        };

        // Clear all items from watchlist
        window.clearWatchlist = async function() {
            if (!currentUser) {
                alert('Please sign in to manage your watchlist');
                return;
            }

            if (!confirm('Are you sure you want to clear your entire watchlist?')) {
                return;
            }

            try {
                const watchlistRef = doc(db, 'watchlists', currentUser.uid);

                // Clear the products array
                await updateDoc(watchlistRef, {
                    products: []
                });

                watchlistItems = [];
                showEmptyState();

            } catch (error) {
                console.error('Error clearing watchlist:', error);
                alert('Failed to clear watchlist. Please try again.');
            }
        };

        // Sort watchlist
        window.sortWatchlist = function() {
            const sortType = document.getElementById('sort-select').value;

            switch(sortType) {
                case 'recent':
                    watchlistItems.sort((a, b) => b.dateAdded - a.dateAdded);
                    break;
                case 'price-low':
                    watchlistItems.sort((a, b) => a.price - b.price);
                    break;
                case 'price-high':
                    watchlistItems.sort((a, b) => b.price - a.price);
                    break;
                case 'title':
                    watchlistItems.sort((a, b) => a.title.localeCompare(b.title));
                    break;
            }

            renderWatchlist();
        };

        // Update item count
        function updateItemCount() {
            const count = watchlistItems.length;
            const countElement = document.getElementById('item-count');
            countElement.innerHTML = `<strong>${count} ${count === 1 ? 'item' : 'items'}</strong> in your watchlist`;
        }

        // Show empty state
        function showEmptyState() {
            const loadingState = document.getElementById('loading-state');
            const emptyState = document.getElementById('empty-state');
            const controls = document.getElementById('watchlist-controls');
            const container = document.getElementById('watchlist-container');

            loadingState.style.display = 'none';
            emptyState.style.display = 'block';
            controls.style.display = 'none';
            container.style.display = 'none';
        }

        // Show auth required state
        function showAuthRequired() {
            const loadingState = document.getElementById('loading-state');
            const authRequired = document.getElementById('auth-required');
            const controls = document.getElementById('watchlist-controls');
            const container = document.getElementById('watchlist-container');
            const emptyState = document.getElementById('empty-state');

            loadingState.style.display = 'none';
            authRequired.style.display = 'block';
            controls.style.display = 'none';
            container.style.display = 'none';
            emptyState.style.display = 'none';
        }

        // Search function
        window.performSearch = function() {
            const searchTerm = document.getElementById('search-input').value;
            if (searchTerm) {
                window.location.href = `search.html?q=${encodeURIComponent(searchTerm)}`;
            } else {
                window.location.href = 'search.html';
            }
        };
