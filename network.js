/*
 * LITEcrib - Litecoin-powered multiplayer networking client.
 *
 * One public surface (game.js is byte-compatible, needs no changes), two
 * transports:
 *
 *   RELAY - real cross-device networking. When served by the relay server
 *   (`node server.js`), this client talks to it over plain HTTP:
 *     - EventSource (SSE)  GET /api/stream?playerId=..&tableId=..
 *       server -> client push of named events: "tableList", "state", "chat".
 *       EventSource auto-reconnects; on every (re)connect the relay REPLAYS
 *       the full current view, so a freshly-opened lobby or a recovered
 *       connection catches up with zero extra round-trips. Two devices that
 *       point at the same relay genuinely see each other's tables.
 *     - HTTP POST          POST /api/tables/...  (create/join/leave/state/chat)
 *       client -> server. The relay is the single source of truth.
 *
 *   LOCAL - fallback. If no relay is reachable (static GitHub Pages or
 *   file://), it falls back to the old localStorage + `storage`-event
 *   simulation. Table sync then only works across tabs of the SAME browser -
 *   the honest limitation, and the lobby banner says so.
 *
 * Public API (identical to the previous localStorage-only client):
 *   connect() -> Promise<{playerId}>
 *   on/off(event, cb)  events: connected, disconnected, state, tableList,
 *                                chat, connectionState
 *   getServerUrl(), getConnectionStatus(), getTableList(), getTableState()
 *   createTable(mode, name), joinTable(tableId, name), leaveTable()
 *   broadcastState(state), sendGameAction(action, payload), sendChat(message)
 *   syncState(), getServerUrl(), disconnect()
 */
function GameNetwork() {
    'use strict';

    var LS_LIST = 'cribbage_tables';
    var LS_PLAYER = 'cribbage_player_id';
    var LS_BROADCAST = 'cribbage_broadcast_';
    var LS_CHAT = 'cribbage_chat_';
    var LS_STATE = 'cribbage_state_';

    var state = {
        playerId: null,
        playerName: null,
        serverUrl: null,
        mode: 'local',      // 'relay' | 'local'
        connected: false,
        tableId: null
    };

    var listeners = new Map();
    function on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return cb; }
    function off(event, cb) { var a = listeners.get(event); if (!a) return; var i = a.indexOf(cb); if (i !== -1) a.splice(i, 1); }
    function emit(event, data) { var a = listeners.get(event); if (!a) return; a.slice().forEach(function (cb) { try { cb(data); } catch (e) {} }); }

    function serverUrl() {
        if (state.serverUrl) return state.serverUrl;
        var loc = window.location;
        if (loc.protocol === 'http:' || loc.protocol === 'https:') return loc.origin;
        return 'http://localhost:8080';
    }

    function post(path, body) {
        return fetch(serverUrl() + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
          .catch(function () { return { ok: false, error: 'no connection' }; });
    }

    function readList() {
        try { var raw = localStorage.getItem(LS_LIST); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
    }
    function writeList(list) {
        try { localStorage.setItem(LS_LIST, JSON.stringify(list)); localStorage.setItem(LS_BROADCAST + 'list', JSON.stringify({ at: Date.now(), tables: list })); } catch (e) {}
    }
    function localBroadcast() {
        try { localStorage.setItem(LS_BROADCAST + 'tables', JSON.stringify({ at: Date.now(), tables: readList() })); } catch (e) {}
    }

    var listCache = [];
    var stateCache = null;
    var chatCache = [];
    var es = null;

    // -----------------------------------------------------------------------
    // Relay (EventSource + POST)
    // -----------------------------------------------------------------------
    function connectRelay() {
        var url = serverUrl();
        var q = 'playerId=' + encodeURIComponent(state.playerId) + '&tableId=' + encodeURIComponent(state.tableId || '');
        if (es) es.close();
        es = new EventSource(url + '/api/stream?' + q);

        es.addEventListener('tableList', function (ev) {
            try { listCache = JSON.parse(ev.data); emit('tableList', listCache); } catch (e) {}
        });
        es.addEventListener('state', function (ev) {
            try {
                var d = JSON.parse(ev.data);
                if (d.tableId === state.tableId) { stateCache = d.state; emit('state', d.state); }
            } catch (e) {}
        });
        es.addEventListener('chat', function (ev) {
            try {
                var d = JSON.parse(ev.data);
                if (d.tableId === state.tableId) { chatCache = d.messages || []; emit('chat', { messages: chatCache }); }
            } catch (e) {}
        });
        es.onopen = function () { state.connected = true; emit('connected', { playerId: state.playerId, mode: 'relay' }); };
        es.onerror = function () { state.connected = false; emit('disconnected', { mode: 'relay' }); };
    }

    function postRelay(path, body) { return post(path, body); }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    function connect() {
        state.playerId = localStorage.getItem(LS_PLAYER) || ('p_' + Math.random().toString(36).substr(2, 9));
        localStorage.setItem(LS_PLAYER, state.playerId);

        // Pages has no relay API. Do not delay browser play on an API probe.
        if (window.location.hostname.endsWith('.github.io')) {
            state.mode = 'local';
            state.connected = true;
            listCache = readList();
            window.addEventListener('storage', onStorage);
            emit('connected', { playerId: state.playerId, mode: 'local' });
            emit('tableList', listCache);
            return Promise.resolve({ playerId: state.playerId, mode: state.mode });
        }
        var rel = null;
        return fetch(serverUrl() + '/api/health', { method: 'GET' })
            .then(function (r) { rel = r.ok; })
            .catch(function () { rel = false; })
            .then(function () {
                if (rel) {
                    state.mode = 'relay';
                    connectRelay();
                } else {
                    state.mode = 'local';
                    state.connected = true;
                    listCache = readList();
                    window.addEventListener('storage', onStorage);
                    emit('connected', { playerId: state.playerId, mode: 'local' });
                    emit('tableList', listCache);
                }
                return { playerId: state.playerId, mode: state.mode };
            });
    }

    function onStorage(e) {
        if (!e.newValue) return;
        if (e.key === LS_LIST) { listCache = readList(); emit('tableList', listCache); }
        else if (e.key.indexOf(LS_BROADCAST) === 0) { emit('tableList', readList()); }
    }

    function getTableList() { return listCache; }
    function getTableState() { return stateCache; }
    function getConnectionStatus() {
        return { connected: state.connected, mode: state.mode, serverUrl: state.serverUrl || serverUrl(), playerId: state.playerId, tableId: state.tableId };
    }
    function getServerUrl() { return serverUrl(); }

    function createTable(mode, name) {
        if (state.mode === 'relay') {
            return post('/api/tables', { mode: mode, name: name, playerId: state.playerId }).then(function (res) {
                if (res.ok && res.tableId) { state.tableId = res.tableId; }
                return res;
            });
        }
        var table = {
            id: 't_' + Date.now().toString(36),
            mode: mode,
            name: name || 'Table',
            players: [{ id: state.playerId, name: name || 'Player', ready: true }],
            state: null,
            chat: []
        };
        var list = readList();
        list.push(table);
        writeList(list);
        localBroadcast();
        emit('tableList', list);
        state.tableId = table.id;
        return Promise.resolve({ ok: true, tableId: table.id, table: table });
    }

    function joinTable(tableId, name) {
        if (state.mode === 'relay') {
            return post('/api/tables/' + tableId + '/join', { playerId: state.playerId, name: name || state.playerName }).then(function (res) {
                if (res.ok || res.success) state.tableId = tableId;
                return res;
            });
        }
        var list = readList();
        var found = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === tableId) { found = list[i]; break; }
        }
        if (!found) return Promise.resolve({ ok: false, error: 'not found' });
        var exists = found.players.some(function (p) { return p.id === state.playerId; });
        if (!exists) found.players.push({ id: state.playerId, name: name || state.playerName, ready: false });
        writeList(list);
        localBroadcast();
        emit('tableList', list);
        emit('state', found.state);
        state.tableId = tableId;
        return Promise.resolve({ ok: true, table: found });
    }

    function leaveTable() {
        if (state.mode === 'relay' && state.tableId) {
            return post('/api/tables/' + state.tableId + '/leave', { playerId: state.playerId }).then(function (res) {
                state.tableId = null; return res;
            });
        }
        var list = readList();
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === state.tableId) {
                list[i].players = list[i].players.filter(function (p) { return p.id !== state.playerId; });
                if (list[i].players.length === 0) list.splice(i, 1);
                break;
            }
        }
        writeList(list);
        localBroadcast();
        emit('tableList', list);
        state.tableId = null;
        return Promise.resolve({ ok: true });
    }

    function broadcastState(value) {
        if (state.mode === 'relay' && state.tableId) {
            return post('/api/tables/' + state.tableId + '/state', { playerId: state.playerId, state: value }).then(function (res) {
                if (res.ok && res.state) stateCache = res.state;
                return res;
            });
        }
        stateCache = value;
        var list = readList();
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === state.tableId) { list[i].state = value; break; }
        }
        writeList(list);
        localBroadcast();
        emit('state', value);
        return Promise.resolve({ ok: true });
    }

    function sendGameAction(action, payload) {
        return broadcastState({ __action: action, __payload: payload || {}, playerId: state.playerId });
    }

    function sendChat(message) {
        if (state.mode === 'relay') {
            return post('/api/tables/' + state.tableId + '/chat', { playerId: state.playerId, message: message }).then(function (res) { return res; });
        }
        var list = readList();
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === state.tableId) {
                list[i].chat = list[i].chat || [];
                list[i].chat.push({ playerId: state.playerId, name: state.playerName, message: message, at: Date.now() });
                break;
            }
        }
        writeList(list);
        localBroadcast();
        emit('chat', { messages: (function () { for (var i = 0; i < list.length; i++) if (list[i].id === state.tableId) return list[i].chat; return []; })() });
        return Promise.resolve({ ok: true });
    }

    function syncState() {
        if (state.mode === 'relay' && state.tableId) {
            return post('/api/tables/' + state.tableId + '/state', { playerId: state.playerId, pull: true }).then(function (res) {
                if (res.ok && res.state) { stateCache = res.state; emit('state', res.state); }
                return res;
            });
        }
        return Promise.resolve({ ok: true, state: stateCache });
    }

    function disconnect() {
        if (es) { es.close(); es = null; }
        state.connected = false;
        emit('disconnected', { mode: state.mode });
    }

    var net = {
        connect: connect,
        on: on,
        off: off,
        emit: emit,
        getServerUrl: getServerUrl,
        getConnectionStatus: getConnectionStatus,
        getTableList: getTableList,
        getTableState: getTableState,
        createTable: createTable,
        joinTable: joinTable,
        leaveTable: leaveTable,
        broadcastState: broadcastState,
        sendGameAction: sendGameAction,
        sendChat: sendChat,
        syncState: syncState,
        disconnect: disconnect
    };

    ['playerId', 'playerName', 'tableId', 'connected'].forEach(function (key) {
        Object.defineProperty(net, key, { get: function () { return state[key]; } });
    });
    return net;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GameNetwork: GameNetwork };
} else {
    window.GameNetwork = GameNetwork;
}
