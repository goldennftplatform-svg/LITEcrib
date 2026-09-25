/*
 * LITEcrib SSO + custody wallet e2e — register/login/me/export, and the one
 * assertion that matters: deriving the wallet from the EXPORTED mnemonic at
 * USER_PATH reproduces the issued address (i.e. export = real Electrum-LTC
 * recovery). Runs in-process against a temp store file; server.js must not
 * start listening on import (it is gated behind require.main).
 */
'use strict';

const process = require('process');
process.env.LITECRIB_STORE_FILE = process.env.LITECRIB_STORE_FILE ||
    require('path').join(require('os').tmpdir(), 'litecrib-sso-' + Date.now() + '.json');

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bip32 = BIP32Factory(ecc);
const bitcoin = require('bitcoinjs-lib');

const PORT = 18100;
const BASE = 'http://localhost:' + PORT + '/api/';

function req(method, api, { body, token } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = http.request(BASE + api, { method, headers }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(d); } catch (e) { parsed = d; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        r.on('error', reject);
        if (body) r.write(JSON.stringify(body));
        r.end();
    });
}

const TESTNET = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'tltc',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef
};

function deriveAddress(mnemonic) {
    const root = bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic));
    const node = root.derivePath("m/84'/2'/0'/0/0");
    return bitcoin.payments.p2wpkh({ pubkey: node.publicKey, network: TESTNET }).address;
}

(async () => {
    const { server } = require('../server.js');
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

    const results = [];
    const ok = (name, cond, extra) => {
        results.push(!!cond);
        console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra != null ? '  (' + extra + ')' : ''));
    };

    // 1) register issues an account + fresh custody wallet
    const reg = await req('POST', 'auth/register', { body: { email: '  Alice@LITEcrib.dev ', password: 'correct-horse-123' } });
    ok('register = 200 with token', reg.status === 200 && !!reg.body.token, 'status ' + reg.status);
    ok('registers new wallet on tltc', /^tltc1/.test(reg.body.user.address), reg.body.user.address);
    ok('email normalized to lowercase', reg.body.user.email === 'alice@litecrib.dev', reg.body.user.email);
    ok('mnemonic NOT leaked on register', !JSON.stringify(reg.body).includes('mnemonic'));
    const alice = { token: reg.body.token, user: reg.body.user };

    // 2) duplicate email rejected
    const dup = await req('POST', 'auth/register', { body: { email: 'alice@litecrib.dev', password: 'whatever-pw-123' } });
    ok('duplicate email = 409', dup.status === 409, 'status ' + dup.status);

    // 3) weak password rejected
    const weak = await req('POST', 'auth/register', { body: { email: 'bob@litecrib.dev', password: 'short' } });
    ok('weak password = 400', weak.status === 400, 'status ' + weak.status);

    // 4) login: wrong then right
    const bad = await req('POST', 'auth/login', { body: { email: 'alice@litecrib.dev', password: 'wrong-password-1' } });
    ok('wrong password = 401', bad.status === 401, 'status ' + bad.status);
    const login = await req('POST', 'auth/login', { body: { email: 'alice@litecrib.dev', password: 'correct-horse-123' } });
    ok('login = 200 with new token', login.status === 200 && !!login.body.token);
    const aliceLogin = login.body.token;

    // 5) me: session resolves, wallet matches, balance route answers
    const me = await req('GET', 'auth/me', { token: aliceLogin });
    ok('me resolves account', me.status === 200 && me.body.user.id === alice.user.id, 'status ' + me.status);
    ok('me.address === issued address', me.body.user.address === alice.user.address);
    ok('me omits mnemonic', !JSON.stringify(me.body).includes('mnemonic'));
    ok('me carries balance (indexer, null-tolerant)', me.status === 200 && (me.body.balance === null || typeof me.body.balance.confirmedLtc === 'number'));

    // 6) export: wrong password rejects, correct returns mnemonic
    const exportBad = await req('POST', 'wallet/export', { token: aliceLogin, body: { password: 'wrong-password-1' } });
    ok('export wrong password = 403', exportBad.status === 403, 'status ' + exportBad.status);
    const exportOk = await req('POST', 'wallet/export', { token: aliceLogin, body: { password: 'correct-horse-123' } });
    ok('export correct password = 200', exportOk.status === 200 && !!exportOk.body.mnemonic);
    const mnemonic = exportOk.body.mnemonic;

    // 7) THE assertion: exported mnemonic restores the issued address (Electrum path)
    const restored = deriveAddress(mnemonic);
    ok('exported mnemonic restores issued address (real recovery)', restored === alice.user.address, restored + ' vs ' + alice.user.address);

    // 8) unauth'd me = 401, unauth'd export = 401
    const noMe = await req('GET', 'auth/me');
    ok('me without token = 401', noMe.status === 401);
    const noExp = await req('POST', 'wallet/export', { body: {} });
    ok('export without token = 401', noExp.status === 401);

    // 9) login throttling: 5 bad attempts -> 429
    for (let i = 0; i < 5; i++) await req('POST', 'auth/login', { body: { email: 'throttle@litecrib.dev', password: 'nope-nope-nope' } });
    const throttle = await req('POST', 'auth/login', { body: { email: 'throttle@litecrib.dev', password: 'nope-nope-nope' } });
    ok('throttled after repeated failures = 429', throttle.status === 429, 'status ' + throttle.status);

    // 10) restart persistence: accounts survive a fresh store load
    server.close();
    delete require.cache[require.resolve('../store.js')];
    const store2 = require('../store.js');
    store2.load();
    ok('accounts survive restart (persisted)', store2.findByEmail('alice@litecrib.dev') !== null && store2.findByEmail('alice@litecrib.dev').address === alice.user.address);
    ok('store file path is repo-external', path.basename(store2._file) !== 'users.json');

    fs.unlinkSync(process.env.LITECRIB_STORE_FILE);   // cleanup temp store

    const fails = results.filter((x) => !x);
    console.log(fails.length ? '\n' + fails.length + ' assertions FAILED' : '\nall SSO + custody assertions passed');
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('SSO TEST CRASH:', e); process.exit(2); });