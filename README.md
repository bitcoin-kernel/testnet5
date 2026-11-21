# bitcoin-kernel / testnet5

A Bitcoin **testnet5** ([BIP95](https://github.com/bitcoin/bips/blob/master/bip-0095.md)) node in plain JavaScript, built on the [bitcoin-kernel](https://bitcoin-kernel.com/) engine.

Testnet5 is new and small: a few thousand blocks, almost all of them coinbases, paying about a hundred addresses. So the node needs no snapshot. It syncs from genesis, checks every rule on every block, and keeps the whole set of unspent coins in memory.

**Status: all four steps working.** A node that syncs testnet5 from genesis and validates every block in full: headers, structure, scripts, and BIP54 (as an engine overlay, `src/bip54.js` + `src/bip54.jsonld`). It runs two ways:

- **In a browser tab:** [bitcoin-kernel.com/testnet5](https://bitcoin-kernel.com/testnet5/). Blocks arrive in bulk, never one by one. There is one sealed file per completed difficulty period, served with the page (`epochs/`, built by `tools/build-epochs.js`). The newest blocks come as one more file, `current.bin`, which `tools/publish-current.js` rebuilds on our R2 bucket whenever the tip moves (checked every 10 minutes). The tab checks each file's SHA-256 and validates every block in it. Blocks are kept in IndexedDB, so a reload validates the local copy again and downloads nothing.
  - A first visit downloads about 2.6 MB and reaches the tip in about 5 s.
  - The network tip comes from Nostr: a signed NIP-333 headers event (kind 33333, `d=tbtc5`), published by `tools/publish-nip333.js` from a validated window of the last 12 headers. The tab checks the signature, the pinned author and every header's proof of work and links. No Bitcoin server is asked anything.

- **On Node, over P2P,** from lapis and the libbitcoin nodes. It follows the tip, switching to a branch with more work when it must, keeps a mempool, relays transactions, and serves an esplora-compatible API.
  - Genesis to tip takes about 12 s. The result equals Core's coin set and chain work.
  - Validated blocks are kept in `data/blocks.bin` (same format as the epoch files). A restart validates them again from disk (about 7 s) and asks peers only for newer blocks.
  - Every API answer matched an RPC-backed esplora server.
  - A fund-agent payment broadcast through it reached Core's and libbitcoin's mempools.

```sh
npm install
node src/node.js --api 3497   # sync, follow, serve http://127.0.0.1:3497 (esplora API)
npm test                      # header and BIP54 rules on real testnet5 headers and blocks, plus tampered copies
node src/status.js [--watch 10]  # the running node's state from GET /status: tip, sync, peers, mempool, UTXO set hash (compare with Core's gettxoutsetinfo), epochs
node src/check-blocks.js      # cross-check: every block via a local Core node's RPC, coin set vs gettxoutsetinfo
node src/utxo-hash.js --height 2016,4032 [--dump <dir>] [--json]   # UTXO set hash at those heights (Core's hash_serialized_3); --dump writes the snapshot files byte for byte as dumptxoutset does; --json is the report for `assumeutxo attest --from`
```

Point tools at it: `GITMARK_EXPLORER=http://127.0.0.1:3497`, `FUND_AGENT_TBTC5_API=http://127.0.0.1:3497`.

**Limits for now:**
- Mempool admission checks inputs and amounts, but leaves scripts to the peers.

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
