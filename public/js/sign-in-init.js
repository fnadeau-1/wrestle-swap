        let popupInProgress = false;

        // Disable sign-in until age gate is confirmed
        document.addEventListener('DOMContentLoaded', () => {
            document.getElementById('btn-google').disabled = true;
        });

        function onAgeCheckChange() {
            const checked = document.getElementById('age-confirm').checked;
            if (!popupInProgress) document.getElementById('btn-google').disabled = !checked;
        }

        function showError(msg) {
            const el = document.getElementById('error-banner');
            el.textContent = msg;
            el.style.display = 'block';
        }

        function hideError() {
            document.getElementById('error-banner').style.display = 'none';
        }

        function setAllButtonsDisabled(disabled) {
            document.getElementById('btn-google').disabled = disabled;
        }

        function getPostLoginRedirect() {
            const params = new URLSearchParams(window.location.search);
            const redirect = params.get('redirect');
            if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) return redirect;
            return 'index.html';
        }

        function generateUsername() {
            const randomNum = Math.floor(10000 + Math.random() * 90000);
            return `wrestler_${randomNum}`;
        }

        async function isUsernameUnique(username) {
            try {
                const snap = await window.firestoreGetDoc(window.firestoreDoc(window.firebaseDb, 'usernames', username));
                return !snap.exists();
            } catch {
                return false;
            }
        }

        async function generateUniqueUsername() {
            for (let i = 0; i < 10; i++) {
                const username = generateUsername();
                if (await isUsernameUnique(username)) return username;
            }
            return `wrestler_${Date.now()}`;
        }

        async function ensureUserProfile(user) {
            const userRef = window.firestoreDoc(window.firebaseDb, 'users', user.uid);
            const snap = await window.firestoreGetDoc(userRef);
            if (snap.exists()) return; // existing user, nothing to do

            // New user — create profile
            const username = await generateUniqueUsername();
            const userData = {
                uid: user.uid,
                email: user.email || '',
                // Use generated username as displayName — avoids leaking Google real name publicly
                // (getPublicProfile exposes displayName; username is the only public identity)
                displayName: username,
                username: username,
                photoURL: user.photoURL || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            await window.firestoreSetDoc(userRef, userData);
            await window.firestoreSetDoc(
                window.firestoreDoc(window.firebaseDb, 'usernames', username),
                { userId: user.uid, createdAt: new Date().toISOString() }
            );
        }

        async function socialLogin() {
            if (popupInProgress) return;
            if (!document.getElementById('age-confirm').checked) {
                showError('Please confirm you are 18 or older to continue.');
                return;
            }
            hideError();
            popupInProgress = true;
            setAllButtonsDisabled(true);

            try {
                const authProvider = new window.GoogleAuthProvider();

                const result = await window.signInWithPopup(window.firebaseAuth, authProvider);
                await ensureUserProfile(result.user);
                window.location.href = getPostLoginRedirect();
            } catch (error) {
                const ignored = ['auth/cancelled-popup-request', 'auth/popup-closed-by-user'];
                if (!ignored.includes(error.code)) {
                    showError(error.message || 'Sign in failed. Please try again.');
                }
            } finally {
                setAllButtonsDisabled(false);
                popupInProgress = false;
            }
        }
