// Lets a separate program make the poker decisions, in any language. It reads one JSON question per line on
// stdin and replies with one JSON line on stdout. It only ever sees this player's own cards and public game
// state, never a key. Whatever it replies is only a proposal: the engine checks every move, and a bad answer,
// a slow one or none at all means the safe default. See docs/connect-your-agent.md.
import {spawn} from 'node:child_process';
import {CARDS} from '../mental-poker/deck.js';
const MAX_LINE=64*1024,MAX_RESTARTS=3,MAX_LOG_LINES=200;
const STREETS=['preflop','flop','turn','river'],ACTIONS=['fold','check','call','raise','all-in'],REASONS=['fold','showdown','forfeit','muck'];
const names=cards=>cards.map(c=>CARDS[c]);
const whose=(seat,me)=>seat===me?'you':'opponent';
const both=(pair,me)=>({you:pair[me],opponent:pair[1-me]});
const history=(entries,me)=>entries.map(e=>({street:STREETS[e.street],player:whose(e.seat,me),action:ACTIONS[e.action],...(e.to===undefined?{}:{to:e.to})}));
// What the program is told. All amounts are lamports, and a raise is the total to reach on this street.
export function describe({type,view}){
 const me=view.seat;
 if(type==='show')return {type,hand:view.hand,hands:view.hands,cards:names(view.cards),opponentCards:names(view.opponentCards),board:names(view.board),winning:view.winning,tied:view.tied,pot:view.pot};
 return {type,hand:view.hand,hands:view.hands,street:STREETS[view.street],dealer:whose(view.button,me),cards:names(view.cards),board:names(view.board),stacks:both(view.stacks,me),bets:both(view.bets,me),pot:view.pot,toCall:view.owed,bigBlind:view.bigBlind,legal:view.legal,history:history(view.history,me)};
}
export function describeResult(r){
 const me=r.seat;
 return {type:'result',hand:r.hand,winner:r.winner===2?'split':whose(r.winner,me),reason:REASONS[r.reason],stacks:both(r.stacks,me),cards:r.cards?names(r.cards):null,opponentCards:names(r.opponentCards),board:names(r.board),history:history(r.betting,me)};
}
// What the peer is handed. Null means no usable reply, and the legality of a move is the engine's to judge.
export function parseReply(type,reply){
 if(!reply||typeof reply!=='object')return null;
 if(type==='show')return typeof reply.show==='boolean'?reply.show:null;
 if(reply.action==='raise'||reply.action==='bet')return Number.isSafeInteger(reply.to)?{action:3,amount:reply.to}:null;
 const action=ACTIONS.indexOf(reply.action);
 return action>=0?{action,amount:0}:null;
}
export class DecisionProgram{
 constructor(command,{limitMs=20_000,log=()=>{},env=process.env}={}){
  Object.assign(this,{command,limitMs,log,failures:0,nextId:0,pending:new Map(),child:null,closed:false,logged:0});
  // A connection string can carry an API key, and the program has no use for any of these.
  this.env=Object.fromEntries(Object.entries(env).filter(([name])=>!name.startsWith('AGENT_STACKS_')));
 }
 start(){
  if(this.child||this.closed||this.failures>MAX_RESTARTS)return this.child;
  // Its own process group, so closing it also stops anything the command itself started.
  const child=spawn(this.command,{shell:true,detached:true,stdio:['pipe','pipe','pipe'],env:this.env});
  child.stdin.on('error',()=>{});
  this.lines(child.stdout,line=>this.onLine(line));
  this.lines(child.stderr,line=>this.onLog(line));
  child.on('error',error=>this.log(`decision program: ${error.message}`));
  child.once('close',code=>this.onClose(child,code));
  return this.child=child;
 }
 // A program that never ends a line can't make this agent hold on to an endless buffer.
 lines(stream,handle){
  let buffer='',skipping=false;
  stream.setEncoding('utf8');
  stream.on('data',chunk=>{
   buffer+=chunk;
   for(;;){
    const end=buffer.indexOf('\n');
    if(end<0)break;
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    if(skipping)skipping=false;else if(line.length<=MAX_LINE)handle(line);else this.log('decision program: ignored a line that was too long');
   }
   if(buffer.length>MAX_LINE){buffer='';if(!skipping)this.log('decision program: ignored a line that was too long');skipping=true;}
  });
 }
 onLog(line){
  if(this.logged<MAX_LOG_LINES)this.log(`decision program says: ${line.slice(0,300)}`);
  if(++this.logged===MAX_LOG_LINES)this.log('decision program: not logging any more of its output');
 }
 onLine(line){
  let reply;
  try{reply=JSON.parse(line);}catch{this.log('decision program: ignored a line that isn’t JSON');return;}
  const waiting=this.pending.get(reply?.id);
  if(!waiting)return;
  this.failures=0;
  const parsed=parseReply(waiting.type,reply);
  if(parsed===null)this.log(`decision program: couldn’t use the reply to question ${reply.id}, so the safe default applies`);
  waiting.finish(parsed);
 }
 onClose(child,code){
  if(this.child===child)this.child=null;
  if(this.closed)return;
  this.failures++;
  this.log(this.failures>MAX_RESTARTS?`decision program exited (${code}) too many times, so the safe default applies from now on`:`decision program exited (${code}), and starts again at the next decision`);
  for(const waiting of [...this.pending.values()])waiting.finish(null);
 }
 // Always settles within the limit, and never rejects.
 ask(question,limitMs=this.limitMs){
  return new Promise(done=>{
   const child=this.start();
   if(!child){done(null);return;}
   const id=++this.nextId;
   const timer=setTimeout(()=>{this.log(`decision program didn’t answer within ${Math.round(limitMs/1000)}s, so the safe default applies`);finish(null);},limitMs);
   timer.unref?.();
   const finish=value=>{clearTimeout(timer);this.pending.delete(id);done(value);};
   this.pending.set(id,{type:question.type,finish});
   child.stdin.write(`${JSON.stringify({...describe(question),id,seconds:Math.floor(limitMs/1000)})}\n`);
  });
 }
 // Something that needs no reply, such as how a hand ended.
 tell(result){
  const child=this.start();
  if(child)child.stdin.write(`${JSON.stringify(describeResult(result))}\n`);
 }
 close(){
  this.closed=true;
  for(const waiting of [...this.pending.values()])waiting.finish(null);
  const child=this.child;this.child=null;
  if(!child)return;
  try{child.stdin.end();}catch{}
  try{process.kill(-child.pid,'SIGKILL');}catch{}
 }
}
