/*
 * LITEcrib net — zero-dependency HTTP/RPC transport shared by the relay,
 * the payments providers, and the wallet module.
 */
'use strict';

const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// JSON transport over http/https (returns parsed JSON; works for text/* too).
// Idempotent GETs retry with backoff — public indexers rate-limit.
// ---------------------------------------------------------------------------
function jsonRequest(url, { method = 'GET', headers = {}, body = null, timeout = 20000, attempts = 3 } = {}) {
    const doOnce = () => new Promise((resolve, reject) => {
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

    // Retry only idempotent requests; a failed broadcast must surface as-is.
    if (method !== 'GET' || attempts <= 1) return doOnce();

    return (async () => {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                return await doOnce();
            } catch (e) {
                lastErr = e;
                if (!/^(Request timed out|HTTP (4\d\d|5\d\d))/.test(e.message)) throw e;
                if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
            }
        }
        throw lastErr;
    })();
}

// ---------------------------------------------------------------------------
// Litecoin Core / hosted JSON-RPC (Bitcoin-style). Configure via
// LTC_RPC_URL + LTC_RPC_USER + LTC_RPC_PASS. Any Bitcoin-Core-compatible
// endpoint works, including Litecoin Core and QuickNode's Litecoin RPC.
// ---------------------------------------------------------------------------
let nodeRpcId = 0;

function nodeRpc(method, params) {
    const nodeUrl = process.env.LTC_RPC_URL || '';
    if (!nodeUrl) throw new Error('LTC_RPC_URL not configured.');
    const body = JSON.stringify({ jsonrpc: '1.0', id: ++nodeRpcId, method, params: params || [] });
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.LTC_RPC_PASS) {
        const user = process.env.LTC_RPC_USER || '';
        headers.Authorization = 'Basic ' + Buffer.from(user + ':' + process.env.LTC_RPC_PASS).toString('base64');
    }
    return jsonRequest(nodeUrl, { method: 'POST', headers, body }).then((res) => {
        if (res && res.error) {
            throw new Error('Litecoin RPC ' + method + ': ' + (res.error.message || JSON.stringify(res.error)));
        }
        return res ? res.result : null;
    });
}

module.exports = { jsonRequest, nodeRpc };