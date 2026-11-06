// Reproducible TEST material for programs/escrow/tests/channel.rs: a whole hand played by the JavaScript engine
// with real keys, shuffles and proofs. The contract must accept every step and reach identical bytes.
// Usage: node scripts/channel-vectors.js PROGRAM CREATOR OPPONENT GENESIS NONCE_HEX BUY_IN BIG_BLIND SECONDS
import {PublicKey} from '@solana/web3.js';
import {keyContext,shuffleContext,shareContext} from '../src/solana/client.js';
import {makeKey} from '../src/mental-poker/proofs.js';
import {initialDeck,decryptionShare} from '../src/mental-poker/deck.js';
import {shuffleAndProve} from '../src/mental-poker/shuffle.js';
import {point} from '../src/mental-poker/group.js';
import {encodeDLEQ,G} from '../src/channel/wire.js';
import {sessionFromSeed,signMessage} from '../src/channel/keys.js';
import {channelAddress,channelTerms} from '../src/channel/chain.js';
import {acceptedHand,applyAction,applyMuck,applyShare,encodeHand,firstShower,mayMuck,muck,obligated,owedPositions,signedMessage,sha256,stacksPayload,closePayload,KIND_HAND,KIND_STACKS,KIND_CLOSE,P_BETTING,P_DONE,P_SHOW_A,P_SHOW_B} from '../src/channel/engine.js';
const [program,creator,opponent,genesis,nonce,buyIn,bigBlind,seconds]=process.argv.slice(2);
const stake=Number(buyIn),blind=Number(bigBlind);
const [address]=await channelAddress(program,creator,Buffer.from(nonce,'hex')),match=address.toBase58();
const sessions=[sessionFromSeed(Buffer.alloc(32,11)),sessionFromSeed(Buffer.alloc(32,22))];
const stranger=sessionFromSeed(Buffer.alloc(32,33));
const hex=b=>Buffer.from(b).toString('hex');
const terms=channelTerms({program,players:[creator,opponent],genesis,buyIn:stake,turnSeconds:Number(seconds),bigBlind:blind,maxHands:1,sessions:sessions.map(s=>hex(s.publicKey))});
const binding={program:Buffer.from(new PublicKey(program).toBytes()),match:Buffer.from(new PublicKey(match).toBytes()),terms:Buffer.from(terms,'hex')};
const message=(kind,seq,payload)=>signedMessage(binding,kind,seq,sha256(payload));
const both=m=>sessions.map(s=>hex(signMessage(s,m)));
const keys=[0,1].map(seat=>makeKey(keyContext(program,match,seat,terms,1)));
const joint=point(keys[0].registration.publicKey,true).add(point(keys[1].registration.publicKey,true)).toHex();
const first=shuffleAndProve(initialDeck(),joint,shuffleContext(program,match,0,terms,1));
const second=shuffleAndProve(first.output,joint,shuffleContext(program,match,1,terms,1));
const deck=second.output;
const hand=(stacks=[stake,stake])=>acceptedHand({hand:1,keys:keys.map(k=>k.registration.publicKey),deck,stacks,bigBlind:blind});
const raiseOnTheFlop=s=>{
 const seat=obligated(s),owed=s.game.currentBet-s.game.bets[seat];
 if(s.game.street===1&&s.game.acted===0&&s.game.stacks[seat]>3*blind)return [3,s.game.currentBet+2*blind];
 return [owed>0?2:1,0];
};
const callOrCheck=s=>[s.game.currentBet>s.game.bets[obligated(s)]?2:1,0];
// Seat 0 bets on the river after seat 1 checks, and seat 1 calls: seat 0 got called.
const betTheRiver=s=>{
 const seat=obligated(s);
 if(s.game.street===3&&seat===0&&s.game.currentBet===0)return [3,3*blind];
 return callOrCheck(s);
};
const shoveAndCall=s=>obligated(s)===0&&s.game.street===0?[4,0]:callOrCheck(s);
function step(s,plan){
 const seat=obligated(s);
 if(s.phase===P_BETTING){
  const [action,amount]=plan(s);
  applyAction(s,seat,action,amount);
  const args=Buffer.alloc(9);args[0]=action;args.writeBigUInt64LE(BigInt(amount),1);
  return {tag:39,seat,args:hex(args)};
 }
 const logical=owedPositions(s)[s.cursor],c=s.cards[logical];
 const context=shareContext(program,match,s.phase,seat,logical,terms,s.hand);
 const proof=decryptionShare(keys[seat].secret,c,context);
 const wire=encodeDLEQ(context,proof.publicKey,c.a,proof.share,proof.proof);
 applyShare(s,context,seat,logical,wire);
 return {tag:40,seat,args:hex(Buffer.concat([Buffer.from([logical]),wire]))};
}
function record(s,move,seq){
 const blob=encodeHand(s),m=message(KIND_HAND,seq,blob);
 return {...move,seq,blob:hex(blob),message:hex(m),signature:hex(signMessage(sessions[move.seat],m)),signatures:both(m)};
}
// A move the rules forbid, correctly signed, so that only the rule itself can stop it on chain.
function illegalMuck(s,seat,seq){
 const c=structuredClone(s);muck(c.game,seat);c.phase=P_DONE;c.cursor=0;
 return record(c,{tag:45,seat,args:''},seq);
}
function playOut(s,startSeq,plan=raiseOnTheFlop,{mucks=false}={}){
 const steps=[],illegal={};let seq=startSeq,first=null;
 while(s.phase!==P_DONE){
  if(s.game.stage===2){
   first??=firstShower(s);
   if(s.phase===(first===0?P_SHOW_A:P_SHOW_B)&&s.cursor===0)illegal.firstMuck??={...illegalMuck(s,first,seq+1),index:steps.length};
   if(s.phase===(first===0?P_SHOW_B:P_SHOW_A)&&s.cursor===1)illegal.partialMuck??={...illegalMuck(s,1-first,seq+1),index:steps.length};
   if(mucks&&mayMuck(s)){
    const seat=obligated(s);applyMuck(s,seat);seq++;
    steps.push(record(s,{tag:45,seat,args:''},seq));
    break;
   }
  }
  const move=step(s,plan);seq++;
  steps.push(record(s,move,seq));
 }
 return {steps,final:s.game.stacks,lastSeq:seq,first,illegal,holes:s.game.holes,reason:s.game.reason};
}
const accepted=hand(),acceptBlob=encodeHand(accepted),acceptMessage=message(KIND_HAND,1,acceptBlob);
const {steps,final,lastSeq,first:mainFirst}=playOut(structuredClone(accepted),1);
// A hand where a player can't pay the blind in full, starting from its own first state. Seat 0 has the button,
// so it pays the small blind and seat 1 the big one. Most of these have no betting at all.
const short=(seat,amount)=>{
 const stacks=seat===0?[amount,2*stake-amount]:[2*stake-amount,amount],start=hand(stacks),blob=encodeHand(start),m=message(KIND_HAND,1,blob);
 return {accept:{seq:1,blob:hex(blob),message:hex(m),signatures:both(m)},...playOut(structuredClone(start),1,callOrCheck)};
};
const traces={
 smallBlindAllIn:short(0,blind/2),
 underSmallBlind:short(0,blind/4),
 bigBlindSameAsSmall:short(1,blind/2),
 underBothBlinds:short(1,blind/4),
 betweenTheBlinds:short(1,blind*3/4),
 riverBetMucked:playOut(structuredClone(accepted),1,betTheRiver,{mucks:true}),
 riverBetShown:playOut(structuredClone(accepted),1,betTheRiver),
 checkedDownMucked:playOut(structuredClone(accepted),1,callOrCheck,{mucks:true}),
 allInCalled:playOut(structuredClone(accepted),1,shoveAndCall),
};
// A later state that both have signed, partway through the same hand, for rollback and fork tests.
const middle=steps[5],middleMessage=Buffer.from(middle.message,'hex');
const stacks={seq:lastSeq+1,hand:2,stacks:final};
const stacksBytes=stacksPayload(2,final),stacksMessage=message(KIND_STACKS,stacks.seq,stacksBytes);
const closeBytes=closePayload(final),closeMessage=message(KIND_CLOSE,lastSeq+1,closeBytes);
// One player signing two different states at one step: the contract's forfeit case.
const forkA=sha256(acceptBlob),forkB=sha256(Buffer.from('a different state')),forkSeq=7;
const fork=[forkA,forkB].map(hash=>{const m=signedMessage(binding,KIND_HAND,forkSeq,hash);return {hash:hex(hash),message:hex(m),signature:hex(signMessage(sessions[1],m))};});
// States both players signed that the contract must still refuse, and two close variants for edge cases.
const signedHand=(blob,seq)=>{const m=message(KIND_HAND,seq,blob);return {seq,blob:hex(blob),message:hex(m),signatures:both(m)};};
const signedClose=(seq,stacks)=>{const m=message(KIND_CLOSE,seq,closePayload(stacks));return {seq,stacks,message:hex(m),signatures:both(m)};};
const inflated=structuredClone(accepted);inflated.game.stacks[0]+=1;
const wrongStage=structuredClone(accepted);wrongStage.phase=11;
const otherBlind=structuredClone(accepted);otherBlind.game.bigBlind=blind*2;
const badAggressor=structuredClone(accepted);badAggressor.aggressor=7;
const later=steps[8],laterMessage=Buffer.from(later.message,'hex');
const signedStacks=(seq,hand,stacks)=>{const payload=stacksPayload(hand,stacks),m=message(KIND_STACKS,seq,payload);return {seq,hand,stacks,payload:hex(payload),message:hex(m),signatures:both(m)};};
void P_BETTING;
console.log(JSON.stringify({
 badAggressor:signedHand(encodeHand(badAggressor),2),inflated:signedHand(encodeHand(inflated),2),wrongStage:signedHand(encodeHand(wrongStage),2),otherBlind:signedHand(encodeHand(otherBlind),2),
 later:{seq:later.seq,blob:later.blob,message:later.message,signatures:both(laterMessage)},
 inflatedClose:signedClose(lastSeq+3,[stake+1,stake]),inflatedStacks:signedStacks(lastSeq+3,2,[stake+1,stake]),
 earlyClose:signedClose(1,[stake,stake]),smallClose:signedClose(lastSeq+2,[2*stake-1000,1000]),
 traces,mainFirst,terms,match,sessions:sessions.map(s=>hex(s.publicKey)),stranger:hex(stranger.publicKey),
 accept:{seq:1,blob:hex(acceptBlob),message:hex(acceptMessage),signatures:both(acceptMessage),strangerSignature:hex(signMessage(stranger,acceptMessage))},
 middle:{seq:middle.seq,blob:middle.blob,message:middle.message,signatures:both(middleMessage),index:5},
 steps,final,
 stacks:{...stacks,payload:hex(stacksBytes),message:hex(stacksMessage),signatures:both(stacksMessage)},
 close:{seq:lastSeq+1,stacks:final,message:hex(closeMessage),signatures:both(closeMessage)},
 fork:{seat:1,seq:forkSeq,kind:KIND_HAND,entries:fork},
}));
void G;
