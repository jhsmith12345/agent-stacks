import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateWallet, signCommand } from '../src/crypto.js';
import { G, F, scalarHex, scalar, point, ZERO } from '../src/mental-poker/group.js';
import { makeKey, verifyKey, aggregateKeys, proveDLEQ, verifyDLEQ } from '../src/mental-poker/proofs.js';
import { initialDeck, decryptionShare, privateCard, revealCard, verifyShare, CARDS } from '../src/mental-poker/deck.js';
import { shuffleAndProve, verifyShuffle } from '../src/mental-poker/shuffle.js';
import { PeerSession, cryptoContext, PEER_DOMAIN } from '../src/mental-poker/session.js';
import { VerifiedPeerAgent } from '../src/mental-poker/verified-agent.js';
import { MentalPokerAgent } from '../src/mental-poker/agent.js';
let keys, joint, first, second;
before(() => {
  keys = [makeKey('key/0'), makeKey('key/1')]; joint = aggregateKeys(keys.map(k => k.registration), ['key/0', 'key/1']);
  first = shuffleAndProve(initialDeck(), joint, 'shuffle/0');
  second = shuffleAndProve(first.output, joint, 'shuffle/1');
});
test('key possession prevents rogue/identity keys, malformed encodings and proof replay', () => {
  assert.ok(verifyKey(keys[0].registration, 'key/0'));
  assert.equal(verifyKey(keys[0].registration, 'another-hand'), false);
  assert.equal(verifyKey(null, 'key/0'), false);
  assert.equal(verifyKey({ publicKey: ZERO.toHex(), proof: keys[0].registration.proof }, 'key/0'), false);
  assert.throws(() => scalar(scalarHex(0n), true));
  assert.throws(() => scalar('ff'.repeat(32)));
  assert.throws(() => point('ff'.repeat(32)));
  // A rogue public key canceling A is rejected without proof of its discrete log.
  const rogue = { ...keys[1].registration, publicKey: point(keys[0].registration.publicKey).negate().toHex() };
  assert.throws(() => aggregateKeys([keys[0].registration, rogue], ['key/0', 'key/1']));
});
test('two full 52-card 128-round shuffle proofs verify and bind every transcript component', () => {
  assert.ok(verifyShuffle(initialDeck(), joint, 'shuffle/0', first));
  assert.ok(verifyShuffle(first.output, joint, 'shuffle/1', second));
  assert.equal(verifyShuffle(initialDeck(), joint, 'other-hand', first), false);
  const cases = [
    p => { p.output[0] = p.output[1]; },
    p => { p.openings[0].permutation[0] = p.openings[0].permutation[1]; },
    p => { p.openings[0].randomness[0] = 'ff'.repeat(32); },
    p => { p.commitments[0][0].a = ZERO.toHex(); },
    p => { p.commitments.pop(); p.openings.pop(); },
    p => { p.output.reverse(); },
  ];
  for (const tamper of cases) { const proof = structuredClone(first); tamper(proof); assert.equal(verifyShuffle(initialDeck(), joint, 'shuffle/0', proof), false); }
});
test('all 52 encrypted cards decrypt exactly once; shares bind ciphertext, key and position', () => {
  const cards = [];
  for (let i = 0; i < 52; i++) {
    const cipher = second.output[i], context = `card/${i}`;
    const shares = keys.map(k => decryptionShare(k.secret, cipher, context));
    assert.ok(verifyShare(keys[1].registration, cipher, shares[1], context));
    cards.push(revealCard(cipher, shares));
    assert.equal(privateCard(keys[0].secret, cipher, keys[1].registration, shares[1], context), cards[i]);
    assert.equal(verifyShare(keys[1].registration, cipher, shares[1], `card/${i + 1}`), false);
    assert.equal(verifyShare(keys[0].registration, cipher, shares[1], context), false);
  }
  assert.deepEqual([...cards].sort(), [...CARDS].sort());
  const cipher = second.output[0], share = decryptionShare(keys[1].secret, cipher, 'private');
  assert.throws(() => privateCard(keys[0].secret, second.output[1], keys[1].registration, share, 'private'));
});
test('DLEQ response tampering and noncanonical scalars are rejected', () => {
  const p = proveDLEQ(keys[0].secret, G.toHex(), 'test');
  assert.ok(verifyDLEQ(p.publicKey, G.toHex(), p.share, p.proof, 'test'));
  p.proof.s = scalarHex(F.add(scalar(p.proof.s), 1n));
  assert.equal(verifyDLEQ(p.publicKey, G.toHex(), p.share, p.proof, 'test'), false);
});
function sessionFixture() {
  let now = Date.now(); const wallets = [generateWallet(), generateWallet()];
  const config = { id: randomUUID(), players: wallets.map(w => w.player), turnSeconds: 30 };
  const session = new PeerSession(config, { now: () => now });
  const agents = wallets.map(w => new MentalPokerAgent(w, v => ({ action: v.hand.legalActions.check ? 'check' : 'call' })));
  const step = () => { const view = session.view(); return session.submit(agents[view.obligation.seat].decide(view, now)); };
  return { session, agents, wallets, step, config, setTime: t => { now = t; }, now: () => now };
}
test('signed peer state machine completes a private hand and deterministic transcript replay', () => {
  const f = sessionFixture(); let view = f.session.view(); let steps = 0;
  const peers = f.wallets.map(w => new VerifiedPeerAgent(w, v => ({ action: v.hand.legalActions.check ? 'check' : 'call' }), f.config, f.session.createdAt, { now: f.now }));
  const phases = new Set(), timeoutCases = new Set();
  const observer = generateWallet();
  while (view.status !== 'complete') {
    assert.ok(++steps < 100);
    const obligated = view.obligation.seat; phases.add(view.obligation.kind);
    const timeoutCase = `${view.obligation.kind}/${obligated}/${view.hand?.street}`;
    if (!timeoutCases.has(timeoutCase)) {
      timeoutCases.add(timeoutCase);
      let at = view.deadline - 1;
      const fork = new PeerSession(f.config, { now: () => at }); fork.state = structuredClone(f.session.state);
      const command = { type: 'claim-timeout', matchId: view.id, termsHash: view.termsHash, handNo: view.handNo, expectedVersion: view.version };
      assert.throws(() => fork.submit(signCommand(observer, command, 1, at, PEER_DOMAIN)), e => e.code === 'TOO_EARLY');
      at = view.deadline;
      const done = fork.submit(signCommand(observer, command, 1, at, PEER_DOMAIN));
      assert.equal(done.status, 'complete');
      assert.deepEqual(done.result.payouts, view.status === 'consenting' ? [1000, 1000] : obligated === 0 ? [0, 2000] : [2000, 0]);
    }
    // Each peer derives obligations locally; a relay-supplied view is never a
    // request to decrypt arbitrary positions. Only authenticated messages enter.

    const signed = peers[obligated].nextCommand();
    view = f.session.submit(signed);
    for (const peer of peers) peer.receive(f.session.transcript.at(-1));
    if (view.status === 'active' && !view.events.some(e => e.type === 'hand_complete')) {
      assert.deepEqual(f.session.state.hand.holes, [[], []]); assert.deepEqual(f.session.state.hand.deck, []);
    }
    const publicJSON = JSON.stringify(view);
    for (const a of peers) for (const k of a.agent.keys.values()) assert.equal(publicJSON.includes(k.secret), false);
  }
  assert.deepEqual([...phases].sort(), ['accept', 'action', 'board-share', 'hole-share', 'key', 'showdown-share', 'shuffle']);
  assert.equal(view.result.payouts.reduce((a, b) => a + b), 2000);
  assert.equal(view.events.find(e => e.type === 'hand_complete').showdown.length, 2);
  let time = f.session.createdAt;
  const replay = new PeerSession(f.config, { now: () => time });
  for (const entry of f.session.transcript) { time = entry.acceptedAt; replay.submit(entry.envelope); }
  assert.deepEqual(replay.view(), view);
});
test('shuffle obligation timeout is attributable and invalid messages never reset it', () => {
  const f = sessionFixture();
  for (let i = 0; i < 4; i++) f.step(); // accept A/B, key A/B; A now owes a shuffle
  const view = f.session.view(); assert.equal(view.obligation.kind, 'shuffle');
  const bad = signCommand(f.wallets[0], { type: 'shuffle', matchId: view.id, termsHash: view.termsHash, handNo: view.handNo, expectedVersion: view.version, proof: {} },
    view.nonces[f.wallets[0].player] + 1, f.now(), PEER_DOMAIN);
  assert.throws(() => f.session.submit(bad), error => error.code === 'BAD_PROOF');
  assert.deepEqual(f.session.view(), view);
  const outsider = generateWallet();
  const claim = () => signCommand(outsider, { type: 'claim-timeout', matchId: view.id, termsHash: view.termsHash, handNo: view.handNo, expectedVersion: view.version }, 1, f.now(), PEER_DOMAIN);
  f.setTime(view.deadline - 1); assert.throws(() => f.session.submit(claim()), error => error.code === 'TOO_EARLY');
  f.setTime(view.deadline); const done = f.session.submit(claim());
  assert.deepEqual(done.result.payouts, [0, 2000]);
});

test('verified agents reject relay-invented decryption obligations before producing shares', () => {
  const wallet = generateWallet(), other = generateWallet(); const now = Date.now();
  const config = { id: randomUUID(), players: [wallet.player, other.player] };
  const peer = new VerifiedPeerAgent(wallet, () => ({ action: 'check' }), config, now, { now: () => now });
  const view = peer.view();
  const command = { type: 'hole-share', matchId: view.id, termsHash: view.termsHash, handNo: 0, expectedVersion: 0, shares: [] };
  assert.throws(() => peer.receive({ acceptedAt: now, envelope: signCommand(wallet, command, 1, now, PEER_DOMAIN) }), e => e.code === 'WRONG_PHASE');
  assert.deepEqual(peer.view(), view); assert.equal(peer.agent.keys.size, 0);
  // Even when handed an extra fabricated view, nextCommand uses its own mirror.
  assert.equal(peer.nextCommand({ obligation: { kind: 'hole-share', positions: Array.from({length:52}, (_,i)=>i) } }).command.type, 'accept');
});
