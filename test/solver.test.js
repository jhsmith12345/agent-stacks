// The simple solver: it has to play legally whatever it's asked, and behave like a solver, not a script.
import test from 'node:test';
import assert from 'node:assert/strict';
import {handStrength,makeSolverBot,seededRandom,solve} from '../src/channel/solver.js';
import {act,BETTING,BOARD,legalMoves,newGame,resumeBoard,SHOWDOWN} from '../src/channel/engine.js';
import {describe,parseReply} from '../src/channel/decider.js';
const riverSpot=(overrides={})=>({type:'bet',id:1,hand:1,hands:1,street:'river',dealer:'you',cards:['2c','7d'],board:['As','Ks','Qh','9d','4c'],stacks:{you:900_000,opponent:900_000},bets:{you:0,opponent:0},pot:200_000,toCall:0,bigBlind:20_000,legal:{fold:true,check:true,call:null,raise:{min:20_000,max:900_000},allIn:900_000},history:[],...overrides});
const tally=(bot,spot,times=400)=>{const counts={};for(let i=0;i<times;i++){const r=bot(spot);counts[r.action]=(counts[r.action]??0)+1;}return counts;};
test('hand strength tells strong from weak',()=>{
 const random=seededRandom(3);
 assert.ok(handStrength(['Ah','Ad'],[],random,400)>0.75,'aces');
 assert.ok(handStrength(['7h','2d'],[],random,400)<0.45,'seven-deuce');
 assert.ok(handStrength(['Ah','Kh'],['Qh','Jh','Th','2c','3d'],random,100)>0.99,'a royal flush can’t lose');
 assert.ok(handStrength(['2c','7d'],['As','Ks','Qh','9d','4c'],random,300)<0.25,'nothing at all');
});
test('the solved strategy is mixed, bets strong hands and bluffs some weak ones',()=>{
 const {actions,strategies}=solve({pot:200_000,facing:0,myStack:900_000,theirStack:900_000,sizes:[0.75],canRaise:true,lastToAct:true,street:'river'});
 const betting=actions.findIndex(a=>a.name==='raise');
 assert.ok(strategies[7][betting]>0.5,`the strongest hands bet: ${strategies[7][betting]}`);
 assert.ok(strategies[0][betting]>0.05,`the weakest hands sometimes bluff: ${strategies[0][betting]}`);
 assert.ok(strategies[3][betting]<strategies[7][betting],'medium hands bet less than the best');
 for(const row of strategies)assert.ok(Math.abs(row.reduce((s,v)=>s+v,0)-1)<1e-9,'each is a real mix');
});
test('facing a bet, it folds weak hands and continues with strong ones',()=>{
 const {actions,strategies}=solve({pot:400_000,facing:200_000,myStack:900_000,theirStack:700_000,sizes:[0.75],canRaise:true,lastToAct:false,street:'river'});
 const fold=actions.findIndex(a=>a.name==='fold'),call=actions.findIndex(a=>a.name==='call');
 assert.ok(strategies[0][fold]>0.3,`weak hands fold often: ${strategies[0][fold]}`);
 assert.ok(strategies[0][call]<0.2,`and hardly ever call, because they can’t win a showdown: ${strategies[0][call]}`);
 assert.ok(strategies[7][fold]<0.01,`the best never fold: ${strategies[7][fold]}`);
});
test('with nothing to lose by calling a tiny bet, it almost never folds',()=>{
 const {actions,strategies}=solve({pot:1_000_000,facing:1000,myStack:900_000,theirStack:900_000,sizes:[0.75],canRaise:false,lastToAct:false,street:'river'});
 const fold=actions.findIndex(a=>a.name==='fold');
 assert.ok(strategies[4][fold]<0.01,`${strategies[4][fold]}`);
});
test('the same seed plays the same way, and different seeds and styles vary',()=>{
 const run=options=>{const bot=makeSolverBot(options);return Array.from({length:40},()=>JSON.stringify(bot(riverSpot())));};
 assert.deepEqual(run({seed:5}),run({seed:5}));
 assert.notDeepEqual(run({seed:5}),run({seed:6}));
 const raises=style=>{const counts=tally(makeSolverBot({seed:9,style}),riverSpot({cards:['Ah','Ad']}));return counts.raise??0;};
 assert.ok(raises('aggressive')>raises('passive'),'styles make a difference');
 assert.throws(()=>makeSolverBot({style:'nonsense'}),/Unknown style/);
});
test('it chooses among real bet sizes, and only goes all-in when stacks are short',()=>{
 const bot=makeSolverBot({seed:11,style:'aggressive'}),sizes=new Set();
 for(let i=0;i<400;i++){const r=bot(riverSpot({cards:['Ah','Ad']}));assert.notEqual(r.action,'all-in','deep stacks');if(r.action==='raise')sizes.add(r.to);}
 assert.ok(sizes.size>=2,`varied sizes: ${[...sizes]}`);
 const short=riverSpot({cards:['Ah','Ad'],stacks:{you:300_000,opponent:300_000},legal:{fold:true,check:true,call:null,raise:{min:20_000,max:300_000},allIn:300_000}});
 assert.ok(tally(makeSolverBot({seed:12,style:'aggressive'}),short)['all-in']>0,'short stacks can shove');
});
test('showing or mucking follows its setting',()=>{
 const spot=winning=>({type:'show',id:1,winning,tied:false});
 assert.deepEqual(makeSolverBot({})(spot(true)),{show:true});
 assert.deepEqual(makeSolverBot({})(spot(false)),{show:false});
 assert.deepEqual(makeSolverBot({show:'always'})(spot(false)),{show:true});
 assert.deepEqual(makeSolverBot({show:'never'})(spot(true)),{show:false});
 const bot=makeSolverBot({seed:2,show:'sometimes'});
 const flips=Array.from({length:200},()=>bot(spot(true)).show).filter(s=>!s).length;
 assert.ok(flips>5&&flips<70,`sometimes mucks a winner: ${flips}`);
 assert.equal(makeSolverBot({})({type:'result'}),null,'and it needs no reply to a result');
});
test('across whole random games, every move it makes is one the engine accepts',{timeout:120000},()=>{
 const random=seededRandom(21);
 const seen={};
 for(let game=0;game<120;game++){
  const stacks=[200+Math.floor(random()*4000),200+Math.floor(random()*4000)],g=newGame(stacks,40,game%2);
  const bots=[0,1].map(s=>makeSolverBot({seed:game*2+s,style:['balanced','tight','loose','aggressive','passive'][(game+s)%5],noise:0.1}));
  const history=[];
  for(let turn=0;turn<80&&g.stage!==SHOWDOWN&&g.stage!==3;turn++){
   if(g.stage===BOARD){g.board=[0,1,2,3,4];resumeBoard(g);continue;}
   assert.equal(g.stage,BETTING);
   const seat=g.actor;
   const view={hand:1,hands:1,seat,cards:[8+seat*4,9+seat*4],board:g.board.filter(c=>c<52).slice(0,g.street===0?0:g.street+2),stacks:[...g.stacks],bets:[...g.bets],pot:g.contributed[0]+g.contributed[1],bigBlind:40,button:g.button,owed:Math.max(0,g.currentBet-g.bets[seat]),street:g.street,legal:legalMoves(g,seat),history:history.map(e=>({...e}))};
   const reply=bots[seat](describe({type:'bet',view})),move=parseReply('bet',reply);
   assert.ok(move,`a usable reply: ${JSON.stringify(reply)}`);
   seen[reply.action]=(seen[reply.action]??0)+1;
   assert.doesNotThrow(()=>act(g,seat,move.action,move.amount),`${JSON.stringify(reply)} with ${JSON.stringify(view.legal)}`);
   history.push({seq:turn,street:view.street,seat,action:move.action});
  }
 }
 for(const action of ['fold','check','call','raise','all-in'])assert.ok(seen[action]>0,`played ${action}: ${JSON.stringify(seen)}`);
});
test('a decision takes a small fraction of the time allowed',()=>{
 const bot=makeSolverBot({seed:3}),started=Date.now();
 for(let i=0;i<20;i++)bot(riverSpot({pot:200_000+i*50_000}));
 assert.ok((Date.now()-started)/20<500,`${(Date.now()-started)/20} ms each`);
});
