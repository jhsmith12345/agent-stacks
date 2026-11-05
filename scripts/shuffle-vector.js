// Public verifier fixture generation, not a gameplay agent. No private keys are written.
import { readFileSync, writeFileSync } from 'node:fs';
import { makeKey, aggregateKeys } from '../src/mental-poker/proofs.js';
import { initialDeck } from '../src/mental-poker/deck.js';
import { shuffleAndProve, encodeShuffle } from '../src/mental-poker/shuffle.js';
const context = process.argv[3] ?? 'agent-stacks/solana/shuffle-benchmark/v2';
const keys = [makeKey('benchmark/key/0'), makeKey('benchmark/key/1')];
const joint = process.argv[4] ?? aggregateKeys(keys.map(k => k.registration), ['benchmark/key/0', 'benchmark/key/1']);
const input = process.argv[5] ? (() => { const b = readFileSync(process.argv[5]); if (b.length !== 3328) throw new Error('Expected full input deck'); return Array.from({length:52}, (_,i) => ({a:b.subarray(i*64,i*64+32).toString('hex'),b:b.subarray(i*64+32,i*64+64).toString('hex')})); })() : initialDeck();
const proof = shuffleAndProve(input, joint, context);
writeFileSync(process.argv[2], encodeShuffle(input, proof));
