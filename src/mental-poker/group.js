// Experimental protocol composition; noble supplies the curve implementation.
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { createHash, randomBytes } from 'node:crypto';
import { canonical } from '../crypto.js';
export const Point = ristretto255.Point;
export const F = Point.Fn;
export const G = Point.BASE;
export const ZERO = Point.ZERO;
export const scalarHex = n => Buffer.from(F.toBytes(n)).toString('hex');
export function scalar(value, nonzero = false) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Noncanonical scalar');
  const n = F.fromBytes(Buffer.from(value, 'hex'));
  if (nonzero && n === 0n) throw new Error('Zero secret scalar');
  return n;
}
export function point(value, nonzero = false) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Noncanonical point');
  const p = Point.fromBytes(Buffer.from(value, 'hex'));
  if (nonzero && p.equals(ZERO)) throw new Error('Identity public key');
  return p;
}
export const mul = (p, n) => n === 0n ? ZERO : p.multiply(n);
export function randomScalar() {
  // Rejection sampling rather than reducing a 256-bit value modulo the order.
  for (;;) {
    const b = randomBytes(32); b[31] &= 31;
    try { const s = F.fromBytes(b); if (s !== 0n) return s; } catch { /* resample */ }
  }
}
export function digest(domain, value) {
  return createHash('sha512').update(domain).update('\0').update(canonical(value)).digest();
}
export function contextString(value) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 1024) throw new Error('Context must contain 1–1024 UTF-8 bytes');
  return value;
}
export function cardPoint(card) {
  return ristretto255_hasher.hashToCurve(new TextEncoder().encode(`agent-stacks/card/v1/${card}`));
}
