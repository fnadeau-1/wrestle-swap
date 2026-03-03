/**
 * site-notice.js — Sitewide announcement banner
 *
 * Reads config/announcement from Firestore. If active, injects a banner
 * at the top of every page. Dismissible banners are suppressed in
 * localStorage until the announcement content changes.
 *
 * Data model (Firestore: config/announcement):
 *   active:      boolean  — whether to show the banner
 *   text:        string   — message to display
 *   type:        'info' | 'warning' | 'danger'  — controls color
 *   link:        string   — optional URL
 *   linkText:    string   — optional link label (defaults to "Learn more")
 *   dismissible: boolean  — whether the ✕ button appears
 */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBrNzOA__bI6zA2PvTFTujmFiBLsCe1iBk",
    authDomain: "wrestleswap.firebaseapp.com",
    projectId: "wrestleswap",
    storageBucket: "wrestleswap.firebasestorage.app",
    messagingSenderId: "857051782398",
    appId: "1:857051782398:web:bb4ab3f98e8dbbc8cad9af"
};

// Reuse existing Firebase app if already initialized on this page
const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG, 'site-notice');
const db = getFirestore(app);

const COLORS = {
    info:     { bg: '#e8f4fd', border: '#3665f3', text: '#1a3a6b', icon: 'ℹ️' },
    warning:  { bg: '#fff8e1', border: '#f59e0b', text: '#7c4e00', icon: '⚠️' },
    danger:   { bg: '#fdecea', border: '#c41e3a', text: '#7b1010', icon: '🚨' },
    critical: { bg: '#fdecea', border: '#c41e3a', text: '#7b1010', icon: '🚨' }
};

function injectStyles() {
    if (document.getElementById('site-notice-style')) return;
    const style = document.createElement('style');
    style.id = 'site-notice-style';
    style.textContent = `
        #site-notice-banner {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 10px 20px;
            font-size: 14px;
            font-family: inherit;
            position: relative;
            border-bottom: 2px solid;
            z-index: 9999;
            flex-wrap: wrap;
        }
        #site-notice-banner a {
            font-weight: 600;
            text-decoration: underline;
        }
        #site-notice-dismiss {
            position: absolute;
            right: 14px;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            opacity: 0.6;
            padding: 4px;
        }
        #site-notice-dismiss:hover { opacity: 1; }
    `;
    document.head.appendChild(style);
}

async function loadAnnouncement() {
    try {
        const snap = await getDoc(doc(db, 'config', 'announcement'));
        if (!snap.exists()) return;

        const data = snap.data();
        const messageText = data.text || data.message || '';
        if (!data.active || !messageText) return;

        // Build a stable dismissal key from text content
        const dismissKey = 'notice_dismissed_' + btoa(unescape(encodeURIComponent(messageText))).slice(0, 20);
        if (data.dismissible && localStorage.getItem(dismissKey)) return;

        const type = ['info', 'warning', 'danger', 'critical'].includes(data.type) ? data.type : 'info';
        const colors = COLORS[type];

        injectStyles();

        const banner = document.createElement('div');
        banner.id = 'site-notice-banner';
        banner.style.backgroundColor = colors.bg;
        banner.style.borderColor = colors.border;
        banner.style.color = colors.text;

        let html = `<span>${colors.icon} ${escapeHtml(messageText)}</span>`;
        if (data.link) {
            const linkText = data.linkText ? escapeHtml(data.linkText) : 'Learn more';
            html += ` <a href="${escapeHtml(data.link)}" style="color:${colors.text}">${linkText}</a>`;
        }
        if (data.dismissible) {
            html += `<button id="site-notice-dismiss" title="Dismiss" style="color:${colors.text}">✕</button>`;
        }
        banner.innerHTML = html;

        // Insert before everything else in body
        document.body.insertBefore(banner, document.body.firstChild);

        if (data.dismissible) {
            document.getElementById('site-notice-dismiss').addEventListener('click', () => {
                banner.remove();
                localStorage.setItem(dismissKey, '1');
            });
        }
    } catch (err) {
        // Silently ignore — announcements are non-critical
        console.debug('site-notice: could not load announcement', err.message);
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Run after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAnnouncement);
} else {
    loadAnnouncement();
}
