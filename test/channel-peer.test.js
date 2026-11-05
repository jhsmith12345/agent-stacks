// Two agents playing through whatever a hostile relay does to their messages. No chain is involved,
// which is the point: during play, nothing an RPC says can reach these agents at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ChannelPeer,STAGE} from '../src/channel/peer.js';
import {sessionFromSeed,signMessage as signFor,verifySignature} from '../src/channel/keys.js';
import {acceptedHand,act,applyAction,applyMuck,applyShare,decodeHand,evaluate,firstShower,greater,mayMuck,newGame,KIND_CLOSE,KIND_HAND,signedMessage,sha256,P_BETTING,P_DONE,P_HOLE_B,encodeHand,owedPositions,parseShare} from '../src/channel/engine.js';
import {shareContext} from '../src/solana/client.js';
import {decryptionShare} from '../src/mental-poker/deck.js';
import {proveDLEQ} from '../src/mental-poker/proofs.js';
import {encodeDLEQ} from '../src/channel/wire.js';
import {fromHex,toHex} from '../src/channel/wire.js';

const sessions=[sessionFromSeed(Buffer.alloc(32,1)),sessionFromSeed(Buffer.alloc(32,2))];
const config=(overrides={})=>({program:'11111111111111111111111111111112',match:'11111111111111111111111111111113',terms:'aa'.repeat(32),programBytes:Buffer.alloc(32,3),matchBytes:Buffer.alloc(32,4),termsBytes:Buffer.alloc(32,0xaa),sessions:sessions.map(s=>toHex(s.publicKey)),buyIn:1_000_000,bigBlind:20_000,maxHands:1,...overrides});
const calling=view=>({action:view.owed>0?2:1});
function peers(strategies=[calling,calling],overrides={}){
 const cfg=config(overrides);
 return [0,1].map(seat=>new ChannelPeer(cfg,sessions[seat],seat,{strategy:strategies[seat]}));
}
// Delivers until nothing is left, in order, and returns every message each side sent.
function run(a,b,{tap=(from,m)=>[m],limit=5000}={}){
 const queue=[...a.start().map(m=>({to:1,m})),...b.start().map(m=>({to:0,m}))],sent=[[],[]];
 for(const {to,m} of queue)sent[1-to].push(m);
 for(let i=0;i<queue.length&&i<limit;i++){
  const {to,m}=queue[i];
  for(const delivered of tap(1-to,m)){
   for(const reply of [a,b][to].receive(delivered)){sent[to].push(reply);queue.push({to:1-to,m:reply});}
  }
 }
 return sent;
}
const shares=messages=>messages.filter(m=>m.type==='move'&&m.step?.logical!==undefined);
// The expensive part of a hand, done once and reused. Tests start from a state both have signed.
let fixture;
function accepted(){
 if(!fixture){
  const [a,b]=peers();
  let stop=false;
  run(a,b,{tap:(from,m)=>{if(stop)return [];if(m.type==='ack'&&m.kind===KIND_HAND){stop=true;}return [m];}});
  fixture=[a.state,b.state].map(s=>JSON.stringify(s));
 }
 return fixture.map(s=>JSON.parse(s));
}
const resume=(seat,state,strategy=calling,overrides={})=>new ChannelPeer(config(overrides),sessions[seat],seat,{strategy,state});

test('two agents play a whole hand with nothing but signed messages, and agree the result',{timeout:60000},()=>{
 const [a,b]=peers();
 run(a,b);
 assert.equal(a.state.stage,STAGE.CLOSED);assert.equal(b.state.stage,STAGE.CLOSED);
 assert.deepEqual(a.closeProof(),b.closeProof());
 const proof=a.closeProof();
 assert.equal(proof.stacks[0]+proof.stacks[1],2_000_000);
 assert.equal(a.state.latest.kind,KIND_CLOSE);
 // Both signatures verify under the session keys, over exactly what the contract will check.
 const message=signedMessage(a.binding,KIND_CLOSE,proof.seq,sha256(fromHex(a.state.latest.payload)));
 for(const seat of [0,1])assert.equal(verifySignature(sessions[seat].publicKey,message,fromHex(proof.sigs[seat],64)),true);
});
test('a multi-hand match moves stacks between hands and swaps the button',{timeout:120000},()=>{
 const raiser=view=>view.street===1&&view.owed===0?{action:3,amount:view.currentBet+40_000}:{action:view.owed>0?2:1};
 const [a,b]=peers([raiser,calling],{maxHands:2});
 run(a,b);
 assert.equal(a.state.stage,STAGE.CLOSED);assert.equal(a.state.hand,2);
 assert.deepEqual(a.state.final,b.state.final);
 assert.equal(a.state.final[0]+a.state.final[1],2_000_000);
});
test('an agent with no chain and no RPC cannot be told to reveal anything: invented requests are ignored',{timeout:60000},()=>{
 // Port of the AS-03 attack. The attacker controls everything the agent receives and asks it to
 // reveal a hidden card, as a relay view or a fake "phase", and it must produce no share at all.
 const [stateA]=accepted();
 const victim=resume(0,stateA);
 const before=JSON.stringify(victim.state);
 const attacks=[
  {type:'reveal',positions:[0,2]},
  {type:'view',phase:11,positions:[0,2],obligation:{kind:'showdown-share',seat:0}},
  {type:'move',seq:victim.state.latest.seq+1,step:{action:1},hash:'00'.repeat(32),sig:'00'.repeat(64)},
  {type:'ack',seq:victim.state.latest.seq+1,kind:KIND_HAND,hash:'11'.repeat(32),sig:'22'.repeat(64)},
  null,42,'rubbish',[],{},
 ];
 for(const attack of attacks)assert.deepEqual(victim.receive(attack),[],JSON.stringify(attack));
 const after=victim.state;
 assert.equal(after.seq,JSON.parse(before).seq);
 assert.deepEqual(after.s,JSON.parse(before).s,'no state moved');
});
test('a fully signed fake showdown from someone without the opponent’s key gets nothing',{timeout:60000},()=>{
 const [stateA]=accepted();
 const victim=resume(0,stateA);
 const s=structuredClone(victim.state.s);s.phase=11;s.game.stage=2;
 const hash=sha256(encodeHand(s));
 const forger=sessionFromSeed(Buffer.alloc(32,9));
 const message=signedMessage(victim.binding,KIND_HAND,victim.state.latest.seq+1,hash);
 const before=victim.state.latest.seq;
 const forged={type:'move',seq:before+1,step:{action:1},hash:toHex(hash),sig:toHex(signFor(forger,message))};
 assert.deepEqual(victim.receive(forged),[]);
 assert.equal(victim.state.latest.seq,before);
});
test('even the real opponent can only obtain what the rules owe: a move that skips ahead is refused',{timeout:60000},()=>{
 const [stateA,stateB]=accepted();
 const victim=resume(0,stateA),cheat=resume(1,stateB);
 assert.equal(victim.state.s.phase,P_HOLE_B,'seat 1 owes the first shares');
 // The real opponent signs a state claiming betting is over and showdown is due.
 const s=structuredClone(victim.state.s);s.phase=11;s.game.stage=2;s.game.actor=255;
 const seq=victim.state.latest.seq+1,hash=sha256(encodeHand(s));
 const sig=signFor(cheat.session,signedMessage(cheat.binding,KIND_HAND,seq,hash));
 const out=victim.receive({type:'move',seq,step:{action:1},hash:toHex(hash),sig:toHex(sig)});
 assert.deepEqual(out,[]);assert.equal(victim.state.latest.seq,seq-1);
 assert.equal(victim.state.s.phase,P_HOLE_B);
 assert.equal(shares(out).length,0);
});
test('an agent reveals nothing until the state that obliges it carries the opponent’s signature',{timeout:60000},()=>{
 const [stateA]=accepted();
 const a=resume(0,stateA);
 // Seat 0 owes nothing yet, and asking it to act directly must fail rather than release a share.
 assert.throws(()=>a.chooseStep(),/owes nothing/);
 const state=structuredClone(stateA);state.s.phase=11;state.s.game.stage=2;
 const tampered=resume(0,state);
 assert.throws(()=>tampered.chooseStep(),/differs from the signed state/,'a changed local state can’t produce a share either');
 const unsigned=structuredClone(stateA);unsigned.latest.sigs[1]=null;
 assert.throws(()=>resume(0,unsigned).chooseStep(),/not signed by the opponent/);
});
test('a relay that drops, repeats, reorders and corrupts messages can delay play but not change it',{timeout:120000},()=>{
 const [a,b]=peers();
 let n=0;const stash=[];
 const hostile=(from,m)=>{
  n++;
  if(n%7===0)return [m,m]; // repeats
  if(n%5===0){const bad=structuredClone(m);if(bad.sig)bad.sig=bad.sig.replace(/^../,'00');return [bad,m];} // corrupts, then delivers
  if(n%11===0){stash.push(m);return [];} // holds back, delivered late below
  const late=stash.splice(0);return [m,...late];
 };
 run(a,b,{tap:hostile});
 // Anything still held back is delivered, then both resend until settled, as the real loop would.
 for(let round=0;round<50&&!(a.state.stage===STAGE.CLOSED&&b.state.stage===STAGE.CLOSED);round++){
  for(const m of stash.splice(0))for(const reply of (m.type==='ack'||m.type==='move'||m.type==='key'||m.type==='shuffle')?[a,b].flatMap(p=>p.receive(m)):[])stash.push(reply);
  for(const m of a.resend())for(const r of b.receive(m))for(const x of a.receive(r))b.receive(x);
  for(const m of b.resend())for(const r of a.receive(m))for(const x of b.receive(r))a.receive(x);
 }
 assert.equal(a.state.stage,STAGE.CLOSED);assert.equal(b.state.stage,STAGE.CLOSED);
 assert.deepEqual(a.state.final,b.state.final);
 assert.ok(a.state.rejected+b.state.rejected>0,'the corrupted messages were seen and refused');
});
test('a player never signs two states at one step, even if asked to after a restart',{timeout:60000},()=>{
 const [stateA]=accepted();
 const a=resume(0,stateA);
 const seq=a.state.latest.seq+1;
 const first=a.sign(KIND_HAND,seq,sha256(Buffer.from('one')));
 assert.equal(first.length,64);
 assert.throws(()=>a.sign(KIND_HAND,seq,sha256(Buffer.from('two'))),/second state/);
 assert.equal(a.sign(KIND_HAND,seq,sha256(Buffer.from('one'))).length,64,'the same state may be signed again');
 const restarted=resume(0,JSON.parse(JSON.stringify(a.state)));
 assert.throws(()=>restarted.sign(KIND_HAND,seq,sha256(Buffer.from('two'))),/second state/,'the record survives a restart');
});
test('an agent restarted from its durable state carries on and repeats the same decision',{timeout:120000},()=>{
 const saved=[null,null];
 let decisions=0;
 const counting=view=>{decisions++;return calling(view);};
 const cfg=config();
 const make=(seat,state=null)=>new ChannelPeer(cfg,sessions[seat],seat,{strategy:counting,state,store:{save:s=>{saved[seat]=JSON.stringify(s);}}});
 let [a,b]=[make(0),make(1)];
 let delivered=0;
 const queue=[...a.start().map(m=>({to:1,m})),...b.start().map(m=>({to:0,m}))],actions=new Set();
 const done=()=>a.state.stage===STAGE.CLOSED&&b.state.stage===STAGE.CLOSED;
 for(let i=0;i<queue.length&&!done();i++){
  const {to,m}=queue[i];
  if(m.type==='move'&&m.step?.action!==undefined)actions.add(m.seq);
  for(const reply of [a,b][to].receive(m))queue.push({to:1-to,m:reply});
  delivered++;
  // Crash both agents every few messages and restart them from disk, resending what they had sent.
  if(delivered%6===0){
   a=make(0,JSON.parse(saved[0]));b=make(1,JSON.parse(saved[1]));
   for(const m of a.resend())queue.push({to:1,m});
   for(const m of b.resend())queue.push({to:0,m});
  }
 }
 assert.equal(done(),true);
 assert.deepEqual(a.state.final,b.state.final);
 assert.equal(decisions,actions.size,'no betting decision was made twice');
});
test('two different signatures from the opponent at one step are kept as proof',{timeout:60000},()=>{
 const [stateA,stateB]=accepted();
 const victim=resume(0,stateA),cheat=resume(1,stateB);
 const seq=victim.state.latest.seq;
 const other=sha256(Buffer.from('another state at the same step'));
 const sig=signFor(cheat.session,signedMessage(cheat.binding,KIND_HAND,seq,other));
 victim.receive({type:'ack',seq,kind:KIND_HAND,hash:toHex(other),sig:toHex(sig)});
 const evidence=victim.state.evidence;
 assert.equal(evidence.seat,1);assert.equal(evidence.seq,seq);
 assert.notEqual(evidence.first.hash,evidence.second.hash);
});
test('a bad strategy can’t do more than propose a move, and falls back to the safe default',{timeout:60000},()=>{
 const evil=()=>({action:3,amount:999_999_999_999,logical:0,wire:'00'});
 const [a,b]=peers([evil,calling]);
 run(a,b);
 assert.equal(a.state.stage,STAGE.CLOSED);
 // Seat 0 faced a blind and couldn't call by default, so it folded rather than doing anything else.
 assert.deepEqual(a.state.final,[990_000,1_010_000]);
 const secret=a.state.setup.secret;
 assert.equal(JSON.stringify(a.state.outbox).includes(secret),false,'a hand key never leaves the agent');
});
test('a shuffle that doesn’t start from the agreed deck or doesn’t prove out is refused',{timeout:60000},()=>{
 const [a,b]=peers();
 // Run keys, then corrupt seat 0's shuffle in flight.
 const out=a.start();b.start();
 const keyB=b.receive(out[0]);
 const shuffle=a.receive(keyB[0])[0];
 const wire=Buffer.from(shuffle.wire,'base64');
 wire[wire.length-5]^=1;
 const body={...shuffle,wire:wire.toString('base64')};
 assert.deepEqual(b.receive(body),[],'a changed shuffle fails its signature');
 const resigned={...body,sig:b.signSetup.call({...a,setupDigest:a.setupDigest.bind(a),session:a.session},'shuffle',shuffle.hand,createHash('sha256').update(wire).digest())};
 assert.deepEqual(b.receive(resigned),[],'a properly signed bad shuffle fails its proof');
 assert.equal(b.state.stage,STAGE.SHUFFLE);
});
// In a dispute the agent reads the chain through an RPC it can't trust, so each of these is what stands
// between a lying node and a hidden card.
test('in a dispute, an agent only adopts a chain state it signed itself',{timeout:60000},()=>{
 const [stateA]=accepted();
 const a=resume(0,stateA);
 const seq=a.state.latest.seq,own=fromHex(a.state.latest.payload);
 const s=structuredClone(a.state.s);s.phase=11;s.game.stage=2;
 assert.throws(()=>a.adoptChainState(seq,encodeHand(s)),/never signed/);
 assert.throws(()=>a.adoptChainState(seq+40,own),/never signed/);
 a.adoptChainState(seq,own);
 assert.equal(a.state.seq,seq);
});
test('in a dispute, an opponent’s move counts only with their signature on what the engine computes',{timeout:60000},()=>{
 const [stateA,stateB]=accepted();
 const a=resume(0,stateA),b=resume(1,stateB);
 assert.equal(b.state.s.phase,P_HOLE_B);
 const seq=a.state.latest.seq+1,move=b.chainMove(a.state.latest.seq);
 const before=JSON.stringify(a.state.s);
 // A signature from anyone else, or over anything else, doesn't count.
 const forger=sessionFromSeed(Buffer.alloc(32,9));
 assert.throws(()=>a.acceptChainMove(seq,move.step,signFor(forger,move.message)),/Bad signature/);
 assert.throws(()=>a.acceptChainMove(seq+1,move.step,move.signature),/Bad signature/);
 assert.throws(()=>a.acceptChainMove(seq,{logical:2,wire:move.step.wire},move.signature),/Share is not owed/);
 assert.equal(JSON.stringify(a.state.s),before,'nothing changed');
 a.acceptChainMove(seq,move.step,move.signature);
 assert.equal(a.state.latest.seq,seq);
 assert.ok(a.state.latest.sigs[0]&&a.state.latest.sigs[1],'the agent can post it, so the opponent can’t deny it');
});
test('in a dispute, an agent owes only what its own engine says, whatever the chain claims',{timeout:60000},()=>{
 const [stateA,stateB]=accepted();
 const a=resume(0,stateA);
 assert.throws(()=>a.chainMove(a.state.latest.seq),/owes nothing/,'seat 1 owes the next share here');
 assert.throws(()=>a.chainMove(a.state.latest.seq+3),/not at the chain/);
 // A move already signed off-chain is the one that goes on chain, with no second decision.
 const b=resume(1,stateB),first=b.chainMove(b.state.latest.seq),again=b.chainMove(b.state.latest.seq);
 assert.deepEqual(first.signature,again.signature);assert.deepEqual(first.step.logical,again.step.logical);
});
// Each attack below passes every other check, so it exercises exactly one rule.
function realMove(){
 const [stateA,stateB]=accepted();
 const victim=resume(0,stateA),opponent=resume(1,stateB);
 // Seat 1 owes the first card share, and has already signed and sent it.
 const seq=victim.state.latest.seq+1,message=opponent.state.outbox.find(m=>m.type==='move');
 return {victim,opponent,seq,message,sessionB:opponent.session};
}
test('a correct move signed by someone else is refused',{timeout:60000},()=>{
 const {victim,seq,message}=realMove();
 const forger=sessionFromSeed(Buffer.alloc(32,9));
 const forged={...message,sig:toHex(signFor(forger,signedMessage(victim.binding,KIND_HAND,seq,fromHex(message.hash,32))))};
 assert.deepEqual(victim.receive(forged),[]);
 assert.equal(victim.state.latest.seq,seq-1);
 // The same move with the real signature is accepted, so the refusal is about the signature.
 const replies=victim.receive(message);
 assert.equal(replies[0].type,'ack');assert.equal(victim.state.latest.seq,seq);
});
test('the opponent’s real signature on a state the move doesn’t produce is refused',{timeout:60000},()=>{
 const {victim,seq,message,sessionB}=realMove();
 const s=structuredClone(victim.state.s);s.game.stacks[1]+=500;s.game.stacks[0]-=500;
 const hash=sha256(encodeHand(s));
 const lying={...message,hash:toHex(hash),sig:toHex(signFor(sessionB,signedMessage(victim.binding,KIND_HAND,seq,hash)))};
 assert.deepEqual(victim.receive(lying),[]);
 assert.equal(victim.state.latest.seq,seq-1,'nothing was co-signed');
 assert.equal(victim.state.signed[seq],undefined);
});
test('an acknowledgement counts only from the opponent, and only for the state this agent signed',{timeout:60000},()=>{
 const {victim,opponent,seq,message}=realMove();
 // The opponent's turn is done, so now the mover waits on an acknowledgement from the victim.
 const ack=victim.receive(message)[0];
 const before=opponent.state.latest.seq;
 const forger=sessionFromSeed(Buffer.alloc(32,9));
 const fromForger={...ack,sig:toHex(signFor(forger,signedMessage(opponent.binding,KIND_HAND,seq,fromHex(ack.hash,32))))};
 assert.deepEqual(opponent.receive(fromForger),[]);
 assert.equal(opponent.state.latest.seq,before);
 const other=sha256(Buffer.from('some other state'));
 const wrongState={...ack,hash:toHex(other),sig:toHex(signFor(victim.session,signedMessage(opponent.binding,KIND_HAND,seq,other)))};
 assert.deepEqual(opponent.receive(wrongState),[]);
 assert.equal(opponent.state.latest.seq,before);
 opponent.receive(ack);
 assert.equal(opponent.state.latest.seq,seq);
});
test('a valid shuffle with a forged signature is refused',{timeout:60000},()=>{
 const [a,b]=peers();
 const out=a.start();b.start();
 const shuffle=a.receive(b.receive(out[0])[0])[0];
 const forger=new ChannelPeer(config(),a.session,0,{strategy:calling});
 forger.session=sessionFromSeed(Buffer.alloc(32,9));
 const forged={...shuffle,sig:forger.signSetup('shuffle',shuffle.hand,sha256(Buffer.from(shuffle.wire,'base64')))};
 assert.deepEqual(b.receive(forged),[]);
 assert.equal(b.state.stage,STAGE.SHUFFLE);assert.match(b.lastRejection,/shuffle signature/);
});
test('a card share counts only with a valid proof, in this context, for this card and key',{timeout:60000},()=>{
 const [,stateB]=accepted();
 const s=stateB.s,seat=1,secret=stateB.setup.secret;
 const logical=owedPositions(s)[s.cursor],card=s.cards[logical];
 const context=shareContext(config().program,config().match,s.phase,seat,logical,config().terms,s.hand);
 const honest=decryptionShare(secret,card,context);
 const wire=(ctx,base,p)=>encodeDLEQ(ctx,p.publicKey,base,p.share,p.proof);
 const attempt=w=>applyShare(structuredClone(s),context,seat,logical,w);
 assert.doesNotThrow(()=>attempt(wire(context,card.a,honest)),'the honest share is accepted');
 // A broken proof.
 const broken=wire(context,card.a,honest);broken[broken.length-1]^=1;
 assert.throws(()=>attempt(broken),/Invalid share proof|scalar|Invalid/);
 const badShare=parseShare(wire(context,card.a,honest));
 const otherPoint=decryptionShare(secret,s.cards[logical+1],context).share;
 assert.throws(()=>attempt(wire(context,card.a,{...badShare,share:otherPoint})),/Invalid share proof/);
 // A valid proof made for another context can't be replayed here.
 const elsewhere='agent-stacks/some/other/context';
 const other=decryptionShare(secret,card,elsewhere);
 assert.throws(()=>attempt(wire(elsewhere,card.a,other)),/Wrong share context/);
 // A valid proof, in this context, for a different card: this is how a hidden card would leak.
 const otherCard=s.cards[logical+1];
 const wrongCard=decryptionShare(secret,otherCard,context);
 assert.throws(()=>attempt(wire(context,otherCard.a,wrongCard)),/does not match this card/);
 // A valid proof from a key that isn't this seat's.
 const stranger='0'.repeat(62)+'0a';
 const fromStranger=proveDLEQ(stranger,card.a,context);
 assert.throws(()=>attempt(wire(context,card.a,fromStranger)),/does not match this card/);
});
test('junk from a relay can’t crowd out a real message',{timeout:60000},()=>{
 const {victim,message}=realMove();
 for(let i=0;i<100;i++)victim.receive({type:'key',hand:99,registration:{},sig:'00'});
 assert.ok(victim.held.length<=16,'the holding queue stays bounded');
 assert.equal(victim.receive(message)[0].type,'ack');
});
test('a player can only bet on their own turn, with only a legal amount',()=>{
 const fresh=()=>newGame([1_000_000,1_000_000],20_000,0);
 const g=fresh();assert.equal(g.actor,0,'the button acts first');
 for(const [action,amount] of [[0,0],[1,0],[2,0],[3,60_000],[4,0]])assert.throws(()=>act(fresh(),1,action,amount),/Illegal betting move/,`seat 1, action ${action}`);
 assert.throws(()=>act(fresh(),2,1,0),/Illegal betting move/);
 assert.throws(()=>act(fresh(),0,1,0),/Cannot check/,'a check while owing the blind');
 assert.throws(()=>act(fresh(),0,3,20_000),/Illegal raise/,'a raise to the current bet');
 assert.throws(()=>act(fresh(),0,3,5_000_000),/Illegal raise/,'a raise beyond the stack');
 assert.throws(()=>act(fresh(),0,1,5),/Illegal betting move/,'an amount on a check');
 assert.throws(()=>act(fresh(),0,2,-1),/Invalid amount/);
 const called=fresh();act(called,0,2,0);
 assert.equal(called.stacks[0]+called.contributed[0],1_000_000,'chips are conserved');
});
// Showing and mucking. Hand 1's button is seat 0, so with no bet on the river seat 1 shows first.
const checkEverything=view=>({action:view.owed>0?2:1});
const betRiverAsSeat0=view=>view.street===3&&view.seat===0&&view.owed===0?{action:3,amount:60_000}:{action:view.owed>0?2:1};
function playHand(strategies,reveals){
 const cfg=config();
 const pair=[0,1].map(seat=>new ChannelPeer(cfg,sessions[seat],seat,{strategy:strategies[seat],reveal:reveals?.[seat]??null}));
 const sent=run(pair[0],pair[1]);
 return {a:pair[0],b:pair[1],sent};
}
test('a caller who chooses to muck gives up the pot, and its cards stay hidden for good',{timeout:60000},()=>{
 const {a,b,sent}=playHand([betRiverAsSeat0,checkEverything],[null,()=>false]);
 assert.equal(a.state.stage,STAGE.CLOSED);assert.equal(b.state.stage,STAGE.CLOSED);
 // Seat 0 bet the river and got called, so it showed. Seat 1 mucked.
 assert.equal(sent[1].filter(m=>m.type==='move'&&m.step?.muck===true).length,1);
 assert.deepEqual(a.state.final,[1_080_000,920_000]);
 assert.deepEqual(a.state.s.game.holes[1],[255,255],'the opponent never learns the mucked cards');
 assert.ok(a.state.s.game.holes[0].every(c=>c<52),'the called player’s cards are public');
 assert.equal(a.state.s.game.reason,3);
 const zero='00'.repeat(32);
 for(const state of [a.state,b.state])for(const logical of [1,3])assert.equal(state.s.shares[logical][1],zero,'no share for a mucked card was ever released');
 // Seat 1's own shares for its own cards are the ones that would reveal them, and none was ever sent.
 const revealed=sent[1].filter(m=>m.type==='move'&&m.step?.logical!==undefined&&m.seq>4).map(m=>m.step.logical);
 assert.equal(revealed.some(logical=>logical===1||logical===3),false);
});
test('a caller who chooses to show reveals, and the hands are compared',{timeout:60000},()=>{
 const {a}=playHand([betRiverAsSeat0,checkEverything],[null,()=>true]);
 assert.equal(a.state.s.game.reason,1);
 assert.ok(a.state.s.game.holes.flat().every(c=>c<52));
 assert.equal(a.state.final[0]+a.state.final[1],2_000_000);
});
test('by default an agent shows a hand that wins or ties, and mucks one that loses',{timeout:60000},()=>{
 const {a,b}=playHand([betRiverAsSeat0,checkEverything]);
 const game=a.state.s.game,mine=b.myCards(b.state.s),board=game.board;
 const theirs=evaluate([...game.holes[0],...board]),ours=evaluate([...mine,...board]);
 if(greater(theirs,ours)){assert.equal(game.reason,3,'a losing caller mucked');assert.deepEqual(game.holes[1],[255,255]);}
 else{assert.equal(game.reason,1,'a winning or tied caller showed');assert.deepEqual(game.holes[1],mine);}
});
test('the decision rests on the real comparison',()=>{
 // Seat 1 holds aces. Seat 0 showed kings. Seat 1 wins with this board, then loses with a straight on it.
 const card=(rank,suit)=>'23456789TJQKA'.indexOf(rank)*4+'cdhs'.indexOf(suit);
 const peerFor=(reveal=null)=>{const p=new ChannelPeer(config(),sessions[1],1,{strategy:calling,reveal});p.myCards=()=>[card('A','s'),card('A','h')];return p;};
 const state=board=>({hand:1,game:{holes:[[card('K','s'),card('K','h')],[255,255]],board,contributed:[60_000,60_000]}});
 const safe=[card('2','c'),card('7','d'),card('9','c'),card('J','d'),card('3','h')];
 assert.equal(peerFor().choosesToShow(state(safe)),true,'a winning hand is shown');
 const kings=[card('K','c'),card('2','d'),card('7','c'),card('J','d'),card('3','h')];
 assert.equal(peerFor().choosesToShow(state(kings)),false,'a losing hand is mucked');
 const tied={...state([card('T','c'),card('J','c'),card('Q','c'),card('K','c'),card('A','c')])};
 assert.equal(peerFor().choosesToShow(tied),true,'a tied hand is shown, to claim its half');
 const views=[];
 assert.equal(peerFor(v=>{views.push(v);return true;}).choosesToShow(state(kings)),true,'a player may show a loser if it wants to');
 assert.equal(views[0].winning,false);assert.equal(views[0].pot,120_000);
 assert.equal(peerFor(()=>false).choosesToShow(state(safe)),false,'and may even muck a winner');
});
test('only the player second to show can muck, and only before showing anything',()=>{
 const deck=Array.from({length:52},()=>({a:'11'.repeat(32),b:'22'.repeat(32)}));
 const hand=()=>{const s=acceptedHand({hand:1,keys:['33'.repeat(32),'44'.repeat(32)],deck,stacks:[1_000_000,1_000_000],bigBlind:20_000});s.phase=P_BETTING;return s;};
 const atShowdown=aggressor=>{const s=hand();s.game.stage=2;s.game.actor=255;s.aggressor=aggressor;s.phase=aggressor===0?11:12;return s;};
 assert.throws(()=>applyMuck(hand(),0),/not allowed/,'not during betting');
 // Seat 0 got called, so it shows first and can't muck.
 assert.equal(firstShower(atShowdown(0)),0);
 assert.throws(()=>applyMuck(atShowdown(0),0),/not allowed/,'the called player has to show');
 assert.throws(()=>applyMuck(atShowdown(0),1),/not allowed/,'and the caller has to wait for that');
 // Once seat 0 has shown, it's seat 1's choice.
 const second=atShowdown(0);second.phase=12;
 assert.equal(mayMuck(second),true);
 const mucked=applyMuck(structuredClone(second),1);
 assert.equal(mucked.phase,P_DONE);assert.equal(mucked.game.winner,0);
 assert.throws(()=>applyMuck(structuredClone(second),0),/not allowed/,'seat 0 can’t muck on seat 1’s behalf');
 // One card shown is too late.
 const partial=structuredClone(second);partial.cursor=1;
 assert.equal(mayMuck(partial),false);
 assert.throws(()=>applyMuck(partial,1),/not allowed/);
 // With no bet on the river, the first to act shows first, which is the player without the button.
 const checked=hand();checked.game.stage=2;checked.game.actor=255;
 assert.equal(firstShower(checked),1);
 checked.game.button=1;
 assert.equal(firstShower(checked),0);
});
test('betting sets who got called, and a new betting round clears it',()=>{
 const deck=Array.from({length:52},()=>({a:'11'.repeat(32),b:'22'.repeat(32)}));
 const s=acceptedHand({hand:1,keys:['33'.repeat(32),'44'.repeat(32)],deck,stacks:[1_000_000,1_000_000],bigBlind:20_000});
 s.phase=P_BETTING;
 assert.equal(s.aggressor,255,'blinds aren’t a bet');
 applyAction(s,0,3,60_000);assert.equal(s.aggressor,0);
 applyAction(s,1,3,180_000);assert.equal(s.aggressor,1,'the last raise counts');
 applyAction(s,0,2,0);assert.equal(s.aggressor,1,'a call doesn’t change it');
 assert.deepEqual(decodeHand(encodeHand(s)),s,'it survives encoding, because it’s part of what both sign');
});
