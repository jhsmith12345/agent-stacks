import { startHand, act, resumeExternalDeal, resumeExternalShowdown, legalActions } from '../src/poker.js';
import { CARDS, initialDeck } from '../src/mental-poker/deck.js';
import { evaluate } from '../src/cards.js';
let seed=123456789;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
const id=c=>CARDS.indexOf(c),score=c=>{const s=evaluate(c).score;return [...s,...Array(6-s.length).fill(0)];};
const ranks=[];
for(let i=0;i<400;i++){const deck=[...CARDS];for(let j=51;j>0;j--){const k=Math.floor(random()*(j+1));[deck[j],deck[k]]=[deck[k],deck[j]];}const cards=deck.slice(0,5+i%3);ranks.push({cards:cards.map(id),score:score(cards)});}
function snapshot(m){const h=m.hand,done=m.status==='complete';return structuredClone({stacks:m.stacks,bets:done?[0,0]:h.bets,contributed:h.contributed,currentBet:h.currentBet,minRaise:h.minRaise,actor:h.actor??255,street:['preflop','flop','turn','river'].indexOf(h.street),stage:done?3:h.phase==='betting'?0:h.phase==='awaiting-board'?1:2,board:[...h.board.map(id),...Array(5-h.board.length).fill(255)],holes:h.holes.map(cs=>cs.length?cs.map(id):[255,255])});}
const games=[];
for(let game=0;game<120;game++){
 const stacks=[1+Math.floor(random()*2000),1+Math.floor(random()*2000)],button=game%2,bb=20;
 const m={stacks:[...stacks],status:'active',handNo:button,bigBlind:bb,smallBlind:bb/2,turnSeconds:86400,maxHands:button+1,events:[],dealing:'external'};
 startHand(m,0);resumeExternalDeal(m,0);
 const initial=snapshot(m),steps=[];let guard=0;
 while(m.status!=='complete'){
  if(++guard>3000)throw Error('action loop');
  if(m.hand.phase==='awaiting-board') {const cards=m.hand.street==='flop'?['2c','3d','4h']:m.hand.street==='turn'?['8s']:['9c'];m.hand.board.push(...cards);resumeExternalDeal(m,0);steps.push({kind:'board',cards:cards.map(id),expected:snapshot(m)});}
  else if(m.hand.phase==='awaiting-showdown'){const holes=[['As','Ad'],['Ks','Kd']];resumeExternalShowdown(m,holes,0);steps.push({kind:'showdown',holes:holes.map(cs=>cs.map(id)),expected:snapshot(m)});}
  else {const seat=m.hand.actor,legal=legalActions(m,seat);let action,amount=0;const r=random();if(r<0.08)action=0;else if(legal.allIn && r<0.22)action=4;else if(legal.raise&&r<0.48){action=3;amount=legal.raise.min;}else action=legal.check?1:2;act(m,seat,['fold','check','call','raise','all-in'][action],action===3?amount:undefined,0);steps.push({kind:'action',seat,action,amount,expected:snapshot(m)});}
 }
 games.push({stacks,button,bb,initial,steps});
}
console.log(JSON.stringify({ranks,games,initialDeckHex:Buffer.concat(initialDeck().flatMap(c=>[Buffer.from(c.a,'hex'),Buffer.from(c.b,'hex')])).toString('hex')}));
