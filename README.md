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

## Litecoin / LitVM wiring

- Server-side only (`server.js`): deposit address generation + TX verification.
- Verifier: Litecoin Space (`litecoinspace.org`, mempool.space-compatible) LTC
  indexer first; swap to Litecoin Core RPC (`getblockcount`, `gettransaction`)
  later if self-hosting a node.
- LitVM seam: `config` block + `PaymentsProvider` interface so game state and
  settlement can move on-chain without rewriting the client.

## Architecture

```
index.html          - Main HTML structure
styles.css          - 8-bit Litecoin theme (Press Start 2P + VT323 fonts)
cribbage-engine.js  - Core game logic (pure JS, no deps)
network.js          - Multiplayer sync (relay or localStorage)
game.js             - Game state & UI management
main.js             - Entry point & event handlers
server.js           - Zero-dep relay: SSE + HTTP POST
```

## Credits

- Fonts: Press Start 2P, VT323 (Google Fonts)
- Forked from the "29" Cribbage Safari — rebranded and Litecoin-ready.