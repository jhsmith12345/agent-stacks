// Drives one agent through a match: relay messages during play, and the chain when something goes wrong.
// Chain reads only ever decide when to act. What the agent signs or reveals comes from what it verified itself.
import {setTimeout as pause} from 'node:timers/promises';
import {sha256,signedMessage,decodeHand,KIND_CLOSE,KIND_HAND,KIND_STACKS,obligated,P_DONE} from './engine.js';
import {STAGE} from './peer.js';
import {fromHex} from './wire.js';
import {COMPLETE,EXIT,OPEN,WAITING} from './chain.js';
const quiet=error=>!!(error.rpcFailure||error.notSent||error.signature);
const MAX_QUEUED=64;
export class ChannelRunner{
 // `decider` is an outside program making this player's decisions, if there is one. `lastMomentMs` is how
 // close to the on-chain deadline it stops being asked, because the move itself takes time to land.
 constructor({peer,chains,transport,bufferKey,stallMs=60_000,resendMs=5_000,pollMs=250,chainPollMs=15_000,disputePollMs=5_000,decider=null,lastMomentMs=10_000,log=()=>{}}){
  if(peer.outside&&!decider)throw Error('This agent is set up to ask a program for its decisions, but has no program');
  Object.assign(this,{peer,chains,transport,bufferKey,stallMs,resendMs,pollMs,chainPollMs,disputePollMs,decider,lastMomentMs,log});
  this.asking=null;this.answers=[];this.told=0;
  this.progressAt=Date.now();this.resentAt=0;this.chainAt=0;this.seen=null;this.stats={onChainTransactions:0,relayMessages:0};
  this.bufferAttempts=new Map();this.buffers=new Map();this.inbox=[];this.outgoing=[];this.sending=null;this.receiving=null;
 }
 get chain(){return this.chains[0];}
 message(kind,seq,payloadHash){return signedMessage(this.peer.binding,kind,seq,payloadHash);}
 // Any one honest source is enough to see a dispute, so read them all and take the furthest along.
 async readChain(){
  const results=await Promise.allSettled(this.chains.map(c=>c.read()));
  const states=results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
  if(!states.length){const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;return null;}
  return states.reduce((best,s)=>(s.retired||(s.version??0)>(best.version??0))?s:best);
 }
 // Relay traffic never holds up the chain checks. A relay that silently drops packets makes each request
 // hang until it times out, and an agent waiting on that could miss a deadline on chain.
 // A lost message is never fatal: it stays in the outbox and goes again on the next resend.
 async send(messages){
  this.outgoing.push(...messages);
  if(this.outgoing.length>MAX_QUEUED)this.outgoing.splice(0,this.outgoing.length-MAX_QUEUED);
  if(!this.sending)this.sending=this.drain().finally(()=>{this.sending=null;});
 }
 async drain(){
  while(this.outgoing.length){
   const m=this.outgoing.shift();
   try{await this.transport.send(m);this.stats.relayMessages++;}
   catch(error){this.log(`relay send failed, will resend: ${error.message}`);}
  }
 }
 pumpRelay(){
  if(this.receiving)return;
  this.receiving=Promise.resolve().then(()=>this.transport.receive())
   .then(messages=>{this.inbox.push(...messages);},error=>{this.log(`relay: ${error.message}`);})
   .finally(()=>{this.receiving=null;});
 }
 async submit(label,work){
  this.log(`on-chain: ${label}`);
  const signature=await work();this.stats.onChainTransactions++;return signature;
 }
 async run(){
  // No point dealing a hand against a deposit that isn't there. An RPC could lie about this, but all
  // that buys is a hand that counts for nothing, since this agent's own deposit stays refundable.
  const early=await this.waitForOpponent();
  if(early)return early;
  await this.send(this.peer.start());
  this.progressAt=Date.now();
  for(;;){
   const done=await this.tick();
   if(done){await this.returnBuffers();return done;}
   await pause(this.pollMs);
  }
 }
 async waitForOpponent(){
  for(;;){
   try{
    const state=await this.readChain();
    if(state?.retired||state?.phase===COMPLETE)return {complete:true,payouts:state.payouts,stats:this.stats};
    if(state&&state.phase!==WAITING)return null;
    if(state&&await this.chain.chainTime()>=state.deadline){await this.submit('refund the expired invitation',()=>this.chain.timeout());continue;}
   }catch(error){if(!quiet(error))this.log(`waiting to start: ${error.message}`);}
   await pause(Math.max(this.pollMs,1000));
  }
 }
 async returnBuffers(){
  for(const key of this.buffers.values()){
   try{await this.chain.closeBuffer(key);}catch(error){this.log(`buffer rent stays until it's closed: ${error.message}`);}
  }
 }
 async tick(){
  const peer=this.peer,now=Date.now();
  this.pumpRelay();
  for(const m of this.inbox.splice(0))await this.send(peer.receive(m));
  if(this.decider)await this.decisions(now);
  const progress=peer.progress();
  if(progress!==this.seen){this.seen=progress;this.progressAt=now;}
  if(peer.state.evidence&&!this.reportedFork){await this.forkProof();}
  if(!peer.state.disputed&&peer.state.stage!==STAGE.CLOSED&&now-this.resentAt>this.resendMs&&!this.outgoing.length){this.resentAt=now;await this.send(peer.resend());}
  // Chain reads stay paced even in a dispute, which can mean waiting out a long window. Public RPCs
  // rate limit by address, and an agent hammering one only slows itself and anyone sharing its address.
  const busy=peer.state.disputed||peer.state.stage===STAGE.CLOSED;
  const stalled=now-this.progressAt>=this.stallMs&&peer.state.stage!==STAGE.CLOSED;
  const interval=busy||stalled?Math.min(this.chainPollMs,this.disputePollMs):this.chainPollMs;
  if(now-this.chainAt<interval)return null;
  this.chainAt=now;
  if(peer.state.stage===STAGE.CLOSED&&!peer.state.disputed)return this.settleClosed();
  let state;
  try{state=await this.readChain();}catch(error){if(!quiet(error))this.log(`chain read: ${error.message}`);return null;}
  if(!state){return null;}
  if(state.retired||state.phase===COMPLETE)return {complete:true,payouts:state.payouts,stats:this.stats};
  if(state.phase===WAITING)return null;
  if(state.phase===OPEN&&!peer.state.disputed){
   if(now-this.progressAt<this.stallMs)return null;
   this.log('The opponent has gone quiet, so this goes to the chain');
  }
  peer.markDisputed();
  try{await this.disputeStep(state);}
  catch(error){if(!quiet(error))this.log(`dispute: ${error.message}`);else this.log(`dispute retry: ${error.message}`);}
  return null;
 }
 // An outside program can take far longer than one pass of this loop, and everything else has to keep
 // running meanwhile, so it answers in the background.
 consult(limitMs=this.decider.limitMs){
  const question=this.peer.question();
  if(!question)return false;
  if(!this.asking)this.asking=Promise.resolve().then(()=>this.decider.ask(question,limitMs))
   .catch(error=>{this.log(`decision program: ${error.message}`);return null;})
   .then(reply=>{this.answers.push({key:question.key,reply});this.asking=null;});
  return true;
 }
 async decisions(now){
  const peer=this.peer;
  for(const {key,reply} of this.answers.splice(0)){
   peer.answer(key,reply);
   if(peer.state.disputed)this.chainAt=0;
   else await this.send(peer.resume());
   if(peer.overruled){this.log(`The decision program’s move isn’t allowed (${peer.overruled}), so the safe default applies`);peer.overruled=null;}
  }
  // This agent is the one holding things up, which says nothing about the opponent.
  if(!peer.state.disputed&&this.consult())this.progressAt=now;
  const results=peer.state.results??[];
  for(;this.told<results.length;this.told++)this.decider.tell?.(results[this.told]);
 }
 async settleClosed(){
  const peer=this.peer,proof=peer.closeProof();
  const state=await this.readChain().catch(()=>null);
  if(state?.retired||state?.phase===COMPLETE)return {complete:true,payouts:state.payouts??proof.stacks,stats:this.stats};
  const signed=this.message(KIND_CLOSE,proof.seq,sha256(fromHex(peer.state.latest.payload)));
  // Both agents try. The second attempt is refused harmlessly, because the match is already settled.
  try{await this.submit('close',()=>this.chain.close(signed,proof));}
  catch(error){if(!quiet(error))this.log(`close: ${error.message}`);}
  return null;
 }
 async forkProof(){
  const e=this.peer.state.evidence;this.reportedFork=true;
  const first=this.message(e.first.kind,e.seq,fromHex(e.first.hash,32)),second=this.message(e.second.kind,e.seq,fromHex(e.second.hash,32));
  try{await this.submit('prove the opponent signed two states at one step',()=>this.chain.proveFork(e,first,second));}
  catch(error){this.reportedFork=false;this.log(`fork proof: ${error.message}`);}
 }
 async post(latest){
  const hash=sha256(fromHex(latest.payload)),signed=this.message(latest.kind,latest.seq,hash);
  if(latest.kind===KIND_HAND){
   const attempt=this.bufferAttempts.get(latest.seq)??0;
   const key=await this.bufferKey(latest.seq,attempt);this.buffers.set(key.publicKey.toBase58(),key);
   try{return await this.submit(`post state ${latest.seq}`,()=>this.chain.postHand(signed,latest.seq,fromHex(latest.payload),latest.sigs,key));}
   catch(error){if(error.bufferBlocked)this.bufferAttempts.set(latest.seq,attempt+1);throw error;}
  }
  if(latest.kind===KIND_STACKS)return this.submit(`post stacks ${latest.seq}`,()=>this.chain.postStacks(signed,latest.seq,fromHex(latest.payload),latest.sigs));
  return this.submit(`close ${latest.seq}`,()=>this.chain.close(signed,this.peer.closeProof()??{seq:latest.seq,sigs:latest.sigs,stacks:[Number(fromHex(latest.payload).readBigUInt64LE(0)),Number(fromHex(latest.payload).readBigUInt64LE(8))]}));
 }
 async disputeStep(state){
  const peer=this.peer,latest=peer.postable(),mine=latest?.seq??0;
  const time=await this.chain.chainTime();
  if(state.phase===OPEN){
   if(latest)await this.post(latest);else await this.submit('exit with the original deposits',()=>this.chain.exitWithDeposits());
   return;
  }
  // While the window is open, a newer state must go up now, because later it can't.
  if(time<state.window){
   if(mine>state.seq)await this.post(latest);
   return;
  }
  if(state.phase===EXIT){await this.submit('settle',()=>this.chain.timeout());return;}
  if(time>=state.deadline){await this.submit('claim the timeout',()=>this.chain.timeout());return;}
  await this.playOnChain(state,time);
 }
 // The hand continues on chain. Every step is checked locally first, so the chain's word alone
 // can't make this agent reveal anything.
 async playOnChain(state,time){
  const peer=this.peer,st=peer.state;
  const local=st.mine?.seq===state.seq?state.seq:st.seq;
  if(local<state.seq){
   // Catch up on what the opponent did, verifying each step and its signature.
   const moves=await this.chain.onChainMoves(local);
   for(let seq=local+1;seq<=state.seq;seq++){
    // Our own signed move can reach the chain as the opponent's post, which isn't a move transaction.
    if(st.mine?.seq===seq){peer.confirmChainMove(seq);continue;}
    const move=moves.get(seq);
    if(!move){this.log(`Waiting to see the opponent’s move ${seq}`);return;}
    peer.acceptChainMove(seq,move.step,move.signature);
   }
  }else if(local>state.seq){
   // Our newest state was never posted and the window has closed. Fall back to what the chain holds,
   // which this agent must have signed, unless our own unconfirmed move is simply still landing.
   if(!(st.mine&&st.mine.seq===state.seq+1)||st.seq>state.seq)peer.adoptChainState(state.seq,state.blob);
  }else if(st.mine?.seq===state.seq){peer.confirmChainMove(state.seq);}
  if(st.s.phase===P_DONE||obligated(decodeHand(state.blob))!==peer.seat)return;
  const question=peer.question();
  if(question){
   // The chain's clock is running, so a decision gets at most half of what's left, and none at the very end.
   const left=(state.deadline-time)*1000;
   if(left>this.lastMomentMs){this.consult(Math.min(this.decider.limitMs,left/2));return;}
   this.log('Too close to the deadline to wait for a decision, so the safe default applies');
   peer.answer(question.key,null);
  }
  const move=peer.chainMove(state.seq);
  await this.submit(`on-chain move ${move.seq}`,()=>this.chain.move(peer.seat,state.seq,move.step,move.message,move.signature));
 }
}
