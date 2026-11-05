// The hand rules exactly as programs/escrow/src/{game,play}.rs apply them, so a state reached off-chain can be
// posted and continued on chain byte for byte. Differential tests hold the two together. Nothing here does I/O.
import {createHash} from 'node:crypto';
import {initialDeck,verifyShare} from '../mental-poker/deck.js';
import {verifyDLEQ,encodeDLEQ} from '../mental-poker/proofs.js';
import {point,contextString} from '../mental-poker/group.js';
export const NONE=255,BETTING=0,BOARD=1,SHOWDOWN=2,COMPLETE=3;
export const P_HOLE_B=5,P_DONE=6,P_HOLE_A=7,P_BETTING=8,P_BOARD_A=9,P_BOARD_B=10,P_SHOW_A=11,P_SHOW_B=12;
export const PHYSICAL=[0,1,2,3,5,6,7,9,11];
export const KIND_STACKS=1,KIND_CLOSE=2,KIND_HAND=3;
export const BLOB_BYTES=1311,GAME_BYTES=89;
const DOMAIN=Buffer.from('agent-stacks/channel/v1');
const fail=message=>{const error=Error(message);error.invalidMove=true;throw error;};
const ensure=(ok,message='Invalid move')=>{if(!ok)fail(message);};
const safe=(n,name)=>ensure(Number.isSafeInteger(n)&&n>=0,`Invalid ${name}`);
const zero='00'.repeat(32);

function pay(g,seat,amount){g.stacks[seat]-=amount;g.bets[seat]+=amount;g.contributed[seat]+=amount;}
function nextStreet(g){
 g.street+=1;g.stage=BOARD;g.actor=NONE;g.bets=[0,0];g.currentBet=0;g.minRaise=g.bigBlind;g.acted=0;g.pending=0;
 for(const s of [0,1])if(g.stacks[s]>0)g.pending|=1<<s;
}
function advance(g){if(g.street<3)nextStreet(g);else{g.stage=SHOWDOWN;g.actor=NONE;}}
function progress(g){
 for(const s of [0,1])if(g.stacks[s]===0)g.pending&=~(1<<s);
 if(g.stacks.includes(0)){
  const s=[0,1].find(i=>g.stacks[i]>0&&g.bets[i]<g.currentBet);
  if(s!==undefined){g.pending=1<<s;g.actor=s;return;}
  advance(g);return;
 }
 if(g.pending===0)advance(g);
 else if(g.actor>1||!(g.pending&(1<<g.actor)))g.actor=g.pending&1?0:1;
}
function award(g,winner,reason){
 const matched=Math.min(g.contributed[0],g.contributed[1]);
 for(const s of [0,1])g.stacks[s]+=g.contributed[s]-matched;
 if(winner!==null)g.stacks[winner]+=2*matched;else for(const s of [0,1])g.stacks[s]+=matched;
 g.contributed=[0,0];g.bets=[0,0];g.pending=0;g.acted=0;g.actor=NONE;g.stage=COMPLETE;g.winner=winner??2;g.reason=reason;
}
export function newGame(stacks,bigBlind,button){
 ensure(button<2&&Number.isSafeInteger(bigBlind)&&bigBlind>=2&&bigBlind%2===0&&bigBlind<=100_000_000_000&&stacks.every(s=>Number.isSafeInteger(s)&&s>0&&s<=2_000_000_000_000),'Invalid hand parameters');
 const g={stacks:[...stacks],bets:[0,0],contributed:[0,0],currentBet:bigBlind,minRaise:bigBlind,bigBlind,actor:button,pending:3,acted:0,street:0,stage:BETTING,button,winner:NONE,reason:NONE,board:Array(5).fill(NONE),holes:[[NONE,NONE],[NONE,NONE]]};
 pay(g,button,Math.min(bigBlind/2,g.stacks[button]));
 pay(g,1-button,Math.min(bigBlind,g.stacks[1-button]));
 if(g.stacks.includes(0))g.currentBet=Math.max(g.bets[0],g.bets[1]);
 progress(g);return g;
}
// Actions: 0 fold, 1 check, 2 call, 3 raise to `amount`, 4 all-in.
export function act(g,seat,action,amount=0){
 safe(amount,'amount');
 ensure(g.stage===BETTING&&(seat===0||seat===1)&&g.actor===seat&&Number.isInteger(action)&&action>=0&&action<=4&&(action===3||amount===0),'Illegal betting move');
 const other=1-seat,owed=Math.max(0,g.currentBet-g.bets[seat]),max=g.bets[seat]+g.stacks[seat];
 const canRaise=!(g.acted&(1<<seat))&&g.stacks[other]>0&&max>g.currentBet;
 if(action===0){award(g,other,0);return;}
 if(action===4){ensure(max<=g.currentBet||canRaise,'Illegal all-in');amount=max;action=max<=g.currentBet?2:3;}
 if(action===1)ensure(owed===0,'Cannot check facing a bet');
 else if(action===2){ensure(owed>0,'Nothing to call');pay(g,seat,Math.min(owed,g.stacks[seat]));}
 else{
  ensure(canRaise&&amount>g.currentBet&&amount<=max&&(amount>=g.currentBet+g.minRaise||amount===max),'Illegal raise');
  const increase=amount-g.currentBet;pay(g,seat,amount-g.bets[seat]);g.currentBet=amount;
  if(increase>=g.minRaise){g.minRaise=increase;g.acted=0;}
  g.pending=1<<other;
 }
 if(action!==3)g.pending&=~(1<<seat);
 g.acted|=1<<seat;g.actor=other;progress(g);
}
export function resumeBoard(g){
 ensure(g.stage===BOARD&&g.street>=1&&g.street<=3,'Board is not due');
 const required=g.street===1?3:g.street+2;ensure(g.board.slice(0,required).every(c=>c<52),'Board cards missing');
 g.stage=BETTING;g.actor=1-g.button;progress(g);
}
function five(cards){
 const count=Array(15).fill(0);for(const c of cards)count[Math.floor(c/4)+2]++;
 const flush=cards.every(c=>c%4===cards[0]%4);
 let straight=0;
 for(let high=14;high>=5&&!straight;high--){
  const needed=high===5?[14,2,3,4,5]:[high-4,high-3,high-2,high-1,high];
  if(needed.every(r=>count[r]>0))straight=high;
 }
 const ranks=[];for(let r=14;r>=2;r--)for(let i=0;i<count[r];i++)ranks.push(r);
 const groups=[];for(let r=2;r<=14;r++)if(count[r]>0)groups.push([count[r],r]);
 groups.sort((a,b)=>b[0]-a[0]||b[1]-a[1]);
 if(flush&&straight)return [8,straight,0,0,0,0];
 if(groups[0][0]===4)return [7,groups[0][1],groups[1][1],0,0,0];
 if(groups[0][0]===3&&groups[1][0]===2)return [6,groups[0][1],groups[1][1],0,0,0];
 if(flush)return [5,...ranks.slice(0,5)];
 if(straight)return [4,straight,0,0,0,0];
 if(groups[0][0]===3)return [3,groups[0][1],groups[1][1],groups[2][1],0,0];
 if(groups[0][0]===2&&groups[1][0]===2)return [2,groups[0][1],groups[1][1],groups[2][1],0,0];
 if(groups[0][0]===2)return [1,groups[0][1],groups[1][1],groups[2][1],groups[3][1],0];
 return [0,...ranks.slice(0,5)];
}
const greater=(a,b)=>{for(let i=0;i<6;i++)if(a[i]!==b[i])return a[i]>b[i];return false;};
export function evaluate(cards){
 ensure(cards.length>=5&&cards.length<=7&&cards.every(c=>Number.isInteger(c)&&c>=0&&c<52)&&new Set(cards).size===cards.length,'Invalid cards');
 let best=[0,0,0,0,0,0];const n=cards.length;
 for(let a=0;a<n-4;a++)for(let b=a+1;b<n-3;b++)for(let c=b+1;c<n-2;c++)for(let d=c+1;d<n-1;d++)for(let e=d+1;e<n;e++){
  const score=five([cards[a],cards[b],cards[c],cards[d],cards[e]]);if(greater(score,best))best=score;
 }
 return best;
}
export function showdown(g){
 ensure(g.stage===SHOWDOWN,'Showdown is not due');
 const all=[...g.board,...g.holes.flat()];ensure(all.every(c=>c<52)&&new Set(all).size===all.length,'Showdown cards are invalid');
 const a=evaluate([...g.holes[0],...g.board]),b=evaluate([...g.holes[1],...g.board]);
 award(g,greater(a,b)?0:greater(b,a)?1:null,1);
}
export function encodeGame(g){
 const out=Buffer.alloc(GAME_BYTES);
 [g.stacks[0],g.stacks[1],g.bets[0],g.bets[1],g.contributed[0],g.contributed[1],g.currentBet,g.minRaise,g.bigBlind].forEach((v,i)=>out.writeBigUInt64LE(BigInt(v),i*8));
 Buffer.from([g.actor,g.pending,g.acted,g.street,g.stage,g.button,g.winner,g.reason,...g.board,...g.holes[0],...g.holes[1]]).copy(out,72);
 return out;
}
export function decodeGame(b){
 ensure(b.length===GAME_BYTES,'Invalid game bytes');
 const n=at=>{const v=b.readBigUInt64LE(at);ensure(v<=BigInt(Number.MAX_SAFE_INTEGER),'Unsafe game value');return Number(v);};
 return {stacks:[n(0),n(8)],bets:[n(16),n(24)],contributed:[n(32),n(40)],currentBet:n(48),minRaise:n(56),bigBlind:n(64),actor:b[72],pending:b[73],acted:b[74],street:b[75],stage:b[76],button:b[77],winner:b[78],reason:b[79],board:[...b.subarray(80,85)],holes:[[...b.subarray(85,87)],[...b.subarray(87,89)]]};
}

// One hand as both agents and the contract see it. `cards` holds only the nine positions that can be revealed.
export function acceptedHand({hand,keys,deck,stacks,bigBlind}){
 ensure(deck.length===52&&keys.length===2,'Invalid accepted deck');
 return {phase:P_HOLE_B,cursor:0,hand,keys:[...keys],cards:PHYSICAL.map(i=>({a:deck[i].a,b:deck[i].b})),game:newGame(stacks,bigBlind,(hand-1)%2),shares:Array.from({length:9},()=>[zero,zero])};
}
export function encodeHand(s){
 const out=Buffer.alloc(BLOB_BYTES);out[0]=s.phase;out[1]=s.cursor;out.writeUInt32LE(s.hand,2);
 Buffer.from(s.keys[0]+s.keys[1],'hex').copy(out,6);
 s.cards.forEach((c,i)=>{Buffer.from(c.a+c.b,'hex').copy(out,70+i*64);});
 encodeGame(s.game).copy(out,646);
 s.shares.forEach((p,i)=>{Buffer.from(p[0]+p[1],'hex').copy(out,735+i*64);});
 return out;
}
export function decodeHand(b){
 ensure(b.length===BLOB_BYTES,'Invalid hand bytes');
 const hex=(at,n=32)=>b.subarray(at,at+n).toString('hex');
 return {phase:b[0],cursor:b[1],hand:b.readUInt32LE(2),keys:[hex(6),hex(38)],cards:Array.from({length:9},(_,i)=>({a:hex(70+i*64),b:hex(102+i*64)})),game:decodeGame(b.subarray(646,735)),shares:Array.from({length:9},(_,i)=>[hex(735+i*64),hex(767+i*64)])};
}
export function stacksPayload(hand,stacks){const b=Buffer.alloc(20);b.writeUInt32LE(hand,0);b.writeBigUInt64LE(BigInt(stacks[0]),4);b.writeBigUInt64LE(BigInt(stacks[1]),12);return b;}
export function closePayload(stacks){const b=Buffer.alloc(16);b.writeBigUInt64LE(BigInt(stacks[0]),0);b.writeBigUInt64LE(BigInt(stacks[1]),8);return b;}
export const sha256=(...parts)=>{const h=createHash('sha256');for(const p of parts)h.update(p);return h.digest();};
// `binding` is {program,match,terms} as raw 32-byte buffers.
export function signedMessage(binding,kind,seq,payloadHash){
 const s=Buffer.alloc(8);s.writeBigUInt64LE(BigInt(seq));
 return sha256(DOMAIN,binding.program,binding.match,binding.terms,Buffer.from([kind]),s,payloadHash);
}

export function obligated(s){
 if([P_HOLE_A,P_BOARD_A,P_SHOW_A].includes(s.phase))return 0;
 if([P_HOLE_B,P_BOARD_B,P_SHOW_B].includes(s.phase))return 1;
 if(s.phase===P_BETTING){ensure(s.game.actor<2,'No betting actor');return s.game.actor;}
 return null;
}
export function owedPositions(s){
 if([P_HOLE_B,P_SHOW_A].includes(s.phase))return [0,2];
 if([P_HOLE_A,P_SHOW_B].includes(s.phase))return [1,3];
 if([P_BOARD_A,P_BOARD_B].includes(s.phase)){
  if(s.game.street===1)return [4,5,6];if(s.game.street===2)return [7];if(s.game.street===3)return [8];
  fail('Invalid board street');
 }
 fail('No card share is owed');
}
function sync(s){
 s.cursor=0;
 const phase=[P_BETTING,P_BOARD_A,P_SHOW_A,P_DONE][s.game.stage];ensure(phase!==undefined,'Invalid stage');s.phase=phase;
}
const CARD_INDEX=new Map(initialDeck().map((c,i)=>[c.b,i]));
function decodeCard(s,logical){
 const [a,c]=s.shares[logical];ensure(a!==zero&&c!==zero,'Card share missing');
 const index=CARD_INDEX.get(point(s.cards[logical].b).subtract(point(a)).subtract(point(c)).toHex());
 ensure(index!==undefined,'Decryption does not encode a card');return index;
}
export function applyAction(s,seat,action,amount=0){
 ensure(s.phase===P_BETTING,'Betting is not due');act(s.game,seat,action,amount);sync(s);return s;
}
// `wire` is the same DLEQ encoding the contract's share instruction takes.
export function parseShare(wire){
 ensure(Buffer.isBuffer(wire)&&wire.length>=194,'Invalid share');
 const n=wire.readUInt16LE(0);ensure(n>0&&n<=1024&&wire.length===194+n,'Invalid share');
 const field=i=>wire.subarray(2+n+i*32,2+n+(i+1)*32).toString('hex');
 return {context:wire.subarray(2,2+n).toString('utf8'),publicKey:field(0),base2:field(1),share:field(2),proof:{t1:field(3),t2:field(4),s:field(5)}};
}
export function applyShare(s,context,seat,logical,wire){
 const phase=s.phase,expected=owedPositions(s),cursor=s.cursor;
 ensure(obligated(s)===seat&&cursor<expected.length&&logical===expected[cursor],'Share is not owed');
 const parsed=parseShare(wire);
 ensure(parsed.context===context,'Wrong share context');
 ensure(parsed.publicKey===s.keys[seat]&&parsed.base2===s.cards[logical].a,'Share does not match this card');
 ensure(verifyDLEQ(parsed.publicKey,parsed.base2,parsed.share,parsed.proof,context),'Invalid share proof');
 ensure(s.shares[logical][seat]===zero,'Share already recorded');
 s.shares[logical][seat]=parsed.share;
 if(phase===P_BOARD_B)s.game.board[logical-4]=decodeCard(s,logical);
 if(phase===P_SHOW_A||phase===P_SHOW_B)s.game.holes[seat][logical<2?0:1]=decodeCard(s,logical);
 s.cursor=cursor+1;
 if(cursor+1===expected.length){
  s.cursor=0;
  if(phase===P_HOLE_B)s.phase=P_HOLE_A;
  else if(phase===P_HOLE_A)sync(s);
  else if(phase===P_BOARD_A)s.phase=P_BOARD_B;
  else if(phase===P_BOARD_B){resumeBoard(s.game);sync(s);}
  else if(phase===P_SHOW_A)s.phase=P_SHOW_B;
  else if(phase===P_SHOW_B){showdown(s.game);sync(s);}
  else fail('Invalid phase');
 }
 return s;
}
export {verifyShare,encodeDLEQ,contextString};
