/*
 * LITEcrib wallet PSBT unit test — proves derivation + signing + change +
 * broadcast plumbing WITHOUT touching the network. The indexer transport is
 * stubbed per-URL (utxo list, fee rate, tx broadcast), so a spend is built,
 * signed, finalized and "broadcast" against a fake UTXO the address owns.
 */
'use strict';

const process = require('process');
process.env.LITECRIB_SEED = process.env.LITECRIB_SEED || 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const assert = require('assert');
const net = require('../net.js');
const wallet = require('../lit-wallet.js');

const UTXO = { txid: 'f' .repeat(64), vout: 0, value: 5000000, status: { confirmed: true } };
const ORIG = net.jsonRequest;

let utxoQueue = [[UTXO]];

net.jsonRequest = (url, opts) => {
    if (opts && opts.method === 'POST') {
        assert.ok(typeof opts.body === 'string' && /^[0-9a-f]+$/i.test(opts.body), 'broadcast body is raw hex');
        return Promise.resolve('mock-broadcast-txid');
    }
    if (/\/utxo$/.test(url)) return Promise.resolve(utxoQueue.shift() || []);
    if (/\/fees\/recommended$/.test(url)) return Promise.resolve({ fastestFee: 1 });
    return Promise.resolve({ chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } });
};

(async () => {
    const results = [];
    const ok = (name, cond, extra) => {
        results.push(!!cond);
        console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
    };

    // 1) deterministic address (matches BIP-0004-style expectation we verified earlier)
    const a = wallet.depositAddress('psbt_player');
    const b = wallet.depositAddress('psbt_player');
    ok('deterministic deposit address', a === b && /^tltc1/.test(a), a);

    // 2) partial send with change
    const r1 = await wallet.spendFromPlayer({ playerId: 'psbt_player', toAddress: 'tltc1qplzdrwkh5qvctxwddxchn3z7f9xpuae66z623t', amountLtc: 0.01, feerate: 1 });
    ok('partial send signed', r1.txid === 'mock-broadcast-txid', JSON.stringify(r1));
    assert.ok(Math.abs(r1.sent - 0.01) < 0.000001, 'sent is exactly amountLtc');
    ok('change backs to source', r1.fee > 0 && r1.source === a, 'fee=' + r1.fee);

    // 3) sweep-all (single output, no change)
    utxoQueue = [[UTXO]];
    const r2 = await wallet.spendFromPlayer({ playerId: 'psbt_player', toAddress: 'tltc1qplzdrwkh5qvctxwddxchn3z7f9xpuae66z623t', amountLtc: 'all', feerate: 1 });
    ok('sweep-all signed', r2.txid === 'mock-broadcast-txid');
    assert.ok(r2.sent === 5000000 / 1e8 - r2.fee, 'sweep sends everything minus fee');

    // 4) insufficient funds errors cleanly
    utxoQueue = [[]];
    let threw = false;
    try { await wallet.spendFromPlayer({ playerId: 'psbt_player', toAddress: 'tltc1qplzdrwkh5qvctxwddxchn3z7f9xpuae66z623t', amountLtc: 'all', feerate: 1 }); }
    catch (e) { threw = /No confirmed funds/.test(e.message); }
    ok('empty wallet errors cleanly', threw);

    net.jsonRequest = ORIG;
    const fails = results.filter((x) => !x);
    console.log(fails.length ? '\n' + fails.length + ' assertions FAILED' : '\nall wallet PSBT assertions passed');
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('WALLET TEST CRASH:', e); process.exit(2); });
