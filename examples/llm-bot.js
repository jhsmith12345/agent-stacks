// A decision program that asks a language model, using src/channel/llm.js.
//   node examples/llm-bot.js [--api anthropic|claude-cli] [--model ID] [--effort low|medium|high] [--log FILE] [--check]
// --api anthropic needs the official SDK and ANTHROPIC_API_KEY. --api claude-cli uses the login of the claude command
// instead. Without the flag, it uses the API if there's a key. A decision takes seconds, so give it time with
// --think on the host: 60 is a sensible start. --check asks one sample question and exits, so you can test it first.
// --log keeps every decision, including your own cards, in a file only you can read.
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {anthropicBackend,cliBackend,DEFAULT_EFFORT,DEFAULT_MODEL,makeLlmBot} from '../src/channel/llm.js';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const api=option('--api',process.env.ANTHROPIC_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN?'anthropic':'claude-cli');
const model=option('--model',DEFAULT_MODEL),effort=option('--effort',DEFAULT_EFFORT),logFile=option('--log');
if(!['anthropic','claude-cli'].includes(api))throw Error(`Unknown --api ${api}`);
const ask=api==='anthropic'?anthropicBackend({model,effort,baseURL:option('--base-url')}):cliBackend({model,effort,command:option('--command','claude')});
let last=null;
const record=entry=>{
 last=entry;
 console.error(`llm ${JSON.stringify(entry)}`.slice(0,280));
 if(logFile)appendFileSync(logFile,`${JSON.stringify(entry)}\n`,{mode:0o600});
};
const answer=makeLlmBot({ask,record,log:text=>console.error(text)});
if(process.argv.includes('--check')){
 const sample={type:'bet',id:1,seconds:Number(option('--seconds',120)),hand:1,hands:10,street:'flop',dealer:'you',cards:['Ah','Kd'],board:['2c','7h','9d'],stacks:{you:960000,opponent:940000},bets:{you:0,opponent:20000},pot:100000,toCall:20000,bigBlind:20000,legal:{fold:true,check:false,call:20000,raise:{min:40000,max:960000},allIn:960000},history:[]};
 const reply=await answer(sample);
 console.log(JSON.stringify({api,model,effort,ok:!last.failed,reply,seconds:last.ms/1000,input:last.input??null,output:last.output??null,failed:last.failed??null}));
 process.exit(last.failed?1:0);
}
for await (const line of createInterface({input:process.stdin})){
 let question;
 try{question=JSON.parse(line);}catch{console.error('Ignored a line that isn’t JSON');continue;}
 const reply=await answer(question);
 // `failed` says this is only the safe default, which is how stacks knows not to start a match with a model that can't answer.
 if(reply)console.log(JSON.stringify({id:question.id,...reply,...(last.failed?{failed:true}:{})}));
}
