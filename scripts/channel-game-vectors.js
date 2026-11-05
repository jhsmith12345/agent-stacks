// Random betting traces from the JavaScript engine, replayed by the Rust game in programs/escrow/tests/game.rs.
// Any byte of difference would make a state signed off-chain impossible to continue on chain.
import {newGame,act,resumeBoard,showdown,encodeGame,evaluate,BETTING,BOARD,SHOWDOWN,COMPLETE} from '../src/channel/engine.js';
let seed=20261105;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
const shuffled=()=>{const d=Array.from({length:52},(_,i)=>i);for(let i=51;i>0;i--){const j=Math.floor(random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}return d;};
const games=[];
for(let n=0;n<600;n++){
 const button=n%2,bb=2*(1+Math.floor(random()*50));
 const stacks=[1+Math.floor(random()*(n%5===0?200:6000)),1+Math.floor(random()*(n%7===0?200:6000))];
 const g=newGame(stacks,bb,button),deck=shuffled(),steps=[];
 g.holes=[[deck[0],deck[2]],[deck[1],deck[3]]];
 const initial=Buffer.from(encodeGame(g)).toString('hex');
 for(let guard=0;g.stage!==COMPLETE;guard++){
  if(guard>500)throw Error('Trace did not finish');
  if(g.stage===BETTING){
   const seat=g.actor,r=random(),owed=Math.max(0,g.currentBet-g.bets[seat]),max=g.bets[seat]+g.stacks[seat];
   const candidates=[owed?[2,0]:[1,0]];
   if(r<0.06)candidates.unshift([0,0]);
   else if(r<0.2)candidates.unshift([4,0]);
   else if(r<0.5&&max>g.currentBet){const low=Math.min(max,g.currentBet+g.minRaise);candidates.unshift([3,low+Math.floor(random()*(max-low+1))]);}
   else if(r<0.55)candidates.unshift([3,g.currentBet]);
   let done=false;
   for(const [action,amount] of candidates){
    const copy=structuredClone(g);let ok=true;try{act(copy,seat,action,amount);}catch(error){if(!error.invalidMove)throw error;ok=false;}
    steps.push({kind:'act',seat,action,amount,ok,after:ok?encodeGame(copy).toString('hex'):null});
    if(ok){act(g,seat,action,amount);done=true;break;}
   }
   if(!done)throw Error('No legal move found');
  }else if(g.stage===BOARD){
   const street=g.street;if(street===1)g.board.splice(0,3,deck[5],deck[6],deck[7]);else if(street===2)g.board[3]=deck[9];else g.board[4]=deck[11];
   resumeBoard(g);steps.push({kind:'board',street,cards:street===1?[deck[5],deck[6],deck[7]]:[street===2?deck[9]:deck[11]],after:encodeGame(g).toString('hex')});
  }else if(g.stage===SHOWDOWN){
   showdown(g);steps.push({kind:'showdown',after:encodeGame(g).toString('hex')});
  }
 }
 games.push({stacks,bb,button,holes:[[deck[0],deck[2]],[deck[1],deck[3]]],initial,steps});
}
const ranks=[];
for(let n=0;n<3000;n++){const cards=shuffled().slice(0,5+n%3);ranks.push({cards,score:evaluate(cards)});}
console.log(JSON.stringify({games,ranks}));
