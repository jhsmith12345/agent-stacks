// A simple solver, for testing and as a starting point. Before each decision it estimates this hand's strength
// by simulation, then solves a small model of the rest of the hand with counterfactual regret minimisation, and
// samples a move from the mixed strategy. That gives value bets, bluffs, check-raises and varied sizes.
// It isn't strong. It models only one more bet and raise, assumes the opponent could hold anything, and treats
// each street as if it were the last, with hand strength counting for less on earlier streets.
import {evaluate,greater} from './engine.js';
import {CARDS} from '../mental-poker/deck.js';
const BUCKETS=8,ITERATIONS=300,SIMULATIONS=150,INDEX=new Map(CARDS.map((c,i)=>[c,i]));
// How much a stronger hand is ahead, by street: the later, the more decisive.
const SHARPNESS={preflop:0.35,flop:0.6,turn:1,river:3};
export function seededRandom(seed){
 let s=seed>>>0;
 return ()=>{s=(s+0x6d2b79f5)>>>0;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
// This hand's chance against a random one, with a random run-out.
export function handStrength(cards,board,random=Math.random,simulations=SIMULATIONS){
 const mine=cards.map(c=>INDEX.get(c)),common=board.map(c=>INDEX.get(c)),known=new Set([...mine,...common]);
 const rest=[];for(let c=0;c<52;c++)if(!known.has(c))rest.push(c);
 const needed=5-common.length;let score=0;
 for(let n=0;n<simulations;n++){
  for(let i=0;i<needed+2;i++){const j=i+Math.floor(random()*(rest.length-i));[rest[i],rest[j]]=[rest[j],rest[i]];}
  const run=[...common,...rest.slice(2,needed+2)];
  const a=evaluate([...mine,...run]),b=evaluate([rest[0],rest[1],...run]);
  score+=greater(a,b)?1:greater(b,a)?0:0.5;
 }
 return score/simulations;
}
const terminal=payoff=>({payoff});
const decision=(actor,actions)=>({actor,actions,regret:Array.from({length:BUCKETS},()=>new Float64Array(actions.length)),total:Array.from({length:BUCKETS},()=>new Float64Array(actions.length))});
// Chips added from now on, by me and by the opponent. `facing` is what the opponent already has in that I haven't matched.
function buildTree({pot,facing,myStack,theirStack,sizes,canRaise,lastToAct,winChance}){
 const showdown=(mine,theirs)=>{
  const matched=Math.min(mine,theirs+facing),contested=pot-facing+2*matched;
  return terminal((i,j)=>winChance(i,j)*contested-matched);
 };
 // The opponent answers a bet from me: it can fold, call, or put me all-in.
 const answerBet=mine=>{
  const toMatch=Math.max(0,mine-facing),actions=[{name:'fold',node:terminal(()=>pot)},{name:'call',node:showdown(mine,Math.min(toMatch,theirStack))}];
  if(theirStack>toMatch&&myStack>mine){
   const reply=decision(0,[{name:'fold',node:terminal(()=>-mine)},{name:'call',node:showdown(Math.min(myStack,theirStack+facing),theirStack)}]);
   actions.push({name:'raise',node:reply});
  }
  return decision(1,actions);
 };
 const myBets=sizes.filter(f=>canRaise).map(f=>{
  const extra=f===Infinity?myStack:Math.max(1,Math.round(f*(pot+facing)))+facing;
  return {name:'raise',size:f,node:answerBet(Math.min(extra,myStack))};
 });
 if(facing>0)return decision(0,[{name:'fold',node:terminal(()=>0)},{name:'call',node:showdown(Math.min(facing,myStack),0)},...myBets]);
 let afterCheck=showdown(0,0);
 if(!lastToAct){
  const bet=Math.min(Math.max(1,Math.round(pot*0.66)),theirStack,myStack);
  if(bet>0)afterCheck=decision(1,[{name:'check',node:showdown(0,0)},{name:'bet',node:decision(0,[{name:'fold',node:terminal(()=>0)},{name:'call',node:showdown(bet,bet)}])}]);
 }
 return decision(0,[{name:'check',node:afterCheck},...myBets]);
}
function iterate(node,i,j,mine,theirs){
 if(node.payoff)return node.payoff(i,j);
 const bucket=node.actor===0?i:j,regret=node.regret[bucket],n=node.actions.length;
 let positive=0;for(let a=0;a<n;a++)positive+=Math.max(0,regret[a]);
 const strategy=new Float64Array(n);for(let a=0;a<n;a++)strategy[a]=positive>0?Math.max(0,regret[a])/positive:1/n;
 const values=new Float64Array(n);let value=0;
 for(let a=0;a<n;a++){
  values[a]=node.actor===0?iterate(node.actions[a].node,i,j,mine*strategy[a],theirs):iterate(node.actions[a].node,i,j,mine,theirs*strategy[a]);
  value+=strategy[a]*values[a];
 }
 const sign=node.actor===0?1:-1,other=node.actor===0?theirs:mine,own=node.actor===0?mine:theirs;
 for(let a=0;a<n;a++){regret[a]=Math.max(0,regret[a]+sign*other*(values[a]-value));node.total[bucket][a]+=own*strategy[a];}
 return value;
}
// The mixed strategy for each strength of hand at this decision, assuming either player could hold any of them.
export function solve({pot,facing,myStack,theirStack,sizes,canRaise,lastToAct,street}){
 const k=SHARPNESS[street],winChance=(i,j)=>1/(1+Math.exp(-(i-j)*k));
 const root=buildTree({pot,facing,myStack,theirStack,sizes,canRaise,lastToAct,winChance});
 for(let t=0;t<ITERATIONS;t++)for(let i=0;i<BUCKETS;i++)for(let j=0;j<BUCKETS;j++)iterate(root,i,j,1,1);
 const strategies=root.total.map(total=>{const sum=total.reduce((s,v)=>s+v,0);return [...total].map(v=>sum>0?v/sum:1/total.length);});
 return {actions:root.actions.map(({name,size})=>({name,size})),strategies};
}
const STYLES={balanced:{},tight:{fold:1.7,raise:0.7},loose:{fold:0.5,call:1.3},aggressive:{raise:1.8,check:0.7,fold:0.8},passive:{raise:0.4,call:1.3}};
export function makeSolverBot({seed=1,style='balanced',sizes=[0.33,0.75,1.5],noise=0,show='default'}={}){
 const random=seededRandom(seed),bias=STYLES[style];
 if(!bias)throw Error(`Unknown style ${style}`);
 const cache=new Map();
 const replyFor=(choice,q)=>{
  if(choice.name==='fold'||choice.name==='check'||choice.name==='call')return {action:choice.name};
  if(choice.size===Infinity)return {action:'all-in'};
  const to=Math.round(q.bets.you+q.toCall+choice.size*(q.pot+q.toCall));
  return {action:'raise',to:Math.min(q.legal.raise.max,Math.max(q.legal.raise.min,to))};
 };
 function bet(q){
  const legal=q.legal,canRaise=!!legal.raise,facing=q.toCall,myStack=q.stacks.you,theirStack=q.stacks.opponent;
  // Going all-in is only part of the plan when stacks are short enough for it to make sense.
  const menu=myStack<=(q.pot+facing)*4?[...sizes,Infinity]:sizes;
  const lastToAct=q.history.at(-1)?.street===q.street&&q.history.at(-1)?.action==='check';
  const key=[Math.round(40*facing/(q.pot+1)),Math.round(4*myStack/(q.pot+1)),Math.round(4*theirStack/(q.pot+1)),canRaise,lastToAct,q.street,menu.length].join();
  if(!cache.has(key))cache.set(key,solve({pot:q.pot,facing,myStack,theirStack,sizes:menu,canRaise,lastToAct,street:q.street}));
  const {actions,strategies}=cache.get(key);
  const bucket=Math.min(BUCKETS-1,Math.floor(handStrength(q.cards,q.board,random)*BUCKETS));
  const weights=strategies[bucket].map((p,a)=>p*(bias[actions[a].name]??1));
  const usable=actions.map((a,i)=>({a,w:weights[i]}));
  if(random()<noise){return replyFor(usable[Math.floor(random()*usable.length)].a,q);}
  let roll=random()*usable.reduce((s,u)=>s+u.w,0);
  for(const u of usable){roll-=u.w;if(roll<=0)return replyFor(u.a,q);}
  return replyFor(usable.at(-1).a,q);
 }
 function showOrMuck(q){
  const worthIt=q.winning||q.tied;
  if(show==='always')return {show:true};
  if(show==='never')return {show:false};
  // Now and then the unusual choice, to exercise it: showing a loser, or mucking a winner.
  if(show==='sometimes'&&random()<0.15)return {show:!worthIt};
  return {show:worthIt};
 }
 return q=>q.type==='bet'?bet(q):q.type==='show'?showOrMuck(q):null;
}
