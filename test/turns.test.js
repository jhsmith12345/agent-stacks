// Playing by running commands, one decision at a time. The match and the commands only share a private folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {writePrivate} from '../src/private-files.js';
import {finishTurns,matchRunning,moveTaken,nextTurn,readMove,recordProcess,submitMove,TurnDecider} from '../src/channel/turns.js';
const SCRIPT=fileURLToPath(new URL('../scripts/stacks.js',import.meta.url));
const legal={fold:true,check:false,call:20_000,raise:{min:40_000,max:960_000},allIn:960_000};
const view={seat:0,hand:2,hands:3,street:1,button:0,cards:[0,1],board:[2,3,4],stacks:[960_000,940_000],bets:[0,20_000],pot:100_000,owed:20_000,bigBlind:20_000,legal,history:[]};
const bet=(key='2/17',overrides={})=>({key,type:'bet',view:{...view,...overrides}});
const show=(key='2/30',winning=false)=>({key,type:'show',view:{seat:0,hand:2,hands:3,cards:[0,1],opponentCards:[5,6],board:[2,3,4,7,8],winning,tied:false,pot:300_000}});
const result=hand=>({seat:0,hand,winner:0,reason:0,stacks:[1_000_000,1_000_000],cards:[0,1],opponentCards:[5,6],board:[],betting:[]});
function folder(t){
 const home=mkdtempSync(join(tmpdir(),'turns-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const directory=join(home,'turns');
 const decider=new TurnDecider(directory,{limitMs:30_000,pollMs:5});
 recordProcess(directory,process.pid);
 t.after(()=>decider.close());
 return {home,directory,decider};
}
const quick={waitMs:0,pollMs:5};
const first=async directory=>{for(let tries=0;tries<400;tries++){const turn=await nextTurn(directory,quick);if(turn.type!=='waiting')return turn;await pause(5);}throw Error('Nothing was offered');};

test('a decision goes out by next, and comes back by move',async t=>{
 const {directory,decider}=folder(t);
 const asked=decider.ask(bet());
 const turn=await first(directory);
 assert.equal(turn.type,'bet');assert.equal(turn.id,'2/17');
 assert.deepEqual(turn.legal,legal);assert.equal(turn.toCall,20_000);assert.deepEqual(turn.stacks,{you:960_000,opponent:940_000});
 assert.ok(turn.secondsLeft>0&&turn.secondsLeft<=30);assert.equal(turn.seconds,30);
 assert.equal(turn.deadline,undefined,'it’s told how long it has, in the same terms as a program');
 assert.deepEqual(turn.moves,['move 2/17 fold','move 2/17 call','move 2/17 raise TO','move 2/17 all-in'],'and exactly what it can do');
 assert.match(turn.raiseTo,/from 40000 to 960000/);
 assert.deepEqual(submitMove(directory,'2/17',['raise','60000']),{action:'raise',to:60_000});
 assert.deepEqual(await asked,{action:3,amount:60_000},'what the engine is handed');
 assert.ok(await moveTaken(directory));
 assert.equal((await nextTurn(directory,quick)).type,'waiting','and it isn’t asked twice');
 assert.throws(()=>submitMove(directory,'2/17',['call']),/isn’t waiting/,'nor can it be answered twice');
});

test('show or muck works the same way',async t=>{
 const {directory,decider}=folder(t);
 let asked=decider.ask(show());
 let turn=await first(directory);
 assert.equal(turn.type,'show');assert.deepEqual(turn.moves,['move 2/30 show','move 2/30 muck']);assert.equal(turn.winning,false);
 submitMove(directory,'2/30',['muck']);
 assert.equal(await asked,false);
 asked=decider.ask(show('2/40'));await first(directory);
 submitMove(directory,'2/40',['show']);
 assert.equal(await asked,true);
});

test('a bad move is refused with the reason, while there’s still time to answer again',async t=>{
 const {directory,decider}=folder(t);
 const asked=decider.ask(bet());
 await first(directory);
 const refused={
  'check':/can’t check.*20000/,'raise':/whole number/,'raise 39999':/out of range/,'raise 960001':/out of range/,'raise 1.5':/whole number/,'raise -40000':/whole number/,'raise 4e5':/whole number/,
  'raise 0x10000':/whole number/,'raise 99999999999999999999':/whole number/,'call 5':/Too many words/,'raise 50000 now':/Too many words/,'show':/Say one of/,'muck':/Say one of/,'allin':/Say one of/,'':/Say one of/,
 };
 for(const [words,reason] of Object.entries(refused))assert.throws(()=>submitMove(directory,'2/17',words?words.split(' '):[]),reason,words);
 assert.equal(existsSync(join(directory,'answer.json')),false,'none of that reached the match');
 submitMove(directory,'2/17',['bet','40000']);
 assert.deepEqual(await asked,{action:3,amount:40_000},'a bet is a raise, and the edges of the range are fine');
});

test('each kind of bad move is told apart from what’s allowed',()=>{
 const free={fold:true,check:true,call:null,raise:{min:20_000,max:100_000},allIn:100_000};
 assert.deepEqual(readMove({type:'bet',legal:free},['check']),{action:'check'});
 assert.deepEqual(readMove({type:'bet',legal:free},['fold']),{action:'fold'});
 assert.throws(()=>readMove({type:'bet',legal:free},['call']),/nothing to call/);
 const noRaise={fold:true,check:false,call:50_000,raise:null,allIn:null};
 assert.deepEqual(readMove({type:'bet',legal:noRaise},['call']),{action:'call'});
 assert.throws(()=>readMove({type:'bet',legal:noRaise},['raise','100000']),/can’t bet or raise/);
 assert.throws(()=>readMove({type:'bet',legal:noRaise},['all-in']),/can’t go all-in/);
 assert.throws(()=>readMove({type:'show'},['call']),/show or muck/);
});

test('an answer to an old decision can’t land on the next one',async t=>{
 const {directory,decider}=folder(t);
 assert.equal(await decider.ask(bet('2/17'),60),null,'too slow means the safe default');
 assert.throws(()=>submitMove(directory,'2/17',['raise','60000']),/isn’t waiting/);
 const nextOne=decider.ask(bet('2/19'));
 await first(directory);
 assert.throws(()=>submitMove(directory,'2/17',['raise','60000']),/has passed, and 2\/19 is waiting/);
 submitMove(directory,'2/19',['fold']);
 assert.deepEqual(await nextOne,{action:0,amount:0});
});

test('a stale answer left behind by a crash is thrown away, and one for the same decision still counts',async t=>{
 const {directory,decider}=folder(t);
 writePrivate(join(directory,'answer.json'),JSON.stringify({id:'1/5',reply:{action:'all-in'}}));
 const asked=decider.ask(bet('2/17'),2000);
 await first(directory);
 assert.equal(existsSync(join(directory,'answer.json')),false);
 submitMove(directory,'2/17',['call']);
 assert.deepEqual(await asked,{action:2,amount:0});
 decider.close();
 // Answered, and the match died before it could read that.
 writePrivate(join(directory,'answer.json'),JSON.stringify({id:'2/21',reply:{action:'call'}}));
 const again=new TurnDecider(directory,{limitMs:2000,pollMs:5});
 t.after(()=>again.close());
 assert.deepEqual(await again.ask(bet('2/21')),{action:2,amount:0});
});

test('what happened since the last look is reported once, including decisions that went by',async t=>{
 const {directory,decider}=folder(t);
 decider.tell(result(1));
 await decider.ask(bet('2/17',{owed:0,legal:{...legal,check:true,call:null}}),30);
 await decider.ask(bet('2/19'),30);
 await decider.ask(show('2/30',true),30);
 const look=await nextTurn(directory,quick);
 assert.deepEqual(look.since.map(e=>[e.type,e.hand]),[['result',1],['missed',2],['missed',2],['missed',2]]);
 assert.deepEqual(look.since.slice(1).map(e=>e.applied),[{action:'check'},{action:'fold'},{show:true}],'it says what was played for it');
 assert.equal((await nextTurn(directory,quick)).since,undefined);
 decider.tell(result(2));
 assert.deepEqual((await nextTurn(directory,quick)).since.map(e=>e.hand),[2]);
});

test('a restart tells every hand again, and the agent still only hears each one once',async t=>{
 const {directory,decider}=folder(t);
 decider.tell(result(1));decider.tell(result(2));
 assert.equal((await nextTurn(directory,quick)).since.length,2);
 decider.close();
 const again=new TurnDecider(directory);
 t.after(()=>again.close());
 again.tell(result(1));again.tell(result(2));again.tell(result(3));
 assert.deepEqual((await nextTurn(directory,quick)).since.map(e=>e.hand),[3]);
});

test('a restart keeps what the agent hasn’t heard yet, and doesn’t lose track of what it has',async t=>{
 const {directory,decider}=folder(t);
 await decider.ask(bet('1/5'),30);
 decider.tell(result(1));
 assert.deepEqual((await nextTurn(directory,quick)).since.map(e=>e.type),['missed','result']);
 decider.close();
 const again=new TurnDecider(directory);
 t.after(()=>again.close());
 again.tell(result(1));again.tell(result(2));
 assert.deepEqual((await nextTurn(directory,quick)).since.map(e=>e.hand),[2],'the next hand still gets through');
});

test('a decision from before a restart isn’t offered, because it may no longer be owed',async t=>{
 const {directory,decider}=folder(t);
 void decider.ask(bet('2/17'));
 assert.equal((await first(directory)).id,'2/17');
 decider.close();
 const again=new TurnDecider(directory);
 t.after(()=>again.close());
 assert.equal((await nextTurn(directory,quick)).type,'waiting');
 assert.throws(()=>submitMove(directory,'2/17',['call']),/isn’t waiting/);
});

test('a decision with under a second left isn’t offered, because no answer could arrive in time',async t=>{
 const {directory,decider}=folder(t);
 const asked=decider.ask(bet(),400);
 assert.equal((await nextTurn(directory,quick)).type,'waiting');
 assert.equal(await asked,null);
});

test('a question left behind by a dead match is not offered, and it says how to carry on',async t=>{
 const {home,directory,decider}=folder(t);
 void decider.ask(bet());
 await first(directory);
 decider.closed=true;
 const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))']);
 recordProcess(directory,Number(dead.stdout));
 writePrivate(join(home,'log.txt'),'first line\nStopped: the node went away\n');
 assert.equal(matchRunning(directory),false);
 const turn=await nextTurn(directory,{...quick,command:words=>`node scripts/stacks.js ${words}`});
 assert.equal(turn.type,'stopped');
 assert.equal(turn.reason,'Stopped: the node went away');
 assert.equal(turn.resume,'node scripts/stacks.js resume');
});

test('next gives up after a while, so a shell’s time limit never decides anything',async t=>{
 const {home,directory}=folder(t);
 writePrivate(join(home,'log.txt'),'Waiting for the other player.\n');
 const started=Date.now();
 const turn=await nextTurn(directory,{waitMs:120,pollMs:5,command:words=>`stacks ${words}`});
 assert.ok(Date.now()-started>=120);
 assert.equal(turn.type,'waiting');assert.equal(turn.status,'Waiting for the other player.');assert.match(turn.note,/stacks next/);
});

test('the end of the match is reported, however the commands were left',async t=>{
 const {directory,decider}=folder(t);
 decider.tell(result(3));
 finishTurns(directory,{summary:'Match over after 3 hands.',started:1_000_000,finished:1_200_000,hands:3});
 const turn=await nextTurn(directory,quick);
 assert.equal(turn.type,'over');assert.equal(turn.finished,1_200_000);assert.deepEqual(turn.since.map(e=>e.hand),[3]);
 recordProcess(directory,999_999_999);
 assert.equal((await nextTurn(directory,quick)).type,'over','even with the match’s process long gone');
});

test('nothing but the owner can read any of it, since it holds this player’s cards',async t=>{
 const {directory,decider}=folder(t);
 decider.tell(result(1));
 const asked=decider.ask(bet());
 await first(directory);
 submitMove(directory,'2/17',['fold']);
 for(const name of readdirSync(directory))assert.equal(statSync(join(directory,name)).mode&0o077,0,name);
 assert.equal(statSync(directory).mode&0o077,0);
 await asked;
});

test('closing stops a decision waiting for an answer',async t=>{
 const {decider}=folder(t);
 const asked=decider.ask(bet());
 decider.close();
 assert.equal(await asked,null);
});

test('the commands need no wallet and no network, and say what’s wrong',t=>{
 const home=mkdtempSync(join(tmpdir(),'turns-cli-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const run=(...args)=>spawnSync(process.execPath,[SCRIPT,...args,'--home',home,'--rpc','http://127.0.0.1:1'],{encoding:'utf8',timeout:20_000});
 let done=run('next');
 assert.equal(done.status,1);assert.match(done.stderr,/No match has been started/);
 assert.deepEqual(readdirSync(home),[],'not even a wallet was made');
 const directory=join(home,'match','turns');
 const decider=new TurnDecider(directory,{limitMs:15_000,pollMs:5});
 t.after(()=>decider.close());
 recordProcess(directory,process.pid);
 writePrivate(join(home,'current'),'match');
 done=run('next','--wait','0');
 assert.equal(done.status,0);assert.equal(JSON.parse(done.stdout).type,'waiting');
 done=run('next','--wait','never');
 assert.equal(done.status,1);assert.match(done.stderr,/Invalid --wait/);
 done=run('move');
 assert.equal(done.status,1);assert.match(done.stderr,/Say which decision/);
 done=run('move','2/17','call');
 assert.equal(done.status,1);assert.match(done.stderr,/isn’t waiting/);
 finishTurns(directory,{summary:'done'});
 done=run('next');
 assert.equal(JSON.parse(done.stdout).type,'over');
});
