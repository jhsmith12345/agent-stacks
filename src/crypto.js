import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { requireThat } from './errors.js';

// Canonical JSON is the wire signing format; never sign JSON with unspecified key order.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  requireThat(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)),
    'INVALID_ARGUMENT', 'Only JSON values can be signed');
  return JSON.stringify(value);
}
export function generateWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    player: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    secret: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}
export function playerKey(player) {
  requireThat(typeof player === 'string' && /^[A-Za-z0-9_-]{59}$/.test(player), 'BAD_SIGNATURE', 'Noncanonical player key');
  const key = createPublicKey({ key: Buffer.from(player, 'base64url'), type: 'spki', format: 'der' });
  requireThat(key.asymmetricKeyType === 'ed25519' && key.export({ type: 'spki', format: 'der' }).toString('base64url') === player,
    'BAD_SIGNATURE', 'Noncanonical Ed25519 player key');
  return key;
}
export function signCommand(wallet, command, nonce, issuedAt = Date.now(), domain = 'agent-stacks/local/v1') {
  const payload = { domain, player: wallet.player, nonce, issuedAt, command };
  const signature = sign(null, Buffer.from(canonical(payload)), createPrivateKey({
    key: Buffer.from(wallet.secret, 'base64url'), type: 'pkcs8', format: 'der',
  })).toString('base64url');
  return { ...payload, signature };
}
export function verifyEnvelope(envelope, now, domain = 'agent-stacks/local/v1') {
  requireThat(envelope && typeof envelope === 'object', 'BAD_SIGNATURE', 'Signed envelope required');
  let copy;
  try { copy = structuredClone(envelope); } catch { requireThat(false, 'BAD_SIGNATURE', 'Malformed signed envelope'); }
  const { signature, ...payload } = copy;
  requireThat(payload.domain === domain, 'BAD_SIGNATURE', 'Wrong signing domain');
  requireThat(typeof payload.player === 'string' && typeof signature === 'string', 'BAD_SIGNATURE', 'Missing player or signature');
  requireThat(Number.isSafeInteger(payload.issuedAt) && Math.abs(now - payload.issuedAt) <= 300_000,
    'STALE_SIGNATURE', 'Commands must be signed within five minutes of server time');
  let valid = false;
  try {
    const key = playerKey(payload.player);
    const bytes = Buffer.from(signature, 'base64url');
    valid = bytes.length === 64 && bytes.toString('base64url') === signature && verify(null, Buffer.from(canonical(payload)), key, bytes);
  } catch { /* malformed keys and signatures are rejected */ }
  requireThat(valid, 'BAD_SIGNATURE', 'Invalid Ed25519 signature');
  return payload;
}
