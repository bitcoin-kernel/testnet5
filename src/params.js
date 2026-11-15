// Testnet5 (BIP95) network parameters, in the engine's NetworkParams shape (schema/chain.jsonld).
// Taken from Bitcoin Core PR 35861 (CTestNet5Params), not from memory:
//   powLimit 0000000000000fffff00…, fPowAllowMinDifficultyBlocks false, enforce_BIP94 false
//   (so the retarget scales the last block's bits, as on mainnet), BIP34/65/66/CSV/segwit at 1,
//   message start "FIVE", port 18353, and BIP54 (consensus cleanup) always active.
// Kept here until the engine's chain.jsonld carries a btc:testnet5 entry.

export const TESTNET5 = {
  '@id': 'btc:testnet5',
  '@type': 'btc:NetworkParams',
  name: 'testnet5',
  magic: '46495645',
  genesisHash: '00000000000008c1637e7d3252dc1c333d4546fd6fff6a474b200d674a91d497',
  powLimit: '0000000000000fffff0000000000000000000000000000000000000000000000',
  targetTimespan: 1209600,
  targetSpacing: 600,
  difficultyAdjustmentInterval: 2016,
  maxFutureBlockTime: 7200,
  halvingInterval: 210000,
  port: 18353,
  p2pkhVersion: 111,
  p2shVersion: 196,
  bech32Hrp: 'tb',
  maxMoney: 2100000000000000,
  initialSubsidy: 5000000000,
  maxBlockWeight: 4000000,
  bip34Height: 1,
  bip65Height: 1,
  bip66Height: 1,
  csvHeight: 1,
  segwitHeight: 1,
  maxBlockSigopsCost: 80000,
  coinbaseMaturity: 100,
  allowMinDifficultyBlocks: false, // BIP95: no 20-minute exception
  timewarpFix: true,               // BIP54: first block of a period no earlier than prev - 2 h
  maxTimewarp: 7200,               // MAX_TIMEWARP_BIP54 (testnet4's BIP94 uses 600)
  retargetSeed: 'last',            // enforce_BIP94 = false: mainnet's retarget
  xpubVersion: 70617039,
  bip54Height: 1,                  // consensus cleanup from block 1 (ALWAYS_ACTIVE)
};

// The chain schema with testnet5 added, for the engine's fromSchemas(…, 'btc:testnet5').
export function withTestnet5(chainSchema) {
  return { ...chainSchema, '@graph': [...chainSchema['@graph'].filter((n) => n['@id'] !== TESTNET5['@id']), TESTNET5] };
}
