  import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
  import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
  import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js';

  const app = initializeApp({
    apiKey: "AIzaSyBjDNViO7zXGDIT6gN7qP1VLU2H1lZphe0",
    authDomain: "grappletrade.firebaseapp.com",
    projectId: "grappletrade",
    storageBucket: "grappletrade.firebasestorage.app",
    messagingSenderId: "119683736855",
    appId: "1:119683736855:web:0d0bc6cea784290ded8352"
  });

  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6Lck5w4tAAAAABZvUgLj4J5zg_CPlK7mQawuk6b6'),
    isTokenAutoRefreshEnabled: true,
  });

  const auth = getAuth(app);
  const FUNCTIONS_BASE = 'https://us-central1-grappletrade.cloudfunctions.net';

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      document.getElementById('main-content').style.display = 'none';
      document.getElementById('auth-wall').style.display = 'block';
    }
  });

  document.getElementById('export-btn').addEventListener('click', async () => {
    const btn = document.getElementById('export-btn');
    const statusMsg = document.getElementById('status-msg');
    const errorMsg = document.getElementById('error-msg');
    statusMsg.style.display = 'none';
    errorMsg.style.display = 'none';

    const user = auth.currentUser;
    if (!user) { errorMsg.textContent = 'Please sign in first.'; errorMsg.style.display = 'block'; return; }

    btn.disabled = true;
    btn.textContent = 'Requesting...';

    try {
      const token = await user.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/requestDataExport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      statusMsg.style.display = 'block';
      btn.textContent = 'Export Requested';
    } catch (e) {
      errorMsg.textContent = e.message;
      errorMsg.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Request Data Export';
    }
  });

  document.getElementById('delete-btn').addEventListener('click', async () => {
    const user = auth.currentUser;
    if (!user) return;
    if (!confirm('Are you sure you want to permanently delete your account? This cannot be undone.')) return;
    if (!confirm('Final confirmation: all your data, listings, and account access will be removed.')) return;

    try {
      const token = await user.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/selfDeleteAccount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deletion failed');
      alert('Your account has been deleted. You will now be signed out.');
      window.location.href = '/index.html';
    } catch (e) {
      alert('Error deleting account: ' + e.message);
    }
  });
