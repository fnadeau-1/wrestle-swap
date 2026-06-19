// notifications.js — shared module for in-app notification bell
// Include on any page with: <script type="module" src="js/notifications.js"></script>

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    getFirestore, collection, query, where, onSnapshot,
    orderBy, limit, updateDoc, doc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyBjDNViO7zXGDIT6gN7qP1VLU2H1lZphe0",
    authDomain: "grappletrade.firebaseapp.com",
    projectId: "grappletrade",
    storageBucket: "grappletrade.firebasestorage.app",
    messagingSenderId: "119683736855",
    appId: "1:119683736855:web:0d0bc6cea784290ded8352"
};

// Reuse existing app if already initialized on this page
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let unsubscribeNotifs = null;

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function injectBell() {
    // Find top-bar-content right div and inject bell button before the last child
    const topBarContents = document.querySelectorAll('.top-bar-content > div');
    const rightDiv = topBarContents[topBarContents.length - 1];
    if (!rightDiv || document.getElementById('notif-bell-btn')) return;

    const bellBtn = document.createElement('button');
    bellBtn.className = 'top-bar-btn';
    bellBtn.id = 'notif-bell-btn';
    bellBtn.style.cssText = 'position:relative;padding:4px 12px;';
    bellBtn.innerHTML = `🔔 <span id="notif-badge" style="display:none;background:#c41e3a;color:white;font-size:10px;border-radius:10px;padding:1px 5px;position:absolute;top:0;right:0;font-weight:700;"></span>`;
    bellBtn.onclick = toggleNotifDropdown;

    // Insert at the start of rightDiv
    rightDiv.insertBefore(bellBtn, rightDiv.firstChild);

    // Dropdown panel
    const dropdown = document.createElement('div');
    dropdown.id = 'notif-dropdown';
    dropdown.style.cssText = `
        display:none;position:fixed;top:40px;right:20px;width:340px;max-height:420px;overflow-y:auto;
        background:white;border:1px solid #e5e5e5;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.12);
        z-index:9999;font-family:'DM Sans',sans-serif;
    `;
    document.body.appendChild(dropdown);

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!bellBtn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
}

function toggleNotifDropdown() {
    const dropdown = document.getElementById('notif-dropdown');
    if (!dropdown) return;
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
}

function renderNotifications(notifs) {
    const dropdown = document.getElementById('notif-dropdown');
    const badge = document.getElementById('notif-badge');
    if (!dropdown || !badge) return;

    const unread = notifs.filter(n => !n.read).length;
    if (unread > 0) {
        badge.textContent = unread > 9 ? '9+' : unread;
        badge.style.display = 'inline';
    } else {
        badge.style.display = 'none';
    }

    if (notifs.length === 0) {
        dropdown.innerHTML = `<div style="padding:24px;text-align:center;color:#707070;font-size:14px;">No notifications yet</div>`;
        return;
    }

    const header = `
        <div style="padding:14px 16px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-size:15px;">Notifications</strong>
            ${unread > 0 ? `<button onclick="markAllRead()" style="font-size:12px;color:#3665f3;background:none;border:none;cursor:pointer;padding:0;">Mark all read</button>` : ''}
        </div>
    `;

    const items = notifs.map(n => {
        const ts = n.createdAt?.toDate ? n.createdAt.toDate() : new Date(n.createdAt || Date.now());
        const ago = formatAgo(ts);
        return `
            <div data-notif-id="${esc(n.id)}" data-link="${esc(n.link || '')}"
                 onclick="handleNotifClick(this.dataset.notifId, this.dataset.link, this)"
                 style="padding:14px 16px;border-bottom:1px solid #f8f8f8;cursor:pointer;background:${n.read ? 'white' : '#f0f9ff'};display:flex;gap:12px;align-items:flex-start;transition:background 0.15s;"
                 onmouseenter="this.style.background='#f5f5f5'" onmouseleave="this.style.background='${n.read ? 'white' : '#f0f9ff'}'">
                <span style="font-size:20px;flex-shrink:0;">${esc(n.icon || '🔔')}</span>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:13px;color:#1a1a1a;font-weight:${n.read ? '400' : '600'};line-height:1.4;">${esc(n.message || '')}</div>
                    <div style="font-size:11px;color:#999;margin-top:3px;">${ago}</div>
                </div>
                ${!n.read ? `<span style="width:8px;height:8px;background:#c41e3a;border-radius:50%;flex-shrink:0;margin-top:4px;"></span>` : ''}
            </div>
        `;
    }).join('');

    dropdown.innerHTML = header + items;
}

window.handleNotifClick = async function(notifId, link, el) {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    // Mark as read
    try {
        await updateDoc(doc(db, 'notifications', uid, 'items', notifId), { read: true });
    } catch (e) { /* ignore */ }
    // Only navigate to relative paths — never javascript: or external URLs
    if (link && /^[^:]*$/.test(link)) window.location.href = link;
};

window.markAllRead = async function() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const notifList = document.getElementById('notif-dropdown').__notifList || [];
    const unread = notifList.filter(n => !n.read);
    if (!unread.length) return;
    const batch = writeBatch(db);
    unread.forEach(n => batch.update(doc(db, 'notifications', uid, 'items', n.id), { read: true }));
    await batch.commit().catch(() => {});
};

function formatAgo(date) {
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}

onAuthStateChanged(auth, (user) => {
    if (unsubscribeNotifs) { unsubscribeNotifs(); unsubscribeNotifs = null; }
    if (!user) return;

    injectBell();

    const q = query(
        collection(db, 'notifications', user.uid, 'items'),
        orderBy('createdAt', 'desc'),
        limit(30)
    );

    unsubscribeNotifs = onSnapshot(q, (snap) => {
        const notifs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Attach list to dropdown for markAllRead access
        const dd = document.getElementById('notif-dropdown');
        if (dd) dd.__notifList = notifs;
        renderNotifications(notifs);
    }, (err) => {
        console.error('notifications listener error:', err);
    });
});
