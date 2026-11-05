import { RANKS, SUITS } from '../cards.js';
import { ZERO, cardPoint, point, scalar, mul, G } from './group.js';
import { verifyDLEQ, proveDLEQ } from './proofs.js';
export const CARDS = [...RANKS].flatMap(rank => [...SUITS].map(suit => rank + suit));
const ENCODINGS = new Map(CARDS.map(card => [cardPoint(card).toHex(), card]));
export function initialDeck() { return CARDS.map(card => ({ a: ZERO.toHex(), b: cardPoint(card).toHex() })); }
export function decodeCipher(cipher) { return { a: point(cipher.a), b: point(cipher.b) }; }
export const encodeCipher = c => ({ a: c.a.toHex(), b: c.b.toHex() });
export function reencrypt(cipher, key, randomness) {
  return { a: cipher.a.add(mul(G, randomness)), b: cipher.b.add(mul(key, randomness)) };
}
export function decryptionShare(secret, cipher, context) {
  // A=0 is valid only in the initial public deck, never a dealt encrypted card.
  return proveDLEQ(secret, cipher.a, context);
}
export function verifyShare(registration, cipher, share, context) {
  return share?.publicKey === registration.publicKey && verifyDLEQ(registration.publicKey, cipher.a, share.share, share.proof, context);
}
export function revealCard(cipher, shares) {
  if (!Array.isArray(shares) || shares.length !== 2) throw new Error('Exactly two decryption shares required');
  const decoded = point(cipher.b).subtract(point(shares[0].share)).subtract(point(shares[1].share));
  const card = ENCODINGS.get(decoded.toHex());
  if (!card) throw new Error('Decryption does not encode a card');
  return card;
}
export function privateCard(secret, cipher, peerRegistration, peerShare, context) {
  if (!verifyShare(peerRegistration, cipher, peerShare, context)) throw new Error('Invalid peer decryption share');
  const own = mul(point(cipher.a, true), scalar(secret, true)).toHex();
  return revealCard(cipher, [{ share: own }, peerShare]);
}
