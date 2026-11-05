import test from 'node:test';
import assert from 'node:assert/strict';
import {generateWallet, signCommand, verifyEnvelope} from '../src/crypto.js';
import {Protocol} from '../src/protocol.js';
import {PeerSession, PEER_DOMAIN, cryptoContext} from '../src/mental-poker/session.js';
import {makeKey} from '../src/mental-poker/proofs.js';
import {proveDLEQ,verifyDLEQ} from '../src/mental-poker/proofs.js';
import {point,randomScalar,mul,scalar} from '../src/mental-poker/group.js';
import {initialDeck,reencrypt,encodeCipher,revealCard,CARDS} from '../src/mental-poker/deck.js';
import {MentalPokerAgent} from '../src/mental-poker/agent.js';

test('local identities reject alternate encodings and trailing DER aliases of the same key', () => {
  const w = generateWallet();
  for (const player of [w.player + '=', Buffer.concat([Buffer.from(w.player, 'base64url'), Buffer.of(0)]).toString('base64url')]) {
    assert.throws(() => verifyEnvelope(signCommand({...w, player}, {type:'faucet'}, 1), Date.now()), /signature/i);
    assert.throws(() => new PeerSession({id:'alias', players:[w.player, player]}));
  }
  const valid = signCommand(w, {type:'faucet'}, 1);
  assert.throws(() => verifyEnvelope({...valid, signature:valid.signature + '='}, Date.now()), /signature/i);
});

test('a strategy can propose an action but cannot replace the signed match or protocol command', () => {
  const wallets=[generateWallet(),generateWallet()], a=makeKey('policy/a'), b=makeKey('policy/b');
  const agent=new MentalPokerAgent(wallets[0],()=>({action:'call',type:'key',matchId:'attacker-match',handNo:999,expectedVersion:0,registration:{},shares:[]}));
  const view={id:'policy-match',termsHash:'accepted',handNo:1,version:8,players:wallets.map(w=>w.player),nonces:{},obligation:{kind:'action',seat:0},hand:{},legalActions:{call:10},crypto:{deck:[],keys:[a.registration,b.registration],holeShares:{}}};
  const joint=point(a.registration.publicKey).add(point(b.registration.publicKey));
  for(const [i,position] of [0,2].entries()){
    const source=initialDeck()[i];const cipher=encodeCipher(reencrypt({a:point(source.a),b:point(source.b)},joint,randomScalar()));
    view.crypto.deck[position]=cipher;
    view.crypto.holeShares[position]=proveDLEQ(b.secret,cipher.a,cryptoContext(view,'hole-share',1,position));
  }
  agent.keys.set('policy-match:1',a);
  const envelope=agent.decide(view);
  assert.deepEqual(envelope.command,{type:'action',matchId:view.id,termsHash:view.termsHash,handNo:1,expectedVersion:8,action:'call'});
});

test('DLEQ context binding does not protect a secret released for a fabricated RPC card obligation', () => {
  // Documents an OPEN trust boundary: proof verification by the chain occurs
  // after an RPC sees the submitted share, even when it rejects the transaction.
  const a=makeKey('rpc/key/a'), b=makeKey('rpc/key/b');
  const publicKey=point(a.registration.publicKey).add(point(b.registration.publicKey));
  const first=initialDeck()[0];
  const cipher=encodeCipher(reencrypt({a:point(first.a),b:point(first.b)},publicKey,randomScalar()));
  const fakeContext='rpc/claims-this-is-an-authorized-peer-hole';
  const leaked=proveDLEQ(a.secret,cipher.a,fakeContext);
  assert.equal(verifyDLEQ(a.registration.publicKey,cipher.a,leaked.share,leaked.proof,'real/other-position'),false);
  const own=mul(point(cipher.a),scalar(b.secret,true)).toHex();
  assert.equal(revealCard(cipher,[leaked,{share:own}]),CARDS[0]);
});

test('caller mutations cannot alter accepted protocol state through returned views', () => {
  const w = generateWallet(), p = new Protocol();
  p.execute(signCommand(w, {type:'faucet',serverId:p.state.serverId}, 1));
  const result = p.execute(signCommand(w, {type:'create',serverId:p.state.serverId}, 2));
  result.match.stacks[0] = 999999;
  const view = p.get(result.match.id); view.players[0] = 'attacker';
  assert.equal(p.state.matches[result.match.id].stacks[0], 1000);
  assert.equal(p.state.matches[result.match.id].players[0], w.player);
  p.assertConservation(p.state);
});

test('a persistence failure freezes subsequent writes until state is recovered', () => {
  const w=generateWallet();let writes=0;
  const p=new Protocol(undefined,{persist:()=>{writes++;throw Error('Directory fsync failed after rename');}});
  const command=signCommand(w,{type:'faucet',serverId:p.state.serverId},1);
  assert.throws(()=>p.execute(command),/fsync failed/);
  assert.throws(()=>p.execute(command),/state recovery/);
  assert.equal(writes,1);assert.equal(p.publicWallet(w.player).balance,0);
});

test('peer sessions snapshot accepted keys and constructor terms before retaining them', () => {
  const wallets = [generateWallet(), generateWallet()];
  const config = {id:'snapshot-test', players:wallets.map(w => w.player)};
  const s = new PeerSession(config);
  config.players[0] = 'changed';
  assert.equal(s.view().players[0], wallets[0].player);
  const command = (seat, fields) => {
    const v = s.view();
    return signCommand(wallets[seat], {matchId:v.id, termsHash:v.termsHash, handNo:v.handNo, expectedVersion:v.version, ...fields},
      (v.nonces[wallets[seat].player] ?? 0) + 1, Date.now(), PEER_DOMAIN);
  };
  s.submit(command(0, {type:'accept'})); s.submit(command(1, {type:'accept'}));
  const key = makeKey(cryptoContext(s.view(), 'key', 0));
  const expected = key.registration.publicKey;
  const envelope = command(0, {type:'key', registration:key.registration});
  s.submit(envelope);
  envelope.command.registration.publicKey = '00'.repeat(32);
  assert.equal(s.view().crypto.keys[0].publicKey, expected);
  assert.notEqual(s.view().crypto.keys[0].publicKey, '00'.repeat(32));
});
