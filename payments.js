/*
 * LITEcrib payments — Litecoin deposits, status, payouts. SERVER-SIDE ONLY.
 *
 *   getDepositAddress(playerId) -> { address }         from the HD wallet (lit-wallet.js)
 *   getStatus(address)          -> { confirmedLtc, unconfirmedLtc, txCount, txs }
 *                                -> Litecoin Space indexer, or node RPC when configured
 *   payoutFromPlayer(...)       -> { txid }            PSBT-signed sweep/send (lit-wallet.js)
 *
 * Keys never leave the host: a single BIP39 seed (env LITECRIB_SEED) derives
 * every player address on account m/84'/2'/0/... and signs payouts. The RPC
 * / indexer are watch + broadcast only.
 *
 * The LitVM seam stays behind /api/wallet/* too: when settlement moves on
 * chain, add a LitVM provider to this module with the same interface and the
 * client never changes.
 */
'use strict';

const config = require('./config');
const net = require('./net');
const wallet = require('./lit-wallet');

// ---------------------------------------------------------------------------
// Status provider: Litecoin Space indexer (public), Core RPC as fallback.
// ---------------------------------------------------------------------------
async function getStatus(address) {
    const base = config.indexerBase;
    const [addr, txs] = await Promise.all([
        net.jsonRequest(base + '/address/' + encodeURIComponent(address)),
        net.jsonRequest(base + '/address/' + encodeURIComponent(address) + '/txs')
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

async function getStatusOrNode(address) {
    try {
        return await getStatus(address);
    } catch (e) {
        return net.nodeRpc('getreceivedbyaddress', [address, 1]).then((confirmed) => {
            return { confirmedLtc: (confirmed || 0), unconfirmedLtc: 0, txCount: 0, txs: [] };
        });
    }
}

// ---------------------------------------------------------------------------
// LitVM provider seam (testnet constants — mainnet pending). Wire payout to a
// contracts/Settlement.sol call here once mainnet ships; earnings can match
// script hash + game result to release escrow.
// ---------------------------------------------------------------------------
const litvm = {
    config: {
        chainId: Number(process.env.LITVM_CHAIN_ID || 4441),
        rpcUrl: process.env.LITVM_RPC_URL || 'https://liteforge.rpc.caldera.xyz/http',
        explorer: 'https://liteforge.explorer.caldera.xyz',
        gasToken: 'zkLTC',
        live: false               // true when mainnet + audited bridge exist
    },
    status() {
        return { chainId: this.config.chainId, live: this.config.live, note: 'LitVM is testnet-only (LiteForge). Expect pipeline changes until mainnet.' };
    }
};

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------
module.exports = {
    config: config.public(),
    litvm,
    getDepositAddress: (playerId) => ({ address: wallet.depositAddress(playerId) }),
    getStatus: async (address) => {
        try {
            return await getStatusOrNode(address);
        } catch (e) {
            return { confirmedLtc: 0, unconfirmedLtc: 0, txCount: 0, txs: [], error: e.message };
        }
    },
    balanceOfPlayer: (playerId) => wallet.balanceOf(playerId),
    payoutFromPlayer: (playerId, toAddress, amountLtc, feerate) =>
        wallet.spendFromPlayer({ playerId, toAddress, amountLtc, feerate }),
    providers: { net, wallet }
};