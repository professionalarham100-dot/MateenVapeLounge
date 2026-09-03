/* =====================================================================
   Mateen VapeLounge - Shared auth + utility module
   Loaded on every page. Exposes window.MV = { ... }
   ===================================================================== */

(function () {
    'use strict';

    const TOKEN_KEY = 'mv.token';
    const REMEMBER_KEY = 'mv.rememberEmail';
    const THEME_KEY = 'mv.theme';
    const API_BASE_URL = (function () {
        const host = window.location.hostname;
        const port = window.location.port;
        if ((host === '127.0.0.1' || host === 'localhost') && port && port !== '5000') {
            return 'http://127.0.0.1:5000';
        }
        return '';
    })();

    // ----- Theme management -----
    function applyTheme(t) {
        document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
    }
    function currentTheme() {
        return localStorage.getItem(THEME_KEY) || 'dark';
    }
    function toggleTheme() {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        localStorage.setItem(THEME_KEY, next);
        applyTheme(next);
        return next;
    }
    applyTheme(currentTheme());

    // ----- Token helpers -----
    function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
    function getToken()  { return localStorage.getItem(TOKEN_KEY); }
    function clearAuth() {
        localStorage.removeItem(TOKEN_KEY);
    }

    // ----- API client -----
    async function api(path, opts) {
        opts = opts || {};
        const headers = Object.assign(
            { 'Content-Type': 'application/json' },
            opts.headers || {}
        );
        const tok = getToken();
        if (tok) headers['Authorization'] = 'Bearer ' + tok;

        let res;
        try {
            res = await fetch(API_BASE_URL + path, {
                method: opts.method || 'GET',
                headers,
                body: opts.body ? JSON.stringify(opts.body) : undefined,
            });
        } catch (e) {
            throw new Error('Network error — could not reach server');
        }

        let data = null;
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
            try { data = await res.json(); } catch (_) { data = null; }
        }

        if (res.status === 401 && path !== '/api/auth/login') {
            clearAuth();
            if (!location.pathname.endsWith('index.html') && location.pathname !== '/') {
                location.href = 'index.html';
            }
            throw new Error((data && data.error) || 'Session expired');
        }

        if (!res.ok) {
            const msg = (data && data.error) || ('Request failed (' + res.status + ')');
            const err = new Error(msg);
            err.status = res.status;
            err.data = data;
            throw err;
        }

        return data || {};
    }

    // ----- Toast notifications -----
    function ensureToastStack() {
        let s = document.querySelector('.toast-stack');
        if (!s) {
            s = document.createElement('div');
            s.className = 'toast-stack';
            document.body.appendChild(s);
        }
        return s;
    }

    const ICONS = {
        success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        error:   '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8"  x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
        info:    '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        amber:   '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    };

    function toast(msg, type) {
        type = type || 'info';
        const stack = ensureToastStack();
        const el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.innerHTML = (ICONS[type] || ICONS.info) +
            '<div class="toast-msg"></div>' +
            '<button class="toast-close" aria-label="Dismiss">&times;</button>';
        el.querySelector('.toast-msg').textContent = String(msg);
        stack.appendChild(el);

        const dismiss = () => {
            el.style.transition = 'opacity 180ms, transform 180ms';
            el.style.opacity = '0';
            el.style.transform = 'translateX(20px)';
            setTimeout(() => el.remove(), 180);
        };
        el.querySelector('.toast-close').addEventListener('click', dismiss);
        setTimeout(dismiss, type === 'error' ? 6000 : 4000);
        return el;
    }

    // ----- Formatters -----
    function fmtPKR(n) {
        const num = Number(n || 0);
        const s = num.toLocaleString('en-PK', {
            maximumFractionDigits: num % 1 === 0 ? 0 : 2,
            minimumFractionDigits: 0,
        });
        return 'PKR ' + s;
    }
    function fmtNum(n, digits) {
        const num = Number(n || 0);
        return num.toLocaleString('en-US', {
            maximumFractionDigits: typeof digits === 'number' ? digits : 0
        });
    }

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function parseDateStr(s) {
        if (!s) return null;
        if (s instanceof Date) return s;
        // Treat naive strings as UTC since backend returns UTC-ish DATETIME
        const norm = String(s).replace(' ', 'T');
        const d = new Date(norm + (norm.endsWith('Z') ? '' : 'Z'));
        return isNaN(d.getTime()) ? new Date(s) : d;
    }
    function fmtDate(s) {
        const d = parseDateStr(s);
        if (!d || isNaN(d.getTime())) return '—';
        const day = String(d.getDate()).padStart(2, '0');
        const mon = MONTHS[d.getMonth()];
        const yr = d.getFullYear();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${day} ${mon} ${yr} ${hh}:${mm}`;
    }
    function fmtTime(s) {
        const d = parseDateStr(s);
        if (!d || isNaN(d.getTime())) return '—';
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    // ----- Misc helpers -----
    function initials(name) {
        if (!name) return '?';
        const parts = String(name).trim().split(/\s+/);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    function avatarClass(name) {
        if (!name) return 'avatar-color-1';
        let h = 0;
        for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
        return 'avatar-color-' + ((h % 5) + 1);
    }
    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function setBusy(btn, busy) {
        if (!btn) return;
        if (busy) {
            btn.setAttribute('aria-busy', 'true');
            btn.disabled = true;
        } else {
            btn.removeAttribute('aria-busy');
            btn.disabled = false;
        }
    }
    function debounce(fn, wait) {
        let t;
        return function () {
            const args = arguments, ctx = this;
            clearTimeout(t);
            t = setTimeout(() => fn.apply(ctx, args), wait);
        };
    }
    function on(el, ev, sel, fn) {
        if (typeof sel === 'function') {
            el.addEventListener(ev, sel);
            return;
        }
        el.addEventListener(ev, function (e) {
            const t = e.target.closest(sel);
            if (t && el.contains(t)) fn.call(t, e, t);
        });
    }

    // ----- Auth flow on dashboard pages -----
    async function requireAuth(expectedRole) {
        const tok = getToken();
        if (!tok) {
            location.href = 'index.html';
            throw new Error('No session');
        }
        try {
            const me = await api('/api/auth/me');
            if (expectedRole && me.role !== expectedRole) {
                clearAuth();
                location.href = 'index.html';
                throw new Error('Wrong role');
            }
            return me;
        } catch (e) {
            clearAuth();
            location.href = 'index.html';
            throw e;
        }
    }

    async function logout() {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
        clearAuth();
        location.href = 'index.html';
    }

    // ----- Service worker registration -----
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').catch(() => { /* offline fallback only */ });
        });
    }

    window.MV = {
        TOKEN_KEY, REMEMBER_KEY, THEME_KEY,
        api,
        setToken, getToken, clearAuth,
        toast,
        fmtPKR, fmtNum, fmtDate, fmtTime,
        initials, avatarClass,
        escHtml, setBusy, debounce, on,
        requireAuth, logout,
        applyTheme, currentTheme, toggleTheme,
    };

    // ----- Login page handler -----
    document.addEventListener('DOMContentLoaded', () => {
        const form = document.getElementById('loginForm');
        if (!form) return;

        const emailInp = document.getElementById('email');
        const pwInp = document.getElementById('password');
        const remember = document.getElementById('remember');
        const submit = document.getElementById('loginSubmit');
        const errBox = document.getElementById('loginError');

        // Pre-fill remembered email
        const savedEmail = localStorage.getItem(REMEMBER_KEY);
        if (savedEmail && emailInp) {
            emailInp.value = savedEmail;
            if (remember) remember.checked = true;
            if (pwInp) pwInp.focus();
        } else if (emailInp) {
            emailInp.focus();
        }

        // Already logged in? Redirect
        if (getToken()) {
            api('/api/auth/me')
                .then((u) => {
                    location.href = u.role === 'owner' ? 'owner-dashboard.html' : 'staff-dashboard.html';
                })
                .catch(() => clearAuth());
        }

        function showError(msg) {
            if (!errBox) return;
            errBox.textContent = msg;
            errBox.classList.add('show');
        }
        function clearError() {
            if (!errBox) return;
            errBox.textContent = '';
            errBox.classList.remove('show');
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearError();

            const email = (emailInp.value || '').trim().toLowerCase();
            const password = pwInp.value || '';
            if (!email || !password) {
                showError('Please enter both email and password');
                return;
            }

            setBusy(submit, true);
            try {
                const data = await api('/api/auth/login', {
                    method: 'POST',
                    body: { email, password },
                });
                if (!data || !data.token || !data.user) {
                    throw new Error('Unexpected response from server');
                }
                setToken(data.token);
                if (remember && remember.checked) {
                    localStorage.setItem(REMEMBER_KEY, email);
                } else {
                    localStorage.removeItem(REMEMBER_KEY);
                }
                toast('Welcome back, ' + data.user.name, 'success');
                setTimeout(() => {
                    location.href = data.user.role === 'owner'
                        ? 'owner-dashboard.html'
                        : 'staff-dashboard.html';
                }, 200);
            } catch (e) {
                showError(e.message || 'Sign-in failed');
            } finally {
                setBusy(submit, false);
            }
        });
    });
})();
