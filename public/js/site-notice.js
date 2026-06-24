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

// ── Sentry error monitoring ───────────────────────────────────────────────────
// To enable: replace SENTRY_DSN_PLACEHOLDER with your real DSN from sentry.io
//   1. Create a free Browser JavaScript project at https://sentry.io
//   2. Copy the DSN (looks like https://abc123@o123456.ingest.sentry.io/789)
//   3. Replace the value below and redeploy
const SENTRY_DSN = 'SENTRY_DSN_PLACEHOLDER';

(function initSentry() {
    if (!SENTRY_DSN || SENTRY_DSN === 'SENTRY_DSN_PLACEHOLDER') return;
    const script = document.createElement('script');
    script.src = 'https://browser.sentry-cdn.com/8.38.0/bundle.tracing.min.js';
    script.crossOrigin = 'anonymous';
    script.onload = function () {
        if (window.Sentry) {
            window.Sentry.init({
                dsn: SENTRY_DSN,
                environment: 'production',
                tracesSampleRate: 0.1,
            });
        }
    };
    document.head.appendChild(script);
})();
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBjDNViO7zXGDIT6gN7qP1VLU2H1lZphe0",
    authDomain: "grappletrade.firebaseapp.com",
    projectId: "grappletrade",
    storageBucket: "grappletrade.firebasestorage.app",
    messagingSenderId: "119683736855",
    appId: "1:119683736855:web:0d0bc6cea784290ded8352"
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
            // Only allow https:// or root-relative / links — block javascript: and other schemes
            const rawLink = String(data.link);
            const safeLink = (rawLink.startsWith('https://') || rawLink.startsWith('/')) ? rawLink : null;
            if (safeLink) {
                const linkText = data.linkText ? escapeHtml(data.linkText) : 'Learn more';
                html += ` <a href="${escapeHtml(safeLink)}" style="color:${colors.text}">${linkText}</a>`;
            }
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

// Cookie consent banner
const COOKIE_CONSENT_KEY = 'gt_cookie_consent';

function showCookieBanner() {
    if (localStorage.getItem(COOKIE_CONSENT_KEY)) return;

    const style = document.createElement('style');
    style.textContent = `
        #cookie-consent-banner {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: #1a1a2e;
            color: #e0e0e0;
            padding: 14px 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 16px;
            font-size: 13px;
            z-index: 99999;
            flex-wrap: wrap;
            font-family: inherit;
        }
        #cookie-consent-banner a { color: #90caf9; text-decoration: underline; }
        #cookie-consent-accept {
            background: #3665f3;
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 7px 18px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
        }
        #cookie-consent-accept:hover { background: #254cc7; }
    `;
    document.head.appendChild(style);

    const banner = document.createElement('div');
    banner.id = 'cookie-consent-banner';
    banner.innerHTML = `
        <span>We use cookies for authentication, security, and analytics. See our <a href="/legal/cookie.html">Cookie Policy</a>.</span>
        <button id="cookie-consent-accept">Accept</button>
    `;
    document.body.appendChild(banner);

    document.getElementById('cookie-consent-accept').addEventListener('click', () => {
        localStorage.setItem(COOKIE_CONSENT_KEY, '1');
        banner.remove();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showCookieBanner);
} else {
    showCookieBanner();
}

// Spacebar triggers the logo slam animation
document.addEventListener('keydown', (e) => {
    if (e.key !== ' ') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;

    const logo = document.querySelector('.logo');
    if (!logo) return;

    e.preventDefault(); // stop page scroll
    logo.classList.remove('logo--pop');
    void logo.offsetWidth;  // force reflow so animation restarts
    logo.classList.add('logo--pop');
    setTimeout(() => logo.classList.remove('logo--pop'), 460);
});
