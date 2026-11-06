// Checks finished hands without using the engine or the contract, so a mistake in those can't hide itself.
import {compare,evaluate as refereeEvaluate} from '../cards.js';
import {CARDS} from '../mental-poker/deck.js';
// A referee for finished hands, sharing no code with the engine or the contract. From the betting and the cards
// alone it works out who should show first and what each stack should be, using the older hand evaluator.
export function referee(buyIn,bigBlind,records){
 const faults=[];let stacks=[buyIn,buyIn];
 for(const [a,b] of records){
  const button=(a.hand-1)%2,other=1-button,paid=[0,0],bets=[0,0];
  const pay=(seat,n)=>{const amount=Math.min(n,stacks[seat]-paid[seat]);paid[seat]+=amount;bets[seat]+=amount;};
  pay(button,bigBlind/2);pay(other,bigBlind);
  let street=0,top=Math.max(bets[0],bets[1]),folded=null,lastRaiser=null,lastStreet=null;
  for(const e of a.betting){
   if(e.street!==street){street=e.street;bets[0]=0;bets[1]=0;top=0;}
   if(lastStreet!==e.street){lastStreet=e.street;lastRaiser=null;}
   if(e.action===0){folded=e.seat;break;}
   if(e.action===2||(e.action===4&&e.to===undefined))pay(e.seat,top-bets[e.seat]);
   else if(e.action===3||e.action===4){pay(e.seat,e.to-bets[e.seat]);if(bets[e.seat]>top){top=bets[e.seat];lastRaiser=e.seat;}}
  }
  const matched=Math.min(paid[0],paid[1]),name=list=>list.map(c=>CARDS[c]);
  let winner;
  if(folded!==null)winner=1-folded;
  else if(a.reason===3)winner=a.winner;
  else{
   if(!a.cards||!b.cards||a.board.length!==5){faults.push(`hand ${a.hand}: no cards to judge a showdown`);continue;}
   const board=name(a.board),order=compare(refereeEvaluate([...name(a.cards),...board]).score,refereeEvaluate([...name(b.cards),...board]).score);
   winner=order>0?a.seat:order<0?b.seat:2;
  }
  if(a.winner!==winner)faults.push(`hand ${a.hand}: the referee says the winner is ${winner}, the record says ${a.winner}`);
  const next=[stacks[0]-paid[0],stacks[1]-paid[1]];
  for(const s of [0,1])next[s]+=paid[s]-matched;
  if(winner===2){next[0]+=matched;next[1]+=matched;}else next[winner]+=2*matched;
  if(next[0]!==a.stacks[0]||next[1]!==a.stacks[1])faults.push(`hand ${a.hand}: the referee has the stacks at ${next}, the record has ${a.stacks}`);
  if(folded===null){
   const first=lastRaiser??other;
   if(a.firstToShow!==first)faults.push(`hand ${a.hand}: the referee says seat ${first} shows first, the record says ${a.firstToShow}`);
  }
  if(a.reason===3&&a.opponentCards.length&&b.opponentCards.length)faults.push(`hand ${a.hand}: a muck, but both sides saw the other's cards`);
  if(a.reason===1&&(b.opponentCards.join()!==a.cards?.join()||a.opponentCards.join()!==b.cards?.join()))faults.push(`hand ${a.hand}: a showdown where the cards shown don't match the cards held`);
  stacks=a.stacks;
 }
 return faults;
}
// What a set of hands actually exercised, to tell whether the variety is really there.
export function coverage(total,records,bigBlind){
 const add=(name,n=1)=>{total[name]=(total[name]??0)+n;};
 for(const [a,b] of records){
  if(a.betting.length===0&&a.reason!==0)add('hands with a blind all-in and no betting');
  let street=0,top=bigBlind,minimum=bigBlind;
  for(const e of a.betting){
   if(e.street!==street){street=e.street;top=0;minimum=bigBlind;}
   if(e.to===undefined)continue;
   if(e.to-top<minimum){add('all-in raises below the minimum');}else minimum=e.to-top;
   top=Math.max(top,e.to);
  }
  add('hands');add(`ended by ${['fold','showdown','forfeit','muck'][a.reason]}`);
  if(a.winner===2)add('split pots');
  if(a.reason===3&&a.cards!==null&&b.cards&&a.board.length===5){
   const mucker=a.winner===a.seat?b:a,taker=a.winner===a.seat?a:b;
   const board=a.board.map(c=>CARDS[c]);
   if(compare(refereeEvaluate([...mucker.cards.map(c=>CARDS[c]),...board]).score,refereeEvaluate([...taker.cards.map(c=>CARDS[c]),...board]).score)>=0)add('winning hands mucked');
  }
  if(a.board.length===5&&a.betting.every(e=>e.street<3))add('board ran out with no river betting');
  const byStreet=[0,0,0,0];
  for(const e of a.betting){
   add(`${['fold','check','call','raise','all-in'][e.action]} on ${['preflop','flop','turn','river'][e.street]}`);
   if(e.action===3||e.action===4)byStreet[e.street]++;
  }
  if(byStreet.some(n=>n>=2))add('hands with a re-raise');
  if(byStreet.some(n=>n>=3))add('hands with three or more raises on a street');
  if(a.stacks.includes(0))add('hands ending the match by bust');
  if(a.betting.some(e=>e.action===4)&&a.reason!==0&&Math.min(...a.stacks)>0)add('all-ins that didn’t end the match');
  if(a.betting.some(e=>e.action===4&&e.to===undefined))add('all-ins that only called');
 }
}
