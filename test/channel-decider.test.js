// A separate program making the poker decisions. It can only ever propose a move, and the agent carries on
// whatever it does: a bad reply, a slow one, or none at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {ChannelPeer,STAGE} from '../src/channel/peer.js';
import {ChannelRunner} from '../src/channel/runner.js';
import {DecisionProgram,describe,describeResult,parseReply} from '../src/channel/decider.js';
import {act,BETTING,BOARD,encodeHand,legalMoves,newGame,resumeBoard,SHOWDOWN} from '../src/channel/engine.js';
import {sessionFromSeed} from '../src/channel/keys.js';
import {OPEN} from '../src/channel/chain.js';
const sessions=[sessionFromSeed(Buffer.alloc(32,1)),sessionFromSeed(Buffer.alloc(32,2))];
const config=(overrides={})=>({program:'11111111111111111111111111111112',match:'11111111111111111111111111111113',terms:'aa'.repeat(32),programBytes:Buffer.alloc(32,3),matchBytes:Buffer.alloc(32,4),termsBytes:Buffer.alloc(32,0xaa),sessions:sessions.map(s=>Buffer.from(s.publicKey).toString('hex')),buyIn:1_000_000,bigBlind:20_000,maxHands:1,...overrides});
const pairOf=(overrides,states=[null,null])=>[0,1].map(seat=>new ChannelPeer(config(overrides),sessions[seat],seat,{outside:true,state:states[seat]}));
// Delivers every message, and asks each player's bot whenever there's nothing else to do.
function play(pair,bots,{stop=()=>false,limit=20_000}={}){
 const queue=[...pair[0].start().map(m=>({to:1,m})),...pair[1].start().map(m=>({to:0,m}))],asked=[[],[]];
 for(let n=0;n<limit&&!stop(pair);n++){
  if(queue.length){const {to,m}=queue.shift();for(const reply of pair[to].receive(m))queue.push({to:1-to,m:reply});continue;}
  let moved=false;
  for(const seat of [0,1]){
   const question=pair[seat].question();
   if(!question)continue;
   moved=true;asked[seat].push(question);
   pair[seat].answer(question.key,parseReply(question.type,bots[seat](describe(question))));
   for(const m of pair[seat].resume())queue.push({to:1-seat,m});
  }
  if(!moved)break;
 }
 return asked;
}
const passive=q=>q.type==='show'?{show:q.winning||q.tied}:q.legal.check?{action:'check'}:{action:'call'};
const raiser=q=>q.type==='bet'&&q.legal.raise?{action:'raise',to:q.legal.raise.min}:passive(q);
const shover=q=>q.type==='bet'&&q.legal.allIn?{action:'all-in'}:passive(q);
const shows=answer=>q=>q.type==='show'?{show:answer}:passive(q);
const betRiver=q=>q.type==='bet'&&q.street==='river'&&q.legal.raise?{action:'raise',to:q.legal.raise.min}:passive(q);
// The expensive part of a hand, done once: seat 0 has to make the first betting decision.
let fixture;
function atFirstDecision(){
 if(!fixture){
  const pair=pairOf();
  play(pair,[passive,passive],{stop:p=>!!p[0].question()});
  fixture=pair.map(p=>JSON.stringify(p.state));
 }
 return fixture.map(s=>JSON.parse(s));
}
const dealer=()=>pairOf({},atFirstDecision())[0];

test('the moves it offers are exactly the ones the engine accepts',()=>{
 let seed=1;const random=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
 const attempt=(g,seat,action,amount=0)=>{try{act(structuredClone(g),seat,action,amount);return true;}catch(error){assert.ok(error.invalidMove,error.message);return false;}};
 let raises=0,shortAllIns=0;
 for(let game=0;game<400;game++){
  const stacks=[100+Math.floor(random()*3000),100+Math.floor(random()*3000)];
  const g=newGame(stacks,40,game%2);
  for(let turn=0;turn<60&&g.stage!==SHOWDOWN&&g.stage!==3;turn++){
   if(g.stage===BOARD){g.board=[0,1,2,3,4];resumeBoard(g);continue;}
   assert.equal(g.stage,BETTING);
   const seat=g.actor,legal=legalMoves(g,seat);
   assert.equal(attempt(g,seat,0),legal.fold);
   assert.equal(attempt(g,seat,1),legal.check);
   assert.equal(attempt(g,seat,2),legal.call!==null);
   assert.equal(attempt(g,seat,4),legal.allIn!==null,'all-in');
   if(legal.call!==null)assert.ok(legal.call>0&&legal.call<=g.stacks[seat]);
   if(legal.raise){
    raises++;
    assert.ok(attempt(g,seat,3,legal.raise.min),'the smallest raise it offers is accepted');
    assert.ok(attempt(g,seat,3,legal.raise.max),'and so is the largest');
    assert.ok(!attempt(g,seat,3,legal.raise.max+1),'one more is not');
    if(legal.raise.min<legal.raise.max)assert.ok(!attempt(g,seat,3,legal.raise.min-1),'nor is one less');
    if(legal.raise.min===legal.raise.max)shortAllIns++;
   }else assert.ok(!attempt(g,seat,3,g.currentBet+g.minRaise),'no raise when it offers none');
   const roll=random();
   if(legal.raise&&roll<0.45)act(g,seat,3,legal.raise.min+Math.floor(random()*(legal.raise.max-legal.raise.min+1)));
   else if(legal.check)act(g,seat,1);
   else if(roll<0.05)act(g,seat,0);
   else act(g,seat,2);
  }
 }
 assert.ok(raises>500&&shortAllIns>0,`the walk covered enough ground: ${raises} raises, ${shortAllIns} all-in only`);
});

test('a question says only what this player may know, in plain terms',{timeout:60000},()=>{
 const a=dealer(),question=a.question();
 assert.equal(question.type,'bet');
 const told=describe(question),text=JSON.stringify(told);
 assert.deepEqual(Object.keys(told).sort(),['bets','bigBlind','board','cards','dealer','hand','hands','history','legal','pot','stacks','street','toCall','type'].sort());
 for(const card of [...told.cards])assert.match(card,/^[2-9TJQKA][cdhs]$/);
 assert.equal(told.street,'preflop');assert.equal(told.dealer,'you');
 assert.deepEqual(told.bets,{you:10_000,opponent:20_000});assert.equal(told.toCall,10_000);assert.equal(told.pot,30_000);
 assert.deepEqual(told.board,[]);assert.deepEqual(told.history,[]);
 // No secret and nothing about the opponent's hidden cards.
 for(const secret of [a.state.setup.secret,JSON.stringify(a.state.setup.secret)])assert.ok(!text.includes(String(secret)));
 assert.ok(!/opponentCards|secret|session|signature|sig|key/i.test(text));
 // The same question from the other seat is the other way round.
 const view=structuredClone(question.view);view.seat=1;
 assert.deepEqual(describe({type:'bet',view}).bets,{you:20_000,opponent:10_000});
 assert.equal(describe({type:'bet',view}).dealer,'opponent');
});

test('replies become moves, and anything else counts as no reply',()=>{
 assert.deepEqual(parseReply('bet',{action:'fold'}),{action:0,amount:0});
 assert.deepEqual(parseReply('bet',{action:'check'}),{action:1,amount:0});
 assert.deepEqual(parseReply('bet',{action:'call'}),{action:2,amount:0});
 assert.deepEqual(parseReply('bet',{action:'raise',to:500}),{action:3,amount:500});
 assert.deepEqual(parseReply('bet',{action:'bet',to:500}),{action:3,amount:500});
 assert.deepEqual(parseReply('bet',{action:'all-in'}),{action:4,amount:0});
 assert.equal(parseReply('show',{show:true}),true);assert.equal(parseReply('show',{show:false}),false);
 for(const bad of [null,7,'call',[],{},{action:'dance'},{action:'raise'},{action:'raise',to:'500'},{action:'raise',to:1.5},{action:'raise',to:2**60},{action:'constructor'},{action:0}])assert.equal(parseReply('bet',bad),null,JSON.stringify(bad));
 for(const bad of [null,{},{show:'yes'},{show:1},{action:'call'}])assert.equal(parseReply('show',bad),null,JSON.stringify(bad));
});

test('nothing is signed or sent until the program has answered',{timeout:60000},()=>{
 const a=dealer(),seq=a.state.seq;
 assert.ok(a.question());
 assert.deepEqual(a.next(),[]);assert.deepEqual(a.resume(),[]);
 assert.equal(a.state.mine,null);assert.equal(a.state.signed[seq+1],undefined);
 // A reply to some other question counts for nothing.
 a.answer('1/0',{action:3,amount:60_000});
 assert.ok(a.question());assert.deepEqual(a.resume(),[]);assert.equal(a.state.signed[seq+1],undefined);
 a.answer(a.question().key,{action:2,amount:0});
 assert.equal(a.question(),null);
 const out=a.resume();
 assert.equal(out.length,1);assert.equal(out[0].step.action,2);assert.equal(out[0].seq,seq+1);
 assert.ok(a.state.signed[seq+1]);
});

test('a move the engine refuses, or no answer, means the safe default',{timeout:60000},()=>{
 // Facing the big blind, the safe default is to fold rather than put in more.
 for(const reply of [null,{action:3,amount:1},{action:1,amount:0},{action:99,amount:0}]){
  const a=dealer();
  a.answer(a.question().key,reply);
  const [move]=a.resume();
  assert.equal(move.step.action,0,JSON.stringify(reply));
  if(reply&&reply.action!==99)assert.ok(a.overruled,'and the agent can say why');
 }
 // With nothing to call, it checks.
 const pair=pairOf({},atFirstDecision());
 const asked=play(pair,[passive,()=>null],{stop:p=>p[1].state.s?.game?.street===1&&!!p[1].question()});
 assert.ok(asked[1].length>=1);
 assert.equal(pair[1].state.betting.at(-1).action,1,'the big blind checked, not folded, with no reply');
});

test('a restart never decides a signed step again, and may decide an unsigned one',{timeout:60000},()=>{
 const a=dealer(),key=a.question().key;
 // Crashed before signing: it just asks again, and can answer differently.
 const again=new ChannelPeer(config(),sessions[0],0,{outside:true,state:JSON.parse(JSON.stringify(a.state))});
 assert.equal(again.question().key,key);
 a.answer(key,{action:2,amount:0});
 const [move]=a.resume(),seq=move.seq;
 // Crashed after signing: the same move goes again, and the program isn't asked.
 const restarted=new ChannelPeer(config(),sessions[0],0,{outside:true,state:JSON.parse(JSON.stringify(a.state))});
 assert.equal(restarted.question(),null);
 assert.deepEqual(restarted.resend().filter(m=>m.type==='move'),[move]);
 restarted.answer(key,{action:0,amount:0});
 assert.deepEqual(restarted.resume(),[]);
 assert.equal(restarted.state.signed[seq].hash,a.state.signed[seq].hash);
});

test('a resend gets one answer, not an endless exchange, and a lost signature still gets through',{timeout:60000},()=>{
 const [a,b]=pairOf({},atFirstDecision());
 // Both hold everything at this step, so everything either of them resends is old news.
 const old=b.resend().find(m=>m.type==='ack');
 assert.ok(old);
 const answer=a.receive(old);
 assert.equal(answer.length,1);assert.equal(answer[0].echo,true);
 assert.deepEqual(b.receive(answer[0]),[],'the answer itself gets no answer');
 // A resent move also gets one answer, carrying the signature the sender may have lost.
 const move=a.resend().find(m=>m.type==='move');
 const reply=b.receive(move);
 assert.equal(reply.length,1);assert.equal(reply[0].sig,b.state.latest.sigs[1]);
 assert.deepEqual(a.receive(reply[0]),[]);
 assert.equal(a.state.rejected,0);assert.equal(b.state.rejected,0);
});

test('an acknowledgement stays ready to resend while the program thinks, and after it answers',{timeout:60000},()=>{
 const [a,b]=pairOf({},atFirstDecision());
 a.answer(a.question().key,{action:2,amount:0});
 const [move]=a.resume();
 // Seat 1 co-signs seat 0's move, then has its own decision to make.
 const out=b.receive(move);
 assert.deepEqual(out.map(m=>m.type),['ack'],'it can’t send a move yet');
 assert.ok(b.question(),'it has to think');
 assert.deepEqual(b.resend().map(m=>m.type),['ack'],'and the signature seat 0 needs can still go again');
 b.answer(b.question().key,{action:1,amount:0});
 const [check]=b.resume();
 assert.equal(check.step.action,1);
 assert.deepEqual(b.resend().map(m=>m.type),['ack','move'],'the acknowledgement might have been the message that got lost');
});

test('an on-chain move waits for the decision too',{timeout:60000},()=>{
 const a=dealer(),seq=a.state.seq;
 assert.throws(()=>a.chainMove(seq),/decision is still due/);
 assert.equal(a.state.signed[seq+1],undefined,'and nothing was signed');
 a.answer(a.question().key,{action:2,amount:0});
 const move=a.chainMove(seq);
 assert.equal(move.step.action,2);
});

test('falling back to an older state on chain rolls the betting record back with it',{timeout:60000},()=>{
 const [a,b]=pairOf({},atFirstDecision());
 const kept=structuredClone(a.state.s),seq=a.state.seq,payload=Buffer.from(a.state.latest.payload,'hex');
 a.answer(a.question().key,{action:2,amount:0});
 const [move]=a.resume();
 b.receive(move);
 a.receive(b.resend().find(m=>m.type==='ack'));
 assert.equal(a.state.betting.length,1);assert.equal(a.state.betting[0].action,2);
 a.adoptChainState(seq,payload);
 assert.deepEqual(a.state.betting,[],'that call never happened');
 assert.deepEqual(a.state.s.game,kept.game);
 // It signed a call at the next step, so a call is all it can do there, whatever a program might say now.
 assert.equal(a.question(),null);
 const restarted=new ChannelPeer(config(),sessions[0],0,{outside:true,state:JSON.parse(JSON.stringify(a.state))});
 assert.equal(restarted.question(),null,'even after a restart');
 const again=restarted.chainMove(seq);
 assert.equal(again.step.action,2);assert.equal(again.seq,move.seq);
});

test('the betting record says what really happened, including an all-in that only calls',{timeout:60000},()=>{
 const a=dealer();
 const record=(game,step)=>{a.state.s.game={...a.state.s.game,street:1,...game};a.state.betting=[];a.remember(0,70,step);return a.state.betting[0];};
 // Found by the simulation: all-in for less than the bet closes the round, and it was recorded as a raise to 0.
 assert.deepEqual(record({bets:[0,76_508],stacks:[21_984,900_000],currentBet:76_508},{action:4}),{seq:70,street:1,seat:0,action:4});
 assert.deepEqual(record({bets:[0,76_508],stacks:[76_508,900_000],currentBet:76_508},{action:4}),{seq:70,street:1,seat:0,action:4},'exactly the bet is still a call');
 assert.deepEqual(record({bets:[10_000,20_000],stacks:[90_000,900_000],currentBet:20_000},{action:4}),{seq:70,street:1,seat:0,action:4,to:100_000},'it’s the total for the street');
 assert.deepEqual(record({bets:[0,20_000],stacks:[900_000,900_000],currentBet:20_000},{action:3,amount:60_000}),{seq:70,street:1,seat:0,action:3,to:60_000});
 assert.deepEqual(record({bets:[0,20_000],stacks:[900_000,900_000],currentBet:20_000},{action:2}),{seq:70,street:1,seat:0,action:2});
 assert.equal(record({},{logical:4,wire:'00'}),undefined,'and a card share isn’t betting');
 assert.deepEqual(describeResult({hand:1,winner:1,reason:3,stacks:[0,100],seat:0,cards:null,opponentCards:[],board:[],betting:[{seq:70,street:1,seat:0,action:4}]}).history,[{street:'flop',player:'you',action:'all-in'}]);
});

test('a real bet: whoever got called shows first and is never asked, and the caller decides',{timeout:120000},()=>{
 const pair=pairOf();
 const asked=play(pair,[betRiver,shows(true)]);
 assert.equal(pair[0].state.stage,STAGE.CLOSED);
 assert.equal(asked[0].filter(q=>q.type==='show').length,0,'seat 0 bet the river and got called');
 assert.equal(asked[1].filter(q=>q.type==='show').length,1,'only seat 1 gets a choice');
 const [result]=pair[0].state.results;
 assert.equal(result.reason,1);assert.equal(result.aggressor,0);assert.equal(result.firstToShow,0);
 assert.equal(result.opponentCards.length,2,'seat 1 chose to show');
 const said=describeResult(result);
 assert.equal(said.reason,'showdown');
 assert.equal(said.history.filter(e=>e.action==='raise'&&e.street==='river').length,1);
 assert.deepEqual(pair[0].state.final,pair[1].state.final);
 assert.equal(pair[0].state.final[0]+pair[0].state.final[1],2_000_000);
});

test('a caller that mucks gives up the pot even with the better hand, and its cards stay hidden',{timeout:120000},()=>{
 const pair=pairOf();
 play(pair,[betRiver,shows(false)]);
 const [result]=pair[0].state.results;
 assert.equal(result.reason,3);assert.equal(result.winner,0);
 assert.deepEqual(result.opponentCards,[],'seat 0 never learns them');
 assert.deepEqual(pair[0].state.final,[1_040_000,960_000],'20,000 each before the river, and 20,000 each on it');
 assert.equal(describeResult(result).reason,'muck');
 assert.equal(pair[1].state.results[0].cards.length,2,'seat 1 still has its own record');
});

test('a called all-in shows first, once the board has run out',{timeout:120000},()=>{
 const pair=pairOf();
 const asked=play(pair,[shover,shows(false)]);
 assert.equal(asked[0].filter(q=>q.type==='show').length,0);
 assert.equal(asked[1].filter(q=>q.type==='show').length,1);
 const [result]=pair[0].state.results;
 assert.equal(result.aggressor,0);assert.equal(result.board.length,5);assert.equal(result.reason,3);
 assert.deepEqual(pair[0].state.final,[2_000_000,0],'it ends the match');
});

test('with no usable answer it shows a hand that wins or ties, and mucks one that loses',{timeout:120000},()=>{
 const pair=pairOf();
 let told=null;
 const asked=play(pair,[betRiver,q=>{if(q.type==='show'){told=q;return {show:'maybe'};}return passive(q);}]);
 assert.equal(asked[1].filter(q=>q.type==='show').length,1);
 const [result]=pair[0].state.results,worthShowing=told.winning||told.tied;
 assert.equal(result.reason,worthShowing?1:3,`winning ${told.winning}, tied ${told.tied}`);
 assert.equal(result.opponentCards.length,worthShowing?2:0);
});

test('with no bet on the river the first to act shows first, and the dealer decides',{timeout:120000},()=>{
 const pair=pairOf();
 const asked=play(pair,[shows(false),shows(true)]);
 assert.equal(asked[1].filter(q=>q.type==='show').length,0,'seat 1 acts first after the flop');
 assert.equal(asked[0].filter(q=>q.type==='show').length,1,'seat 0 has the button');
 assert.equal(pair[0].state.results[0].firstToShow,1);
});

test('a whole match of real betting: both sides agree, and every hand is on record',{timeout:240000},()=>{
 const pair=pairOf({maxHands:3});
 let seed=7;const random=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
 const wild=q=>{
  if(q.type==='show')return {show:random()<0.5};
  const roll=random();
  if(q.legal.raise&&roll<0.4)return {action:'raise',to:q.legal.raise.min+Math.floor(random()*(q.legal.raise.max-q.legal.raise.min+1)/8)};
  if(!q.legal.check&&roll<0.5)return {action:'fold'};
  return passive(q);
 };
 play(pair,[wild,wild]);
 assert.equal(pair[0].state.stage,STAGE.CLOSED);assert.equal(pair[1].state.stage,STAGE.CLOSED);
 assert.deepEqual(pair[0].state.final,pair[1].state.final);
 assert.equal(pair[0].state.final[0]+pair[0].state.final[1],2_000_000);
 assert.equal(pair[0].state.results.length,pair[0].state.hand);
 for(const seat of [0,1])for(const r of pair[seat].state.results)assert.deepEqual(r.stacks,pair[1-seat].state.results.find(x=>x.hand===r.hand).stacks);
 assert.equal(pair[0].state.rejected,0);assert.equal(pair[1].state.rejected,0);
});

// A real child process, for what a real one can do wrong.
const script=body=>`${process.execPath} -e ${JSON.stringify(`const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);${body}});`)}`.replaceAll('$','\\$');
const betQuestion=()=>({key:'1/1',type:'bet',view:{hand:1,hands:1,seat:0,cards:[0,1],board:[],stacks:[90,80],bets:[10,20],pot:30,bigBlind:20,button:0,owed:10,street:0,legal:{fold:true,check:false,call:10,raise:{min:40,max:100},allIn:100},history:[]}});
const showQuestion=()=>({key:'1/9',type:'show',view:{hand:1,hands:1,seat:1,cards:[0,1],opponentCards:[2,3],board:[4,5,6,7,8],winning:false,tied:false,pot:100}});
const program=(t,command,options={})=>{const p=new DecisionProgram(command,{limitMs:15_000,...options});t.after(()=>p.close());return p;};

test('a program gets the question and its reply comes back as a move',{timeout:30000},async t=>{
 const p=program(t,script(`console.log(JSON.stringify(q.type==='show'?{id:q.id,show:q.winning}:{id:q.id,action:'raise',to:q.legal.raise.min,seen:q.cards}));`));
 assert.deepEqual(await p.ask(betQuestion()),{action:3,amount:40});
 assert.equal(await p.ask(showQuestion()),false);
});
test('a reply to the wrong question, or anything that is not a reply, is ignored until the limit',{timeout:30000},async t=>{
 const logged=[];
 const p=program(t,script(`console.log('not json');console.log('[]');console.log('null');console.log(JSON.stringify({id:q.id+1000,action:'fold'}));`),{log:s=>logged.push(s)});
 const started=Date.now();
 assert.equal(await p.ask(betQuestion(),300),null);
 assert.ok(Date.now()-started<3000);
 assert.ok(logged.some(s=>/isn’t JSON/.test(s)));
 assert.ok(logged.some(s=>/didn’t answer/.test(s)));
});
test('a reply it can’t use is the safe default straight away, not a long wait',{timeout:30000},async t=>{
 const p=program(t,script(`console.log(JSON.stringify({id:q.id,action:'dance'}));`));
 const started=Date.now();
 assert.equal(await p.ask(betQuestion()),null);
 assert.ok(Date.now()-started<10_000);
});
test('a program that says nothing costs only the time limit',{timeout:30000},async t=>{
 const p=program(t,script(''));
 const started=Date.now();
 assert.equal(await p.ask(betQuestion(),300),null);
 const took=Date.now()-started;
 assert.ok(took>=280&&took<5000,`took ${took}ms`);
});
test('a reply over the size limit doesn’t count, even if it’s valid',{timeout:30000},async t=>{
 const logged=[];
 const p=program(t,script(`console.log(JSON.stringify({id:q.id,action:'fold',padding:'x'.repeat(65600)}));console.log(JSON.stringify({id:q.id,action:'call'}));`),{log:s=>logged.push(s)});
 assert.deepEqual(await p.ask(betQuestion()),{action:2,amount:0},'it took the reply that fits');
 assert.ok(logged.some(s=>/too long/.test(s)));
});
test('an endless line can’t fill memory, and the program can still answer after it',{timeout:30000},async t=>{
 const logged=[];
 const p=program(t,script(`process.stdout.write('x'.repeat(300000));console.log();console.log(JSON.stringify({id:q.id,action:'call'}));`),{log:s=>logged.push(s)});
 assert.deepEqual(await p.ask(betQuestion()),{action:2,amount:0});
 assert.ok(logged.some(s=>/too long/.test(s)));
 logged.length=0;
 const unending=program(t,script(`setInterval(()=>process.stdout.write('y'.repeat(100000)),5);`),{log:s=>logged.push(s)});
 assert.equal(await unending.ask(betQuestion(),400),null);
 assert.ok(logged.some(s=>/too long/.test(s)),'it stopped collecting the line');
});
test('a program that crashes is started again at the next decision',{timeout:30000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'stacks-decider-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const marker=join(directory,'ran');
 const p=program(t,script(`const fs=require('fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'');process.exit(3);}console.log(JSON.stringify({id:q.id,action:'call'}));`));
 const started=Date.now();
 assert.equal(await p.ask(betQuestion()),null,'the crash means no answer');
 assert.ok(Date.now()-started<10_000,'and it doesn’t wait out the limit');
 assert.deepEqual(await p.ask(betQuestion()),{action:2,amount:0});
 assert.equal(p.failures,0,'a good answer clears the count');
});
test('after repeated crashes it stops trying, and the agent plays on with the safe default',{timeout:30000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'stacks-decider-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const starts=join(directory,'starts'),logged=[],count=()=>readFileSync(starts,'utf8').length;
 const p=program(t,`printf x >> ${JSON.stringify(starts)}; exit 7`,{log:s=>logged.push(s)});
 for(let i=0;i<4;i++)assert.equal(await p.ask(betQuestion()),null);
 assert.ok(logged.some(s=>/too many times/.test(s)));
 assert.equal(count(),4);
 assert.equal(await p.ask(betQuestion()),null);
 assert.equal(await p.ask(betQuestion()),null);
 assert.equal(count(),4,'no more starts');
 assert.equal(p.child,null);
 p.tell({hand:1,winner:0,reason:0,stacks:[1,1],seat:0,cards:null,opponentCards:[],board:[],betting:[]});
});
test('a command that doesn’t exist is only a safe default, not a crash',{timeout:30000},async t=>{
 const p=program(t,'/no/such/program --anything');
 assert.equal(await p.ask(betQuestion()),null);
});
test('settings that may carry secrets don’t reach the program',{timeout:30000},async t=>{
 const env={...process.env,AGENT_STACKS_RPC:'https://rpc.example/?api-key=hidden',AGENT_STACKS_OTHER:'x',VISIBLE_TO_PROGRAM:'yes'};
 const p=program(t,script(`const leaked=Object.keys(process.env).filter(k=>k.startsWith('AGENT_STACKS')).length;console.log(JSON.stringify({id:q.id,action:leaked||process.env.VISIBLE_TO_PROGRAM!=='yes'?'fold':'call'}));`),{env});
 assert.deepEqual(await p.ask(betQuestion()),{action:2,amount:0});
});
test('closing stops the program and anything it started',{timeout:30000},async t=>{
 // It ignores the end of its input and would otherwise carry on.
 const p=program(t,script(`setInterval(()=>{},1000);console.log(JSON.stringify({id:q.id,action:'raise',to:process.pid}));`));
 const {amount:pid}=await p.ask(betQuestion());
 assert.doesNotThrow(()=>process.kill(pid,0));
 p.close();
 let gone=false;
 for(let i=0;i<100&&!gone;i++){try{process.kill(pid,0);await pause(50);}catch(error){gone=error.code==='ESRCH';}}
 assert.ok(gone);
 assert.equal(await p.ask(betQuestion()),null,'a closed program answers nothing');
});
test('it is told how each hand ended, with no reply expected',{timeout:30000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'stacks-decider-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const p=program(t,script(`if(q.type==='result'){globalThis.last=q;return;}console.log(JSON.stringify({id:q.id,action:globalThis.last?.reason==='muck'&&globalThis.last.winner==='you'?'call':'fold'}));`));
 p.tell({hand:1,winner:0,reason:3,stacks:[120,80],seat:0,cards:[0,1],opponentCards:[],board:[4,5,6,7,8],betting:[{seq:9,street:3,seat:0,action:3,to:40},{seq:10,street:3,seat:1,action:2}]});
 assert.deepEqual(await p.ask(betQuestion()),{action:2,amount:0});
 const said=describeResult({hand:1,winner:2,reason:1,stacks:[100,100],seat:1,cards:null,opponentCards:[0,1],board:[],betting:[{seq:9,street:3,seat:0,action:3,to:40}]});
 assert.equal(said.winner,'split');assert.deepEqual(said.history,[{street:'river',player:'opponent',action:'raise',to:40}]);
});

// The runner, with a scripted chain and decider.
function chainFor(state){
 const calls=[];
 return {calls,state,time:1000,read:async function(){return this.state;},chainTime:async function(){return this.time;},move:async(seat,chainSeq,step)=>{calls.push({type:'move',seat,chainSeq,step});return 'sig';},postHand:async(_s,seq)=>{calls.push({type:'post',seq});return 'sig';},exitWithDeposits:async()=>{calls.push({type:'exit'});return 'sig';},timeout:async()=>{calls.push({type:'timeout'});return 'sig';},onChainMoves:async()=>new Map(),closeBuffer:async()=>null};
}
const silent={send:async()=>{},receive:async()=>[]};
const settle=()=>new Promise(done=>setImmediate(done));
const runnerFor=(p,chain,decider,options={})=>new ChannelRunner({peer:p,chains:[chain],transport:silent,bufferKey:async()=>({publicKey:{toBase58:()=>'buffer'}}),decider,stallMs:1e9,chainPollMs:0,disputePollMs:0,...options});
const open=()=>({phase:OPEN,seq:0,window:0,deadline:0,version:1,blob:Buffer.alloc(0)});

test('an agent set up to ask a program refuses to run without one',{timeout:60000},()=>{
 assert.throws(()=>new ChannelRunner({peer:dealer(),chains:[],transport:silent}),/no program/);
});
test('a program that takes forever holds up nothing: the relay and chain keep going, with no false alarm',{timeout:60000},async()=>{
 const a=dealer(),limits=[],received=[{type:'junk'}];
 const decider={limitMs:5000,ask:(_q,limit)=>{limits.push(limit);return new Promise(()=>{});}};
 const chain=chainFor(open());let reads=0;const read=chain.read.bind(chain);chain.read=async()=>{reads++;return read();};
 const r=runnerFor(a,chain,decider,{stallMs:1,transport:{send:async()=>{},receive:async()=>received.splice(0)}});
 for(let i=0;i<5;i++){await r.tick();await settle();await pause(3);}
 assert.equal(limits.length,1,'it asked once');assert.equal(limits[0],5000);
 assert.ok(reads>=4,'chain checks went on');
 assert.equal(a.state.rejected,1,'relay messages were still handled');
 assert.equal(a.state.disputed,false,'its own thinking isn’t the opponent going quiet');
 assert.deepEqual(chain.calls,[]);
});
test('once it answers the move goes out, and it isn’t asked again',{timeout:60000},async()=>{
 const a=dealer(),sent=[];let asked=0;
 const decider={limitMs:5000,ask:async question=>{asked++;assert.equal(question.type,'bet');return {action:2,amount:0};}};
 const r=runnerFor(a,chainFor(open()),decider,{chainPollMs:1e9,transport:{send:async m=>sent.push(m),receive:async()=>[]}});
 for(let i=0;i<4;i++){await r.tick();await settle();await r.sending;}
 assert.equal(asked,1);
 // Its last card share may go again too, which is harmless. This is about the betting move.
 const moves=sent.filter(m=>m.type==='move'&&m.step.action!==undefined);
 assert.equal(moves.length,1);assert.equal(moves[0].step.action,2);
});
test('a decider that throws only means the safe default',{timeout:60000},async()=>{
 const a=dealer(),sent=[],logged=[];
 const decider={limitMs:5000,ask:async()=>{throw Error('boom');}};
 const r=runnerFor(a,chainFor(open()),decider,{chainPollMs:1e9,log:s=>logged.push(s),transport:{send:async m=>sent.push(m),receive:async()=>[]}});
 for(let i=0;i<4;i++){await r.tick();await settle();await r.sending;}
 assert.ok(logged.some(s=>/boom/.test(s)));
 assert.equal(sent.find(m=>m.type==='move'&&m.step.action!==undefined).step.action,0,'folds rather than put in more');
});
test('an illegal move from the program is logged and overruled',{timeout:60000},async()=>{
 const a=dealer(),sent=[],logged=[];
 const decider={limitMs:5000,ask:async()=>({action:3,amount:1})};
 const r=runnerFor(a,chainFor(open()),decider,{chainPollMs:1e9,log:s=>logged.push(s),transport:{send:async m=>sent.push(m),receive:async()=>[]}});
 for(let i=0;i<4;i++){await r.tick();await settle();await r.sending;}
 assert.ok(logged.some(s=>/isn’t allowed/.test(s)));
 assert.equal(sent.find(m=>m.type==='move'&&m.step.action!==undefined).step.action,0);
});
// In a dispute, at the state both signed, with seat 0 to decide.
const disputed=(a,overrides)=>({phase:8,seq:a.state.seq,window:100,deadline:1200,version:3,blob:encodeHand(a.state.s),...overrides});
test('in a dispute a decision gets at most half the time left on the clock',{timeout:60000},async()=>{
 const a=dealer();a.markDisputed();
 const limits=[];let release;
 const decider={limitMs:60_000,ask:(_q,limit)=>{limits.push(limit);return new Promise(done=>{release=done;});}};
 const chain=chainFor(disputed(a,{deadline:1030}));
 const r=runnerFor(a,chain,decider);
 await r.tick();await settle();
 assert.deepEqual(limits,[15_000],'30 seconds left, so 15 to decide');
 assert.deepEqual(chain.calls,[],'nothing moves until the answer');
 await r.tick();await settle();
 assert.equal(limits.length,1,'it isn’t asked twice');
 release({action:2,amount:0});await settle();await settle();
 await r.tick();await settle();
 assert.equal(chain.calls.length,1);assert.equal(chain.calls[0].type,'move');assert.equal(chain.calls[0].step.action,2);
});
test('a long clock doesn’t stretch the program’s time limit',{timeout:60000},async()=>{
 const a=dealer();a.markDisputed();
 const limits=[];
 const decider={limitMs:20_000,ask:(_q,limit)=>{limits.push(limit);return new Promise(()=>{});}};
 await runnerFor(a,chainFor(disputed(a,{deadline:9000})),decider).tick();await settle();
 assert.deepEqual(limits,[20_000]);
});
test('right at the deadline it doesn’t wait for the program, and moves with the safe default',{timeout:60000},async()=>{
 const a=dealer();a.markDisputed();
 let asked=0;
 const decider={limitMs:60_000,ask:()=>{asked++;return new Promise(()=>{});}};
 const chain=chainFor(disputed(a,{deadline:1005}));
 await runnerFor(a,chain,decider).tick();
 assert.equal(asked,0);
 assert.equal(chain.calls[0]?.type,'move');assert.equal(chain.calls[0].step.action,0);
});
test('a program stuck past the clock still can’t lose the agent its move',{timeout:60000},async()=>{
 const a=dealer();a.markDisputed();
 const decider={limitMs:60_000,ask:()=>new Promise(()=>{})};
 const chain=chainFor(disputed(a,{deadline:1100}));
 const r=runnerFor(a,chain,decider);
 await r.tick();await settle();
 assert.deepEqual(chain.calls,[]);
 chain.time=1095;
 await r.tick();await settle();
 assert.equal(chain.calls[0]?.type,'move','the clock wins');
});
test('the program is told how each hand ended, exactly once',{timeout:120000},async()=>{
 const pair=pairOf();
 play(pair,[passive,passive],{stop:p=>p[0].state.results?.length>0});
 const told=[];
 const decider={limitMs:5000,ask:async()=>null,tell:r=>told.push(r)};
 const r=runnerFor(pair[0],chainFor(open()),decider,{chainPollMs:1e9});
 for(let i=0;i<3;i++){await r.tick();await settle();}
 assert.equal(told.length,1);assert.equal(told[0].hand,1);
});
