/**
 * Mobile bottom navigation bar — shared module.
 * Include via: <script src="/js/bottom-nav.js" data-active="home"></script>
 * data-active values: home, search, sell, orders, profile
 */
(function () {
    const PAGES = [
        { id: 'home',    label: 'Home',    icon: '🏠', href: 'index.html' },
        { id: 'search',  label: 'Search',  icon: '🔍', href: 'search.html' },
        { id: 'sell',    label: 'Sell',    icon: '➕', href: 'sell.html' },
        { id: 'orders',  label: 'Orders',  icon: '📦', href: 'my-orders.html' },
        { id: 'profile', label: 'Profile', icon: '👤', href: 'profile.html' },
    ];

    function getActive() {
        const script = document.currentScript ||
            document.querySelector('script[src*="bottom-nav.js"]');
        return script ? script.getAttribute('data-active') : null;
    }

    function injectStyles() {
        if (document.getElementById('bottom-nav-styles')) return;
        const style = document.createElement('style');
        style.id = 'bottom-nav-styles';
        style.textContent = `
            #bottom-nav {
                display: none;
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                height: 60px;
                background: #fff;
                border-top: 1px solid #e5e5e5;
                z-index: 9000;
                justify-content: space-around;
                align-items: center;
                box-shadow: 0 -2px 8px rgba(0,0,0,0.06);
            }

            @media (max-width: 768px) {
                #bottom-nav { display: flex; }
                body { padding-bottom: 64px; }
            }

            .bottom-nav-item {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                flex: 1;
                height: 100%;
                text-decoration: none;
                color: #888;
                font-size: 11px;
                gap: 2px;
                transition: color 0.15s;
            }

            .bottom-nav-item.active {
                color: #c0392b;
            }

            .bottom-nav-item .nav-icon {
                font-size: 20px;
                line-height: 1;
            }

            .bottom-nav-item span:last-child {
                font-family: 'DM Sans', sans-serif;
                font-weight: 500;
            }
        `;
        document.head.appendChild(style);
    }

    function render(active) {
        const nav = document.createElement('nav');
        nav.id = 'bottom-nav';
        nav.setAttribute('role', 'navigation');
        nav.setAttribute('aria-label', 'Main navigation');

        nav.innerHTML = PAGES.map(p => `
            <a href="${p.href}" class="bottom-nav-item${p.id === active ? ' active' : ''}" aria-label="${p.label}">
                <span class="nav-icon">${p.icon}</span>
                <span>${p.label}</span>
            </a>
        `).join('');

        document.body.appendChild(nav);
    }

    function init() {
        injectStyles();
        render(getActive());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
