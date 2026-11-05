// Reproducible TEST KEY. Never use these known scalars for an actual agent.
import { proveDLEQ, encodeDLEQ } from '../src/mental-poker/proofs.js';
import { G, scalarHex } from '../src/mental-poker/group.js';
const context = process.argv[2] ?? 'agent-stacks/cross-language/test/v1';
const x = BigInt(process.argv[3] ?? '1');
const proof = proveDLEQ(scalarHex(x), G.toHex(), context);
console.log(JSON.stringify({ context, ...proof, wireHex: encodeDLEQ(context, proof.publicKey, G.toHex(), proof.share, proof.proof).toString('hex') }));
