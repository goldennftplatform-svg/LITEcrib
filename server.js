/*
 * LITEcrib - Litecoin multiplayer relay server (zero dependencies).
 *
 * Serves the static game files AND brokers tables between devices.
 *
 * Transport: Server-Sent Events (server -> client) + HTTP POST (client -> server).
 *  - GET  /api/stream?playerId=...&tableId=...   SSE channel; pushes
 *        "tableList", "state", "chat" events. Browser auto-reconnects; on
 *        reconnect the server re-sends everything so a freshly-loaded or
 *        recovered lobby catches up.
 *  - GET  /api/tables                        -> current table registry
 *  - POST /api/tables/                       -> {mode, name} creates a table
 *  - POST /api/tables/:id/join               -> {name} joins
 *  - POST /api/tables/:id/leave              -> {playerId} leaves
 *  - POST /api/tables/:id/state              -> {playerId, state} stores + broadcasts
 *  - POST /api/tables/:id/chat               -> {playerId, name, message} broadcasts
 *
 * In-memory state: tables vanish on server restart (fine for a relay; the
 * host just re-creates).
 *
 * Run:  node server.js
 * Then on your LAN:  http://<THIS_PC_IP>:8080   (phone connects to the same).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const LTC = require('./payments');
const auth = require('./auth');
const store = require('./store');

store.load(); // accounts survive restarts (sessions do not)

const PORT = process.env.PORT || 8080;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// Registry + relay state (all in memory).
// ---------------------------------------------------------------------------
const MEDIA_RE = /^(ws|wss)|^(https?:\/\/)/i;

const tables = new Map();          // tableId -> { id, mode, created, players:[{id,name,ready}], }
let tableSeq = 0;

// SSE clients: Set of { res, playerId, tableId, flags:Set }
const streams = new Set();

function generateId(prefix) {
    return prefix + '_' + Math.random().toString(36).substr(2, 9);
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            if (err) {
                resolve(null);
                return;
            }
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                resolve(null);
            }
        };
        req.on('data', (c) => {
            data += c;
            if (data.length > 1e6) finish(new Error('too large'));
        });
        req.on('end', () => finish());
        req.on('error', () => finish(new Error('read error')));
    });
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------
function sendSse(res, event, payload) {
    const data = JSON.stringify(payload);
    res.write(`event: ${event}\ndata: ${data}\n\n`);
}

function tableToJson(table) {
    return {
        id: table.id,
        mode: table.mode,
        created: table.created,
        players: table.players.map(p => ({ id: p.id, name: p.name, ready: !!p.ready }))
    };
}

function broadcastTables() {
    const list = Array.from(tables.values()).map(tableToJson);
    streams.forEach((s) => sendSse(s.res, 'tableList', list));
}

function broadcastState(table, state, sourcePlayerId) {
    // Relay a full machine-state swap. Everyone including the sender gets it
    // (idempotent snapshot semantics — the sender's own render already has it,
    // re-rendering the same object is a no-op visually).
    streams.forEach((s) => {
        if (s.tableId === table.id) sendSse(s.res, 'state', { tableId: table.id, state });
    });
}

function broadcastChat(table, chat) {
    streams.forEach((s) => {
        if (s.tableId === table.id) sendSse(s.res, 'chat', chat);
    });
}

function broadcastTableJoin(table) {
    // Everyone in the table gets the updated player roster + server timer for
    // handshake bookkeeping (kept identical to the "state" event shape).
    streams.forEach((s) => {
        if (s.tableId === table.id) {
            sendSse(s.res, 'state', { tableId: table.id, state: table.lastState || {} });
        }
    });
    broadcastTables(); // lobby rosters everywhere
}

// ---------------------------------------------------------------------------
// Registry mutations
// ---------------------------------------------------------------------------
function createTable(mode, name) {
    const id = 'table_' + (++tableSeq) + '_' + Date.now().toString(36);
    const table = {
        id,
        mode,
        created: Date.now(),
        players: [],
        lastState: null
    };
    if (name) {
        table.players.push({ id: generateId('player'), name, ready: false });
    }
    tables.set(id, table);
    broadcastTables();
    return table;
}

function findTable(id) {
    return tables.get(id) || null;
}

function joinTable(table, playerName) {
    const maxPlayers = table.mode === '1v1' ? 2 : 3;
    if (table.players.length >= maxPlayers) {
        return { success: false, error: 'Table full' };
    }
    const player = { id: generateId('player'), name: playerName, ready: true };
    table.players.push(player);
    broadcastTableJoin(table);
    return { success: true, playerId: player.id, table };
}

function leaveTable(table, playerId) {
    table.players = table.players.filter(p => p.id !== playerId);
    if (table.players.length === 0) {
        tables.delete(table.id);
    }
    broadcastTables();
    return true;
}

function unsubscribeStream(s) {
    streams.delete(s);
    s.res.end();
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    };
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    // ---- API: SSE stream -----------------------------------------------------
    if (p === '/api/stream' && req.method === 'GET') {
        const playerId = url.searchParams.get('playerId');
        const tableId = url.searchParams.get('tableId') || null;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        res.write('retry: 1500\n\n');

        const stream = { res, playerId, tableId, flags: new Set() };
        streams.add(stream);

        // Initial catch-up: table list for everyone; state+roster for the table.
        const list = Array.from(tables.values()).map(tableToJson);
        sendSse(res, 'tableList', list);

        if (tableId) {
            const table = findTable(tableId);
            if (table) {
                sendSse(res, 'state', { tableId, state: table.lastState || {} });
                const roster = tableToJson(table);
                sendSse(res, 'roster', roster.players);
            }
        }

        req.on('close', () => unsubscribeStream(stream));
        return;
    }

    // ---- API: tables -----------------------------------------------------------
    if (p === '/api/tables' && req.method === 'GET') {
        sendJson(res, 200, { tables: Array.from(tables.values()).map(tableToJson) });
        return;
    }

    if (p === '/api/tables' && req.method === 'POST') {
        readBody(req).then((body) => {
            if (!body || !body.mode) {
                sendJson(res, 400, { success: false, error: 'mode required' });
                return;
            }
            const table = createTable(body.mode, body.name);
            sendJson(res, 200, { success: true, table: tableToJson(table), tableId: table.id });
        });
        return;
    }

    // ---- API: join/leave/state/chat per table ------------------------------------
    const tableMatch = p.match(/^\/api\/tables\/([^/]+)\/(join|leave|state|chat)$/);
    if (tableMatch) {
        const tableId = tableMatch[1];
        const op = tableMatch[2];
        const table = findTable(tableId);
        if (!table) {
            sendJson(res, 404, { success: false, error: 'Table not found' });
            return;
        }
        readBody(req).then((body) => {
            switch (op) {
                case 'join': {
                    if (!body || !body.name) {
                        sendJson(res, 400, { success: false, error: 'name required' });
                        return;
                    }
                    const result = joinTable(table, body.name);
                    if (result.success) {
                        sendJson(res, 200, { success: true, playerId: result.playerId, table: tableToJson(table), tableId });
                    } else {
                        sendJson(res, 409, result);
                    }
                    return;
                }
                case 'leave': {
                    leaveTable(table, body && body.playerId);
                    sendJson(res, 200, { success: true });
                    return;
                }
                case 'state': {
                    if (!body || !body.state) {
                        sendJson(res, 400, { success: false, error: 'state required' });
                        return;
                    }
                    table.lastState = body.state;
                    broadcastState(table, body.state, body.playerId);
                    sendJson(res, 200, { success: true });
                    return;
                }
                case 'chat': {
                    if (!body || !body.message) {
                        sendJson(res, 400, { success: false, error: 'message required' });
                        return;
                    }
                    const chat = {
                        tableId,
                        playerId: body.playerId || '',
                        playerName: body.name || 'Anonymous',
                        message: body.message,
                        timestamp: Date.now()
                    };
                    broadcastChat(table, chat);
                    sendJson(res, 200, { success: true });
                    return;
                }
            }
        });
        return;
    }

    // ---- API: SSO auth + custody wallets ---------------------------------------
    // register: creates the account AND issues a fresh BIP39 wallet. Key export
    // is a separate, password-rechecked endpoint — never returned on login.
    if (p === '/api/auth/register' && req.method === 'POST') {
        readBody(req).then((body) => {
            try {
                const r = auth.registerUser(body && body.email, body && body.password, req.socket.remoteAddress);
                sendJson(res, 200, { success: true, token: r.token, user: r.user });
            } catch (e) {
                sendJson(res, e.code || 500, { success: false, error: e.message || 'server error' });
            }
        });
        return;
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
        readBody(req).then((body) => {
            try {
                const r = auth.login(body && body.email, body && body.password, req.socket.remoteAddress);
                sendJson(res, 200, { success: true, token: r.token, user: r.user });
            } catch (e) {
                sendJson(res, e.code || 500, { success: false, error: e.message || 'server error' });
            }
        });
        return;
    }

    // me: who am I (+ wallet address, never the mnemonic).
    if (p === '/api/auth/me' && req.method === 'GET') {
        const user = auth.getSessionUser((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        if (!user) {
            sendJson(res, 401, { success: false, error: 'unauthorized' });
            return;
        }
        LTC.userBalance(user.mnemonic).then((bal) => {
            sendJson(res, 200, { success: true, user: { ...auth.publicUser(user) }, balance: bal });
        }).catch(() => {
            sendJson(res, 200, { success: true, user: auth.publicUser(user), balance: null });
        });
        return;
    }

    // export: user proves password, gets their BIP39 mnemonic (self-custody exit).
    if (p === '/api/wallet/export' && req.method === 'POST') {
        const user = auth.getSessionUser((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        if (!user) {
            sendJson(res, 401, { success: false, error: 'unauthorized' });
            return;
        }
        readBody(req).then((body) => {
            try {
                const w = auth.exportWallet(user, body && body.password, req.socket.remoteAddress);
                sendJson(res, 200, { success: true, ...w, network: LTC.config.network });
            } catch (e) {
                sendJson(res, e.code || 500, { success: false, error: e.message || 'server error' });
            }
        });
        return;
    }

    // ---- API: LITEcrib wallet (LTC deposits + LitVM seam) ----------------------
    if (p === '/api/wallet/config' && req.method === 'GET') {
        sendJson(res, 200, LTC.config);
        return;
    }

    if (p === '/api/wallet/deposit' && req.method === 'POST') {
        readBody(req).then(async (body) => {
            try {
                const account = await LTC.getDepositAddress(body && body.playerId);
                sendJson(res, 200, { success: true, ...account, network: LTC.config.network });
            } catch (e) {
                sendJson(res, 501, { success: false, error: e.message });
            }
        });
        return;
    }

    if (p === '/api/wallet/status' && req.method === 'GET') {
        const address = url.searchParams.get('address');
        if (!address) {
            sendJson(res, 400, { success: false, error: 'address required' });
            return;
        }
        LTC.getStatus(address).then((status) => {
            sendJson(res, 200, { success: true, address, network: LTC.config.network, ...status });
        }).catch((e) => {
            sendJson(res, 502, { success: false, error: e.message });
        });
        return;
    }

    // LitVM seam — read-only; reports pipeline status until mainnet.
    if (p === '/api/wallet/litvm' && req.method === 'GET') {
        sendJson(res, 200, { success: true, ...LTC.litvm.config, status: LTC.litvm.status() });
        return;
    }

    // Player wallet balance by playerId (server derives the address).
    if (p === '/api/wallet/player' && req.method === 'GET') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) {
            sendJson(res, 400, { success: false, error: 'playerId required' });
            return;
        }
        LTC.balanceOfPlayer(playerId).then((b) => {
            sendJson(res, 200, { success: true, ...b, network: LTC.config.network });
        }).catch((e) => {
            sendJson(res, 502, { success: false, error: e.message });
        });
        return;
    }

    // Payout — DISABLED unless LITECRIB_ADMIN_TOKEN is set; requires the
    // bearer token. amountLtc: number or 'all' (sweep the player's address).
    if (p === '/api/wallet/payout' && req.method === 'POST') {
        const ADMIN = process.env.LITECRIB_ADMIN_TOKEN || '';
        if (!ADMIN) {
            sendJson(res, 501, { success: false, error: 'payout disabled (set LITECRIB_ADMIN_TOKEN)' });
            return;
        }
        const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (auth !== ADMIN) {
            sendJson(res, 401, { success: false, error: 'unauthorized' });
            return;
        }
        readBody(req).then(async (body) => {
            try {
                if (!body || !body.playerId || !body.toAddress) {
                    sendJson(res, 400, { success: false, error: 'playerId and toAddress required' });
                    return;
                }
                const feerate = body.feerate ? Number(body.feerate) : undefined;
                const result = await LTC.payoutFromPlayer(body.playerId, body.toAddress, body.amountLtc || 'all', feerate);
                sendJson(res, 200, { success: true, ...result, network: LTC.config.network });
            } catch (e) {
                sendJson(res, 422, { success: false, error: e.message });
            }
        });
        return;
    }

    // ---- Static files (GitHub Pages parity) ---------------------------------------
    let filePath = path.join('.', decodeURIComponent(p));
    if (filePath === '.' || filePath.endsWith(path.sep)) filePath = path.join('./index.html');

    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, content) => {
        if (err) {
            fs.readFile('./index.html', (err2, content2) => {
                if (err2) {
                    res.writeHead(500);
                    res.end('Server Error');
                    return;
                }
                res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
                res.end(content2);
            });
            return;
        }
        const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
        // Never cache the loading page or JS/CSS during dev so edits show up.
        if (ext === '.html' || ext === '.js' || ext === '.css') {
            headers['Cache-Control'] = 'no-cache';
        }
        res.writeHead(200, headers);
        res.end(content);
    });
});

if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        const nets = require('os').networkInterfaces();
        let lanIp = '';
        Object.keys(nets).forEach((name) => {
            (nets[name] || []).forEach((net) => {
                if (net.family === 'IPv4' && !net.internal) lanIp = net.address;
            });
        });
        console.log('\n  LITEcrib relay running!');
        console.log(`  Local      : http://localhost:${PORT}/`);
        if (lanIp) console.log(`  LAN (phone): http://${lanIp}:${PORT}/`);
        console.log('  Connect both devices to the SAME address above.');
        console.log('  Wallet API : /api/auth/* (SSO), /api/wallet/* (deposit, status, payout, export)');
        console.log('  LitVM seam : /api/wallet/litvm (LiteForge testnet, chain ' + LTC.litvm.config.chainId + ')\n');
    });
}

module.exports = { server };
