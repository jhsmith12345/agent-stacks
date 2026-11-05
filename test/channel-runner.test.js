// What an agent does about the chain, with a scripted chain standing in for any RPC, honest or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ChannelPeer} from '../src/channel/peer.js';
import {ChannelRunner} from '../src/channel/runner.js';
import {RelayTransport,startRelay} from '../src/channel/relay.js';
import {sessionFromSeed} from '../src/channel/keys.js';
import {accountBlob,channelAddress,channelTerms,CHANNEL_SPACE,COMPLETE,decodeChannel,ed25519Instruction,EXIT,OPEN,WAITING} from '../src/channel/chain.js';
import {encodeHand,KIND_HAND,P_DONE,sha256,signedMessage} from '../src/channel/engine.js';
import {fromHex,toHex} from '../src/channel/wire.js';
import {signMessage} from '../src/channel/keys.js';

const sessions=[sessionFromSeed(Buffer.alloc(32,1)),sessionFromSeed(Buffer.alloc(32,2))];
const config=()=>({program:'11111111111111111111111111111112',match:'11111111111111111111111111111113',terms:'aa'.repeat(32),programBytes:Buffer.alloc(32,3),matchBytes:Buffer.alloc(32,4),termsBytes:Buffer.alloc(32,0xaa),sessions:sessions.map(s=>toHex(s.publicKey)),buyIn:1_000_000,bigBlind:20_000,maxHands:1,turnSeconds:30});
const calling=view=>({action:view.owed>0?2:1});
const peer=(seat,state)=>new ChannelPeer(config(),sessions[seat],seat,{strategy:calling,state:structuredClone(state)});
// Plays real agents until both hold a signed state in betting, the expensive part, once.
let fixture;
function inPlay(){
 if(!fixture){
  const pair=[0,1].map(seat=>new ChannelPeer(config(),sessions[seat],seat,{strategy:calling}));
  const queue=[...pair[0].start().map(m=>({to:1,m})),...pair[1].start().map(m=>({to:0,m}))];
  for(let i=0;i<queue.length;i++){
   const {to,m}=queue[i];
   for(const reply of pair[to].receive(m))queue.push({to:1-to,m:reply});
   // Stop while seat 0, the first to bet, holds the state obliging it to act, with nothing newer sent.
   if(pair[0].state.latest?.seq>=5&&pair[1].state.latest?.seq>=5)break;
  }
  fixture=pair.map(p=>JSON.stringify(p.state));
 }
 return fixture.map(s=>JSON.parse(s));
}
function scriptedChain(state,time=1000){
 const calls=[];
 return {calls,state,time,
  read:async function(){return this.state;},
  chainTime:async function(){return this.time;},
  exitWithDeposits:async()=>{calls.push({type:'exit'});return 'sig';},
  postHand:async(_signed,seq,payload)=>{calls.push({type:'post',seq,payload});return 'sig';},
  postStacks:async(_signed,seq)=>{calls.push({type:'stacks',seq});return 'sig';},
  close:async()=>{calls.push({type:'close'});return 'sig';},
  move:async(seat,chainSeq,step)=>{calls.push({type:'move',seat,chainSeq,step});return 'sig';},
  timeout:async()=>{calls.push({type:'timeout'});return 'sig';},
  proveFork:async e=>{calls.push({type:'fork',evidence:e});return 'sig';},
  onChainMoves:async function(){return this.moves??new Map();},
  closeBuffer:async()=>null,
 };
}
const silent={send:async()=>{},receive:async()=>[]};
const runner=(p,chain,options={})=>new ChannelRunner({peer:p,chains:[chain],transport:silent,bufferKey:async()=>({publicKey:{toBase58:()=>'buffer'}}),stallMs:0,chainPollMs:0,...options});
const onChain=(p,overrides)=>({phase:OPEN,seq:0,window:0,deadline:0,version:1,blob:Buffer.alloc(0),...overrides});
const latestHand=p=>fromHex(p.state.latest.payload);

test('an agent waiting on a silent opponent posts its newest signed state',{timeout:60000},async()=>{
 const [stateA]=inPlay(),a=peer(0,stateA);
 const chain=scriptedChain(onChain(a,{phase:OPEN}));
 await runner(a,chain).tick();
 assert.equal(chain.calls[0].type,'post');assert.equal(chain.calls[0].seq,a.state.latest.seq);
 assert.equal(a.state.disputed,true,'it stops signing off-chain from here on');
});
test('with nothing signed yet, it exits with the original deposits',async()=>{
 const a=new ChannelPeer(config(),sessions[0],0,{strategy:calling});a.start();
 const chain=scriptedChain(onChain(a,{phase:OPEN}));
 await runner(a,chain).tick();
 assert.deepEqual(chain.calls.map(c=>c.type),['exit']);
});
test('it answers a stale post with its newest state while the window is open, and leaves a current one alone',{timeout:60000},async()=>{
 const [stateA]=inPlay(),a=peer(0,stateA),newest=a.state.latest.seq;
 const stale=scriptedChain(onChain(a,{phase:EXIT,seq:1,window:2000,deadline:2000}));
 await runner(a,stale).tick();
 assert.equal(stale.calls[0].type,'post');assert.equal(stale.calls[0].seq,newest);
 // This agent owes a move in this state, and still must wait for the window to close.
 const current=scriptedChain(onChain(a,{phase:8,seq:newest,window:2000,deadline:3000,blob:latestHand(a)}));
 await runner(peer(0,stateA),current).tick();
 assert.deepEqual(current.calls,[],'nothing to answer, and no move is allowed yet');
 const open=scriptedChain(onChain(a,{phase:8,seq:newest,window:500,deadline:3000,blob:latestHand(a)}));
 await runner(peer(0,stateA),open).tick();
 assert.deepEqual(open.calls.map(c=>c.type),['move'],'once the window closes, the same move goes through');
});
test('after the window it settles an exit, and claims a missed deadline',{timeout:60000},async()=>{
 const [stateA]=inPlay(),a=peer(0,stateA);
 const exit=scriptedChain(onChain(a,{phase:EXIT,seq:a.state.latest.seq,window:500,deadline:500}));
 await runner(a,exit).tick();
 assert.deepEqual(exit.calls.map(c=>c.type),['timeout']);
 const missed=scriptedChain(onChain(a,{phase:8,seq:a.state.latest.seq,window:100,deadline:900,blob:latestHand(a)}));
 await runner(peer(0,stateA),missed).tick();
 assert.deepEqual(missed.calls.map(c=>c.type),['timeout']);
});
test('a chain that lies about what is due gets no card share out of the agent',{timeout:60000},async()=>{
 const [stateA]=inPlay(),a=peer(0,stateA);
 const seq=a.state.latest.seq,before=JSON.stringify(a.state.s);
 assert.notEqual(a.state.s.phase,11);
 // The chain claims showdown is due from this very agent, with the window closed and time left.
 const s=structuredClone(a.state.s);s.phase=11;s.game.stage=2;
 const lying=scriptedChain(onChain(a,{phase:11,seq,window:100,deadline:5000,blob:encodeHand(s)}));
 await runner(a,lying).tick();
 for(const call of lying.calls)assert.equal(call.step?.logical,undefined,'no share was sent');
 assert.ok(lying.calls.every(c=>c.type==='move'),'at most its own legitimate betting move');
 assert.equal(a.state.s.shares[0][0],JSON.parse(before).shares[0][0]);
 // The chain claims the opponent moved, with no signed move behind it.
 const ahead=scriptedChain(onChain(a,{phase:9,seq:seq+1,window:100,deadline:5000,blob:encodeHand(s)}));
 const b=peer(0,stateA);
 await runner(b,ahead).tick();
 assert.deepEqual(ahead.calls,[],'it waits to see a signed move, and does nothing');
 assert.equal(b.state.latest.seq,seq);
 // The chain shows an older state with different contents, which this agent never signed.
 const c=peer(0,stateA),older=structuredClone(c.state.s);older.game.stacks[0]+=7;older.game.stacks[1]-=7;
 const fake=scriptedChain(onChain(a,{phase:8,seq:2,window:100,deadline:5000,blob:encodeHand(older)}));
 await runner(c,fake).tick();
 assert.deepEqual(fake.calls,[]);assert.equal(c.state.latest.seq,seq);
});
test('an on-chain move from the opponent is accepted only when it verifies',{timeout:60000},async()=>{
 const [stateA,stateB]=inPlay(),a=peer(0,stateA),b=peer(1,stateB);
 // Seat 0 owes a betting move here, so make it, then seat 1 replies on chain.
 const seat0=a.chainMove(a.state.latest.seq),seq=seat0.seq;
 assert.equal(a.state.mine.seq,seq);
 b.acceptChainMove(seq,seat0.step,seat0.signature);
 const reply=b.chainMove(seq);
 a.confirmChainMove(seq);
 const s=structuredClone(a.state.s);
 const moves=new Map([[reply.seq,{seq:reply.seq,step:reply.step,signature:Buffer.alloc(64,1)}]]);
 const forged=scriptedChain(onChain(a,{phase:9,seq:reply.seq,window:100,deadline:5000,blob:encodeHand(s)}));
 forged.moves=moves;
 const logged=[];
 await runner(a,forged,{log:t=>logged.push(t)}).tick();
 assert.equal(a.state.seq,seq,'a forged move changes nothing');
 assert.ok(logged.some(t=>/Bad signature/.test(t)));
 moves.set(reply.seq,{seq:reply.seq,step:reply.step,signature:reply.signature});
 await runner(a,forged).tick();
 assert.equal(a.state.seq,reply.seq,'the real one is accepted');
});
test('it proves a fork as soon as it holds two signatures from the opponent at one step',{timeout:60000},async()=>{
 const [stateA]=inPlay(),a=peer(0,stateA),seq=a.state.latest.seq;
 const other=sha256(Buffer.from('another state'));
 const sig=signMessage(sessions[1],signedMessage(a.binding,KIND_HAND,seq,other));
 a.receive({type:'ack',seq,kind:KIND_HAND,hash:toHex(other),sig:toHex(sig)});
 const chain=scriptedChain(onChain(a,{phase:OPEN}));
 await runner(a,chain,{stallMs:1e9,chainPollMs:1e9}).tick();
 assert.equal(chain.calls[0]?.type,'fork');assert.equal(chain.calls[0].evidence.seat,1);
});
test('a chain or relay failure never stops the agent',{timeout:60000},async()=>{
 const [stateA]=inPlay(),a=peer(0,stateA);
 const failing={send:async()=>{throw Error('relay down');},receive:async()=>{throw Error('relay down');}};
 const chain=scriptedChain(onChain(a,{phase:OPEN}));chain.read=async()=>{const e=Error('node down');e.rpcFailure=true;throw e;};
 const r=runner(a,chain,{transport:failing,resendMs:0});
 assert.equal(await r.tick(),null);
 await r.send([{type:'ack'}]);
});
test('it won’t deal until the opponent has joined, and refunds an expired invitation',async()=>{
 const a=new ChannelPeer(config(),sessions[0],0,{strategy:calling});
 const chain=scriptedChain({phase:WAITING,deadline:500,version:1},1000);
 let refunded=false;chain.timeout=async function(){refunded=true;this.state={phase:COMPLETE,payouts:[1_000_000,0],version:2};return 'sig';};
 const sent=[];
 const result=await runner(a,chain,{transport:{send:async m=>sent.push(m),receive:async()=>[]}}).waitForOpponent();
 assert.equal(refunded,true);assert.equal(result.complete,true);assert.deepEqual(sent,[]);
 assert.equal(a.state.setup,null,'no hand was started');
});
test('an agent sends nothing at all until the opponent has joined',{timeout:30000},async()=>{
 const a=new ChannelPeer(config(),sessions[0],0,{strategy:calling}),sent=[];
 const chain=scriptedChain({phase:WAITING,deadline:5000,version:1},1000);let reads=0;
 chain.read=async function(){return ++reads>1?{phase:COMPLETE,payouts:[1,2],version:2}:this.state;};
 const result=await runner(a,chain,{transport:{send:async m=>sent.push(m),receive:async()=>[]}}).run();
 assert.equal(result.complete,true);assert.deepEqual(sent,[]);assert.equal(a.state.setup,null);
});
test('the relay carries messages, refuses bad requests, and agents survive it lying about itself',async t=>{
 const relay=await startRelay();t.after(()=>relay.close());
 const match='11111111111111111111111111111113',a=new RelayTransport(relay.url,match,0),b=new RelayTransport(relay.url,match,1);
 await a.send({hello:1});await a.send({hello:2});
 assert.deepEqual(await b.receive(),[{hello:1},{hello:2}]);
 assert.deepEqual(await b.receive(),[],'nothing is delivered twice');
 assert.equal((await fetch(`${relay.url}/not-a-match/0`)).status,404);
 assert.equal((await fetch(`${relay.url}/${match}/0`,{method:'POST',body:'not json'})).status,400);
 assert.equal((await fetch(`${relay.url}/${match}/0`,{method:'PUT',body:'{}'})).status,405);
 assert.equal((await fetch(`${relay.url}/${match}/0`,{method:'POST',body:Buffer.alloc(1_300_000)})).status,413);
});
test('a channel account decodes, and its hand state matches what the players sign',{timeout:60000},()=>{
 const [stateA]=inPlay(),a=peer(0,stateA),s=a.state.s;
 const b=Buffer.alloc(CHANNEL_SPACE);b.write('ASTKCHN1');b[8]=s.phase;b[4251]=s.cursor;b.writeUInt32LE(s.hand,4252);
 const payload=encodeHand(s);
 payload.subarray(6,70).copy(b,137);
 [0,1,2,3,5,6,7,9,11].forEach((p,i)=>payload.subarray(70+i*64,134+i*64).copy(b,250+p*64));
 payload.subarray(646,735).copy(b,3586);payload.subarray(735,1311).copy(b,3675);
 assert.deepEqual(accountBlob(b),payload);
 b[8]=EXIT;
 assert.equal(accountBlob(b)[0],P_DONE,'a finished hand signs as done while the account is in its exit phase');
 assert.equal(decodeChannel(Buffer.from('ASTKEND5')).retired,true);
 assert.throws(()=>decodeChannel(Buffer.alloc(100)),/Not a channel account/);
});
test('the Ed25519 instruction keeps every offset inside itself',()=>{
 const entry=(n)=>({publicKey:Buffer.alloc(32,n),signature:Buffer.alloc(64,n+1),message:Buffer.alloc(32,n+2)});
 const data=Buffer.from(ed25519Instruction([entry(1),entry(5)]).data);
 assert.equal(data[0],2);assert.equal(data.length,2+28+2*128);
 for(const i of [0,1]){
  const at=2+i*14,field=n=>data.readUInt16LE(at+n);
  for(const index of [2,6,12])assert.equal(field(index),0xffff);
  assert.equal(field(10),32);
  assert.deepEqual(data.subarray(field(4),field(4)+32),Buffer.alloc(32,i?5:1));
  assert.deepEqual(data.subarray(field(0),field(0)+64),Buffer.alloc(64,i?6:2));
  assert.deepEqual(data.subarray(field(8),field(8)+32),Buffer.alloc(32,i?7:3));
 }
});
test('the terms hash changes with every term, and the match address with its nonce',async()=>{
 const base={program:'11111111111111111111111111111112',players:['11111111111111111111111111111113','11111111111111111111111111111114'],genesis:'11111111111111111111111111111115',buyIn:1000,turnSeconds:3600,bigBlind:20,maxHands:2,sessions:sessions.map(s=>toHex(s.publicKey))};
 const hash=channelTerms(base);
 for(const change of [{buyIn:1001},{turnSeconds:3601},{bigBlind:22},{maxHands:3},{genesis:'11111111111111111111111111111116'},{program:'11111111111111111111111111111116'},{players:[base.players[0],'11111111111111111111111111111116']},{sessions:[base.sessions[0],'ff'.repeat(32)]}])
  assert.notEqual(channelTerms({...base,...change}),hash,JSON.stringify(change));
 const [one]=await channelAddress(base.program,base.players[0],Buffer.alloc(32,1)),[two]=await channelAddress(base.program,base.players[0],Buffer.alloc(32,2));
 assert.notEqual(one.toBase58(),two.toBase58());
});
