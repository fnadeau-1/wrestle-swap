        let allProducts = [];
        let currentProducts = [];
        let searchQuery = '';
        let displayedCount = 0;
        const SEARCH_PAGE_SIZE = 24;
        window.userWatchlist = new Set();

        function toggleWatchlistCard(productId, btn) {
            const inWatchlist = window.userWatchlist.has(productId);
            if (inWatchlist) {
                window.userWatchlist.delete(productId);
                btn.textContent = '🤍';
                btn.title = 'Add to watchlist';
            } else {
                window.userWatchlist.add(productId);
                btn.textContent = '❤️';
                btn.title = 'Remove from watchlist';
            }
            window._toggleWatchlistFirestore && window._toggleWatchlistFirestore(productId, !inWatchlist);
        }

        function getSearchQuery() {
            const urlParams = new URLSearchParams(window.location.search);
            return urlParams.get('q') || '';
        }

        function applyCategoryFromURL() {
            const urlParams = new URLSearchParams(window.location.search);
            const cat = urlParams.get('category');
            if (!cat) return;
            const el = document.getElementById(cat);
            if (el) {
                el.checked = true;
                updateSizeFilters();
            }
        }

        async function loadProductsFromFirestore() {
            try {
                const q = window.query(
                    window.collection(window.firestoreDB, 'products'),
                    window.where('active', '==', true)
                );
                const querySnapshot = await window.getDocs(q);
                allProducts = [];
                querySnapshot.forEach((doc) => {
                    const data = doc.data();
                    if (data.sold === true) return;
                    allProducts.push({
                        id: doc.id,
                        name: data.title,
                        price: data.price,
                        category: data.category,
                        brand: (data.brand || 'other').toLowerCase(),
                        condition: data.condition,
                        size: data.size,
                        sellerName: data.sellerName || '',
                        sellerRating: data.sellerRating || 0,
                        zipCode: data.zipCode || '',
                        shipping: getShippingDisplay(data),
                        icon: getCategoryIcon(data.category),
                        images: data.images || [],
                        sold: data.sold || false
                    });
                });
                currentProducts = [...allProducts];
                document.getElementById('loading-state').style.display = 'none';
                document.getElementById('results-header').style.display = 'flex';
                filterProducts();
            } catch (error) {
                console.error('Error loading products:', error);
                document.getElementById('loading-state').innerHTML =
                    '<p style="color: #dc2626;">Error loading products. Please refresh the page.</p>';
            }
        }

        function getShippingDisplay(product) {
            if (product.shippingMethod === 'free') return 'Free shipping';
            const cost = product.shippingCost || 0;
            return `+$${cost.toFixed(2)} shipping`;
        }

        function getCategoryIcon(category) {
            const icons = {
                'shoes': '👟', 'singlets': '🤼', 'warmups': '🧥',
                'shirts': '👕', 'bottoms': '🩳', 'accessories': '🎒', 'other': '📦'
            };
            return icons[category] || '📦';
        }

        function initializePage() {
            searchQuery = getSearchQuery();
            document.getElementById('search-input').value = searchQuery;
            document.getElementById('search-query-breadcrumb').textContent = searchQuery ? `"${searchQuery}"` : 'All Items';
            document.getElementById('no-results-query').textContent = searchQuery;
            applyCategoryFromURL();
            loadProductsFromFirestore();
        }

        // Mobile filter drawer
        function openFilters() {
            document.getElementById('filter-sidebar').classList.add('drawer-open');
            document.getElementById('filter-overlay').classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        function closeFilters() {
            document.getElementById('filter-sidebar').classList.remove('drawer-open');
            document.getElementById('filter-overlay').classList.remove('active');
            document.body.style.overflow = '';
        }

        function performSearch() {
            const q = document.getElementById('search-input').value.trim();
            window.location.href = q ? 'search.html?q=' + encodeURIComponent(q) : 'search.html';
        }

        // Shoe size pill toggle
        function toggleSizePill(btn) {
            btn.classList.toggle('selected');
            filterProducts();
            updateFilterCount();
        }

        // Show/hide size filter sections based on selected categories
        function updateSizeFilters() {
            const shoesChecked = document.getElementById('shoes')?.checked;
            const clothingCats = ['singlets', 'warmups', 'shirts', 'bottoms'];
            const clothingChecked = clothingCats.some(c => document.getElementById(c)?.checked);
            const noCatChecked = !shoesChecked && !clothingChecked;

            document.getElementById('shoe-size-section').style.display =
                (shoesChecked || noCatChecked) ? 'block' : 'none';
            document.getElementById('clothing-size-section').style.display =
                (clothingChecked || noCatChecked) ? 'block' : 'none';
        }

        // Count active filters and update the badge + clear button
        function updateFilterCount() {
            let count = 0;
            ['shoes','singlets','warmups','shirts','bottoms','accessories','other'].forEach(id => {
                if (document.getElementById(id)?.checked) count++;
            });
            document.querySelectorAll('.size-pill.selected').forEach(() => count++);
            ['size-xs','size-s','size-m','size-l','size-xl','size-xxl'].forEach(id => {
                if (document.getElementById(id)?.checked) count++;
            });
            ['cond-new','cond-likenew','cond-good','cond-fair'].forEach(id => {
                if (document.getElementById(id)?.checked) count++;
            });
            ['asics','adidas','nike','rudis','cliff_keen','brute','champion','matman','brand-other'].forEach(id => {
                if (document.getElementById(id)?.checked) count++;
            });
            const minP = parseFloat(document.getElementById('price-min-input')?.value);
            const maxP = parseFloat(document.getElementById('price-max-input')?.value);
            if (!isNaN(minP) && minP > 0) count++;
            if (!isNaN(maxP) && maxP > 0) count++;

            const badge = document.getElementById('filter-count-badge');
            const clearBar = document.getElementById('clear-filters-bar');
            if (count > 0) {
                if (badge) { badge.textContent = count; badge.style.display = 'inline-flex'; }
                if (clearBar) clearBar.style.display = 'block';
            } else {
                if (badge) badge.style.display = 'none';
                if (clearBar) clearBar.style.display = 'none';
            }
        }

        // Clear all filters
        function clearAllFilters() {
            ['shoes','singlets','warmups','shirts','bottoms','accessories','other',
             'size-xs','size-s','size-m','size-l','size-xl','size-xxl',
             'cond-new','cond-likenew','cond-good','cond-fair',
             'asics','adidas','nike','rudis','cliff_keen','brute','champion','matman','brand-other'
            ].forEach(id => { const el = document.getElementById(id); if (el) el.checked = false; });
            document.querySelectorAll('.size-pill.selected').forEach(p => p.classList.remove('selected'));
            const minEl = document.getElementById('price-min-input');
            const maxEl = document.getElementById('price-max-input');
            if (minEl) minEl.value = '';
            if (maxEl) maxEl.value = '';
            updateSizeFilters();
            filterProducts();
            updateFilterCount();
        }

        // Filter products
        function filterProducts() {
            let filtered = [...allProducts];

            // Search query
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                filtered = filtered.filter(p => p.name.toLowerCase().includes(q));
            }

            // Category
            const selectedCategories = [];
            ['shoes','singlets','warmups','shirts','bottoms','accessories','other'].forEach(cat => {
                if (document.getElementById(cat)?.checked) selectedCategories.push(cat);
            });
            if (selectedCategories.length > 0) {
                filtered = filtered.filter(p => selectedCategories.includes(p.category));
            }

            // Shoe size (pills)
            const selectedSizes = [];
            document.querySelectorAll('.size-pill.selected').forEach(p => selectedSizes.push(p.dataset.size));
            if (selectedSizes.length > 0) {
                filtered = filtered.filter(p => {
                    if (!p.size) return false;
                    const ps = p.size.toString().toLowerCase();
                    return selectedSizes.some(s => ps.includes(s));
                });
            }

            // Clothing size
            const clothingSizeMap = {
                'size-xs': ['xs', 'x-small', 'xsmall', 'extra small'],
                'size-s':  ['small', ' s ', '"s"'],
                'size-m':  ['medium', ' m '],
                'size-l':  ['large', ' l '],
                'size-xl': ['xl', 'x-large', 'xlarge', 'extra large'],
                'size-xxl':['xxl', 'xx-large', 'xxlarge', '2xl']
            };
            const selectedClothing = Object.entries(clothingSizeMap)
                .filter(([id]) => document.getElementById(id)?.checked)
                .map(([, vals]) => vals);
            if (selectedClothing.length > 0) {
                filtered = filtered.filter(p => {
                    const ps = (p.size || '').toLowerCase();
                    return selectedClothing.some(vals => vals.some(v => ps.includes(v)));
                });
            }

            // Condition
            const condMap = {
                'cond-new': 'new',
                'cond-likenew': 'likenew',
                'cond-good': 'good',
                'cond-fair': 'fair'
            };
            const selectedConds = Object.entries(condMap)
                .filter(([id]) => document.getElementById(id)?.checked)
                .map(([, val]) => val);
            if (selectedConds.length > 0) {
                filtered = filtered.filter(p => selectedConds.includes((p.condition || '').toLowerCase()));
            }

            // Brand
            const brandMap = {
                'asics': 'asics', 'adidas': 'adidas', 'nike': 'nike', 'rudis': 'rudis',
                'cliff_keen': 'cliff keen', 'brute': 'brute', 'champion': 'champion', 'matman': 'matman'
            };
            const selectedBrands = Object.entries(brandMap)
                .filter(([id]) => document.getElementById(id)?.checked)
                .map(([, val]) => val);
            if (document.getElementById('brand-other')?.checked) selectedBrands.push('other');
            if (selectedBrands.length > 0) {
                filtered = filtered.filter(p => selectedBrands.includes((p.brand || 'other').toLowerCase()));
            }

            // Price
            const minPrice = parseFloat(document.getElementById('price-min-input')?.value) || 0;
            const maxPrice = parseFloat(document.getElementById('price-max-input')?.value) || Infinity;
            filtered = filtered.filter(p => p.price >= minPrice && p.price <= maxPrice);

            currentProducts = filtered;
            updateFilterCount();
            displayProducts();
        }

        // Sort products
        function sortProducts(sortType) {
            switch(sortType) {
                case 'price-low':  currentProducts.sort((a, b) => a.price - b.price); break;
                case 'price-high': currentProducts.sort((a, b) => b.price - a.price); break;
                case 'newest':     currentProducts.reverse(); break;
                default: break;
            }
            displayProducts();
        }

        function renderProductSlice(products) {
            return products.map(product => {
                const imgSrc = safeUrl(product.images && product.images[0]);
                const imageDisplay = imgSrc
                    ? `<img src="${esc(imgSrc)}" alt="${esc(product.name)}" loading="lazy">`
                    : esc(product.icon || '📦');
                const soldClass = product.sold ? 'sold' : '';
                const soldBadge = product.sold ? '<div class="sold-badge">SOLD</div>' : '';
                const inWatchlist = userWatchlist.has(product.id);
                const heartHtml = `<button class="heart-btn" onclick="event.stopPropagation(); toggleWatchlistCard('${product.id}', this)" title="${inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}">${inWatchlist ? '❤️' : '🤍'}</button>`;
                const trustBadge = product.sellerRating >= 4.5 ? '<span class="trust-badge">Top Seller</span>' : '';
                const locationText = product.zipCode ? ` &middot; Ships from ${esc(product.zipCode)}` : '';
                return `
                    <a class="product-item ${soldClass}" href="productdetail.html?id=${esc(product.id)}" style="text-decoration:none;color:inherit;">
                        ${soldBadge}
                        ${heartHtml}
                        <div class="product-img">${imageDisplay}</div>
                        <div class="product-details">
                            <div class="product-name">${esc(product.name)}</div>
                            <div class="product-price">$${product.price.toFixed(2)}</div>
                            <div class="product-condition">${formatCondition(product.condition)}</div>
                            <div class="seller-trust">${trustBadge}<span>${esc(product.sellerName)}${locationText}</span></div>
                        </div>
                    </a>
                `;
            }).join('');
        }

        function displayProducts() {
            const container = document.getElementById('products-container');
            const noResults = document.getElementById('no-results');
            const resultsCount = document.getElementById('results-count');
            const loadMoreWrapper = document.getElementById('load-more-wrapper');

            if (currentProducts.length === 0) {
                container.style.display = 'none';
                noResults.style.display = 'block';
                resultsCount.innerHTML = `<strong>0 results</strong>`;
                loadMoreWrapper.style.display = 'none';
            } else {
                container.style.display = 'grid';
                noResults.style.display = 'none';
                resultsCount.innerHTML = `<strong>${currentProducts.length} result${currentProducts.length !== 1 ? 's' : ''}</strong>`;
                displayedCount = Math.min(SEARCH_PAGE_SIZE, currentProducts.length);
                container.innerHTML = renderProductSlice(currentProducts.slice(0, displayedCount));
                if (currentProducts.length > displayedCount) {
                    loadMoreWrapper.style.display = 'block';
                    document.getElementById('load-more-btn').textContent = 'Load More';
                } else {
                    loadMoreWrapper.style.display = 'none';
                }
            }
        }

        function showMoreProducts() {
            const container = document.getElementById('products-container');
            const loadMoreWrapper = document.getElementById('load-more-wrapper');
            const nextCount = Math.min(displayedCount + SEARCH_PAGE_SIZE, currentProducts.length);
            container.insertAdjacentHTML('beforeend', renderProductSlice(currentProducts.slice(displayedCount, nextCount)));
            displayedCount = nextCount;
            if (displayedCount >= currentProducts.length) loadMoreWrapper.style.display = 'none';
        }

        function esc(s) {
            return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function safeUrl(url) {
            if (!url) return '';
            const u = String(url);
            return (u.startsWith('https://') || u.startsWith('http://')) ? u : '';
        }
        function formatCondition(condition) {
            const conditions = { 'new': 'New', 'good': 'Used - Good', 'likenew': 'Like New', 'fair': 'Used - Fair' };
            return conditions[condition] || esc(condition);
        }

        document.addEventListener('DOMContentLoaded', function() {
            document.getElementById('search-input').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') performSearch();
            });
            initializePage();
        });
