/*
 * LITEcrib wallet client — LTC deposit panel for the lobby, driven by the
 * relay's /api/wallet/* routes. No secrets ever live client-side; the server
 * owns address issuance + verification (payments.js).
 *
 * Degrades silently on static hosting (no relay): the panel stays hidden and
 * nothing throws.
 */
(function () {
    'use strict';

    var cfg = window.LITECRIB_CONFIG || {};
    var LS_PLAYER = 'cribbage_player_id';
    var LS_ADDR = 'litecrib_deposit_addr';

    var panel, addrEl, balEl, netEl, refreshBtn, tipEl;
    var lastAddr = '';

    function base() {
        var loc = window.location;
        if (loc.protocol === 'http:' || loc.protocol === 'https:') return loc.origin;
        return 'http://localhost:8080';
    }

    function getPlayerId() {
        if (window.network && window.network.playerId) return window.network.playerId;
        try { return localStorage.getItem(LS_PLAYER) || ''; } catch (e) { return ''; }
    }

    async function api(path, opts) {
        var res;
        try { res = await fetch(base() + path, opts); } catch (e) { return null; }
        if (!res.ok) return null;
        try { return await res.json(); } catch (e) { return null; }
    }

    async function depositAddress() {
        var cached = null;
        try { cached = localStorage.getItem(LS_ADDR) || ''; } catch (e) {}
        if (cached) return cached;
        var body;
        try { body = JSON.stringify({ playerId: getPlayerId() }); } catch (e) {}
        var data = await api('/api/wallet/deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
        });
        if (!data || !data.success || !data.address) return '';
        try { localStorage.setItem(LS_ADDR, data.address); } catch (e) {}
        return data.address;
    }

    async function refresh() {
        if (!lastAddr) {
            lastAddr = await depositAddress();
            if (addrEl) addrEl.textContent = lastAddr || 'NO ADDRESS (start the relay, set LTC_RPC_URL)';
            if (!lastAddr) return;
        }
        var data = await api('/api/wallet/status?address=' + encodeURIComponent(lastAddr));
        if (!data) {
            setBalance('OFFLINE'); // static hosting, no relay
            return;
        }
        if (!data.success) {
            setBalance(data.error || 'UNAVAILABLE');
            return;
        }
        var total = (data.confirmedLtc || 0) + (data.unconfirmedLtc || 0);
        if (total > 0) {
            setBalance(data.confirmedLtc + ' LTC' + (data.unconfirmedLtc ? ' (+' + data.unconfirmedLtc + ' pending)' : ''));
        } else {
            setBalance('0 LTC — waiting for deposit');
        }
    }

    function setBalance(text) {
        if (balEl) balEl.textContent = text;
    }

    async function init() {
        if (!cfg.features || !cfg.features.paymentsEnabled) return;
        panel = document.getElementById('wallet-panel');
        if (!panel) return;

        addrEl = document.getElementById('wallet-addr');
        balEl = document.getElementById('wallet-bal');
        netEl = document.getElementById('wallet-net');
        tipEl = document.getElementById('wallet-tip');
        refreshBtn = document.getElementById('wallet-refresh-btn');

        if (netEl) netEl.textContent = (cfg.network === 'mainnet' ? 'MAINNET' : 'TESTNET').toUpperCase();
        panel.hidden = false;
        if (refreshBtn) refreshBtn.addEventListener('click', refresh);
        refresh();

        if (tipEl && cfg.network !== 'mainnet') {
            tipEl.textContent = 'TESTNET only — faucet coins are free, do not send real LTC';
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();