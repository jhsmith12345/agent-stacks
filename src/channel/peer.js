// One player's side of a channel match, with no I/O of its own: messages in, messages out, and durable state.
// It decides what it owes only from messages it has verified, never from a relay or an RPC, which is what
// removes the card-leak attack in docs/security-audit-2026-11-04.md. See docs/channel-design.md for the rules.
import {keyContext,shuffleContext,shareContext} from '../solana/client.js';
import {makeKey,verifyKey,aggregateKeys} from '../mental-poker/proofs.js';
import {initialDeck,decryptionShare} from '../mental-poker/deck.js';
import {shuffleAndProve,encodeShuffle,decodeShuffle,verifyShuffle} from '../mental-poker/shuffle.js';
import {mul,point,scalar} from '../mental-poker/group.js';
import {signMessage,verifySignature} from './keys.js';
import {fromHex,toHex,encodeDLEQ} from './wire.js';
import {acceptedHand,applyAction,applyMuck,applyShare,closePayload,decodeHand,encodeHand,evaluate,firstShower,greater,legalMoves,mayMuck,KIND_CLOSE,KIND_HAND,KIND_STACKS,obligated,owedPositions,P_BETTING,P_DONE,sha256,signedMessage,stacksPayload} from './engine.js';
export const STAGE={KEYS:'keys',SHUFFLE:'shuffle',PLAY:'play',AGREE:'agree',CLOSED:'closed'};
const MAX_WIRE=1_000_000,MAX_HELD=16;
const CARD_POINTS=new Map(initialDeck().map((c,i)=>[c.b,i]));
const clone=value=>structuredClone(value);

export class ChannelPeer{
 // config: {program,match,terms,programBytes,matchBytes,termsBytes,sessions:[hex,hex],buyIn,bigBlind,maxHands}
 // `reveal` decides, when this player is second to show, whether to show (true) or muck (false). By
 // default it shows a hand that wins or ties, and mucks one that loses, since showing that gains nothing.
 // With `outside`, a separate program makes both of those decisions. Nothing here waits for it: `question`
 // says what's needed, `answer` hands in the reply, and `resume` carries on.
 constructor(config,session,seat,{strategy,store=null,state=null,reveal=null,outside=false}){
  this.config=config;this.session=session;this.seat=seat;this.strategy=strategy;this.store=store;this.held=[];this.reveal=reveal;this.outside=outside;
  this.keys=config.sessions.map(k=>fromHex(k,32));
  if(!this.keys[seat].equals(session.publicKey))throw Error('This session key is not in the match');
  this.binding={program:config.programBytes,match:config.matchBytes,terms:config.termsBytes};
  this.st=state??{seat,seq:0,hand:1,stacks:[config.buyIn,config.buyIn],stage:STAGE.KEYS,latest:null,mine:null,signed:{},theirs:{},setup:null,s:null,outbox:[],evidence:null,disputed:false,rejected:0};
 }
 get opponent(){return 1-this.seat;}
 get state(){return this.st;}
 persist(){this.noteResult();if(this.store)this.store.save(this.st);}
 // Records before anything is sent. A player signs at most one state per step, or forfeits the match.
 sign(kind,seq,payloadHash){
  const hash=toHex(payloadHash),previous=this.st.signed[seq];
  if(previous&&(previous.kind!==kind||previous.hash!==hash))throw Error(`Refusing to sign a second state at step ${seq}`);
  this.st.signed[seq]={kind,hash};
  return signMessage(this.session,signedMessage(this.binding,kind,seq,payloadHash));
 }
 verify(seat,kind,seq,payloadHash,signature){return verifySignature(this.keys[seat],signedMessage(this.binding,kind,seq,payloadHash),signature);}
 setupDigest(type,hand,body){return sha256(Buffer.from('agent-stacks/channel/setup/v1'),this.binding.program,this.binding.match,this.binding.terms,Buffer.from(type),Buffer.from(String(hand)),body);}
 signSetup(type,hand,body){return toHex(signMessage(this.session,this.setupDigest(type,hand,body)));}
 verifySetup(seat,type,hand,body,signature){return verifySignature(this.keys[seat],this.setupDigest(type,hand,body),fromHex(signature,64));}
 // The last thing sent stays ready to resend, because a repeat is always harmless.
 send(messages){if(messages.length)this.st.outbox=messages;this.persist();return messages;}
 // Everything needed to carry on after a restart or a lost message.
 resend(){return this.st.disputed?[]:this.st.outbox;}
 start(){
  if(this.st.outbox.length)return this.resend();
  return this.send(this.setupStep());
 }
 setupStep(){
  const st=this.st;
  if(st.stage!==STAGE.KEYS||st.setup)return [];
  st.setup={keys:[null,null],secret:null,deck:initialDeck()};
  return this.seat===0?[this.keyMessage()]:[];
 }
 keyMessage(){
  const st=this.st,context=keyContext(this.config.program,this.config.match,this.seat,this.config.terms,st.hand);
  if(!st.setup.secret){const key=makeKey(context);st.setup.secret=key.secret;st.setup.keys[this.seat]=key.registration;}
  const registration=st.setup.keys[this.seat];
  return {type:'key',hand:st.hand,registration,sig:this.signSetup('key',st.hand,Buffer.from(JSON.stringify(registration)))};
 }
 shuffleMessage(extra={}){
  const st=this.st,context=shuffleContext(this.config.program,this.config.match,this.seat,this.config.terms,st.hand);
  const joint=aggregateKeys(st.setup.keys,[0,1].map(s=>keyContext(this.config.program,this.config.match,s,this.config.terms,st.hand)));
  const input=clone(st.setup.deck),proof=shuffleAndProve(input,joint,context),wire=encodeShuffle(input,proof);
  st.setup.deck=proof.output;
  return {wire,message:{type:'shuffle',hand:st.hand,wire:wire.toString('base64'),sig:this.signSetup('shuffle',st.hand,sha256(wire)),...extra}};
 }
 acceptance(){
  const st=this.st;
  return acceptedHand({hand:st.hand,keys:st.setup.keys.map(k=>k.publicKey),deck:st.setup.deck,stacks:st.stacks,bigBlind:this.config.bigBlind});
 }
 // A message that fails any check changes nothing. Anyone on the path can send rubbish.
 receive(message){
  try{
   const out=this.dispatch(message);
   // Held messages may now be next in line. Relays are free to reorder.
   const replies=[...out];
   for(let again=true;again;){
    again=false;
    for(const [i,held] of this.held.entries()){
     if(!this.isFuture(held)){this.held.splice(i,1);replies.push(...this.dispatch(held));again=true;break;}
    }
   }
   return replies;
  }catch(error){
   if(error.fatal)throw error;
   this.st.rejected++;this.lastRejection=error.message;
   // A count by reason, because a resend that arrives late is normal and anything else is worth a look.
   const why=this.st.rejectedWhy??={};
   if(why[error.message]!==undefined||Object.keys(why).length<32)why[error.message]=(why[error.message]??0)+1;
   return [];
  }
 }
 isFuture(m){
  if(!m||typeof m!=='object')return false;
  if(Number.isInteger(m.hand)&&m.hand>this.st.hand)return true;
  if(m.type==='shuffle')return m.hand===this.st.hand&&this.st.stage===STAGE.KEYS;
  if(['move','ack'].includes(m.type)&&Number.isSafeInteger(m.seq)){
   const expected=this.expectedSeq();
   return m.seq>expected||(m.type==='move'&&m.seq===expected&&this.st.stage!==STAGE.PLAY);
  }
  return false;
 }
 expectedSeq(){return (this.st.latest?.seq??0)+1;}
 dispatch(m){
  if(!m||typeof m!=='object'||Array.isArray(m))throw Error('Not a message');
  if(this.st.disputed&&m.type!=='ack'&&m.type!=='move')return [];
  // Oldest out first, so junk from a relay can't crowd out a real message that gets resent later.
  if(this.isFuture(m)){if(this.held.length>=MAX_HELD)this.held.shift();this.held.push(m);return [];}
  if(m.type==='key')return this.onKey(m);
  if(m.type==='shuffle')return this.onShuffle(m);
  if(m.type==='move')return this.onMove(m);
  if(m.type==='ack')return this.onAck(m);
  throw Error('Unknown message type');
 }
 onKey(m){
  const st=this.st,other=this.opponent;
  if(st.stage!==STAGE.KEYS||m.hand!==st.hand)throw Error('Key is not due');
  if(!st.setup)this.setupStep();
  if(st.setup.keys[other])throw Error('Key already recorded');
  if(!this.verifySetup(other,'key',st.hand,Buffer.from(JSON.stringify(m.registration)),m.sig))throw Error('Bad key signature');
  if(!verifyKey(m.registration,keyContext(this.config.program,this.config.match,other,this.config.terms,st.hand)))throw Error('Bad key proof');
  st.setup.keys[other]=m.registration;
  if(this.seat===1){const reply=this.keyMessage();st.stage=STAGE.SHUFFLE;return this.send([reply]);}
  st.stage=STAGE.SHUFFLE;
  return this.send([this.shuffleMessage().message]);
 }
 onShuffle(m){
  const st=this.st,other=this.opponent;
  if(st.stage!==STAGE.SHUFFLE||m.hand!==st.hand)throw Error('Shuffle is not due');
  if(typeof m.wire!=='string'||m.wire.length>MAX_WIRE)throw Error('Invalid shuffle transport');
  const wire=Buffer.from(m.wire,'base64');
  if(!this.verifySetup(other,'shuffle',st.hand,sha256(wire),m.sig))throw Error('Bad shuffle signature');
  const {proof}=decodeShuffle(wire);
  const joint=aggregateKeys(st.setup.keys,[0,1].map(s=>keyContext(this.config.program,this.config.match,s,this.config.terms,st.hand)));
  const context=shuffleContext(this.config.program,this.config.match,other,this.config.terms,st.hand);
  // Checked against our own view of the deck, so a player can't shuffle a deck of its choosing.
  if(!verifyShuffle(st.setup.deck,joint,context,proof))throw Error('Invalid shuffle proof');
  st.setup.deck=proof.output;
  const seq=this.expectedSeq();
  if(this.seat===1){
   // Second to shuffle: finish the deck and offer it as this hand's first state.
   const {message}=this.shuffleMessage();
   const s=this.acceptance(),payload=encodeHand(s);
   const sig=this.sign(KIND_HAND,seq,sha256(payload));
   message.accept={seq,hash:toHex(sha256(payload)),sig:toHex(sig)};
   st.s=s;st.mine={kind:KIND_HAND,seq,sig:toHex(sig)};st.stage=STAGE.PLAY;
   return this.send([message]);
  }
  // First to shuffle: this message closes the deck, so accept it and co-sign.
  const s=this.acceptance(),payload=encodeHand(s),hash=sha256(payload);
  if(!m.accept||m.accept.seq!==seq||m.accept.hash!==toHex(hash))throw Error('Offered first state does not match this deck');
  const theirs=fromHex(m.accept.sig,64);
  if(!this.verify(other,KIND_HAND,seq,hash,theirs))throw Error('Bad signature on the first state');
  const mine=this.sign(KIND_HAND,seq,hash);
  st.s=s;st.stage=STAGE.PLAY;
  this.recordBoth(KIND_HAND,seq,payload,mine,theirs);
  return this.send([{type:'ack',seq,kind:KIND_HAND,hash:toHex(hash),sig:toHex(mine)},...this.next()]);
 }
 recordBoth(kind,seq,payload,mine,theirs){
  const sigs=[null,null];sigs[this.seat]=toHex(mine);sigs[this.opponent]=toHex(theirs);
  this.st.latest={kind,seq,payload:toHex(payload),sigs};
  if(kind===KIND_STACKS)this.st.lastStacks=clone(this.st.latest);
  this.st.seq=seq;this.st.mine=null;this.st.theirs[seq]={kind,hash:toHex(sha256(payload)),sig:toHex(theirs)};
 }
 // Two different opponent signatures at one step prove a fork, and the contract forfeits their stake for it.
 noteOpponentSignature(seq,kind,hash,sig){
  const known=this.st.theirs[seq];
  if(known&&(known.kind!==kind||known.hash!==hash)&&!this.st.evidence){
   this.st.evidence={seat:this.opponent,seq,first:known,second:{kind,hash,sig}};
   this.persist();
  }else if(!known)this.st.theirs[seq]={kind,hash,sig};
 }
 hashOf(m){return fromHex(m.hash,32);}
 // The opponent lost our signature. Sending it again costs nothing and changes nothing. The reply is marked,
 // and a marked reply gets no answer, or two agents would bounce acknowledgements between them forever.
 reAck(m){
  const l=this.st.latest;
  if(m.echo||!l||l.seq!==m.seq||l.kind!==m.kind||toHex(sha256(fromHex(l.payload)))!==m.hash)return [];
  return [{type:'ack',seq:l.seq,kind:l.kind,hash:m.hash,sig:l.sigs[this.seat],echo:true}];
 }
 onMove(m){
  const st=this.st,other=this.opponent;
  if(!Number.isSafeInteger(m.seq)||m.seq<1)throw Error('Invalid step');
  const hash=this.hashOf(m),sig=fromHex(m.sig,64);
  if(!this.verify(other,KIND_HAND,m.seq,hash,sig))throw Error('Bad move signature');
  this.noteOpponentSignature(m.seq,KIND_HAND,m.hash,m.sig);
  if(m.seq<this.expectedSeq())return this.reAck({...m,kind:KIND_HAND});
  if(st.disputed)return [];
  if(st.stage!==STAGE.PLAY||st.mine||st.latest?.seq!==m.seq-1||st.latest.kind!==KIND_HAND)throw Error('Move is not due');
  const s=clone(st.s);this.applyStep(s,other,m.step);
  const payload=encodeHand(s);
  if(!sha256(payload).equals(hash))throw Error('Signed state does not match this move');
  const mine=this.sign(KIND_HAND,m.seq,hash);
  this.remember(other,m.seq,m.step);
  st.s=s;this.recordBoth(KIND_HAND,m.seq,payload,mine,sig);
  const ack={type:'ack',seq:m.seq,kind:KIND_HAND,hash:m.hash,sig:toHex(mine)};
  return this.send([ack,...this.next()]);
 }
 applyStep(s,seat,step){
  if(!step||typeof step!=='object')throw Error('Invalid step');
  if(step.muck===true)applyMuck(s,seat);
  else if(step.logical!==undefined){
   const context=shareContext(this.config.program,this.config.match,s.phase,seat,step.logical,this.config.terms,s.hand);
   applyShare(s,context,seat,step.logical,fromHex(step.wire));
  }else applyAction(s,seat,step.action,step.amount??0);
 }
 onAck(m){
  const st=this.st,other=this.opponent;
  if(!Number.isSafeInteger(m.seq)||![KIND_HAND,KIND_STACKS,KIND_CLOSE].includes(m.kind))throw Error('Invalid acknowledgement');
  const hash=this.hashOf(m),sig=fromHex(m.sig,64);
  if(!this.verify(other,m.kind,m.seq,hash,sig))throw Error('Bad acknowledgement signature');
  this.noteOpponentSignature(m.seq,m.kind,m.hash,m.sig);
  if(m.seq<this.expectedSeq())return this.reAck(m);
  if(st.disputed)return [];
  if(!st.mine||st.mine.seq!==m.seq||st.mine.kind!==m.kind)throw Error('Acknowledgement is not due');
  const mine=fromHex(st.mine.sig,64);
  if(m.kind===KIND_HAND){
   const payload=encodeHand(st.s);
   if(!sha256(payload).equals(hash))throw Error('Acknowledged state differs from ours');
   this.recordBoth(KIND_HAND,m.seq,payload,mine,sig);
   return this.send(this.next());
  }
  if(st.pendingAgreement?.hash!==m.hash)throw Error('Acknowledged stacks differ from ours');
  this.recordBoth(m.kind,m.seq,fromHex(st.pendingAgreement.payload),mine,sig);
  return this.send(this.afterAgreement(m.kind));
 }
 next(){
  const st=this.st;
  if(st.disputed||st.mine||st.stage!==STAGE.PLAY||st.latest?.kind!==KIND_HAND)return [];
  if(st.s.phase===P_DONE)return this.startAgreement();
  if(obligated(st.s)!==this.seat||this.question())return [];
  return this.moveMessage();
 }
 // What a separate program has to decide next, or null. Signing a step sets st.mine, so a decision that has
 // been acted on is never asked again, and a crash before that only means asking again.
 question(){
  const st=this.st,s=st.s;
  if(!this.outside||!s||st.mine||st.decided?.[st.seq+1]||obligated(s)!==this.seat)return null;
  const key=`${st.hand}/${st.seq}`;
  if(this.answered?.key===key)return null;
  if(s.phase===P_BETTING)return {key,type:'bet',view:this.betView(s)};
  if(mayMuck(s))return {key,type:'show',view:this.showView(s)};
  return null;
 }
 // Null means no usable reply, so the safe default applies. A reply to an earlier question is simply ignored.
 answer(key,reply){this.answered={key,reply};}
 reply(){return this.answered?.key===`${this.st.hand}/${this.st.seq}`?this.answered.reply:null;}
 resume(){
  const st=this.st,out=this.next();
  // Any acknowledgement stays ready to resend, in case it was the message that got lost.
  if(out.length){st.outbox=[...st.outbox.filter(m=>m.type==='ack'),...out];this.persist();}
  return out;
 }
 // Both players work out the same next state, so there is nothing to negotiate.
 startAgreement(){
  const st=this.st,stacks=st.s.game.stacks,seq=this.expectedSeq();
  const finished=st.hand>=this.config.maxHands||stacks.includes(0);
  const kind=finished?KIND_CLOSE:KIND_STACKS,payload=finished?closePayload(stacks):stacksPayload(st.hand+1,stacks),hash=sha256(payload);
  this.noteResult();
  const sig=this.sign(kind,seq,hash);
  st.stage=STAGE.AGREE;st.pendingAgreement={payload:toHex(payload),hash:toHex(hash),stacks};
  st.mine={kind,seq,sig:toHex(sig)};
  return [{type:'ack',seq,kind,hash:toHex(hash),sig:toHex(sig)}];
 }
 afterAgreement(kind){
  const st=this.st,stacks=st.pendingAgreement.stacks;st.pendingAgreement=null;
  if(kind===KIND_CLOSE){st.stage=STAGE.CLOSED;st.final=stacks;return [];}
  st.hand++;st.stacks=[...stacks];st.stage=STAGE.KEYS;st.s=null;st.setup=null;st.betting=[];st.decided={};
  return this.setupStep();
 }
 // What this player owes, decided once and recorded, so a crash or a dispute can't produce a different answer.
 moveMessage(){
  const st=this.st,seq=st.seq+1,step=this.chooseStep();
  const s=clone(st.s);this.applyStep(s,this.seat,step);
  const payload=encodeHand(s),hash=sha256(payload),sig=this.sign(KIND_HAND,seq,hash);
  this.remember(this.seat,seq,step);(st.decided??={})[seq]=step;
  st.s=s;st.mine={kind:KIND_HAND,seq,sig:toHex(sig),step};
  return [{type:'move',seq,step,hash:toHex(hash),sig:toHex(sig)}];
 }
 chooseStep(){
  const st=this.st,s=st.s;
  // The release rule: only a state the opponent has signed can oblige this agent to do anything.
  if(st.latest?.seq!==st.seq||st.latest.kind!==KIND_HAND||!st.latest.sigs[this.opponent])throw Error('The current state is not signed by the opponent');
  if(!encodeHand(s).equals(fromHex(st.latest.payload)))throw Error('Local state differs from the signed state');
  if(obligated(s)!==this.seat)throw Error('This agent owes nothing now');
  return this.nextStep(s);
 }
 nextStep(s){
  // Back at a step already signed, after falling back to an older state: it has to be the same step again,
  // because signing anything else would forfeit the match, and a program may well answer differently.
  const before=this.st.decided?.[this.st.seq+1];
  if(before)return clone(before);
  if(s.phase===P_BETTING)return this.chooseAction(s);
  if(mayMuck(s)&&!this.choosesToShow(s))return {muck:true};
  return this.shareStep(s);
 }
 showView(s){
  const cards=this.myCards(s),opponentCards=s.game.holes[this.opponent],board=s.game.board;
  const mine=evaluate([...cards,...board]),theirs=evaluate([...opponentCards,...board]);
  return {hand:s.hand,hands:this.config.maxHands,seat:this.seat,cards,opponentCards,board:[...board],winning:greater(mine,theirs),tied:!greater(mine,theirs)&&!greater(theirs,mine),pot:s.game.contributed[0]+s.game.contributed[1]};
 }
 choosesToShow(s){
  const view=this.showView(s);
  // A bad answer can only mean showing or mucking, and both are this player's to choose.
  if(this.outside){const reply=this.reply();return typeof reply==='boolean'?reply:view.winning||view.tied;}
  return this.reveal?!!this.reveal(view):view.winning||view.tied;
 }
 shareStep(s){
  const logical=owedPositions(s)[s.cursor],c=s.cards[logical];
  const context=shareContext(this.config.program,this.config.match,s.phase,this.seat,logical,this.config.terms,s.hand);
  const proof=decryptionShare(this.st.setup.secret,c,context);
  return {logical,wire:toHex(encodeDLEQ(context,proof.publicKey,c.a,proof.share,proof.proof))};
 }
 betView(s){
  const g=s.game,seat=this.seat;
  return {hand:s.hand,hands:this.config.maxHands,seat,cards:this.myCards(s),board:g.board.filter(c=>c<52),stacks:[...g.stacks],bets:[...g.bets],pot:g.contributed[0]+g.contributed[1],currentBet:g.currentBet,minRaise:g.minRaise,bigBlind:g.bigBlind,button:g.button,owed:Math.max(0,g.currentBet-g.bets[seat]),street:g.street,legal:legalMoves(g,seat),history:clone(this.st.betting??[])};
 }
 chooseAction(s){
  const view=this.betView(s),choice=this.outside?this.reply():this.strategy?.(view);
  // A strategy proposes a poker move and nothing else, and a bad one falls back to the safe default.
  if(choice&&Number.isInteger(choice.action)){
   try{applyAction(clone(s),this.seat,choice.action,choice.amount??0);return {action:choice.action,amount:choice.amount??0};}
   catch(error){if(!error.invalidMove)throw error;this.overruled=error.message;}
  }
  return {action:view.owed>0?0:1,amount:0};
 }
 // The betting so far this hand, for whoever is deciding. Nothing signed or checked depends on it.
 remember(seat,seq,step){
  if(step.action===undefined)return;
  const g=this.st.s.game,entry={seq,street:g.street,seat,action:step.action};
  if(step.action===3)entry.to=step.amount;
  // Going all-in for no more than the current bet is a call, so it has nothing to raise to.
  if(step.action===4&&g.bets[seat]+g.stacks[seat]>g.currentBet)entry.to=g.bets[seat]+g.stacks[seat];
  (this.st.betting??=[]).push(entry);
 }
 // How each finished hand went. It's only a record, so a failure here must never get in the way of play.
 noteResult(){
  const st=this.st,s=st.s;
  if(s?.phase!==P_DONE||(st.results??=[]).some(r=>r.hand===st.hand))return;
  const g=s.game;let cards=null;
  try{cards=this.myCards(s);}catch{}
  st.results.push({hand:st.hand,winner:g.winner,reason:g.reason,stacks:[...g.stacks],seat:this.seat,cards,opponentCards:g.holes[this.opponent].filter(c=>c<52),board:g.board.filter(c=>c<52),aggressor:s.aggressor,firstToShow:firstShower(s),betting:clone(st.betting??[])});
 }
 myCards(s){
  const logicals=this.seat===0?[0,2]:[1,3],secret=scalar(this.st.setup.secret,true);
  return logicals.map(i=>{
   const c=s.cards[i],own=mul(point(c.a,true),secret),other=s.shares[i][this.opponent];
   const index=CARD_POINTS.get(point(c.b).subtract(own).subtract(point(other,true)).toHex());
   if(index===undefined)throw Error('Own card did not decrypt');
   return index;
  });
 }
 // For a dispute: the newest state this player can post, with both signatures.
 postable(){return this.st.latest?clone(this.st.latest):null;}
 // The last point both players agreed the stacks, from before the hand in progress. See the runner for its use.
 fallback(){return this.st.lastStacks?clone(this.st.lastStacks):null;}
 // Changes only when the match really moves on, so junk from a relay can't look like progress.
 progress(){const st=this.st;return `${st.hand}/${st.stage}/${st.latest?.seq??0}/${st.mine?.seq??0}/${st.setup?.keys?.filter(Boolean).length??0}/${toHex(sha256(Buffer.from(JSON.stringify(st.setup?.deck?.[0]??null)))).slice(0,8)}`;}
 markDisputed(){if(!this.st.disputed){this.st.disputed=true;this.persist();}}
 // In a dispute the contract holds the state. It's only ever accepted here if this player signed it,
 // so a lying RPC can't make an agent adopt a state it never agreed to.
 adoptChainState(seq,payload){
  const st=this.st,hash=toHex(sha256(payload)),signed=st.signed[seq];
  if(!signed||signed.kind!==KIND_HAND||signed.hash!==hash)throw Error('The chain shows a state this agent never signed');
  st.s=decodeHand(payload);st.seq=seq;st.mine=null;
  // Rolled back, so anything after this step never happened.
  if(st.betting)st.betting=st.betting.filter(e=>e.seq<=seq);
  this.persist();
 }
 // The next on-chain move, using the same step already signed off-chain if there was one. Signing
 // anything else at this step would forfeit the match.
 chainMove(chainSeq){
  const st=this.st,seq=chainSeq+1;
  if(st.mine){
   if(st.mine.seq!==seq||st.mine.kind!==KIND_HAND||!st.mine.step)throw Error('Local state is not at the chain’s step');
  }else{
   if(st.seq!==chainSeq)throw Error('Local state is not at the chain’s step');
   if(obligated(st.s)!==this.seat)throw Error('This agent owes nothing now');
   if(this.question())throw Error('A decision is still due at this step');
   const s=clone(st.s),step=this.nextStep(s);
   this.applyStep(s,this.seat,step);
   const sig=this.sign(KIND_HAND,seq,sha256(encodeHand(s)));
   this.remember(this.seat,seq,step);(st.decided??={})[seq]=step;
   st.s=s;st.mine={kind:KIND_HAND,seq,sig:toHex(sig),step};
   this.persist();
  }
  return {seq,step:st.mine.step,message:signedMessage(this.binding,KIND_HAND,seq,sha256(encodeHand(st.s))),signature:fromHex(st.mine.sig,64)};
 }
 // The opponent's on-chain move is only believed once it verifies here: their signature on the exact
 // state our own engine computes. Whoever relayed it, they are bound by it.
 acceptChainMove(seq,step,signature){
  const st=this.st,other=this.opponent;
  const s=clone(st.s);this.applyStep(s,other,step);
  const payload=encodeHand(s),hash=sha256(payload);
  if(!this.verify(other,KIND_HAND,seq,hash,signature))throw Error('Bad signature on an on-chain move');
  this.noteOpponentSignature(seq,KIND_HAND,toHex(hash),toHex(signature));
  const mine=this.sign(KIND_HAND,seq,hash);
  this.remember(other,seq,step);
  st.s=s;this.recordBoth(KIND_HAND,seq,payload,mine,signature);
  this.persist();
 }
 // Our own on-chain move landed, which makes it the state to continue from.
 confirmChainMove(seq){
  const st=this.st;
  if(st.mine?.seq===seq&&st.mine.kind===KIND_HAND){st.seq=seq;st.mine=null;this.persist();}
 }
 closeProof(){const l=this.st.latest;return this.st.stage===STAGE.CLOSED&&l?.kind===KIND_CLOSE?{seq:l.seq,stacks:this.st.final,sigs:l.sigs}:null;}
}
