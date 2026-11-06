import { randomInt, createHash } from 'node:crypto';
import { point, randomScalar, scalar, scalarHex, F, contextString } from './group.js';
import { decodeCipher, encodeCipher, reencrypt } from './deck.js';
export const SHUFFLE_ROUNDS = 128;
export const SHUFFLE_PROTOCOL = 'agent-stacks/elgamal-cut-and-choose/v2';
export function permutation(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = randomInt(i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  return p;
}
function validPermutation(p, n) {
  return Array.isArray(p) && p.length === n && new Set(p).size === n && p.every(i => Number.isInteger(i) && i >= 0 && i < n);
}
function decodeDeck(deck) {
  if (!Array.isArray(deck) || deck.length < 2 || deck.length > 52) throw new Error('Expected 2–52 encrypted cards');
  return deck.map(decodeCipher);
}
function hexBytes(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Noncanonical wire field');
  return Buffer.from(value, 'hex');
}
function deckBytes(deck, n) {
  if (!Array.isArray(deck) || deck.length !== n) throw new Error('Wrong deck length');
  return Buffer.concat(deck.flatMap(c => [hexBytes(c.a), hexBytes(c.b)]));
}
function prefix(input, key, context, output, commitments) {
  const ctx = Buffer.from(contextString(context));
  const header = Buffer.alloc(4); header.writeUInt16LE(input.length, 0); header.writeUInt16LE(ctx.length, 2);
  return Buffer.concat([header, ctx, hexBytes(key), deckBytes(input, input.length), deckBytes(output, input.length),
    ...commitments.map(deck => deckBytes(deck, input.length))]);
}
function challenges(input, key, context, output, commitments) {
  return createHash('sha256').update(SHUFFLE_PROTOCOL).update(prefix(input, key, context, output, commitments)).digest();
}
// Dense, fixed-width format for the experimental Solana verifier. JSON is only
// an agent transport format; signatures still authenticate the complete message.
export function encodeShuffle(input, proof) {
  if (proof.protocol !== SHUFFLE_PROTOCOL || input.length !== 52 || proof.commitments.length !== SHUFFLE_ROUNDS || proof.openings.length !== SHUFFLE_ROUNDS) throw new Error('Expected full 52-card proof');
  const openings = proof.openings.map(o => {
    if (!validPermutation(o.permutation, 52) || o.randomness.length !== 52) throw new Error('Invalid opening');
    for (const r of o.randomness) scalar(r);
    return Buffer.concat([Buffer.from(o.permutation), ...o.randomness.map(hexBytes)]);
  });
  return Buffer.concat([prefix(input, proof.key, proof.context, proof.output, proof.commitments), ...openings]);
}
const bit = (challenge, round) => (challenge[round >> 3] >> (round & 7)) & 1;

// Research harness: no reduced-round mode. Verification fixes the policy at 128 rounds.
export function shuffleAndProve(input, key, context) {
  contextString(context);
  const source = decodeDeck(input), pk = point(key, true).precompute(8);
  const n = source.length, p = permutation(n), randomness = p.map(randomScalar);
  const output = p.map((j, i) => encodeCipher(reencrypt(source[j], pk, randomness[i])));
  const inverse = []; p.forEach((j, i) => { inverse[j] = i; });
  const witnesses = Array.from({ length: SHUFFLE_ROUNDS }, () => {
    const perm = permutation(n), r = perm.map(randomScalar);
    return { perm, r, deck: perm.map((j, i) => encodeCipher(reencrypt(source[j], pk, r[i]))) };
  });
  const commitments = witnesses.map(w => w.deck);
  const challenge = challenges(input, key, context, output, commitments);
  const openings = witnesses.map((w, round) => bit(challenge, round) === 0
    ? { permutation: w.perm, randomness: w.r.map(scalarHex) }
    : { permutation: w.perm.map(j => inverse[j]), randomness: w.r.map((r, i) => scalarHex(F.sub(r, randomness[inverse[w.perm[i]]]))) });
  return { protocol: SHUFFLE_PROTOCOL, context, key, output, commitments, openings };
}
export function verifyShuffle(input, key, context, proof) {
  try {
    contextString(context);
    if (proof.protocol !== SHUFFLE_PROTOCOL || proof.context !== context || proof.key !== key ||
        !Array.isArray(proof.commitments) || proof.commitments.length !== SHUFFLE_ROUNDS ||
        !Array.isArray(proof.openings) || proof.openings.length !== SHUFFLE_ROUNDS) return false;
    const source = decodeDeck(input), target = decodeDeck(proof.output), n = source.length;
    if (target.length !== n) return false;
    const pk = point(key, true).precompute(8);
    const challenge = challenges(input, key, context, proof.output, proof.commitments);
    for (let round = 0; round < SHUFFLE_ROUNDS; round++) {
      const commitment = decodeDeck(proof.commitments[round]);
      const opening = proof.openings[round];
      if (commitment.length !== n || !validPermutation(opening.permutation, n) ||
          !Array.isArray(opening.randomness) || opening.randomness.length !== n) return false;
      const deck = bit(challenge, round) === 0 ? source : target;
      for (let i = 0; i < n; i++) {
        const expected = reencrypt(deck[opening.permutation[i]], pk, scalar(opening.randomness[i]));
        if (!expected.a.equals(commitment[i].a) || !expected.b.equals(commitment[i].b)) return false;
      }
    }
    return true;
  } catch { return false; }
}

// Decode the public dense v2 proof for independent off-chain verification.
export function decodeShuffle(bytes) {
  const wire=Buffer.from(bytes);if(wire.length<4)throw Error('Truncated shuffle');
  const n=wire.readUInt16LE(0),length=wire.readUInt16LE(2);
  if(n!==52||length<1||length>1024||wire.length!==652324+length)throw Error('Invalid dense shuffle framing');
  let at=4;const context=new TextDecoder('utf-8',{fatal:true}).decode(wire.subarray(at,at+=length));
  const field=()=>wire.subarray(at,at+=32).toString('hex');const key=field();
  const deck=()=>Array.from({length:n},()=>({a:field(),b:field()}));
  const input=deck(),output=deck(),commitments=Array.from({length:SHUFFLE_ROUNDS},deck);
  const openings=Array.from({length:SHUFFLE_ROUNDS},()=>{const permutation=[...wire.subarray(at,at+=n)];const randomness=Array.from({length:n},field);return {permutation,randomness};});
  const proof={protocol:SHUFFLE_PROTOCOL,context,key,output,commitments,openings};
  // Canonical scalar/permutation encoding is required even before mathematical verification.
  if(!encodeShuffle(input,proof).equals(wire))throw Error('Noncanonical dense shuffle');
  return {input,proof};
}
