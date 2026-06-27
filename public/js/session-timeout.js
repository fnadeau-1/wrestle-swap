// session-timeout.js
// Logs the user out after TIMEOUT_MS of inactivity and redirects to sign-in.
// Include this script on any authenticated page via:
//   <script type="module" src="/js/session-timeout.js"></script>

import { getAuth, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity

const auth = getAuth();
let timeoutHandle = null;
let isAuthenticated = false;

function resetTimer() {
  if (!isAuthenticated) return;
  clearTimeout(timeoutHandle);
  timeoutHandle = setTimeout(async () => {
    try {
      await signOut(auth);
    } catch (_) {}
    window.location.href = '/sign-in.html?reason=timeout';
  }, TIMEOUT_MS);
}

// Track user activity
['mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
  document.addEventListener(evt, resetTimer, { passive: true });
});

onAuthStateChanged(auth, (user) => {
  isAuthenticated = !!user;
  if (user) {
    resetTimer();
  } else {
    clearTimeout(timeoutHandle);
  }
});
