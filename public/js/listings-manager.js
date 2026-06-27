        // ============================================
        // FIREBASE CONFIGURATION
        // ============================================
        
        const firebaseConfig = {
            apiKey: "AIzaSyBjDNViO7zXGDIT6gN7qP1VLU2H1lZphe0",
            authDomain: "grappletrade.firebaseapp.com",
            projectId: "grappletrade",
            storageBucket: "grappletrade.firebasestorage.app",
            messagingSenderId: "119683736855",
            appId: "1:119683736855:web:0d0bc6cea784290ded8352",
            measurementId: "G-987DNCH23C"
        };

        // Initialize Firebase
        firebase.initializeApp(firebaseConfig);
        firebase.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider('6Lck5w4tAAAAABZvUgLj4J5zg_CPlK7mQawuk6b6'), true);
        const db = firebase.firestore();
        const auth = firebase.auth();

        function esc(s) {
            return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function safeUrl(url) {
            if (!url) return '';
            const u = String(url);
            return (u.startsWith('https://') || u.startsWith('http://')) ? u : '';
        }

        // ============================================
        // USER-SPECIFIC LISTINGS
        // ============================================
        
        async function fetchUserListings() {
            const user = auth.currentUser;

            if (!user) {
                showError('Please sign in to view your listings');
                return [];
            }

            const query = db.collection('products').where('userId', '==', user.uid);
            const snapshot = await query.get({ source: 'server' });

            if (snapshot.empty) {
                return [];
            }

            const listings = [];
            snapshot.forEach(doc => {
                listings.push({
                    ...doc.data(),
                    id: doc.id
                });
            });

            return listings;
        }

        async function updateListing(listingId, data) {
            try {
                await db.collection('products').doc(listingId).update({
                    ...data,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                return { success: true };
            } catch (error) {
                console.error('Error updating listing:', error);
                throw error;
            }
        }

        async function deleteListing(listingId) {
            try {
                await db.collection('products').doc(listingId).delete();
                return { success: true };
            } catch (error) {
                console.error('Error deleting listing:', error);
                throw error;
            }
        }

        const TOGGLE_LISTING_URL = 'https://us-central1-grappletrade.cloudfunctions.net/toggleListingActive';

        async function toggleListingActive(listingId) {
            const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
            if (!idToken) throw new Error('You must be signed in');

            const response = await fetch(TOGGLE_LISTING_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                body: JSON.stringify({ productId: listingId })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to toggle listing');
            return data;
        }

        // ============================================
        // RENDERING FUNCTIONS
        // ============================================

        function createListingCard(listing) {
            // Determine status - cancelled takes priority over sold
            let statusClass, statusText;
            if (listing.cancelled) {
                statusClass = 'status-draft';
                statusText = '❌ Cancelled';
            } else if (listing.sold) {
                statusClass = 'status-sold';
                statusText = '✅ SOLD';
            } else if (listing.active) {
                statusClass = 'status-active';
                statusText = 'Active';
            } else {
                statusClass = 'status-draft';
                statusText = 'Draft';
            }
            
            const _imgSrc = safeUrl(listing.images && listing.images[0]);
            const imageDisplay = _imgSrc
                ? `<img src="${esc(_imgSrc)}" alt="${esc(listing.title)}">`
                : '<span>📦 No Image</span>';

            // For sold items, create fulfillment page link
            const soldCardClass = listing.sold ? 'sold' : '';
            const orderId = listing.soldOrderId || 'unknown';
            const fulfillmentLink = `seller-order-fulfillment.html?productId=${listing.id}&orderId=${orderId}`;

            // Different actions based on sold status
            let actionsHtml;
            const isShipped = listing.trackingNumber || listing.shipped || listing.labelCreated;
            const hasRefundRequest = listing.refundRequested;

            if (listing.sold && !listing.cancelled) {
                if (hasRefundRequest) {
                    // REFUND REQUESTED - Show pending status
                    actionsHtml = `
                        <a href="${fulfillmentLink}" class="btn btn-primary" style="text-align: center;">
                            📦 View Order
                        </a>
                        <span style="color: #f59e0b; font-weight: 600; font-size: 12px;">Refund Requested</span>
                    `;
                } else if (isShipped) {
                    // SHIPPED ITEM - No cancel option, only view details
                    actionsHtml = `
                        <a href="${fulfillmentLink}" class="btn btn-primary" style="text-align: center;">
                            📦 View Shipment
                        </a>
                        <span style="color: #059669; font-size: 12px;">Shipped</span>
                    `;
                } else {
                    // SOLD BUT NOT SHIPPED - Can still cancel
                    actionsHtml = `
                        <a href="${fulfillmentLink}" class="btn btn-primary" style="text-align: center;">
                            📦 Ship Order
                        </a>
                        <button class="btn btn-danger" onclick="event.stopPropagation(); openSellerCancelModal('${listing.id}')">
                            Cancel Sale
                        </button>
                    `;
                }
            } else if (listing.cancelled) {
                // CANCELLED ITEM - offer relist
                actionsHtml = `
                    <button class="btn btn-primary" onclick="event.stopPropagation(); reactivateListing('${listing.id}')">
                        🔄 Relist Item
                    </button>
                    <button class="btn btn-danger" onclick="event.stopPropagation(); openDeleteModal('${listing.id}')">
                        🗑️
                    </button>
                `;
            } else {
                // AVAILABLE ITEM - Show edit/toggle/delete buttons
                actionsHtml = `
                    <button class="btn btn-primary" onclick="openEditModal('${listing.id}')">
                        Edit
                    </button>
                    <button class="btn btn-secondary" onclick="toggleActive('${listing.id}', ${listing.active || false})">
                        ${listing.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button class="btn btn-danger" onclick="openDeleteModal('${listing.id}')">
                        🗑️
                    </button>
                `;
            }

            return `
                <div class="listing-card ${soldCardClass}"
                     data-id="${listing.id}"
                     ${listing.sold && !listing.cancelled ? `onclick="window.location.href='${fulfillmentLink}'" style="cursor: pointer;"` : ''}>
                    <div class="listing-image">
                        ${imageDisplay}
                        <span class="status-badge ${statusClass}">${statusText}</span>
                    </div>
                    <div class="listing-content">
                        <h3 class="listing-title">${esc(listing.title) || 'Untitled'}</h3>
                        <div class="listing-price">$${parseFloat(listing.price || 0).toFixed(2)}</div>
                        
                        <div class="listing-details">
                            <span class="detail-item">📊 ${listing.stock || 0} in stock</span>
                            <span class="detail-item">👁️ ${listing.views || 0} views</span>
                        </div>

                        <div class="listing-actions" ${listing.sold ? 'onclick="event.stopPropagation()"' : ''}>
                            ${actionsHtml}
                        </div>
                    </div>
                </div>
            `;
        }

        async function renderListings() {
            const loadingSpinner = document.getElementById('loading-state');
            const grid = document.getElementById('listingsGrid');
            const emptyState = document.getElementById('emptyState');
            const errorState = document.getElementById('errorState');

            // Show loading, hide everything else
            loadingSpinner.style.display = 'block';
            grid.style.display = 'none';
            emptyState.style.display = 'none';
            errorState.style.display = 'none';

            let listings;
            try {
                listings = await fetchUserListings();
            } catch (error) {
                console.error('Error fetching listings:', error);
                loadingSpinner.style.display = 'none';
                errorState.style.display = 'block';
                return;
            }

            loadingSpinner.style.display = 'none';

            if (listings.length === 0) {
                emptyState.style.display = 'block';
                updateStatsDisplay({ totalListings: 0, activeListings: 0, totalValue: 0 });
                return;
            }

            grid.style.display = 'grid';
            grid.innerHTML = listings.map(listing => createListingCard(listing)).join('');

            // Ship-by deadline alerts
            const alertContainer = document.getElementById('ship-alerts');
            const pendingShipments = listings.filter(l => l.sold && !l.cancelled && !l.trackingNumber);
            if (pendingShipments.length > 0) {
                alertContainer.innerHTML = pendingShipments.map(l => {
                    const daysSinceSale = l.soldTimestamp ? Math.floor((Date.now() - l.soldTimestamp) / (1000 * 60 * 60 * 24)) : 0;
                    const daysLeft = Math.max(0, 10 - daysSinceSale);
                    const urgent = daysLeft <= 2;
                    const bg = urgent ? '#fdecea' : '#fff8e1';
                    const border = urgent ? '#dc3545' : '#ffc107';
                    const icon = daysLeft === 0 ? '🚨' : urgent ? '⚠️' : '📦';
                    const msg = daysLeft === 0
                        ? 'This order will be <strong>auto-cancelled today</strong> if not shipped!'
                        : `You have <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong> to ship or the order will be automatically cancelled and the buyer fully refunded.`;
                    return `<div style="background:${bg};border-left:5px solid ${border};border-radius:6px;padding:14px 18px;margin-bottom:10px;display:flex;align-items:flex-start;gap:12px;">
                        <span style="font-size:22px;flex-shrink:0;">${icon}</span>
                        <div style="flex:1;">
                            <strong style="font-size:14px;color:#1a1a1a;">${urgent ? 'ACTION REQUIRED — ' : ''}Ship "${esc(l.title) || 'your item'}"</strong>
                            <p style="margin:4px 0 0;font-size:13px;color:#555;line-height:1.5;">${msg} <a href="seller-order-fulfillment.html?productId=${l.id}" style="color:#c41e3a;font-weight:600;">View order →</a></p>
                        </div>
                    </div>`;
                }).join('');
                alertContainer.style.display = 'block';
            } else {
                alertContainer.innerHTML = '';
                alertContainer.style.display = 'none';
            }

            // Calculate stats
            const soldListings = listings.filter(l => l.sold);
            const stats = {
                totalListings: listings.length,
                activeListings: listings.filter(l => l.active && !l.sold).length,
                totalValue: listings.filter(l => !l.sold).reduce((sum, l) => sum + ((l.price || 0) * (l.stock || 0)), 0),
                // sellerReceivesCents is stored in cents on the product doc after a sale completes
                totalEarned: soldListings
                    .filter(l => l.sellerPaidOut)
                    .reduce((sum, l) => sum + ((l.sellerReceivesCents || 0) / 100), 0),
                pendingPayout: soldListings
                    .filter(l => !l.sellerPaidOut && !l.cancelled)
                    .reduce((sum, l) => sum + ((l.sellerReceivesCents || 0) / 100), 0),
            };
            updateStatsDisplay(stats);

            // Cache for stats tab
            _allListings = listings;
            _statsLoaded = false;
        }

        function updateStatsDisplay(stats) {
            document.getElementById('totalListings').textContent = stats.totalListings;
            document.getElementById('activeListings').textContent = stats.activeListings;
            document.getElementById('totalValue').textContent = `$${parseFloat(stats.totalValue).toFixed(2)}`;
            document.getElementById('totalEarned').textContent = `$${parseFloat(stats.totalEarned || 0).toFixed(2)}`;
            document.getElementById('pendingPayout').textContent = `$${parseFloat(stats.pendingPayout || 0).toFixed(2)}`;
        }

        function showError(message) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.textContent = message;
            
            const container = document.querySelector('.container');
            container.insertBefore(errorDiv, container.firstChild);
            
            setTimeout(() => errorDiv.remove(), 5000);
        }

        function showInfo(message) {
            const infoDiv = document.createElement('div');
            infoDiv.className = 'info-message';
            infoDiv.textContent = message;
            
            const container = document.querySelector('.container');
            container.insertBefore(infoDiv, container.firstChild);
            
            setTimeout(() => infoDiv.remove(), 5000);
        }

        // ============================================
        // EDIT FUNCTIONALITY
        // ============================================

        async function openEditModal(listingId) {
            try {
                const doc = await db.collection('products').doc(listingId).get();
                
                if (!doc.exists) {
                    showError('Listing not found');
                    return;
                }

                const listing = doc.data();
                
                // Don't allow editing sold items
                if (listing.sold) {
                    showError('Cannot edit sold items');
                    return;
                }
                
                document.getElementById('editListingId').value = listingId;
                document.getElementById('editTitle').value = listing.title || '';
                document.getElementById('editPrice').value = listing.price || 0;
                document.getElementById('editStock').value = listing.stock || 0;
                document.getElementById('editDescription').value = listing.description || '';
                document.getElementById('editActive').checked = listing.active || false;

                document.getElementById('editModal').classList.add('active');
            } catch (error) {
                console.error('Error loading listing:', error);
                showError('Failed to load listing details: ' + error.message);
            }
        }

        function closeEditModal() {
            document.getElementById('editModal').classList.remove('active');
            document.getElementById('editError').innerHTML = '';
        }

        document.getElementById('editForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const saveBtn = document.getElementById('saveBtn');
            const originalText = saveBtn.textContent;
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;

            const listingId = document.getElementById('editListingId').value;
            
            const updatedData = {
                title: document.getElementById('editTitle').value,
                price: parseFloat(document.getElementById('editPrice').value),
                stock: parseInt(document.getElementById('editStock').value),
                description: document.getElementById('editDescription').value,
                active: document.getElementById('editActive').checked
            };

            try {
                await updateListing(listingId, updatedData);
                closeEditModal();
                await renderListings();
                showInfo('Listing updated successfully!');
            } catch (error) {
                document.getElementById('editError').textContent = 'Failed to save changes: ' + error.message;
            } finally {
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
            }
        });

        // ============================================
        // TOGGLE ACTIVE/INACTIVE
        // ============================================

        async function toggleActive(listingId, currentStatus) {
            try {
                const result = await toggleListingActive(listingId);
                await renderListings();
                showInfo(`Listing ${result.active ? 'activated' : 'deactivated'} successfully!`);
            } catch (error) {
                showError('Failed to toggle listing status: ' + error.message);
            }
        }

        // ============================================
        // RELIST CANCELLED ITEM
        // ============================================

        const REACTIVATE_LISTING_URL = 'https://us-central1-grappletrade.cloudfunctions.net/reactivateListing';

        async function reactivateListing(listingId) {
            try {
                const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
                if (!idToken) throw new Error('You must be signed in');

                const response = await fetch(REACTIVATE_LISTING_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`,
                    },
                    body: JSON.stringify({ productId: listingId }),
                });

                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Failed to relist item');

                await renderListings();
                showInfo('Listing reactivated — it\'s visible to buyers again!');
            } catch (error) {
                showError('Failed to relist item: ' + error.message);
            }
        }

        // ============================================
        // DELETE FUNCTIONALITY
        // ============================================

        let listingToDelete = null;

        function openDeleteModal(listingId) {
            listingToDelete = listingId;
            document.getElementById('deleteModal').classList.add('active');
        }

        function closeDeleteModal() {
            listingToDelete = null;
            document.getElementById('deleteModal').classList.remove('active');
        }

        async function confirmDelete() {
            if (!listingToDelete) return;

            const deleteBtn = document.getElementById('deleteBtn');
            const originalText = deleteBtn.textContent;
            deleteBtn.textContent = 'Deleting...';
            deleteBtn.disabled = true;

            try {
                await deleteListing(listingToDelete);
                closeDeleteModal();
                await renderListings();
                showInfo('Listing deleted successfully!');
            } catch (error) {
                showError('Failed to delete listing: ' + error.message);
                deleteBtn.textContent = originalText;
                deleteBtn.disabled = false;
            }
        }

        // ============================================
        // SELLER CANCEL ORDER FUNCTIONALITY
        // ============================================

        const SELLER_CANCEL_ORDER_URL = 'https://us-central1-grappletrade.cloudfunctions.net/sellerCancelOrder';
        let saleToCancel = null;

        function openSellerCancelModal(listingId) {
            saleToCancel = listingId;

            // Show current strike count from user data if available
            const user = auth.currentUser;
            if (user) {
                db.collection('users').doc(user.uid).get().then(userDoc => {
                    const count = userDoc.exists ? (userDoc.data().sellerCancellationCount || 0) : 0;
                    const remainingAfter = Math.max(0, 3 - count - 1);
                    document.getElementById('sellerCancelStrikeDetails').textContent =
                        `Current strikes: ${count}/3 — You will have ${remainingAfter} strike${remainingAfter !== 1 ? 's' : ''} remaining after this cancellation.`;
                }).catch(() => {});
            }

            document.getElementById('sellerCancelModal').classList.add('active');
        }

        function closeSellerCancelModal() {
            saleToCancel = null;
            document.getElementById('sellerCancelModal').classList.remove('active');
        }

        async function confirmSellerCancel() {
            if (!saleToCancel) return;

            const cancelBtn = document.getElementById('confirmSellerCancelBtn');
            const originalText = cancelBtn.textContent;
            cancelBtn.textContent = 'Processing...';
            cancelBtn.disabled = true;

            try {
                const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
                if (!idToken) throw new Error('You must be signed in to cancel a sale');

                const response = await fetch(SELLER_CANCEL_ORDER_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify({ productId: saleToCancel })
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || 'Failed to process cancellation');
                }

                closeSellerCancelModal();
                await renderListings();

                // Show strike warning popup
                showStrikeWarning(result.sellerCancellationCount, result.sellerSuspended, result.strikesRemaining);

            } catch (error) {
                showError('Failed to cancel sale: ' + error.message);
                cancelBtn.textContent = originalText;
                cancelBtn.disabled = false;
            }
        }

        function showStrikeWarning(count, suspended, strikesRemaining) {
            const title = document.getElementById('strikeWarningTitle');
            const msg = document.getElementById('strikeWarningMessage');

            if (suspended) {
                title.textContent = '🚫 Account Suspended';
                msg.innerHTML = `You have reached <strong>${count} cancellations</strong> and can no longer sell on GrappleTrade. If you believe this is an error, please contact support.`;
            } else {
                title.textContent = '⚠️ Strike Recorded';
                msg.innerHTML = `You have <strong>${count} of 3</strong> strikes. You have <strong>${strikesRemaining} strike${strikesRemaining !== 1 ? 's' : ''} remaining</strong> before you can no longer sell on this site.<br><br>The buyer has been fully refunded.`;
            }

            document.getElementById('strikeWarningModal').classList.add('active');
        }

        function closeStrikeWarningModal() {
            document.getElementById('strikeWarningModal').classList.remove('active');
        }

        // ============================================
        // INITIALIZATION
        // ============================================

        async function loadSellerChecklist(user) {
            const steps = [
                { id: 'profile', label: 'Complete your profile', href: 'profile.html' },
                { id: 'stripe', label: 'Connect Stripe to receive payouts', href: 'settings.html' },
                { id: 'listing', label: 'Create your first listing', href: 'sell.html' },
            ];

            let stripeConnected = false;
            let hasListing = false;
            let profileComplete = !!(user.displayName);

            try {
                const userDoc = await db.collection('users').doc(user.uid).get();
                if (userDoc.exists) {
                    const data = userDoc.data();
                    stripeConnected = !!(data.stripeAccountId && data.stripeChargesEnabled && data.stripePayoutsEnabled);
                    if (data.displayName) profileComplete = true;
                }
                const listingSnap = await db.collection('products').where('userId', '==', user.uid).limit(1).get();
                hasListing = !listingSnap.empty;
            } catch(e) {}

            const completed = {
                profile: profileComplete,
                stripe: stripeConnected,
                listing: hasListing,
            };

            const allDone = Object.values(completed).every(Boolean);
            if (allDone) return; // Hide checklist if everything is done

            const checklist = document.getElementById('seller-checklist');
            const itemsEl = document.getElementById('checklist-items');

            itemsEl.innerHTML = steps.map(step => {
                const done = completed[step.id];
                return `<a href="${step.href}" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:${done ? '#f0fdf4' : '#fafafa'};border:1px solid ${done ? '#bbf7d0' : '#e5e5e5'};text-decoration:none;color:inherit;">
                    <span style="font-size:18px;">${done ? '✅' : '⬜'}</span>
                    <span style="font-size:14px;${done ? 'text-decoration:line-through;color:#888;' : ''}">${step.label}</span>
                    ${!done ? '<span style="margin-left:auto;font-size:12px;color:#c0392b;font-weight:600;">→</span>' : ''}
                </a>`;
            }).join('');

            checklist.style.display = 'block';
        }

        auth.onAuthStateChanged(async (user) => {
            const menuWrapper = document.getElementById('user-menu-wrapper');

            if (user) {

                // Update header with dropdown
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

                await renderListings();
                loadSellerChecklist(user);
            } else {
                // Update header for signed out user
                menuWrapper.innerHTML = `
                    <button class="top-bar-btn" onclick="window.location.href='sign-in.html'">Hi! Sign in</button>
                `;

                document.getElementById('loading-state').style.display = 'none';
                document.getElementById('emptyState').style.display = 'block';
                document.getElementById('emptyState').innerHTML = `
                    <div class="empty-state-icon">🔒</div>
                    <h2 class="empty-state-title">Sign In Required</h2>
                    <p class="empty-state-text">Please sign in to view your listings</p>
                    <a href="sign-in.html" class="btn btn-primary">Sign In</a>
                `;
            }
        });

        // ============================================
        // TAB NAVIGATION & STATISTICS
        // ============================================

        let _statsLoaded = false;
        let _allListings = [];
        let _earningsChartInst = null;
        let _categoryChartInst = null;

        function switchTab(tab) {
            const listingsView = document.getElementById('listings-view');
            const statsView = document.getElementById('stats-view');
            const tabListings = document.getElementById('tab-listings');
            const tabStats = document.getElementById('tab-stats');

            if (tab === 'listings') {
                listingsView.style.display = 'block';
                statsView.style.display = 'none';
                tabListings.style.color = '#c41e3a';
                tabListings.style.borderBottomColor = '#c41e3a';
                tabStats.style.color = '#666';
                tabStats.style.borderBottomColor = 'transparent';
            } else {
                listingsView.style.display = 'none';
                statsView.style.display = 'block';
                tabListings.style.color = '#666';
                tabListings.style.borderBottomColor = 'transparent';
                tabStats.style.color = '#c41e3a';
                tabStats.style.borderBottomColor = '#c41e3a';

                if (!_statsLoaded) {
                    if (_allListings.length > 0) {
                        loadStats(_allListings);
                    } else {
                        document.getElementById('stats-loading').style.display = 'none';
                        document.getElementById('stats-content').style.display = 'block';
                        renderStatsView({
                            thisMonthEarnings: 0, thisMonthCount: 0,
                            lastMonthEarnings: 0, lastMonthCount: 0,
                            allTimeEarnings: 0, allTimeSoldCount: 0,
                            activeCount: 0, monthlyData: [], categoryMap: {},
                            yearProjection: 0, yearPct: 0,
                            recentSales: [], listings: [],
                        });
                    }
                }
            }
        }

        function loadStats(listings) {
            _statsLoaded = true;
            document.getElementById('stats-loading').style.display = 'none';

            const now = new Date();
            const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();

            const soldListings = listings.filter(l => l.sold && !l.cancelled);

            const thisMonthSales = soldListings.filter(l => (l.soldTimestamp || 0) >= thisMonthStart);
            const thisMonthEarnings = thisMonthSales.reduce((sum, l) => sum + ((l.sellerReceivesCents || 0) / 100), 0);

            const lastMonthSales = soldListings.filter(l => (l.soldTimestamp || 0) >= lastMonthStart && (l.soldTimestamp || 0) < thisMonthStart);
            const lastMonthEarnings = lastMonthSales.reduce((sum, l) => sum + ((l.sellerReceivesCents || 0) / 100), 0);

            const allTimeEarnings = soldListings.reduce((sum, l) => sum + ((l.sellerReceivesCents || 0) / 100), 0);
            const activeCount = listings.filter(l => l.active && !l.sold && !l.cancelled).length;

            // Last 6 months bar chart data
            const monthlyData = [];
            for (let i = 5; i >= 0; i--) {
                const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1).getTime();
                const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1).getTime();
                const label = new Date(now.getFullYear(), now.getMonth() - i, 1)
                    .toLocaleDateString('en-US', { month: 'short' });
                const earnings = soldListings
                    .filter(l => (l.soldTimestamp || 0) >= mStart && (l.soldTimestamp || 0) < mEnd)
                    .reduce((sum, l) => sum + ((l.sellerReceivesCents || 0) / 100), 0);
                monthlyData.push({ label, earnings });
            }

            // Category breakdown
            const categoryMap = {};
            soldListings.forEach(l => {
                const cat = l.category || 'Other';
                categoryMap[cat] = (categoryMap[cat] || 0) + ((l.sellerReceivesCents || 0) / 100);
            });

            // Annual projection based on all-time daily pace
            const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
            const dayOfYear = Math.max(1, Math.floor((now.getTime() - startOfYear) / (1000 * 60 * 60 * 24)));
            const daysInYear = now.getFullYear() % 4 === 0 ? 366 : 365;
            const yearPct = Math.round((dayOfYear / daysInYear) * 100);
            const yearEarnedSoFar = soldListings
                .filter(l => (l.soldTimestamp || 0) >= startOfYear)
                .reduce((sum, l) => sum + ((l.sellerReceivesCents || 0) / 100), 0);
            const yearProjection = yearEarnedSoFar > 0 ? (yearEarnedSoFar / dayOfYear) * daysInYear : 0;

            const recentSales = [...soldListings]
                .sort((a, b) => (b.soldTimestamp || 0) - (a.soldTimestamp || 0))
                .slice(0, 5);

            renderStatsView({
                thisMonthEarnings, thisMonthCount: thisMonthSales.length,
                lastMonthEarnings, lastMonthCount: lastMonthSales.length,
                allTimeEarnings, allTimeSoldCount: soldListings.length,
                activeCount, monthlyData, categoryMap,
                yearProjection, yearPct,
                recentSales, listings,
            });

            document.getElementById('stats-content').style.display = 'block';

            // Leaderboard loads async after render
            const user = auth.currentUser;
            loadLeaderboard(user ? user.uid : null);
        }

        function renderStatsView(data) {
            const {
                thisMonthEarnings, thisMonthCount,
                lastMonthEarnings, lastMonthCount,
                allTimeEarnings, allTimeSoldCount,
                activeCount, monthlyData, categoryMap,
                yearProjection, yearPct,
                recentSales, listings,
            } = data;

            // Banner
            const bannerMsgs = [
                allTimeSoldCount > 0 && thisMonthCount > 0
                    ? `You've sold ${thisMonthCount} item${thisMonthCount !== 1 ? 's' : ''} this month — keep it up!`
                    : null,
                allTimeSoldCount > 0
                    ? `${allTimeSoldCount} item${allTimeSoldCount !== 1 ? 's' : ''} sold all time. You're building something great!`
                    : null,
                activeCount > 0
                    ? `${activeCount} listing${activeCount !== 1 ? 's' : ''} live and waiting for buyers.`
                    : null,
                'Great sellers ship fast — buyers love it!',
            ].filter(Boolean);
            document.getElementById('stats-banner-msg').textContent = bannerMsgs[0] || 'Welcome to your seller dashboard!';

            // Hero cards
            document.getElementById('s-month-earnings').textContent = '$' + thisMonthEarnings.toFixed(2);
            document.getElementById('s-month-count').textContent = thisMonthCount;
            document.getElementById('s-alltime-earnings').textContent = '$' + allTimeEarnings.toFixed(2);
            document.getElementById('s-alltime-count').textContent = allTimeSoldCount + ' item' + (allTimeSoldCount !== 1 ? 's' : '') + ' sold';
            document.getElementById('s-active-count').textContent = activeCount;

            // Month change
            const changeEl = document.getElementById('s-month-change');
            if (lastMonthEarnings > 0) {
                const pct = Math.abs(((thisMonthEarnings - lastMonthEarnings) / lastMonthEarnings) * 100).toFixed(0);
                const isUp = thisMonthEarnings >= lastMonthEarnings;
                changeEl.innerHTML = '<span style="color:' + (isUp ? '#059669' : '#dc2626') + ';font-weight:600;">' + (isUp ? '▲' : '▼') + ' ' + pct + '%</span> vs last month';
            } else if (thisMonthEarnings > 0) {
                changeEl.innerHTML = '<span style="color:#059669;font-weight:600;">First earnings this month!</span>';
            } else {
                changeEl.textContent = 'No sales yet this month';
            }

            // Projection
            const fmtMoney = v => '$' + Math.round(v).toLocaleString();
            document.getElementById('s-projection-amt').textContent = yearProjection > 0 ? fmtMoney(yearProjection) : '$—';
            document.getElementById('s-projection-year').textContent = new Date().getFullYear();
            document.getElementById('s-year-pct').textContent = yearPct + '% through the year';
            setTimeout(() => { document.getElementById('s-year-progress').style.width = yearPct + '%'; }, 100);

            // Month comparison bars
            const compEl = document.getElementById('s-month-comparison');
            const compItems = [
                { label: 'Earnings', thisVal: thisMonthEarnings, lastVal: lastMonthEarnings, fmt: v => '$' + v.toFixed(2) },
                { label: 'Items Sold', thisVal: thisMonthCount, lastVal: lastMonthCount, fmt: v => v + ' item' + (v !== 1 ? 's' : '') },
            ];
            compEl.innerHTML = compItems.map(item => {
                const max = Math.max(item.thisVal, item.lastVal, 0.01);
                const thisPct = Math.round((item.thisVal / max) * 100);
                const lastPct = Math.round((item.lastVal / max) * 100);
                return '<div>' +
                    '<div style="display:flex;justify-content:space-between;margin-bottom:8px;">' +
                        '<span style="font-size:13px;font-weight:600;color:#333;">' + item.label + '</span>' +
                        '<span style="font-size:13px;color:#888;">' + item.fmt(item.lastVal) + ' → <strong style="color:#1a1a1a;">' + item.fmt(item.thisVal) + '</strong></span>' +
                    '</div>' +
                    '<div style="display:flex;flex-direction:column;gap:6px;">' +
                        '<div style="display:flex;align-items:center;gap:8px;">' +
                            '<span style="font-size:11px;color:#888;min-width:70px;text-align:right;">Last month</span>' +
                            '<div style="flex:1;background:#f3f4f6;border-radius:999px;height:8px;overflow:hidden;">' +
                                '<div style="height:100%;border-radius:999px;background:#d1d5db;width:' + lastPct + '%;"></div>' +
                            '</div>' +
                        '</div>' +
                        '<div style="display:flex;align-items:center;gap:8px;">' +
                            '<span style="font-size:11px;color:#c41e3a;min-width:70px;text-align:right;">This month</span>' +
                            '<div style="flex:1;background:#f3f4f6;border-radius:999px;height:8px;overflow:hidden;">' +
                                '<div style="height:100%;border-radius:999px;background:#c41e3a;width:' + thisPct + '%;"></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }).join('');

            // Recent sales
            const recentEl = document.getElementById('s-recent-sales');
            if (recentSales.length === 0) {
                recentEl.innerHTML = '<p style="color:#888;font-size:13px;margin:0;">No sales yet — your first sale will appear here.</p>';
            } else {
                recentEl.innerHTML = recentSales.map(l => {
                    const earned = (l.sellerReceivesCents || 0) / 100;
                    const date = l.soldTimestamp
                        ? new Date(l.soldTimestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                        : '—';
                    const _rSrc = safeUrl(l.images && l.images[0]);
                    const imgHtml = _rSrc
                        ? '<img src="' + esc(_rSrc) + '" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;">'
                        : '<div style="width:40px;height:40px;border-radius:6px;background:#f5f5f5;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">📦</div>';
                    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #f5f5f5;">' +
                        imgHtml +
                        '<div style="flex:1;min-width:0;">' +
                            '<div style="font-size:13px;font-weight:600;color:#1a1a1a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (esc(l.title) || 'Item') + '</div>' +
                            '<div style="font-size:12px;color:#888;">' + date + '</div>' +
                        '</div>' +
                        '<div style="font-size:14px;font-weight:700;color:#059669;white-space:nowrap;">+$' + earned.toFixed(2) + '</div>' +
                    '</div>';
                }).join('');
            }

            // Milestones
            const milestones = [
                { label: 'First Sale', icon: '🎉', earned: allTimeSoldCount >= 1 },
                { label: '5 Sales', icon: '⭐', earned: allTimeSoldCount >= 5 },
                { label: '10 Sales', icon: '🔥', earned: allTimeSoldCount >= 10 },
                { label: '25 Sales', icon: '💪', earned: allTimeSoldCount >= 25 },
                { label: '$100 Earned', icon: '💰', earned: allTimeEarnings >= 100 },
                { label: '$500 Earned', icon: '💎', earned: allTimeEarnings >= 500 },
                { label: '$1,000 Earned', icon: '🏆', earned: allTimeEarnings >= 1000 },
                { label: '$5,000 Earned', icon: '👑', earned: allTimeEarnings >= 5000 },
            ];
            document.getElementById('s-milestones').innerHTML = milestones.map(m =>
                '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;background:' + (m.earned ? '#f0fdf4' : '#fafafa') + ';border:1px solid ' + (m.earned ? '#bbf7d0' : '#e5e5e5') + ';opacity:' + (m.earned ? '1' : '0.55') + ';">' +
                    '<span style="font-size:20px;">' + m.icon + '</span>' +
                    '<div>' +
                        '<div style="font-size:12px;font-weight:700;color:' + (m.earned ? '#059669' : '#666') + ';">' + m.label + '</div>' +
                        '<div style="font-size:10px;color:#aaa;">' + (m.earned ? 'Unlocked!' : 'Locked') + '</div>' +
                    '</div>' +
                '</div>'
            ).join('');

            // Tips
            const hasLowViews = listings.some(l => l.active && !l.sold && (l.views || 0) < 5);
            const tips = [
                { icon: '📸', tip: 'Clear photos sell 3x faster. Add multiple angles so buyers see exactly what they\'re getting.', show: true },
                { icon: '📦', tip: 'Ship within 24 hours of a sale — fast shippers get better feedback and repeat buyers.', show: true },
                { icon: '💬', tip: 'Respond to buyer messages within an hour to increase your conversion rate.', show: true },
                { icon: '👁️', tip: 'Some of your listings have low views — try refreshing the title or adding better photos.', show: hasLowViews },
                { icon: '🏷️', tip: 'Keep prices competitive. Check the price guide on the sell page before listing.', show: activeCount >= 3 },
            ].filter(t => t.show).slice(0, 3);
            document.getElementById('s-tips').innerHTML = tips.map(t =>
                '<div style="display:flex;align-items:flex-start;gap:12px;padding:12px;border-radius:8px;background:#fafafa;border:1px solid #f0f0f0;">' +
                    '<span style="font-size:24px;flex-shrink:0;line-height:1;">' + t.icon + '</span>' +
                    '<p style="margin:0;font-size:13px;color:#555;line-height:1.55;">' + t.tip + '</p>' +
                '</div>'
            ).join('');

            // Charts
            renderCharts(monthlyData, categoryMap);

            // Goal tracker
            initGoal(thisMonthEarnings);
        }

        function renderCharts(monthlyData, categoryMap) {
            if (_earningsChartInst) { _earningsChartInst.destroy(); _earningsChartInst = null; }
            if (_categoryChartInst) { _categoryChartInst.destroy(); _categoryChartInst = null; }

            if (typeof Chart === 'undefined') return;

            // Monthly earnings bar chart
            const earningsCtx = document.getElementById('earningsChart');
            if (earningsCtx) {
                _earningsChartInst = new Chart(earningsCtx, {
                    type: 'bar',
                    data: {
                        labels: monthlyData.map(m => m.label),
                        datasets: [{
                            label: 'Earnings',
                            data: monthlyData.map(m => m.earnings),
                            backgroundColor: monthlyData.map((m, i) =>
                                i === monthlyData.length - 1 ? '#c41e3a' : 'rgba(196,30,58,0.25)'
                            ),
                            borderRadius: 6,
                            borderSkipped: false,
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            tooltip: { callbacks: { label: ctx => '$' + ctx.parsed.y.toFixed(2) } }
                        },
                        scales: {
                            y: {
                                beginAtZero: true,
                                ticks: { callback: v => '$' + v },
                                grid: { color: '#f5f5f5' }
                            },
                            x: { grid: { display: false } }
                        }
                    }
                });
                earningsCtx.style.height = '200px';
            }

            // Category donut chart
            const catCtx = document.getElementById('categoryChart');
            if (catCtx) {
                const cats = Object.keys(categoryMap);
                const colors = ['#c41e3a','#3b82f6','#059669','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#84cc16'];
                if (cats.length > 0) {
                    _categoryChartInst = new Chart(catCtx, {
                        type: 'doughnut',
                        data: {
                            labels: cats,
                            datasets: [{
                                data: cats.map(c => categoryMap[c]),
                                backgroundColor: colors.slice(0, cats.length),
                                borderWidth: 2,
                                borderColor: '#fff',
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            cutout: '62%',
                            plugins: {
                                legend: { display: false },
                                tooltip: { callbacks: { label: ctx => ctx.label + ': $' + ctx.parsed.toFixed(2) } }
                            }
                        }
                    });
                    catCtx.style.height = '160px';

                    const legendEl = document.getElementById('category-legend');
                    if (legendEl) {
                        legendEl.innerHTML = cats.map((cat, i) =>
                            '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
                                '<div style="width:10px;height:10px;border-radius:2px;background:' + colors[i] + ';flex-shrink:0;"></div>' +
                                '<span style="color:#555;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + cat + '</span>' +
                                '<span style="font-weight:600;color:#333;">$' + (categoryMap[cat] || 0).toFixed(0) + '</span>' +
                            '</div>'
                        ).join('');
                    }
                } else {
                    catCtx.parentElement.innerHTML += '<p style="color:#aaa;font-size:13px;text-align:center;margin-top:20px;">No sales yet</p>';
                }
            }
        }

        // ============================================
        // MONTHLY GOAL TRACKER
        // ============================================

        let _currentMonthEarnings = 0;

        function initGoal(monthEarnings) {
            _currentMonthEarnings = monthEarnings;
            const now = new Date();
            const key = 'seller_goal_' + now.getFullYear() + '_' + now.getMonth();
            const saved = parseFloat(localStorage.getItem(key) || '0');
            const monthName = now.toLocaleDateString('en-US', { month: 'long' });
            document.getElementById('goal-month-label').textContent = 'Your earnings target for ' + monthName;
            if (saved > 0) renderGoalProgress(saved, monthEarnings);
        }

        function saveGoal() {
            const input = document.getElementById('goal-input');
            const goal = parseFloat(input.value);
            if (!goal || goal <= 0) return;
            const now = new Date();
            const key = 'seller_goal_' + now.getFullYear() + '_' + now.getMonth();
            localStorage.setItem(key, goal.toString());
            renderGoalProgress(goal, _currentMonthEarnings);
        }

        function renderGoalProgress(goal, earned) {
            if (!goal || goal <= 0) return;
            document.getElementById('goal-input').value = goal;
            const pct = Math.min(100, Math.round((earned / goal) * 100));
            const wrap = document.getElementById('goal-progress-wrap');
            wrap.style.display = 'block';
            document.getElementById('goal-progress-label').textContent = '$' + earned.toFixed(2) + ' of $' + goal.toFixed(2);
            document.getElementById('goal-pct-label').textContent = pct + '%';
            const bar = document.getElementById('goal-bar');
            setTimeout(() => { bar.style.width = pct + '%'; }, 100);

            const remaining = (goal - earned).toFixed(2);
            const now = new Date();
            const monthName = now.toLocaleDateString('en-US', { month: 'long' });
            let msg, color;
            if (pct >= 100) {
                msg = '🎉 Goal crushed! You hit your ' + monthName + ' target. Time to set a bigger one!';
                color = '#059669';
                bar.style.background = 'linear-gradient(90deg,#059669,#10b981)';
                document.getElementById('goal-pct-label').style.color = '#059669';
            } else if (pct >= 75) {
                msg = '🔥 Almost there — just $' + remaining + ' left to reach your goal!';
                color = '#d97706';
            } else if (pct >= 50) {
                msg = '💪 Halfway there! Keep the momentum going — $' + remaining + ' to go.';
                color = '#3b82f6';
            } else if (pct > 0) {
                msg = 'Good start! You need $' + remaining + ' more to hit your ' + monthName + ' goal.';
                color = '#555';
            } else {
                msg = 'No sales yet this month. Your first sale will get this moving!';
                color = '#888';
            }
            document.getElementById('goal-msg').innerHTML = '<span style="color:' + color + ';">' + msg + '</span>';
        }

        // ============================================
        // LEADERBOARD
        // ============================================

        async function loadLeaderboard(currentUserId) {
            const listEl = document.getElementById('leaderboard-list');
            try {
                const now = new Date();
                const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

                const snap = await db.collection('products')
                    .where('sold', '==', true)
                    .where('soldTimestamp', '>=', thisMonthStart)
                    .limit(100)
                    .get();

                if (snap.empty) {
                    listEl.innerHTML = '<p style="color:#aaa;font-size:13px;text-align:center;padding:16px 0;margin:0;">No sales this month yet — be the first on the board!</p>';
                    return;
                }

                // Count items sold per seller
                const counts = {};
                snap.forEach(doc => {
                    const uid = doc.data().userId;
                    if (uid) counts[uid] = (counts[uid] || 0) + 1;
                });

                const allRanked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                const top5 = allRanked.slice(0, 5);
                const userRank = currentUserId ? allRanked.findIndex(([uid]) => uid === currentUserId) + 1 : 0;

                // Fetch user names for top 5
                const userDocs = await Promise.all(top5.map(([uid]) => db.collection('users').doc(uid).get()));

                const rankIcons = ['🥇', '🥈', '🥉', '4', '5'];
                listEl.innerHTML = top5.map(([uid, count], i) => {
                    const doc = userDocs[i];
                    const name = esc(doc.exists ? (doc.data().username || doc.data().displayName || 'Seller') : 'Seller');
                    const isMe = uid === currentUserId;
                    const rankDisplay = i < 3
                        ? '<span style="font-size:20px;width:28px;text-align:center;">' + rankIcons[i] + '</span>'
                        : '<span style="font-size:13px;font-weight:700;color:#888;width:28px;text-align:center;">#' + (i + 1) + '</span>';
                    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;background:' + (isMe ? '#fef2f2' : (i % 2 === 0 ? '#fafafa' : '#fff')) + ';border:1px solid ' + (isMe ? '#fca5a5' : 'transparent') + ';margin-bottom:6px;">' +
                        rankDisplay +
                        '<div style="flex:1;font-size:14px;font-weight:' + (isMe ? '700' : '500') + ';color:' + (isMe ? '#c41e3a' : '#1a1a1a') + ';">' + name + (isMe ? ' <span style="font-size:11px;background:#fca5a5;color:#7f1d1d;padding:1px 6px;border-radius:999px;">you</span>' : '') + '</div>' +
                        '<div style="font-size:13px;font-weight:600;color:#555;">' + count + ' sold</div>' +
                    '</div>';
                }).join('');

                // Show current user's rank if outside top 5
                if (currentUserId && userRank > 5) {
                    const userCount = counts[currentUserId] || 0;
                    listEl.innerHTML += '<div style="margin-top:10px;padding:10px 14px;border-radius:8px;background:#fef2f2;border:1px dashed #fca5a5;font-size:13px;color:#7f1d1d;text-align:center;">You\'re ranked <strong>#' + userRank + '</strong> this month with <strong>' + userCount + ' sale' + (userCount !== 1 ? 's' : '') + '</strong> — keep going!</div>';
                } else if (currentUserId && userRank === 0 && !counts[currentUserId]) {
                    listEl.innerHTML += '<div style="margin-top:10px;padding:10px 14px;border-radius:8px;background:#f9fafb;border:1px dashed #e5e5e5;font-size:13px;color:#888;text-align:center;">You haven\'t sold anything this month yet — make your first sale to get on the board!</div>';
                }
            } catch (e) {
                listEl.innerHTML = '<p style="color:#aaa;font-size:13px;text-align:center;padding:16px 0;margin:0;">Could not load leaderboard.</p>';
                console.warn('Leaderboard error:', e);
            }
        }

        // Close modals when clicking outside
        document.getElementById('editModal').addEventListener('click', function(e) {
            if (e.target === this) closeEditModal();
        });

        document.getElementById('deleteModal').addEventListener('click', function(e) {
            if (e.target === this) closeDeleteModal();
        });

        document.getElementById('sellerCancelModal').addEventListener('click', function(e) {
            if (e.target === this) closeSellerCancelModal();
        });

        document.getElementById('strikeWarningModal').addEventListener('click', function(e) {
            if (e.target === this) closeStrikeWarningModal();
        });