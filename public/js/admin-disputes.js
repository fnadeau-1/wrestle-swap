  import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
  import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
  import {
    getFirestore, collection, query, where, getDocs, doc, getDoc, orderBy, limit
  } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
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
  const db = getFirestore(app);

  let allItems = [];
  let activeFilter = 'all';

  onAuthStateChanged(auth, async (user) => {
    document.getElementById('loading').style.display = 'none';
    if (!user) {
      document.getElementById('auth-wall').style.display = 'block';
      return;
    }
    // Check admin status
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    if (!userSnap.exists() || !userSnap.data().isAdmin) {
      document.getElementById('auth-wall').style.display = 'block';
      return;
    }
    document.getElementById('main-content').style.display = 'block';
    await loadAll();
  });

  async function loadAll() {
    const [disputesSnap, refundsSnap, flaggedSnap] = await Promise.all([
      getDocs(query(collection(db, 'products'), where('disputeOpened', '==', true))),
      getDocs(query(collection(db, 'products'), where('refundRequested', '==', true))),
      getDocs(query(collection(db, 'conversations'), where('flaggedForReview', '==', true))),
    ]);

    const disputeItems = disputesSnap.docs.map(d => ({ ...d.data(), _id: d.id, _type: 'dispute' }));
    const refundItems = refundsSnap.docs
      .filter(d => !d.data().disputeOpened) // avoid dupes — dispute takes precedence
      .map(d => ({ ...d.data(), _id: d.id, _type: 'refund' }));
    const flaggedItems = flaggedSnap.docs.map(d => ({ ...d.data(), _id: d.id, _type: 'flagged' }));

    allItems = [...disputeItems, ...refundItems, ...flaggedItems];

    document.getElementById('stat-disputes').textContent = disputeItems.length;
    document.getElementById('stat-refunds').textContent = refundItems.length;
    document.getElementById('stat-flagged').textContent = flaggedItems.length;
    document.getElementById('stat-total').textContent = allItems.length;

    render();
  }

  function render() {
    const query = document.getElementById('search-bar').value.toLowerCase();
    let items = allItems;
    if (activeFilter !== 'all') items = items.filter(i => i._type === activeFilter);
    if (query) {
      items = items.filter(i =>
        (i.title || '').toLowerCase().includes(query) ||
        (i._id || '').toLowerCase().includes(query) ||
        (i.userId || '').toLowerCase().includes(query) ||
        (i.buyerId || '').toLowerCase().includes(query)
      );
    }
    const list = document.getElementById('dispute-list');
    if (items.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="icon">✅</div><p>No items match this filter.</p></div>`;
      return;
    }
    list.innerHTML = items.map(item => renderCard(item)).join('');
  }

  function renderCard(item) {
    const type = item._type;
    const ts = item.updatedAt?.toDate?.() || item.flaggedAt?.toDate?.() || null;
    const tsStr = ts ? ts.toLocaleString() : 'Unknown time';

    if (type === 'flagged') {
      return `
        <div class="dispute-card flagged">
          <div class="card-header">
            <div class="card-title">Flagged Conversation</div>
            <span class="tag flagged">Off-Platform Solicitation</span>
          </div>
          <div class="card-meta">
            <strong>Conv ID:</strong> ${item._id}<br>
            <strong>Flagged:</strong> ${tsStr}<br>
            <strong>Reason:</strong> ${item.flagReason || 'unknown'}<br>
            <strong>Participants:</strong> ${(item.participants || []).join(', ')}
          </div>
          <div class="card-actions">
            <button class="btn btn-primary" onclick="window.open('messages.html', '_blank')">View Messages</button>
            <button class="btn btn-outline" onclick="clearFlag('${item._id}')">Clear Flag</button>
          </div>
        </div>`;
    }

    const statusTag = item.delivered
      ? '<span class="tag delivered">Delivered</span>'
      : item.shipped
        ? '<span class="tag shipped">Shipped</span>'
        : '<span class="tag pending">Pending Ship</span>';

    const typeTag = type === 'dispute'
      ? '<span class="tag dispute">Dispute Opened</span>'
      : '<span class="tag refund">Refund Requested</span>';

    return `
      <div class="dispute-card ${type}">
        <div class="card-header">
          <div class="card-title">${escHtml(item.title || 'Unnamed Product')}</div>
          <div>${typeTag}${statusTag}</div>
        </div>
        <div class="card-meta">
          <strong>Product ID:</strong> ${item._id}<br>
          <strong>Seller ID:</strong> ${item.userId || '—'}<br>
          <strong>Price:</strong> $${item.price ? parseFloat(item.price).toFixed(2) : '—'}<br>
          ${item.refundReason ? `<strong>Reason:</strong> ${escHtml(item.refundReason)}<br>` : ''}
          <strong>Updated:</strong> ${tsStr}
        </div>
        <div class="card-actions">
          <button class="btn btn-primary" onclick="viewOrder('${item._id}')">View Order</button>
          <button class="btn btn-refund" onclick="issueRefund('${item._id}')">Issue Refund</button>
          <button class="btn btn-outline" onclick="blockRelease('${item._id}')">Block Auto-Release</button>
        </div>
      </div>`;
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function clearFlag(convId) {
    if (!confirm('Clear this flag? This will remove the flagged-for-review status.')) return;
    try {
      const { updateDoc, doc: firestoreDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
      await updateDoc(firestoreDoc(db, 'conversations', convId), { flaggedForReview: false });
      allItems = allItems.filter(i => i._id !== convId);
      document.getElementById('stat-flagged').textContent = allItems.filter(i => i._type === 'flagged').length;
      document.getElementById('stat-total').textContent = allItems.length;
      render();
    } catch (e) {
      alert('Error clearing flag: ' + e.message);
    }
  }

  function viewOrder(productId) {
    window.open(`seller-order-fulfillment.html?productId=${productId}`, '_blank');
  }

  function issueRefund(productId) {
    alert(`To issue a refund, use the admin panel with product ID: ${productId}\n\nThis requires running adminIssueRefund via the Firebase console or a dedicated admin API call.`);
  }

  function blockRelease(productId) {
    alert(`To block auto-release, set autoReleaseBlocked: true on product ${productId} via Firebase console or the admin SDK.`);
  }

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      render();
    });
  });

  // Search
  document.getElementById('search-bar').addEventListener('input', render);
