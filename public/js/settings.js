        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged, updatePassword, updateProfile, EmailAuthProvider,
                 reauthenticateWithCredential, signOut }
            from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, doc, getDoc, setDoc, deleteDoc, serverTimestamp,
                 collection, query, where, getDocs, writeBatch }
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

        const app = initializeApp(firebaseConfig);
        initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider('6Lck5w4tAAAAABZvUgLj4J5zg_CPlK7mQawuk6b6'), isTokenAutoRefreshEnabled: true });
        const auth = getAuth(app);
        const db = getFirestore(app);

        let currentUser = null;
        let currentUsername = null;
        let usernameCheckTimeout;

        // ── Username availability checker ──────────────────────────────────
        async function checkUsernameAvailable(username, uid) {
            try {
                const snap = await getDoc(doc(db, 'usernames', username.toLowerCase()));
                if (!snap.exists()) return true;
                return snap.data().userId === uid;
            } catch (e) {
                console.error('Username check error:', e);
                return false;
            }
        }

        document.getElementById('username').addEventListener('input', function(e) {
            const val = e.target.value.toLowerCase();
            const status = document.getElementById('username-status');
            clearTimeout(usernameCheckTimeout);

            if (!val) { status.textContent = ''; status.className = ''; return; }

            status.textContent = 'Checking...';
            status.className = 'checking';

            usernameCheckTimeout = setTimeout(async () => {
                if (val.length < 3) {
                    status.textContent = 'Must be at least 3 characters';
                    status.className = 'error'; return;
                }
                if (!/^[a-z0-9_]+$/.test(val)) {
                    status.textContent = 'Letters, numbers, and underscores only';
                    status.className = 'error'; return;
                }
                const ok = await checkUsernameAvailable(val, currentUser?.uid);
                status.textContent = ok ? '✓ Available' : '✗ Already taken';
                status.className = ok ? 'success' : 'error';
            }, 500);
        });

        // ── Auth state ─────────────────────────────────────────────────────
        onAuthStateChanged(auth, async (user) => {
            if (!user) {
                window.location.href = 'sign-in.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
                return;
            }
            currentUser = user;

            // Build dropdown menu
            const menuWrapper = document.getElementById('user-menu-wrapper');
            const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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

            // Account info
            document.getElementById('user-email').textContent = user.email;
            // Sign-in method (for password section only — not displayed)
            const isGoogle = user.providerData.some(p => p.providerId === 'google.com');

            // Password section — hide for Google users
            buildPasswordSection(isGoogle);

            // Load Firestore profile
            try {
                const userDoc = await getDoc(doc(db, 'users', user.uid));
                if (userDoc.exists()) {
                    const d = userDoc.data();

                    // Account status — check suspension
                    if (d.sellerSuspended) {
                        document.getElementById('account-status').innerHTML =
                            '<span style="color:#dc3545;">✗ Selling Suspended</span>';
                    }

                    // Profile fields
                    document.getElementById('username').value = d.username || '';
                    currentUsername = d.username || '';
                    document.getElementById('user-bio').value = d.bio || '';
                    document.getElementById('user-location').value = d.location || '';

                    // Stripe — always get live status from Stripe API so the display
                    // reflects reality, not a stale Firestore cache.
                    if (d.stripeAccountId) {
                        document.getElementById('stripe-status').innerHTML = '<span style="color:#999;">Checking...</span>';
                        try {
                            const idToken = await user.getIdToken();
                            const resp = await fetch('https://us-central1-grappletrade.cloudfunctions.net/checkSellerStatus', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                                body: JSON.stringify({ userId: user.uid }),
                            });
                            const status = resp.ok ? await resp.json() : null;
                            if (status && status.payoutsEnabled) {
                                document.getElementById('stripe-status').innerHTML = '<span style="color:#28a745;">✓ Connected &amp; Active</span>';
                                document.getElementById('stripe-manage-btn').style.display = 'inline-block';
                                document.getElementById('payouts-enabled').innerHTML = '<span style="color:#28a745;">✓ Yes</span>';
                                if (status.chargesEnabled)
                                    document.getElementById('charges-enabled').innerHTML = '<span style="color:#28a745;">✓ Yes</span>';
                            } else {
                                document.getElementById('stripe-status').innerHTML = '<span style="color:#f59e0b;">⚠ Setup Incomplete</span>';
                                document.getElementById('stripe-incomplete-warning').style.display = 'block';
                                document.getElementById('stripe-manage-btn').style.display = 'inline-block';
                            }
                        } catch (_) {
                            // Fallback to cached Firestore value if the live check fails
                            if (d.stripePayoutsEnabled) {
                                document.getElementById('stripe-status').innerHTML = '<span style="color:#28a745;">✓ Connected &amp; Active</span>';
                                document.getElementById('stripe-manage-btn').style.display = 'inline-block';
                            } else {
                                document.getElementById('stripe-status').innerHTML = '<span style="color:#f59e0b;">⚠ Setup Incomplete</span>';
                                document.getElementById('stripe-incomplete-warning').style.display = 'block';
                                document.getElementById('stripe-manage-btn').style.display = 'inline-block';
                            }
                        }
                    } else {
                        // Not connected at all
                        document.getElementById('stripe-connect-btn').style.display = 'inline-block';
                        document.getElementById('stripe-warning').style.display = 'block';
                    }

                    // Notification preferences
                    if (d.notifications) {
                        document.getElementById('notif-orders').checked    = d.notifications.orders    !== false;
                        document.getElementById('notif-shipping').checked  = d.notifications.shipping  !== false;
                        document.getElementById('notif-marketing').checked = d.notifications.marketing === true;
                    }

                    // Seller strikes
                    const strikes = d.sellerCancellationCount || 0;
                    const strikeEl = document.getElementById('seller-strikes');
                    if (d.sellerSuspended) {
                        strikeEl.innerHTML = `<span style="color:#dc3545;">${strikes} / 3 — Suspended</span>`;
                    } else if (strikes > 0) {
                        strikeEl.innerHTML = `<span style="color:#ffa500;">${strikes} / 3</span>`;
                    } else {
                        strikeEl.textContent = '0 / 3';
                    }
                }
            } catch (e) {
                console.error('Error loading user data:', e);
            }

            await loadSellerStats(user.uid);
        });

        // ── Seller stats ───────────────────────────────────────────────────
        async function loadSellerStats(uid) {
            try {
                const snap = await getDocs(
                    query(collection(db, 'products'), where('userId', '==', uid))
                );

                let total = 0, active = 0, sold = 0, revenue = 0;
                snap.forEach(d => {
                    const p = d.data();
                    if (p.cancelled) return; // skip cancelled listings from totals
                    total++;
                    if (p.sold) {
                        sold++;
                        revenue += p.price || 0;
                    } else {
                        active++;
                    }
                });

                document.getElementById('total-listings').textContent  = total;
                document.getElementById('active-listings').textContent = active;
                document.getElementById('sold-items').textContent      = sold;
                document.getElementById('total-revenue').textContent   = '$' + revenue.toFixed(2);
            } catch (e) {
                console.error('Error loading seller stats:', e);
            }
        }

        // ── Password section — differs for Google vs email users ──────────
        function buildPasswordSection(isGoogle) {
            const container = document.getElementById('password-section-content');
            if (isGoogle) {
                container.innerHTML = `
                    <div class="google-only-notice">
                        Your account uses Google Sign-In — password changes are managed through your
                        <a href="https://myaccount.google.com/security" target="_blank" style="color:#3665f3;">Google account settings</a>.
                    </div>`;
                return;
            }

            container.innerHTML = `
                <div class="success-message" id="password-success">Password changed successfully!</div>
                <div class="error-message" id="password-error"></div>
                <form id="password-form">
                    <div class="form-group">
                        <label class="form-label">Current Password</label>
                        <input type="password" class="form-input" id="current-password" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">New Password</label>
                        <input type="password" class="form-input" id="new-password" required>
                        <p class="helper-text">Must be at least 6 characters</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Confirm New Password</label>
                        <input type="password" class="form-input" id="confirm-password" required>
                    </div>
                    <button type="submit" class="btn btn-primary">Change Password</button>
                </form>`;

            document.getElementById('password-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const current   = document.getElementById('current-password').value;
                const next      = document.getElementById('new-password').value;
                const confirm   = document.getElementById('confirm-password').value;
                const errorMsg  = document.getElementById('password-error');
                const successMsg = document.getElementById('password-success');
                errorMsg.style.display = 'none';

                if (next.length < 6) {
                    errorMsg.textContent = 'New password must be at least 6 characters';
                    errorMsg.style.display = 'block'; return;
                }
                if (next !== confirm) {
                    errorMsg.textContent = 'Passwords do not match';
                    errorMsg.style.display = 'block'; return;
                }
                try {
                    const cred = EmailAuthProvider.credential(currentUser.email, current);
                    await reauthenticateWithCredential(currentUser, cred);
                    await updatePassword(currentUser, next);
                    successMsg.style.display = 'block';
                    document.getElementById('password-form').reset();
                    setTimeout(() => successMsg.style.display = 'none', 3000);
                } catch (err) {
                    errorMsg.textContent = err.code === 'auth/wrong-password'
                        ? 'Current password is incorrect'
                        : 'Error: ' + err.message;
                    errorMsg.style.display = 'block';
                }
            });
        }

        // ── Profile form save ──────────────────────────────────────────────
        document.getElementById('profile-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('username').value.toLowerCase().trim();
            const bio      = document.getElementById('user-bio').value.trim().slice(0, 200);
            const location = document.getElementById('user-location').value.trim().slice(0, 100);
            const errorMsg = document.getElementById('profile-error');
            errorMsg.style.display = 'none';

            if (!username || username.length < 3 || username.length > 30 || !/^[a-z0-9_]+$/.test(username)) {
                errorMsg.textContent = 'Please enter a valid username (3–30 characters, letters/numbers/underscores)';
                errorMsg.style.display = 'block'; return;
            }

            const available = await checkUsernameAvailable(username, currentUser.uid);
            if (!available) {
                errorMsg.textContent = 'That username is already taken.';
                errorMsg.style.display = 'block';
                document.getElementById('username-status').textContent = '✗ Already taken';
                document.getElementById('username-status').className = 'error';
                return;
            }

            try {
                // Update username reservation atomically — if the set fails (name taken),
                // the delete is rolled back and the old username is preserved.
                if (username !== currentUsername) {
                    const batch = writeBatch(db);
                    batch.set(doc(db, 'usernames', username), { userId: currentUser.uid, createdAt: serverTimestamp() });
                    if (currentUsername) batch.delete(doc(db, 'usernames', currentUsername));
                    await batch.commit();
                }

                // Username is the display name — one identity, no real name stored
                await setDoc(doc(db, 'users', currentUser.uid), {
                    username,
                    displayName: username,
                    email: currentUser.email,
                    bio,
                    location,
                    updatedAt: serverTimestamp()
                }, { merge: true });

                // Keep Firebase Auth displayName in sync
                await updateProfile(currentUser, { displayName: username });

                currentUsername = username;
                const successMsg = document.getElementById('profile-success');
                successMsg.style.display = 'block';
                setTimeout(() => successMsg.style.display = 'none', 3000);
            } catch (err) {
                errorMsg.textContent = 'Error saving profile: ' + err.message;
                errorMsg.style.display = 'block';
            }
        });

        // ── Notification preferences save ─────────────────────────────────
        document.getElementById('save-notif-btn').addEventListener('click', async () => {
            if (!currentUser) return;
            const successMsg = document.getElementById('notif-success');
            try {
                await setDoc(doc(db, 'users', currentUser.uid), {
                    notifications: {
                        orders:    document.getElementById('notif-orders').checked,
                        shipping:  document.getElementById('notif-shipping').checked,
                        marketing: document.getElementById('notif-marketing').checked,
                    },
                    updatedAt: serverTimestamp()
                }, { merge: true });
                successMsg.style.display = 'block';
                setTimeout(() => successMsg.style.display = 'none', 3000);
            } catch (err) {
                console.error('Error saving notifications:', err);
            }
        });

        // ── Sign out ───────────────────────────────────────────────────────
        window.signOutUser = async function() {
            if (confirm('Are you sure you want to sign out?')) {
                await signOut(auth);
                window.location.href = 'index.html';
            }
        };

        // ── Delete account ─────────────────────────────────────────────────
        window.deleteAccount = async function() {
            if (!confirm('Are you sure you want to delete your account? This cannot be undone.')) return;
            if (!confirm('All your data will be permanently deleted. Confirm?')) return;
            try {
                const idToken = await currentUser.getIdToken();
                const response = await fetch('https://us-central1-grappletrade.cloudfunctions.net/selfDeleteAccount', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                    body: JSON.stringify({}),
                });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.error || `Error ${response.status}`);
                }
                await signOut(auth);
                window.location.href = 'index.html';
            } catch (err) {
                alert('Error deleting account: ' + err.message);
            }
        };
