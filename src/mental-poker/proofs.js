import { createHash } from 'node:crypto';
import { G, point, scalar, scalarHex, randomScalar, mul, F, contextString, ZERO } from './group.js';
export const DLEQ_DOMAIN = 'agent-stacks/dleq/ristretto255/v1';
export function dleqChallenge(context, publicKey, base2, share, t1, t2) {
  const ctx = Buffer.from(contextString(context));
  const length = Buffer.alloc(2); length.writeUInt16LE(ctx.length);
  const hash = createHash('sha256').update(DLEQ_DOMAIN).update(length).update(ctx);
  for (const value of [publicKey, base2, share, t1, t2]) { point(value); hash.update(Buffer.from(value, 'hex')); }
  const bytes = hash.digest(); let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) + BigInt(bytes[i]);
  return n % F.ORDER;
}
export function encodeDLEQ(context, publicKey, base2, share, proof) {
  const ctx = Buffer.from(contextString(context));
  const length = Buffer.alloc(2); length.writeUInt16LE(ctx.length);
  return Buffer.concat([length, ctx, ...[publicKey, base2, share, proof.t1, proof.t2, proof.s].map(s => Buffer.from(s, 'hex'))]);
}
export function proveDLEQ(secret, base2, context) {
  contextString(context);
  const x = scalar(secret, true), b = point(base2, true);
  const publicKey = mul(G, x).toHex(), share = mul(b, x).toHex();
  const k = randomScalar();
  const t1 = mul(G, k).toHex(), t2 = mul(b, k).toHex();
  const c = dleqChallenge(context, publicKey, base2, share, t1, t2);
  return { publicKey, share, proof: { t1, t2, s: scalarHex(F.add(k, F.mul(c, x))) } };
}
export function verifyDLEQ(publicKey, base2, share, proof, context) {
  try {
    contextString(context);
    const pk = point(publicKey, true), b = point(base2, true), d = point(share, true);
    const t1 = point(proof.t1, true), t2 = point(proof.t2, true), s = scalar(proof.s);
    const c = dleqChallenge(context, publicKey, base2, share, proof.t1, proof.t2);
    return mul(G, s).equals(t1.add(mul(pk, c))) && mul(b, s).equals(t2.add(mul(d, c)));
  } catch { return false; }
}
export function makeKey(context) {
  const secret = scalarHex(randomScalar());
  const { publicKey, proof } = proveDLEQ(secret, G.toHex(), context);
  return { secret, registration: { publicKey, proof } };
}
export function verifyKey(registration, context) {
  return verifyDLEQ(registration?.publicKey, G.toHex(), registration?.publicKey, registration?.proof, context);
}
export function aggregateKeys(registrations, contexts) {
  if (registrations.length !== 2 || contexts.length !== 2) throw new Error('Exactly two keys required');
  if (!registrations.every((r, i) => verifyKey(r, contexts[i]))) throw new Error('Invalid key possession proof');
  const joint = point(registrations[0].publicKey, true).add(point(registrations[1].publicKey, true));
  if (joint.equals(ZERO)) throw new Error('Aggregate key is identity');
  return joint.toHex();
}
