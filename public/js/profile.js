        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, collection, query, where, getDocs, doc, getDoc, addDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

        // Get userId from URL parameter
        const urlParams = new URLSearchParams(window.location.search);
        const profileUserId = urlParams.get('user');

        let currentUser = null;
        let isOwnProfile = false;

        // Load profile data
        onAuthStateChanged(auth, async (user) => {
            currentUser = user;

            if (!user && !profileUserId) {
                window.location.href = 'sign-in.html';
                return;
            }

            const targetUserId = profileUserId || (user ? user.uid : null);
            isOwnProfile = user && (!profileUserId || profileUserId === user.uid);

            if (!targetUserId) {
                document.getElementById('loadingState').innerHTML = '<p>User not found</p>';
                return;
            }

            await loadUserProfile(targetUserId);
        });

        async function loadUserProfile(userId) {
            try {
                let userData = {};

                if (isOwnProfile && currentUser) {
                    // Owner: read own doc directly from Firestore (authenticated)
                    const userDocSnap = await getDoc(doc(db, 'users', userId));
                    userData = userDocSnap.exists() ? userDocSnap.data() : {};
                } else {
                    // Non-owner: use Cloud Function to avoid exposing sensitive fields
                    const resp = await fetch(
                        `https://us-central1-grappletrade.cloudfunctions.net/getPublicProfile?uid=${encodeURIComponent(userId)}`
                    );
                    if (!resp.ok) throw new Error('Profile not found');
                    userData = await resp.json();
                }

                // Determine display name: own profile uses Auth data, others use Firestore
                let displayName, username, bio, photoURL;
                if (isOwnProfile && currentUser) {
                    displayName = currentUser.displayName || currentUser.email?.split('@')[0] || 'User';
                    username = userData.username || currentUser.email?.split('@')[0] || 'user';
                    bio = userData.bio || '';
                    photoURL = currentUser.photoURL || null;
                } else {
                    displayName = userData.displayName || userData.username || 'GrappleTrade User';
                    username = userData.username || userId.substring(0, 8);
                    bio = userData.bio || '';
                    photoURL = userData.photoURL || null;
                }

                // Load active products
                const productsSnap = await getDocs(
                    query(collection(db, 'products'), where('userId', '==', userId), where('active', '==', true))
                );
                const soldSnap = await getDocs(
                    query(collection(db, 'products'), where('userId', '==', userId), where('sold', '==', true))
                );
                const activeProducts = productsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => !p.sold);

                // Load reviews from sellerRatings collection
                const ratingsSnap = await getDocs(
                    query(collection(db, 'sellerRatings'), where('sellerId', '==', userId))
                );
                const reviews = ratingsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                const totalReviews = reviews.length;
                const averageRating = totalReviews > 0
                    ? reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / totalReviews
                    : 0;

                document.getElementById('profile-name').textContent = displayName;
                document.getElementById('profile-username').textContent = '@' + username;
                document.getElementById('profile-bio').textContent = bio || 'No bio yet.';

                if (photoURL) {
                    const imgEl = document.createElement('img');
                    imgEl.src = photoURL;
                    imgEl.className = 'profile-image';
                    imgEl.style.cssText = 'width:150px;height:150px;border-radius:50%;object-fit:cover;border:4px solid #c41e3a;';
                    document.getElementById('profile-image').replaceWith(imgEl);
                }

                document.getElementById('items-sold').textContent = soldSnap.size;
                document.getElementById('active-listings').textContent = activeProducts.length;
                document.getElementById('total-reviews').textContent = totalReviews;

                if (totalReviews > 0) {
                    document.getElementById('rating-container').style.display = 'flex';
                    document.getElementById('rating-value').textContent = averageRating.toFixed(1);
                    document.getElementById('rating-count').textContent = `(${totalReviews} review${totalReviews !== 1 ? 's' : ''})`;
                    const fullStars = Math.floor(averageRating);
                    const hasHalf = averageRating % 1 >= 0.5;
                    document.getElementById('rating-stars').textContent =
                        '★'.repeat(fullStars) + (hasHalf ? '☆' : '') + '☆'.repeat(5 - fullStars - (hasHalf ? 1 : 0));
                }

                const badgesContainer = document.getElementById('profile-badges');
                badgesContainer.innerHTML = '';
                if (userData.trustedTrader && !userData.sellerSuspended) {
                    badgesContainer.innerHTML += '<span class="badge trusted">🛡️ Trusted Trader</span>';
                } else if (userData.verifiedSeller && !userData.sellerSuspended) {
                    badgesContainer.innerHTML += '<span class="badge verified">✓ Verified Seller</span>';
                }
                const memberSince = userData.createdAt
                    ? new Date(userData.createdAt.toDate ? userData.createdAt.toDate() : userData.createdAt).getFullYear()
                    : new Date().getFullYear();
                badgesContainer.innerHTML += `<span class="badge member-since">📅 Member since ${memberSince}</span>`;

                const actionButtons = document.getElementById('action-buttons');
                if (isOwnProfile) {
                    actionButtons.innerHTML = `
                        <a href="listings-manager.html" class="btn btn-primary">My Listings</a>
                        <a href="my-orders.html" class="btn btn-primary">My Orders</a>
                        <a href="sell.html" class="btn btn-secondary">Add Listing</a>
                    `;
                } else {
                    actionButtons.innerHTML = `
                        <button class="btn btn-primary" id="contact-seller-btn">💬 Message Seller</button>
                    `;
                    document.getElementById('contact-seller-btn').addEventListener('click', () => contactSeller(userId, displayName));
                }

                displayProducts(activeProducts);
                displayReviews(reviews, userId);

                document.getElementById('loadingState').style.display = 'none';
                document.getElementById('profileContainer').style.display = 'block';

            } catch (error) {
                console.error('Error loading profile:', error);
                document.getElementById('loadingState').textContent = 'Error loading profile. Please try again.';
            }
        }

        async function contactSeller(sellerId, sellerName) {
            if (!currentUser) {
                window.location.href = 'sign-in.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
                return;
            }
            const btn = document.getElementById('contact-seller-btn');
            if (btn) { btn.disabled = true; btn.textContent = 'Opening chat...'; }
            try {
                // Use a stable conversation ID for general (non-product) messages
                const conversationId = `general_${currentUser.uid}_${sellerId}`;
                const convRef = doc(db, 'conversations', conversationId);
                await setDoc(convRef, {
                    productId: null,
                    productName: 'General Inquiry',
                    buyerId: currentUser.uid,
                    buyerName: currentUser.displayName || currentUser.email?.split('@')[0] || 'Buyer',
                    sellerId,
                    sellerName,
                    participants: [currentUser.uid, sellerId],
                    lastMessageAt: serverTimestamp(),
                    lastMessage: null,
                    unreadBuyer: 0,
                    unreadSeller: 0,
                }, { merge: true });
                window.location.href = `messages.html?conv=${conversationId}`;
            } catch (err) {
                console.error('contactSeller error:', err);
                if (btn) { btn.disabled = false; btn.textContent = '💬 Message Seller'; }
                alert('Failed to open chat. Please try again.');
            }
        }

        function esc(s) {
            return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function safeUrl(url) {
            if (!url) return '';
            const u = String(url);
            return (u.startsWith('https://') || u.startsWith('http://')) ? u : '';
        }

        function displayProducts(products) {
            const container = document.getElementById('selling-items');
            const emptyState = document.getElementById('empty-selling');

            if (products.length === 0) {
                container.style.display = 'none';
                emptyState.style.display = 'block';
                return;
            }

            container.style.display = 'grid';
            emptyState.style.display = 'none';

            container.innerHTML = products.map(product => {
                const imgSrc = safeUrl(product.images && product.images[0]);
                const imageHTML = imgSrc
                    ? `<img src="${imgSrc}" alt="${esc(product.title)}">`
                    : '<div class="item-image">📦</div>';

                return `
                    <div class="item-card" onclick="window.location.href='productdetail.html?id=${esc(product.id)}'">
                        <div class="item-image">${imageHTML}</div>
                        <div class="item-details">
                            <div class="item-name">${esc(product.title) || 'Untitled'}</div>
                            <div class="item-price">$${parseFloat(product.price || 0).toFixed(2)}</div>
                            <span class="item-condition">${esc(product.condition) || 'New'}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function displayReviews(reviews) {
            const container = document.getElementById('reviews-list');
            const emptyState = document.getElementById('empty-reviews');

            if (reviews.length === 0) {
                container.style.display = 'none';
                emptyState.style.display = 'block';
                return;
            }

            container.style.display = 'flex';
            emptyState.style.display = 'none';

            // Sort newest first — handle Firestore Timestamp or plain number
            reviews.sort((a, b) => {
                const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt || 0);
                const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt || 0);
                return tb - ta;
            });

            container.innerHTML = reviews.map(review => {
                const ts = review.createdAt?.toMillis ? review.createdAt.toMillis() : (review.createdAt || null);
                const reviewDate = ts ? formatRelativeTime(ts) : 'Recently';
                const stars = '★'.repeat(review.rating || 0) + '☆'.repeat(5 - (review.rating || 0));
                const initial = (review.buyerName || 'A')[0].toUpperCase();

                return `
                    <div class="review-card">
                        <div class="review-header">
                            <div class="reviewer-info">
                                <div class="reviewer-avatar">${initial}</div>
                                <div>
                                    <div class="reviewer-name">${esc(review.buyerName) || 'Anonymous'}</div>
                                    <div class="review-date">${reviewDate}</div>
                                </div>
                            </div>
                            <div class="review-stars">${stars}</div>
                        </div>
                        ${review.text ? `<p class="review-text">${esc(review.text)}</p>` : ''}
                        ${review.productName ? `<p class="review-product">Product: ${esc(review.productName)}</p>` : ''}
                    </div>
                `;
            }).join('');
        }

        function formatRelativeTime(timestamp) {
            const now = Date.now();
            const diff = now - timestamp;
            const seconds = Math.floor(diff / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);
            const weeks = Math.floor(days / 7);
            const months = Math.floor(days / 30);

            if (seconds < 60) return 'Just now';
            if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
            if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
            if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
            if (weeks < 4) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
            if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
            return new Date(timestamp).toLocaleDateString();
        }
