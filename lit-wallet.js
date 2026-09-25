/*
 * LITEcrib HD wallet — deterministic Litecoin deposit addresses + payouts,
 * served from a single BIP39 seed held server-side (env LITECRIB_SEED).
 *
 * Why an HD wallet instead of depending on a node's wallet?
 *   - Litecoin Core / hosted RPC expose getnewaddress, but the private keys
 *     live with that node. Deriving our own BIP84 (native segwit) addresses
 *     means a single seed on the Render host controls every player deposit
 *     address and all payouts — no wallet-enabled node required, keys don't
 *     roam, and the indexer/RPC is only used for watching + broadcasting.
 *
 * Derivation: m/84'/2'/<account>'/0/<index>   (Litecoin coin type = 2)
 *
 * Payout spend: any Litecoin Core, hosted Litecoin RPC, or the Litecoin Space
 * mempool /tx broadcaster accepts our PSBT-built, signed raw transaction.
 */
'use strict';

const crypto = require('crypto');
const { BIP32Factory } = require('bip32');
const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const config = require('./config');
const net = require('./net');

const NETWORKS = {
    testnet: {
        messagePrefix: '\x19Litecoin Signed Message:\n',
        bech32: 'tltc',
        bip32: { public: 0x043587cf, private: 0x04358394 },
        pubKeyHash: 0x6f,
        scriptHash: 0xc4,
        wif: 0xef
    },
    mainnet: {
        messagePrefix: '\x19Litecoin Signed Message:\n',
        bech32: 'ltc',
        bip32: { public: 0x019da462, private: 0x019d9cfe },
        pubKeyHash: 0x30,
        scriptHash: 0x32,
        wif: 0xb0
    }
};

const ACCOUNT_HOUSE = 0;          // player deposit/winning addresses
const ACCOUNT_POOL = 1;           // reserved: house/operator pool

let rootNode = null;
let warned = false;

function getNetwork() {
    return NETWORKS[config.network] || NETWORKS.testnet;
}

function getRoot() {
    if (rootNode) return rootNode;
    let mnemonic = (process.env.LITECRIB_SEED || '').trim();
    if (!mnemonic) {
        mnemonic = bip39.generateMnemonic(256);
        if (!warned) {
            warned = true;
            console.warn('\n  [!] LITECRIB_SEED not set - generated a FRESH wallet.');
            console.warn('      It exists only in this process (lost on restart).');
            console.warn('      Save it now, then pin it in Render env vars:');
            console.warn('      LITECRIB_SEED="' + mnemonic + '"');
            console.warn('      TESTNET ONLY until you set LTC_NETWORK=mainnet.\n');
        }
    }
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error('LITECRIB_SEED is not a valid BIP39 mnemonic');
    }
    rootNode = bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic));
    return rootNode;
}

function accountNode(account) {
    return getRoot().derivePath("m/84'/2'/" + account + "'/0");
}

// Stable index per player (HD indexes must be < 2^31).
function playerIndex(playerId) {
    const h = crypto.createHash('sha256').update(String(playerId || 'anonymous')).digest();
    return h.readUInt32BE(0) & 0x7fffffff;
}

function addressFor(playerId, account) {
    const node = accountNode(account || ACCOUNT_HOUSE).derive(playerIndex(playerId));
    const pay = bitcoin.payments.p2wpkh({ pubkey: node.publicKey, network: getNetwork() });
    return { address: pay.address, index: playerIndex(playerId) };
}

function keyPairFor(playerId, account) {
    const node = accountNode(account || ACCOUNT_HOUSE).derive(playerIndex(playerId));
    return ECPair.fromPrivateKey(Buffer.from(node.privateKey), { network: getNetwork() });
}

// ---------------------------------------------------------------------------
// Watch + broadcast (public indexer by default, Litecoin RPC when configured).
// ---------------------------------------------------------------------------
function utxoUrl(address) {
    return config.indexerBase + '/address/' + encodeURIComponent(address) + '/utxo';
}

async function listUtxos(address) {
    const utxos = await net.jsonRequest(utxoUrl(address));
    return (utxos || []).map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,                                     // satoshis
        confirmed: !!(u.status && u.status.confirmed)
    }));
}

async function feeRate() {
    try {
        const f = await net.jsonRequest(config.indexerBase + '/v1/fees/recommended');
        return Math.max(1, Math.round(f.fastestFee || f.halfHourFee || 1));
    } catch (e) {
        return 1; // testnet floors at ~1 sat/vbyte anyway
    }
}

async function broadcast(rawHex) {
    if (process.env.LTC_RPC_URL) {
        return net.nodeRpc('sendrawtransaction', [rawHex]);
    }
    return net.jsonRequest(config.indexerBase + '/tx', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: rawHex
    });
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------
function depositAddress(playerId) {
    return addressFor(playerId, ACCOUNT_HOUSE).address;
}

// Spend up to amountLtc from a player's deposit address. Returns { txid, sent, fee }.
// amountLtc: number, or 'all' to sweep every confirmed UTXO.
async function spendFromPlayer({ playerId, toAddress, amountLtc, feerate } = {}) {
    const network = getNetwork();
    const index = playerIndex(playerId);
    const source = addressFor(playerId, ACCOUNT_HOUSE).address;
    const keyPair = keyPairFor(playerId, ACCOUNT_HOUSE);

    const utxos = (await listUtxos(source)).filter((u) => u.confirmed);
    const have = utxos.reduce((s, u) => s + u.value, 0);
    if (have === 0) throw new Error('No confirmed funds on ' + source);

    const fr = feerate || await feeRate();
    const inputWeight = 68;                       // P2WPKH ~68 vB/input
    const outputWeight = 31;                      // P2WPKH output
    let target = 0;
    if (amountLtc !== 'all') {
        target = Math.round((amountLtc || 0) * 1e8);
        if (target <= 0) throw new Error('amountLtc must be > 0 (or "all")');
        const estFee = (utxos.length * inputWeight + 2 * outputWeight) * fr;
        if (have < target + estFee) {
            throw new Error('Insufficient funds: need ~' + (target + estFee) / 1e8 + ' LTC, have ' + have / 1e8);
        }
    }

    // Select confirmed UTXOs until we cover target (+ fee headroom).
    const selected = [];
    let picked = 0;
    for (const u of utxos) {
        if (amountLtc !== 'all' && picked >= target) break;
        selected.push(u);
        picked += u.value;
    }

    const fee = (selected.length * inputWeight + (amountLtc === 'all' ? 1 : 2) * outputWeight) * fr;
    let sendValue;
    let changeValue = 0;
    if (amountLtc === 'all') {
        sendValue = picked - fee;
    } else {
        sendValue = Math.min(target, picked - fee);
        changeValue = picked - fee - sendValue;
    }
    if (sendValue <= 0) throw new Error('Fee exceeds funds; nothing to send');

    const psbt = new bitcoin.Psbt({ network });
    const witnessScript = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network }).output;
    selected.forEach((u) => {
        psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: witnessScript, value: u.value } });
    });
    psbt.addOutput({ address: toAddress, value: sendValue });
    if (changeValue > 0) psbt.addOutput({ address: source, value: changeValue });

    selected.forEach((_, i) => psbt.signInput(i, keyPair));
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const txid = await broadcast(tx.toHex());

    return { txid, sent: sendValue / 1e8, fee: fee / 1e8, source, index };
}

async function balanceOf(playerId) {
    const source = addressFor(playerId, ACCOUNT_HOUSE).address;
    const utxos = await listUtxos(source);
    const confirmed = utxos.filter((u) => u.confirmed).reduce((s, u) => s + u.value, 0);
    const pending = utxos.filter((u) => !u.confirmed).reduce((s, u) => s + u.value, 0);
    return { address: source, confirmedLtc: confirmed / 1e8, unconfirmedLtc: pending / 1e8 };
}

module.exports = {
    networkName: () => config.network,
    depositAddress,
    spendFromPlayer,
    balanceOf,
    listUtxos,
    broadcast,
    feeRate,
    _debug: { accountNode, playerIndex, keyPairFor }
};