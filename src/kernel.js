// The engine for testnet5: bitcoin-kernel with the BIP54 overlay (which also carries the testnet5
// network entry), plus the P2P wire format.
import { readFile } from 'node:fs/promises';
import { createKernel } from '@bitcoin-desktop/schema/codec/kernel.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { loadBip54 } from './bip54.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));

export async function loadKernel() {
  const k = createKernel({
    core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
    chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'),
    network: 'btc:testnet5', overlays: [await loadBip54()],
  });
  // createKernel's codec knows the consensus structs; the P2P messages are structs too
  const p2pSchema = await load('schema/p2p.jsonld');
  for (const n of p2pSchema['@graph'] ?? []) if (n['@type'] === 'ConsensusStruct') k.codec.types.set(n['@id'].split(':').pop(), n);
  k.p2p = P2pEngine.fromSchemas(k.codec, p2pSchema, k.schemas.chain, 'btc:testnet5');
  return k;
}
