// Code half of the BIP54 (consensus cleanup) overlay, plus the testnet5 network entry (data half:
// bip54.jsonld). The checks follow Bitcoin Core PR 35861: ContextualCheckBlockHeader
// (time-negative-interval), ContextualCheckBlock (bad-txns-size, bad-cb-locktime, bad-cb-sequence)
// and Consensus::CheckSigopsBIP54 (bad-txns-legacy-sigops). BIP54's timewarp rule needs no code:
// the engine's timewarp check with maxTimewarp 7200 is it.
// Written as an overlay so it can move into the engine (bitcoin-desktop/schema) unchanged.
// No Node imports: the same file runs in the browser.

export const MAX_TX_BIP54_SIGOPS = 2500;
const SEQUENCE_FINAL = 0xffffffff;

// Core's CScript::GetSigOpCount(fAccurate): CHECKSIG(VERIFY) is 1; CHECKMULTISIG(VERIFY) is the
// preceding OP_1..OP_16 when accurate, else 20 (MAX_PUBKEYS_PER_MULTISIG).
export function sigOpCount(ops, accurate) {
  let n = 0, last = null;
  for (const op of ops) {
    if (op.name === 'OP_CHECKSIG' || op.name === 'OP_CHECKSIGVERIFY') n += 1;
    else if (op.name === 'OP_CHECKMULTISIG' || op.name === 'OP_CHECKMULTISIGVERIFY') {
      const m = last && /^OP_([1-9]|1[0-6])$/.exec(last.name);
      n += accurate && m ? Number(m[1]) : 20;
    }
    last = op;
  }
  return n;
}

const isP2SH = (spk) => /^a914[0-9a-f]{40}87$/.test(spk);
const isPush = (op) => op.code <= 0x60; // OP_0 .. OP_16, pushes and OP_1NEGATE, as IsPushOnly

// Core's CScript::GetSigOpCount(scriptSig) on a spent scriptPubKey: P2SH counts the redeem script
// (the scriptSig's last push) accurately; a non-push-only scriptSig counts 0; anything else counts
// the scriptPubKey itself accurately.
export function spentSigOps(parse, scriptPubKey, scriptSig) {
  if (!isP2SH(scriptPubKey)) return sigOpCount(parse(scriptPubKey), true);
  const sig = parse(scriptSig);
  if (!sig.every(isPush)) return 0;
  const redeem = sig.at(-1)?.data;
  return redeem ? sigOpCount(parse(redeem), true) : 0;
}

export function checks(params, { codec, blocks, script }) {
  const parse = (hex) => script.parse(hex);
  const interval = params.difficultyAdjustmentInterval;
  return {
    header: {
      'bip54:rule-header-period-order': ({ header, height, chainAt }) => {
        if (height == null || height % interval !== interval - 1) return true;
        const first = chainAt?.(height - interval + 1);
        return first ? header.time >= first.time : null;
      },
    },
    blocks: {
      block: {
        'bip54:rule-block-no-64-byte-tx': ({ block }) =>
          block.transactions.every((tx) => codec.encode('Transaction', tx, { legacy: true }).length !== 64),
      },
      blockContext: {
        'bip54:rule-blockctx-coinbase-locktime': ({ block, height }) => {
          if (height == null || height === 0) return null;
          const cb = block.transactions[0];
          return cb.lockTime === height - 1 && cb.inputs[0].sequence !== SEQUENCE_FINAL;
        },
        'bip54:rule-blockctx-tx-sigops': ({ spending }) => {
          const perTx = new Map();
          for (const { tx, inIndex, prevout } of spending.resolvedInputs) {
            const inp = tx.inputs[inIndex];
            const n = sigOpCount(parse(inp.scriptSig), true) + spentSigOps(parse, prevout.scriptPubKey, inp.scriptSig);
            perTx.set(tx, (perTx.get(tx) ?? 0) + n);
          }
          for (const n of perTx.values()) if (n > (params.bip54MaxTxSigops ?? MAX_TX_BIP54_SIGOPS)) return false;
          return spending.valueUnresolved || spending.unverified ? null : true;
        },
      },
    },
  };
}

// createKernel overlay object
export const bip54 = (graph) => ({
  graph,
  installChecks(engines) {
    const c = checks(engines.params, engines);
    engines.headers.registerChecks(c.header);
    engines.blocks.registerChecks(c.blocks);
  },
});
