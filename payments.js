/*
 * LITEcrib payments — Litecoin deposit + verification. SERVER-SIDE ONLY.
 *
 * Provider seam (two backends, one interface):
 *   getDepositAddress(playerId) -> Promise<{address}>
 *   getStatus(address)          -> Promise<{confirmedLtc, unconfirmedLtc, txCount, txs:[{txid, value, confirmed}]}>
 *
 *   - nodeRpc : Litecoin Core JSON-RPC — address issuance + authoritative tx data
 *               (configure via LTC_RPC_URL / LTC_RPC_USER / LTC_RPC_PASS).
 *   - mempool : Mempool.space LTC indexer — public status/confirmations.
 *
 * Game state / settlement can later move under LitVM by adding a third
 * provider here with the same interface — the client only talks to
 * /api/wallet/* routes, never to a chain directly.
 */
'use strict';

const config = require('./config');
const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// Tiny JSON transport (zero deps — works wherever the relay runs).
// ---------------------------------------------------------------------------
function jsonRequest(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        let mod = https;
        if (/^http:\/\//i.test(url)) mod = http;
        const req = mod.request(url, { method, headers }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
                    return;
                }
                try { resolve(data ? JSON.parse(data) : null); }
                catch (e) { reject(new Error('Bad JSON from ' + url)); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
        req.setTimeout(timeout);
        if (body) req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Litecoin Core JSON-RPC provider.
// ---------------------------------------------------------------------------
const NODE_URL = process.env.LTC_RPC_URL || '';
const NODE_USER = process.env.LTC_RPC_USER || '';
const NODE_PASS = process.env.LTC_RPC_PASS || '';
let nodeRpcId = 0;

async function nodeRpc(method, params) {
    if (!NODE_URL) {
        throw new Error('LTC_RPC_URL not configured — deposits need Litecoin Core (testnet) or an HD wallet backend.');
    }
    const body = JSON.stringify({ jsonrpc: '1.0', id: ++nodeRpcId, method, params: params || [] });
    const auth = 'Basic ' + Buffer.from(NODE_USER + ':' + NODE_PASS).toString('base64');
    const res = await jsonRequest(NODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body
    });
    if (res.error) throw new Error('Litecoin RPC ' + method + ': ' + (res.error.message || JSON.stringify(res.error)));
    return res.result;
}

const nodeProvider = {
    async getDepositAddress(playerId) {
        const tag = String(playerId || 'anonymous').replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 20);
        const address = await nodeRpc('getnewaddress', ['litecrib_' + tag]);
        return { address };
    },
    async getStatus(address) {
        const confirmed = await nodeRpc('listunspent', [1, 9999999, [address], true]);
        const mempool = await nodeRpc('listunspent', [0, 0, [address], true]);
        let confirmedLtc = 0;
        let unconfirmedLtc = 0;
        const txs = [];
        const seen = new Set();
        function push(utxo, confs) {
            if (seen.has(utxo.txid)) return;
            seen.add(utxo.txid);
            txs.push({ txid: utxo.txid, value: utxo.amount, confirmed: confs >= 1 });
        }
        confirmed.forEach((u) => { confirmedLtc += u.amount; push(u, u.confirmations); });
        mempool.forEach((u) => { unconfirmedLtc += u.amount; push(u, u.confirmations); });
        return { confirmedLtc, unconfirmedLtc, txCount: txs.length, txs };
    }
};

// ---------------------------------------------------------------------------
// Mempool.space indexer provider (public, no auth).
// ---------------------------------------------------------------------------
const mempoolProvider = {
    async getDepositAddress(playerId) {
        throw new Error('Address issuance requires Litecoin Core RPC (set LTC_RPC_URL) or an HD wallet backend.');
    },
    async getStatus(address) {
        const base = config.indexerBase;
        const [addr, txs] = await Promise.all([
            jsonRequest(base + '/address/' + encodeURIComponent(address)),
            jsonRequest(base + '/address/' + encodeURIComponent(address) + '/txs')
        ]);
        const confirmedLtc = (addr.chain_stats.funded_txo_sum - addr.chain_stats.spent_txo_sum) / 1e8;
        const unconfirmedLtc = (addr.mempool_stats.funded_txo_sum - addr.mempool_stats.spent_txo_sum) / 1e8;
        const list = (txs || []).map((t) => {
            let value = 0;
            (t.vout || []).forEach((o) => {
                if (o.scriptpubkey_address === address) value += o.value;
            });
            (t.vin || []).forEach((i) => {
                if (i.prevout && i.prevout.scriptpubkey_address === address) value -= i.prevout.value;
            });
            return { txid: t.txid, value: value / 1e8, confirmed: !!(t.status && t.status.confirmed) };
        });
        return { confirmedLtc, unconfirmedLtc, txCount: list.length, txs: list };
    }
};

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------
module.exports = {
    config: config.public(),
    getDepositAddress: (playerId) => nodeProvider.getDepositAddress(playerId),
    getStatus: async (address) => {
        try {
            return await mempoolProvider.getStatus(address);
        } catch (e) {
            return nodeProvider.getStatus(address);
        }
    },
    providers: { nodeRpc, nodeProvider, mempoolProvider }
};