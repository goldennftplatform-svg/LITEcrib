# LITEcrib ⚡

Old School 8-Bit Multiplayer Cribbage, powered by Litecoin (LTC) and built LitVM-ecosystem ready.

## Features

- **Multiplayer**: 1v1 Head-to-Head or 3-Player Trio
- **Authentic Cribbage Rules**: Full scoring (15s, pairs, runs, flushes, nobs)
- **Real-time Play**: SSE relay server (multiplayer relay) with localStorage fallback for static hosting
- **8-Bit Art Style**: Pixel-perfect retro aesthetic, Litecoin-tinted palette
- **Cribbage Board**: Visual peg tracking with 121 holes
- **Dealer Rotation**: Automatic dealer chip passing
- **Phases**: Deal → Discard → Starter → Play → Count Hands → Count Crib
- **LTC Payments (roadmap)**: Deposit addresses, TX verification, payout settlement
- **LitVM Ready**: Network config + PaymentsProvider seam to swap in LitVM contracts

## Game Rules

### Cribbage Basics
- **Goal**: First to 121 points (peg around the board twice)
- **Deck**: Standard 52 cards
- **Deal**: 6 cards each (1v1), 5 cards each (3-player)
- **Discard**: 2 cards to crib (1v1), 1 card to crib (3-player)
- **Starter**: Cut card turned up after discard
- **Play**: Players alternate playing cards, count ≤ 31
- **Scoring**: During play + hand counting + crib counting

### Scoring
| Combination | Points |
|------------|--------|
| Fifteen (cards sum to 15) | 2 |
| Pair | 2 |
| Three of a Kind | 6 |
| Four of a Kind | 12 |
| Run of 3+ | 1 per card |
| Flush (4 same suit) | 4 (5 with starter) |
| Nobs (Jack of starter suit) | 1 |
| 31 exactly | 2 |
| GO (last card under 31) | 1 |

## Controls

- **Click cards** to select/discard
- **Space** - Play selected card (Play phase)
- **G** - Say GO (Play phase)
- **Enter** - Count hand/crib
- **Escape** - Close modals

## Running the multiplayer relay

The relay (`server.js`) does NOT run as a static-only page. It serves the game AND
brokers tables between devices over SSE + HTTP POST. Deploy it to any Node host
(Render / Railway / Fly), not Vercel (serverless does not support SSE streaming).

```bash
node server.js            # serves the game + relay on PORT (default 8080)
```

In the static fallback (GitHub Pages / Vercel) multiplayer uses `localStorage`
keyed to the same origin — same-browser only. Point `network.js` at the relay URL
for real cross-device play.

## Deploying (Render)

`render.yaml` ships a zero-config Blueprint: one web service (Node, free tier) that
serves the game AND the SSE relay. New > Blueprint > this repo.

Secrets (`LTC_RPC_PASS`, `LITECRIB_SEED`, `LITECRIB_ADMIN_TOKEN`) are `sync: false`
— Render prompts for them in the dashboard and never commits them.

1. **Set `LITECRIB_SEED`** — a BIP39 mnemonic. If you leave it blank the server
   generates one and prints it **once** (it is lost on restart, so pin it). It
   derives every player's deposit address:
   `m/84'/2'/0'/0/<playerIndex>` (native segwit `tltc1…` on testnet).
2. **Set `LITECRIB_ADMIN_TOKEN`** — without it `POST /api/wallet/payout` stays
   disabled (HTTP 501). Generate: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
3. **Leave `LTC_NETWORK=testnet`** until real testnet play is verified. Testnet
   LTC is free from faucets (coins.pilrim.software, `litecoinspace.org`).
4. **`LTC_RPC_URL/LTC_RPC_USER/LTC_RPC_PASS`** are optional: a Litecoin Core or
   QuickNode Litecoin RPC is only an extra broadcast/status path — deposits are
   already covered by the HD wallet + Litecoin Space indexer.

Local dev: `npm install && node server.js` (add a `.env` from `.env.example` if
you want secrets without exporting them).

## Git hosts

- **Render / Railway / Fly** — the real relay (SSE). This is the multiplayer host.
- **GitHub Pages / Vercel** — static-only fallback; multiplayer degrades to
  same-browser localStorage; the wallet panel auto-hides.

## Accounts, SSO & custody wallets

- `POST /api/auth/register` `{email, password}` — creates the account **and issues a
  fresh custody wallet**: an independent BIP39 mnemonic whose funds live at the
  standard Electrum-LTC path `m/84'/2'/0'/0/0`. Returns a session token; the
  mnemonic is never returned here.
- `POST /api/auth/login` / `GET /api/auth/me` — salted-scrypt passwords,
  opaque bearer sessions (in-memory, lost on restart ⇒ re-login), login/export
  throttled after 5 failures/15min.
- `POST /api/wallet/export` (logged-in + **password re-checked**) — returns the
  user's BIP39 mnemonic. Because wallets are standard BIP84, exporting =
  self-custody exit: the mnemonic restores the *same address* in Electrum-LTC
  (covered by `tests/sso-e2e.cjs` assertion #7 — the address derived from the
  exported mnemonic must equal the issued address).
- Accounts persist in `data/users.json` (atomic writes; repo-excluded). Sessions
  do not. Custody mnemonics are plaintext-on-host for the testnet prototype —
  production needs KMS envelope encryption at rest.
- Reuse: the PSBT spend/broadcast engine already backs payout for both master-seed
  (guest `playerId`) and per-user mnemonic wallets.

## Litecoin / LitVM wiring

- `lit-wallet.js` — server-custody HD wallet. One BIP39 seed (`LITECRIB_SEED`)
  derives deterministic P2WPKH addresses per player; payouts are PSBT-built,
  locally signed, and broadcast via Litecoin Space `/tx` (or Core RPC
  `sendrawtransaction` when `LTC_RPC_URL` is set). Keys never leave the host.
- `payments.js` — shared interface used by `/api/wallet/*`:
  `getDepositAddress(playerId)`, `getStatus(address)` (Litecoin Space indexer,
  Core RPC fallback), `balanceOfPlayer(playerId)`, `payoutFromPlayer(...)`.
- Verifier: Litecoin Space (`litecoinspace.org`, mempool.space-compatible).
- **LitVM seam** (`/api/wallet/litvm` + `litvm` config block): EVM-compatible
  rollup on Arbitrum Orbit + BitcoinOS, Litecoin Foundation endorsed. Testnet
  **LiteForge** is live (Chain ID `4441`,
  RPC `https://liteforge.rpc.caldera.xyz/http`, explorer
  `liteforge.explorer.caldera.xyz`). Mainnet / token generation / audits are
  pending — the seam is read-only today. When settlement moves on-chain, a
  `Settlement` contract (script hash + game result releases escrow) replaces
  the `payoutFromPlayer` bridge behind the same API surface, so the client
  never changes.
- Wallet providers that speak LTC:
  - User-facing: Litecoin Core, Electrum-LTC, Trust Wallet, Exodus, Atomic,
    Coinomi, Litewallet, Ledger/Trezor. QR + address flow is already in the
    client — no WalletConnect needed (its bitcoin namespace is BTC-focussed).
  - App-side: self-hosted Litecoin Core RPC or hosted QuickNode Litecoin RPC
    (Bitcoin-style JSON-RPC), or a payment processor (BTCPay Server, Coinbase
    Commerce, NowPayments, CoinGate, Plisio, Blockonomics) if you'd rather not
    hold custody at all.

## Architecture

```
index.html            - Main HTML structure
styles.css            - 8-bit Litecoin theme (Press Start 2P + VT323 fonts)
cribbage-engine.js    - Core game logic (pure JS, no deps)
network.js            - Multiplayer sync (relay or localStorage)
game.js               - Game state & UI management
main.js               - Entry point & event handlers
config.js             - Shared public config (brand/network/features/indexer/LitVM)
net.js                - HTTP/RPC transport (indexer + Litecoin Core RPC)
payments.js           - Deposit/status + LitVM provider seam
lit-wallet.js         - HD wallet: derive addresses, PSBT payouts, broadcast, per-user issue/export
auth.js               - SSO: register/login/me/export (scrypt + bearer sessions + throttle)
store.js              - Durable JSON account store (data/, atomic writes)
wallet.js             - Client wallet panel (auto-hides off-relay)
server.js             - Zero-dep relay: SSE + HTTP POST + wallet/Auth API (system deps: bitcoinjs-lib, bip39, bip32)
render.yaml           - Render Blueprint (Node web service + secrets)
.env.example          - Every env var, documented
litecoin.conf         - Optional Litecoin Core (testnet) RPC template
tests/                - sso-e2e (accounts/export/recovery), wallet-e2e (routes), wallet-psbt (signing), public-browser
```

## Credits

- Fonts: Press Start 2P, VT323 (Google Fonts)
- Forked from the "29" Cribbage Safari — rebranded and Litecoin-ready.