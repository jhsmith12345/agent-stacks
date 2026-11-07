// Lets an agent that can only run shell commands play, one decision at a time. The match runs in its own process,
// and `stacks next` and `stacks move` reach it through files in a private folder. A command that gets cut off costs
// nothing: only `move` changes anything, and it names the decision it answers, so a late one can't land on the next.
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {privateDirectory,readPrivate,writePrivate} from '../private-files.js';
import {describe,describeResult,parseReply,safeDefault} from './decider.js';
const QUESTION='question.json',ANSWER='answer.json',EVENTS='events.json',SEEN='seen.json',OVER='over.json',PROCESS='process.json';
// Writes replace the whole file in one step, so a reader sees all of it or none of it.
const readIf=file=>{try{return JSON.parse(readPrivate(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
// The match's side. It answers to the same calls as a decision program.
export class TurnDecider{
 constructor(directory,{limitMs=300_000,pollMs=200,log=()=>{}}={}){
  privateDirectory(directory);
  Object.assign(this,{directory,limitMs,pollMs,log,closed:false,events:readIf(join(directory,EVENTS))??[]});
  // Whoever was asking has gone. If the decision is still owed, it gets asked again under the same id.
  rmSync(this.file(QUESTION),{force:true});
 }
 file(name){return join(this.directory,name);}
 note(event){this.events.push(event);writePrivate(this.file(EVENTS),JSON.stringify(this.events));}
 // In this order, so that once the answer has gone, a `next` can't still see the question it answered.
 clear(){rmSync(this.file(QUESTION),{force:true});rmSync(this.file(ANSWER),{force:true});}
 // Always settles within the limit. Null means the safe default applies.
 async ask(question,limitMs=this.limitMs){
  const described=describe(question),id=question.key,deadline=Date.now()+limitMs;
  writePrivate(this.file(QUESTION),JSON.stringify({...described,id,seconds:Math.floor(limitMs/1000),deadline}));
  while(!this.closed){
   const answer=readIf(this.file(ANSWER));
   if(answer?.id===id){this.clear();return parseReply(question.type,answer.reply);}
   if(answer)rmSync(this.file(ANSWER),{force:true});
   if(Date.now()>=deadline){
    this.clear();
    this.log(`Nobody answered decision ${id} within ${Math.round(limitMs/1000)}s, so the safe default applies`);
    this.note({type:'missed',id,hand:described.hand,street:described.street??'show',applied:safeDefault(described)});
    return null;
   }
   await pause(this.pollMs);
  }
  return null;
 }
 // A restart tells every hand again, and each should only be reported once.
 tell(result){
  const event=describeResult(result);
  if(!this.events.some(e=>e.type==='result'&&e.hand===event.hand))this.note(event);
 }
 close(){this.closed=true;}
}
export const finishTurns=(directory,summary)=>writePrivate(join(directory,OVER),JSON.stringify(summary));
export const recordProcess=(directory,pid)=>writePrivate(join(directory,PROCESS),JSON.stringify({pid}));
export function matchRunning(directory){
 const pid=readIf(join(directory,PROCESS))?.pid;
 if(!Number.isSafeInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
}
// A word or two from the command line, as the reply a program would have sent. It says what's wrong while there's
// still time to answer again, which a program's bad reply never gets, and the engine still has the last word.
export function readMove(question,words){
 const [word,amount]=words;
 if(words.length>(word==='raise'||word==='bet'?2:1))throw Error(`Too many words: ${words.join(' ')}`);
 if(question.type==='show'){
  if(word==='show')return {show:true};
  if(word==='muck')return {show:false};
  throw Error('This decision is whether to show your cards. Say show or muck.');
 }
 const {legal}=question;
 switch(word){
  case 'fold':return {action:'fold'};
  case 'check':
   if(!legal.check)throw Error(`You can’t check here: it costs ${legal.call} to call. Say call, fold or raise.`);
   return {action:'check'};
  case 'call':
   if(!legal.call)throw Error('There’s nothing to call. Say check, or raise.');
   return {action:'call'};
  case 'all-in':
   if(!legal.allIn)throw Error('You can’t go all-in here.');
   return {action:'all-in'};
  case 'raise':case 'bet':{
   if(!legal.raise)throw Error('You can’t bet or raise here.');
   const to=Number(amount);
   if(!/^\d+$/.test(amount??'')||!Number.isSafeInteger(to))throw Error(`Say how much in lamports, as a whole number: ${word} TO, where TO is your total on this street, from ${legal.raise.min} to ${legal.raise.max}.`);
   if(to<legal.raise.min||to>legal.raise.max)throw Error(`${to} is out of range. TO is your total on this street, from ${legal.raise.min} to ${legal.raise.max}.`);
   return {action:'raise',to};
  }
  default:throw Error(`Say one of: fold, check, call, raise TO, all-in. Not: ${words.join(' ')||'nothing'}`);
 }
}
// The exact commands that would answer this decision, so an agent that has lost its place needs nothing else.
function movesFor(question,command){
 const say=word=>command(`move ${question.id} ${word}`);
 if(question.type==='show')return [say('show'),say('muck')];
 const {legal}=question;
 return [say('fold'),...(legal.check?[say('check')]:[]),...(legal.call?[say('call')]:[]),...(legal.raise?[say('raise TO')]:[]),...(legal.allIn?[say('all-in')]:[])];
}
export function submitMove(directory,id,words){
 const question=readIf(join(directory,QUESTION));
 if(!question)throw Error(`Decision ${id} isn’t waiting for an answer. Run next to see where things are.`);
 if(question.id!==id)throw Error(`Decision ${id} has passed, and ${question.id} is waiting now. Run next to see it.`);
 const reply=readMove(question,words);
 writePrivate(join(directory,ANSWER),JSON.stringify({id,reply}));
 return reply;
}
// Whether the match has picked it up yet.
export async function moveTaken(directory,{waitMs=5000,pollMs=50}={}){
 const until=Date.now()+waitMs;
 while(existsSync(join(directory,ANSWER))){
  if(Date.now()>=until)return false;
  await pause(pollMs);
 }
 return true;
}
const lastLine=file=>{try{return readFileSync(file,'utf8').trim().split('\n').at(-1)||null;}catch{return null;}};
// A match where agents check in every few minutes rather than sitting over it.
export const slowMatch=think=>think>=600;
// How to look for your turn. A long wait never delays a decision, because next comes back as soon as there is one.
export const checkIn=think=>slowMatch(think)?'next --wait 300':'next';
// What an agent should do now: a decision to make, or word that the match is over, stopped, or nothing's due yet.
// This only ever waits for so long, because the shell it's running in may not let a command run for long.
export async function nextTurn(directory,{waitMs=60_000,pollMs=250,command=words=>words,again='next'}={}){
 const log=join(dirname(directory),'log.txt'),started=Date.now();
 // Hands that ended and decisions that went by since the last time anyone asked.
 const reporting=result=>{
  const seen=readIf(join(directory,SEEN))?.count??0,events=readIf(join(directory,EVENTS))??[];
  if(events.length>seen)writePrivate(join(directory,SEEN),JSON.stringify({count:events.length}));
  return events.length>seen?{...result,since:events.slice(seen)}:result;
 };
 for(;;){
  const over=readIf(join(directory,OVER));
  if(over)return reporting({type:'over',...over});
  // A question left behind by a match that has died can't be answered until it's running again.
  if(!matchRunning(directory))return reporting({type:'stopped',reason:lastLine(log),resume:command('resume')});
  const question=readIf(join(directory,QUESTION));
  if(question&&!existsSync(join(directory,ANSWER))){
   const {deadline,...asked}=question,secondsLeft=Math.floor((deadline-Date.now())/1000);
   if(secondsLeft>0)return reporting({...asked,secondsLeft,moves:movesFor(question,command),...(asked.legal?.raise?{raiseTo:`TO is your total on this street in lamports, from ${asked.legal.raise.min} to ${asked.legal.raise.max}`}:{})});
  }
  if(Date.now()-started>=waitMs)return reporting({type:'waiting',status:lastLine(log),note:`Nothing for you to decide yet. Run this again: ${command(again)}`});
  await pause(pollMs);
 }
}
