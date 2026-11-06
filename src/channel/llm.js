// Lets a language model make the poker decisions, one call per decision. The model sees the question the agent asks
// and how earlier hands went, and nothing else: no key, no file and no tools. Its answer is checked against what's
// legal here, and the engine checks it again. If it's slow, refuses or talks nonsense, the safe default applies, and
// the match carries on. See docs/connect-your-agent.md.
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safeDefault} from './decider.js';
export {safeDefault};
export const DEFAULT_MODEL='claude-opus-5-5',DEFAULT_EFFORT='medium';
const MAX_TOKENS=16_000,EARLIER_HANDS=30,MARGIN_MS=1_500,MAX_OUTPUT=1<<20;
const FALLBACK_BETA='server-side-fallback-2026-07-01';
// Haiku has no server-side fallback, and any other model should say so by failing rather than being guessed at.
const HAS_FALLBACKS=/^claude-(opus-5|fable-5-1|sonnet-5-5)/;
export const INSTRUCTIONS=`You are playing heads-up no-limit Texas hold'em against another program, in a match for test tokens with no real value. You're given one decision at a time, as JSON, along with how earlier hands in this match went.

Amounts are in lamports, and you'll find them easier to think about relative to bigBlind. Stacks carry over between hands, the match ends after a set number of hands or when a player runs out, and your final stack is your score. Cards are a rank then a suit, so Ah is the ace of hearts. "dealer" says who holds the button, which is the small blind and acts first before the flop and last after it.

For a betting decision, "legal" lists what's allowed, with null or false for what isn't. A bet and a raise are the same action. Its "to" is the total you'll have in on this street, not the amount added, and it has to be between legal.raise.min and legal.raise.max. All-in puts in your whole stack.

For a show decision, you've seen the opponent's cards. Mucking gives up the pot and keeps your cards hidden. A hand that wins or ties is worth showing, and showing a losing hand only tells the opponent how you play.

Play to win: think about position, likely ranges, pot odds and stack depth, and adjust to what the opponent has done in earlier hands. Vary your sizes, and bluff sometimes, so you aren't easy to read.

Answer with only the JSON the reply format asks for.`;
// The same two formats every time, because a new format costs compile time the first time it's used, and a clock is running.
const BET_FORMAT={type:'object',properties:{action:{type:'string',enum:['fold','check','call','raise','all-in']},to:{type:'integer'}},required:['action'],additionalProperties:false};
const SHOW_FORMAT={type:'object',properties:{show:{type:'boolean'}},required:['show'],additionalProperties:false};
export const replyFormat=question=>question.type==='show'?SHOW_FORMAT:BET_FORMAT;
// Null means no usable reply. A size just outside the range still says what the model meant, so it's moved into range.
export function readReply(question,text){
 let reply;
 try{reply=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));}catch{return null;}
 if(question.type==='show')return typeof reply?.show==='boolean'?{show:reply.show}:null;
 const {legal}=question;
 switch(reply?.action){
  case 'fold':return legal.fold?{action:'fold'}:null;
  case 'check':return legal.check?{action:'check'}:null;
  case 'call':return legal.call?{action:'call'}:null;
  case 'all-in':return legal.allIn?{action:'all-in'}:null;
  case 'raise':return legal.raise&&Number.isSafeInteger(reply.to)?{action:'raise',to:Math.min(legal.raise.max,Math.max(legal.raise.min,reply.to))}:null;
  default:return null;
 }
}
export function decisionPrompt(question,earlier=[]){
 const {id,seconds,...decision}=question;
 return `Earlier hands in this match, oldest first:\n${JSON.stringify(earlier)}\n\nYour decision:\n${JSON.stringify(decision)}`;
}
// Answers a line from the agent with a reply, or null if it needs none. It never throws, and it always answers in time.
export function makeLlmBot({ask,log=()=>{},record=()=>{},marginMs=MARGIN_MS}){
 const earlier=[];
 return async question=>{
  if(question.type==='result'){
   const {type,...hand}=question;earlier.push(hand);earlier.splice(0,Math.max(0,earlier.length-EARLIER_HANDS));
   return null;
  }
  if(question.type!=='bet'&&question.type!=='show')return null;
  const fallback=safeDefault(question),limitMs=question.seconds*1000-marginMs,started=Date.now();
  const finish=(reply,details)=>{record({hand:question.hand,street:question.street??'show',ms:Date.now()-started,reply,...details});return reply;};
  if(!(limitMs>0)){log('No time to ask the model, so the safe default applies');return finish(fallback,{failed:'no time'});}
  const controller=new AbortController();
  let timer;
  // A backend that ignores the signal still can't hold up the next decision.
  const expired=new Promise((_,fail)=>{timer=setTimeout(()=>{controller.abort();fail(Error(`no answer within ${Math.round(limitMs/1000)}s`));},limitMs);});
  try{
   const answer=await Promise.race([ask({prompt:decisionPrompt(question,earlier),format:replyFormat(question),signal:controller.signal,limitMs}),expired]);
   const reply=readReply(question,answer.text);
   if(reply)return finish(reply,{input:answer.input,output:answer.output});
   log(`The model’s answer wasn’t usable, so the safe default applies: ${String(answer.text).slice(0,120)}`);
   return finish(fallback,{failed:'unusable',input:answer.input,output:answer.output});
  }catch(error){
   log(`The model failed, so the safe default applies: ${error.message}`);
   return finish(fallback,{failed:error.message});
  }finally{clearTimeout(timer);}
 };
}
// The Messages API, through the official SDK. It's optional, so a player who doesn't use this never installs it.
export function anthropicBackend({model=DEFAULT_MODEL,effort=DEFAULT_EFFORT,baseURL=null}={}){
 let client=null;
 return async({prompt,format,signal,limitMs})=>{
  if(!client){
   let Anthropic;
   try{({default:Anthropic}=await import('@anthropic-ai/sdk'));}
   catch{throw Error('The Anthropic SDK isn’t installed. Run: npm install @anthropic-ai/sdk');}
   client=new Anthropic(baseURL?{baseURL}:{});
  }
  // No retries, because a retry could only spend time this decision doesn't have.
  const response=await client.beta.messages.create({
   model,max_tokens:MAX_TOKENS,system:INSTRUCTIONS,messages:[{role:'user',content:prompt}],
   output_config:{effort,format:{type:'json_schema',schema:format}},
   ...(HAS_FALLBACKS.test(model)?{betas:[FALLBACK_BETA],fallbacks:'default'}:{}),
  },{signal,timeout:limitMs,maxRetries:0});
  if(response.stop_reason==='refusal')throw Error(`the model declined (${response.stop_details?.category??'no category'})`);
  return {text:response.content.filter(block=>block.type==='text').map(block=>block.text).join(''),input:response.usage?.input_tokens,output:response.usage?.output_tokens};
 };
}
// Started from inside a Claude Code session, the command would pick up that session's settings and endpoint, not its own login.
const SESSION_SETTING=/^CLAUDE(CODE$|_(CODE|AGENT_SDK|EFFORT|PID|PREVIEW))|^ANTHROPIC_BASE_URL$/;
const ownEnvironment=env=>env.CLAUDECODE?Object.fromEntries(Object.entries(env).filter(([name])=>!SESSION_SETTING.test(name))):env;
// The Claude Code command, using its owner's login instead of an API key. Tools, project files, settings and extensions
// are all off and it runs in an empty folder, so it can do nothing but answer, and the cards go over stdin so that
// other users of this machine can't read them from the process list.
export function cliBackend({command='claude',model=DEFAULT_MODEL,effort=DEFAULT_EFFORT}={}){
 return ({prompt,format,signal})=>new Promise((done,fail)=>{
  const directory=mkdtempSync(join(tmpdir(),'stacks-llm-'));
  const child=spawn(command,['-p','--model',model,'--effort',effort,'--tools','','--strict-mcp-config','--disable-slash-commands','--no-session-persistence','--setting-sources','','--system-prompt',INSTRUCTIONS,'--output-format','json','--json-schema',JSON.stringify(format)],{cwd:directory,env:ownEnvironment(process.env),detached:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';
  const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
  signal.addEventListener('abort',stop,{once:true});
  child.stdin.on('error',()=>{});
  child.stdout.on('data',data=>{if(out.length<MAX_OUTPUT)out+=data;});
  child.stderr.on('data',data=>{if(err.length<MAX_OUTPUT)err+=data;});
  child.once('error',error=>{signal.removeEventListener('abort',stop);rmSync(directory,{recursive:true,force:true});fail(Error(`couldn’t run ${command}: ${error.message}`));});
  child.once('close',code=>{
   signal.removeEventListener('abort',stop);rmSync(directory,{recursive:true,force:true});
   let result=null;
   try{result=JSON.parse(out);}catch{}
   if(!result||result.is_error){fail(Error(String(result?.result??(err||`${command} exited ${code}`)).trim().slice(0,200)));return;}
   done({text:result.structured_output?JSON.stringify(result.structured_output):String(result.result??''),input:result.usage?.input_tokens,output:result.usage?.output_tokens});
  });
  child.stdin.end(prompt);
 });
}
