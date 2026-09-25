/*
 * LITEcrib wallet API e2e — boots server.js in-process on an ephemeral port,
 * asserts the wallet routes, then exits cleanly. No child processes.
 *   env: LITECRIB_SEED, LITECRIB_ADMIN_TOKEN (optional here; uses fixed values)
 */
'use strict';

const process = require('process');
process.env.LITECRIB_ADMIN_TOKEN = process.env.LITECRIB_ADMIN_TOKEN || 'test_admin_token_123';
process.env.LITECRIB_SEED = process.env.LITECRIB_SEED || 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const http = require('http');
const assert = require('assert');

const PORT = 18099;
const BASE = 'http://localhost:' + PORT + '/api/wallet/';

function req(method, path, { body, token } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = http.request(BASE + path, { method, headers }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(d); }
                catch (e) { parsed = d; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        r.on('error', reject);
        if (body) r.write(JSON.stringify(body));
        r.end();
    });
}

(async () => {
    const { server } = require('../server.js');
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

    const results = [];
    const ok = (name, cond, extra) => {
        results.push({ name, pass: !!cond, extra });
        console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
    };

    const cfg = await req('GET', 'config');
    ok('config exposes litvm seam', cfg.status === 200 && cfg.body.litvm && cfg.body.litvm.chainId === 4441, JSON.stringify({ chainId: cfg.body.litvm && cfg.body.litvm.chainId }));

    const dep = await req('POST', 'deposit', { body: { playerId: 'e2e_player' } });
    ok('deposit returns tltc address', dep.status === 200 && /^tltc1/.test(dep.body.address), dep.body.address);

    const dep2 = await req('POST', 'deposit', { body: { playerId: 'e2e_player' } });
    ok('deposit deterministic', dep2.status === 200 && dep2.body.address === dep.body.address);

    const bal = await req('GET', 'player?playerId=e2e_player');
    ok('player balance route', bal.status === 200 && typeof bal.body.confirmedLtc === 'number', JSON.stringify(bal.body));

    const litvm = await req('GET', 'litvm');
    ok('litvm status route', litvm.status === 200 && litvm.body.live === false && litvm.body.gasToken === 'zkLTC');

    const savedAdmin = process.env.LITECRIB_ADMIN_TOKEN;
    delete process.env.LITECRIB_ADMIN_TOKEN;   // handler re-reads env per request
    const noToken = await req('POST', 'payout', { body: { playerId: 'e2e_player', toAddress: 'tltc1qplzdrwkh5qvctxwddxchn3z7f9xpuae66z623t', amountLtc: 'all' } });
    process.env.LITECRIB_ADMIN_TOKEN = savedAdmin;
    ok('payout without token = 501', noToken.status === 501, 'HTTP ' + noToken.status);

    const badToken = await req('POST', 'payout', { body: { playerId: 'e2e_player', toAddress: 'tltc1qplzdrwkh5qvctxwddxchn3z7f9xpuae66z623t', amountLtc: 'all' }, token: 'WRONG' });
    ok('payout wrong token = 401', badToken.status === 401, 'HTTP ' + badToken.status);

    const payout = await req('POST', 'payout', { body: { playerId: 'e2e_player', toAddress: 'tltc1qplzdrwkh5qvctxwddxchn3z7f9xpuae66z623t', amountLtc: 'all' }, token: process.env.LITECRIB_ADMIN_TOKEN });
    ok('payout authed, no funds = clean 422 (not auth/crash)',
        payout.status === 422 && /funds|No confirmed/i.test(payout.body.error), 'HTTP ' + payout.status + ' ' + payout.body.error);

    const fails = results.filter((r) => !r.pass);
    server.close();
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('E2E CRASH:', e); process.exit(2); });
