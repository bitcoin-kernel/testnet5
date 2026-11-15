# bitcoin-kernel / testnet5

A Bitcoin **testnet5** ([BIP95](https://github.com/bitcoin/bips/blob/master/bip-0095.md)) node in plain JavaScript, built on the [bitcoin-kernel](https://bitcoin-kernel.com/) engine.

Testnet5 is new and small: a few thousand blocks, almost all of them coinbases, paying about a hundred addresses. So the node needs no snapshot. It syncs from genesis, checks every rule on every block, and keeps the whole set of unspent coins in memory.

**Status: step 2 of 4.** The node validates every testnet5 block from genesis: headers, block structure, scripts, and BIP54's rules (the latter as an engine overlay, `src/bip54.js` + `src/bip54.jsonld`), keeping the set of unspent coins in memory. Blocks come from a local node over RPC for now. The latest run checked 4,205 blocks (4,280 transactions) in about 7 s and ended with exactly the coin set Core reports: 13,614 coins worth 210,250 tBTC5.

```sh
npm install
npm test                    # header and BIP54 rules on real testnet5 headers and blocks, plus tampered copies
node src/check-headers.js   # every header from a local testnet5 node (cookie auth)
node src/check-blocks.js    # every block, then the coin set compared with Core's gettxoutsetinfo
```

## Aim

1. **Validate testnet5 from genesis.** Headers and blocks under BIP95's rules:
   - mainnet consensus;
   - minimum difficulty `0x1a0fffff`, with no 20-minute exception;
   - [BIP54](https://github.com/bitcoin/bips/blob/master/bip-0054.md) from block 1: timewarp, no 64-byte transactions, the coinbase `nLockTime`/`nSequence` tied to height, the per-transaction legacy sigop limit.
2. **Follow the tip over P2P,** on port `18353` with message start `FIVE` (`0x46495645`).
3. **Serve an esplora-compatible API** (tx, address UTXOs, broadcast), so tools like [gitmark](https://git-mark.com/) and [fund-agent](https://github.com/blocktrails/fund-agent) can use testnet5 with nothing in between.
4. **Run in a browser tab,** as [`bitcoin-kernel/node`](https://github.com/bitcoin-kernel/node) does for testnet4.

## Layout

- **Consensus rules** come from the engine, [`bitcoin-desktop/schema`](https://github.com/bitcoin-desktop/schema). BIP54 rules are added there, not here, so every node using the engine gets them.
- **This repo** holds what is specific to testnet5: the network parameters, sync from genesis, the in-memory coin set, the API, and later the browser page.
- **P2P and storage** come from [`bitcoin-kernel/node`](https://github.com/bitcoin-kernel/node) where they fit, rather than being copied.

## Network

| | |
|---|---|
| Message start | `0x46495645` (`FIVE`) |
| P2P port | `18353` |
| Genesis | `00000000000008c1637e7d3252dc1c333d4546fd6fff6a474b200d674a91d497` |
| Minimum difficulty | `0x1a0fffff` (~1,048,560) |

More: [awesome-testnet5](https://testnet4.github.io/awesome-testnet5/).

## Licence

[AGPL-3.0](LICENSE), like the rest of bitcoin-kernel.
