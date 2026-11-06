// The language-model decision program, against fake model servers. What a real model does is for the rehearsals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {chmodSync,existsSync,mkdtempSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {anthropicBackend,cliBackend,decisionPrompt,DEFAULT_MODEL,INSTRUCTIONS,makeLlmBot,readReply,replyFormat,safeDefault} from '../src/channel/llm.js';
import {checkDecisionProgram,DecisionProgram} from '../src/channel/decider.js';
const LEGAL={fold:true,check:false,call:20000,raise:{min:40000,max:960000},allIn:960000};
const bet=(legal=LEGAL,extra={})=>({type:'bet',id:3,seconds:20,hand:1,hands:10,street:'flop',dealer:'you',cards:['Ah','Kd'],board:['2c','7h','9d'],stacks:{you:960000,opponent:940000},bets:{you:0,opponent:20000},pot:100000,toCall:20000,bigBlind:20000,legal,history:[],...extra});
const free={fold:false,check:true,call:null,raise:{min:20000,max:960000},allIn:960000};
const show=(winning,tied=false)=>({type:'show',id:8,seconds:20,hand:1,hands:10,cards:['Ah','Kd'],opponentCards:['Qs','Qc'],board:['2c','7h','9d','Ts','3s'],winning,tied,pot:300000});
const text=value=>JSON.stringify(value);
test('a reply is only used if it’s legal in this position',()=>{
 assert.deepEqual(readReply(bet(),text({action:'call'})),{action:'call'});
 assert.deepEqual(readReply(bet(),text({action:'fold'})),{action:'fold'});
 assert.deepEqual(readReply(bet(),text({action:'all-in'})),{action:'all-in'});
 assert.deepEqual(readReply(bet(),text({action:'raise',to:60000})),{action:'raise',to:60000});
 assert.deepEqual(readReply(bet(free),text({action:'check'})),{action:'check'});
 assert.equal(readReply(bet(),text({action:'check'})),null,'can’t check facing a bet');
 assert.equal(readReply(bet(free),text({action:'call'})),null,'nothing to call');
 assert.equal(readReply(bet({...free,fold:false}),text({action:'fold'})),null,'folding isn’t offered when checking is free');
 assert.equal(readReply(bet({...LEGAL,raise:null}),text({action:'raise',to:60000})),null,'raising isn’t open');
 assert.equal(readReply(bet({...LEGAL,allIn:null}),text({action:'all-in'})),null,'nor is all-in');
 assert.equal(readReply(bet(),text({action:'dance'})),null);
});
test('a raise needs a whole number, and one outside the range moves into it',()=>{
 assert.deepEqual(readReply(bet(),text({action:'raise',to:100})),{action:'raise',to:40000});
 assert.deepEqual(readReply(bet(),text({action:'raise',to:99999999})),{action:'raise',to:960000});
 for(const to of [undefined,'60000',1.5,null,Number.MAX_SAFE_INTEGER+1])assert.equal(readReply(bet(),text({action:'raise',to})),null,String(to));
});
test('rambling around the answer is fine, and rubbish isn’t an answer',()=>{
 assert.deepEqual(readReply(bet(),'Sure!\n```json\n{"action":"call"}\n```\nGood luck.'),{action:'call'});
 for(const bad of ['','I call.','{','}{','[1,2]','null','{"action":'])assert.equal(readReply(bet(),bad),null,bad);
 assert.deepEqual(readReply(show(true),text({show:false})),{show:false},'it may muck a winner');
 assert.equal(readReply(show(true),text({show:'yes'})),null);
 assert.equal(readReply(show(true),text({action:'call'})),null);
});
test('the safe default never puts in more money',()=>{
 assert.deepEqual(safeDefault(bet()),{action:'fold'});
 assert.deepEqual(safeDefault(bet(free)),{action:'check'});
 assert.deepEqual(safeDefault(show(true)),{show:true});
 assert.deepEqual(safeDefault(show(false,true)),{show:true});
 assert.deepEqual(safeDefault(show(false)),{show:false});
});
test('the model is told the decision and earlier hands, and not the plumbing',async()=>{
 const asked=[];
 const bot=makeLlmBot({ask:async request=>{asked.push(request);return {text:text({action:'call'})};}});
 assert.deepEqual(await bot(bet()),{action:'call'});
 assert.equal(await bot({type:'result',hand:1,winner:'you',reason:'fold',stacks:{you:1,opponent:2},cards:['Ah','Kd'],opponentCards:null,board:[],history:[]}),null);
 await bot(bet(LEGAL,{hand:2}));
 assert.match(asked[0].prompt,/oldest first:\n\[\]/);
 const decision=JSON.parse(asked[1].prompt.split('Your decision:\n')[1]);
 assert.equal(decision.hand,2);assert.equal(decision.id,undefined);assert.equal(decision.seconds,undefined);
 const past=JSON.parse(asked[1].prompt.split('oldest first:\n')[1].split('\n\nYour decision')[0]);
 assert.equal(past[0].winner,'you');assert.equal(past[0].type,undefined);
 assert.equal(asked[0].format,replyFormat(bet()));
 assert.notEqual(replyFormat(show(true)),replyFormat(bet()));
 assert.equal(replyFormat(bet(free)),replyFormat(bet()),'one format for every position, so it only compiles once');
});
test('it keeps only the last 30 hands, oldest going first',async()=>{
 let prompt;
 const bot=makeLlmBot({ask:async request=>{prompt=request.prompt;return {text:text({action:'call'})};}});
 for(let hand=1;hand<=35;hand++)await bot({type:'result',hand});
 await bot(bet());
 const past=JSON.parse(prompt.split('oldest first:\n')[1].split('\n\nYour decision')[0]);
 assert.equal(past.length,30);assert.equal(past[0].hand,6);assert.equal(past[29].hand,35);
});
test('lines that need no answer get none, and a line it doesn’t know is ignored',async()=>{
 let asked=0;
 const bot=makeLlmBot({ask:async()=>{asked++;return {text:'{}'};}});
 assert.equal(await bot({type:'something new'}),null);
 assert.equal(await bot({type:'result',hand:1}),null);
 assert.equal(asked,0);
});
test('whatever goes wrong with the model, the safe default goes in',async()=>{
 const logs=[],records=[];
 const failing=ask=>makeLlmBot({ask,log:line=>logs.push(line),record:entry=>records.push(entry)});
 assert.deepEqual(await failing(async()=>{throw Error('401 bad key');})(bet()),{action:'fold'});
 assert.match(logs.at(-1),/401 bad key/);assert.equal(records.at(-1).failed,'401 bad key');
 assert.deepEqual(await failing(async()=>({text:'I fold, I think'}))(bet(free)),{action:'check'});
 assert.equal(records.at(-1).failed,'unusable');
 assert.deepEqual(await failing(async()=>({text:text({action:'call'})}))(bet(free)),{action:'check'},'an illegal move counts as unusable');
 assert.deepEqual(await failing(()=>{throw Error('at once');})(show(true)),{show:true},'even failing before it returns a promise');
});
test('a slow model is cut off in time, even one that ignores being told to stop',async()=>{
 let aborted=false;
 const records=[];
 const bot=makeLlmBot({record:entry=>records.push(entry),marginMs:900,ask:({signal})=>{signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}});
 const started=Date.now();
 assert.deepEqual(await bot(bet(LEGAL,{seconds:1})),{action:'fold'});
 assert.ok(Date.now()-started<500,`took ${Date.now()-started} ms`);
 assert.ok(aborted);assert.match(records[0].failed,/no answer within/);
});
test('with no time left it doesn’t ask at all',async()=>{
 let asked=0;
 const bot=makeLlmBot({ask:async()=>{asked++;return {text:'{}'};}});
 assert.deepEqual(await bot(bet(free,{seconds:1})),{action:'check'});
 assert.equal(asked,0);
});
// A stand-in for the Messages API, with the real SDK talking to it.
async function fakeApi(respond){
 const requests=[];
 const server=createServer((request,response)=>{
  let body='';
  request.on('data',data=>{body+=data;});
  request.on('end',async()=>{
   const entry={headers:request.headers,url:request.url,body:JSON.parse(body)};requests.push(entry);
   const {status=200,json,wait=0}=await respond(entry);
   if(wait)await pause(wait);
   if(response.destroyed)return;
   response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(json));
  });
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 return {requests,url:`http://127.0.0.1:${server.address().port}`,close:()=>{server.closeAllConnections();server.close();}};
}
const message=(content,extra={})=>({id:'msg_1',type:'message',role:'assistant',model:DEFAULT_MODEL,stop_reason:'end_turn',stop_sequence:null,content,usage:{input_tokens:700,output_tokens:40},...extra});
const reply=value=>({json:message([{type:'thinking',thinking:'',signature:'x'},{type:'text',text:JSON.stringify(value)}])});
const withKey=async(work)=>{const before=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='test-key';try{return await work();}finally{if(before===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=before;}};
const request=(extra={})=>({prompt:'the decision',format:replyFormat(bet()),signal:new AbortController().signal,limitMs:5000,...extra});
test('the API gets the request its docs describe, and the answer comes out of the text',()=>withKey(async()=>{
 const api=await fakeApi(()=>reply({action:'raise',to:60000}));
 try{
  const answer=await anthropicBackend({baseURL:api.url})(request());
  assert.equal(answer.text,'{"action":"raise","to":60000}','the thinking block is skipped');
  assert.equal(answer.input,700);assert.equal(answer.output,40);
  const {body,headers,url}=api.requests[0];
  assert.match(url,/\/v1\/messages/);
  assert.equal(headers.authorization,'Bearer test-key');
  assert.equal(body.model,'claude-opus-5-5');
  assert.equal(body.system,INSTRUCTIONS);
  assert.deepEqual(body.messages,[{role:'user',content:'the decision'}]);
  assert.deepEqual(body.output_config,{effort:'medium',format:{type:'json_schema',schema:replyFormat(bet())}});
  assert.equal(body.fallbacks,'default');
  assert.match(headers['anthropic-beta'],/server-side-fallback-2026-07-01/);
  for(const gone of ['temperature','top_p','top_k','thinking','tools','tool_choice'])assert.equal(body[gone],undefined,gone);
 }finally{api.close();}
}));
test('a model with no fallback isn’t asked for one, and the choice of model and effort is respected',()=>withKey(async()=>{
 const api=await fakeApi(()=>reply({action:'call'}));
 try{
  await anthropicBackend({baseURL:api.url,model:'claude-haiku-5-5',effort:'low'})(request());
  const {body,headers}=api.requests[0];
  assert.equal(body.model,'claude-haiku-5-5');assert.equal(body.output_config.effort,'low');
  assert.equal(body.fallbacks,undefined);assert.equal(headers['anthropic-beta'],undefined);
 }finally{api.close();}
}));
test('a refusal, an API error or a slow reply all fail without retrying',()=>withKey(async()=>{
 let api=await fakeApi(()=>({json:message([],{stop_reason:'refusal',stop_details:{type:'refusal',category:'cyber',explanation:'no'}})}));
 try{await assert.rejects(anthropicBackend({baseURL:api.url})(request()),/declined \(cyber\)/);}finally{api.close();}
 for(const status of [401,429,500]){
  api=await fakeApi(()=>({status,json:{type:'error',error:{type:'x',message:`status ${status}`}}}));
  try{
   await assert.rejects(anthropicBackend({baseURL:api.url})(request()));
   assert.equal(api.requests.length,1,`no retry after a ${status}`);
  }finally{api.close();}
 }
 api=await fakeApi(()=>({...reply({action:'call'}),wait:2000}));
 try{
  const controller=new AbortController(),started=Date.now();
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(anthropicBackend({baseURL:api.url})(request({signal:controller.signal})));
  assert.ok(Date.now()-started<1000);assert.equal(api.requests.length,1);
 }finally{api.close();}
}));
// A stand-in for the claude command, which records how it was run and answers as it's told.
function fakeCli(behaviour){
 const directory=mkdtempSync(join(tmpdir(),'fake-cli-')),seen=join(directory,'seen.json'),file=join(directory,'claude');
 writeFileSync(file,`#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd(),env:process.env,pid:process.pid}));${behaviour}});\n`);
 chmodSync(file,0o755);
 return {file,started:join(directory,'started'),seen:()=>JSON.parse(readFileSync(seen,'utf8'))};
}
const withEnv=async(changes,work)=>{
 const before=Object.fromEntries(Object.keys(changes).map(name=>[name,process.env[name]]));
 const apply=values=>{for(const [name,value] of Object.entries(values))if(value===undefined)delete process.env[name];else process.env[name]=value;};
 apply(changes);
 try{return await work();}finally{apply(before);}
};
const gone=async pid=>{for(let i=0;i<40;i++){try{process.kill(pid,0);}catch(error){return error.code==='ESRCH';}await pause(50);}return false;};
const speaking=value=>`console.log(${JSON.stringify(JSON.stringify(value))});`;
const flagValue=(args,name)=>args[args.indexOf(name)+1];
test('the CLI runs with no tools, no settings and an empty folder, and gets the cards over stdin',async()=>{
 const cli=fakeCli(speaking({type:'result',is_error:false,result:'',structured_output:{action:'call'},usage:{input_tokens:10,output_tokens:5}}));
 await withEnv({CLAUDECODE:undefined},async()=>{
  const answer=await cliBackend({command:cli.file,effort:'low'})(request({prompt:'secret cards Ah Kd'}));
  assert.equal(answer.text,'{"action":"call"}');assert.equal(answer.input,10);assert.equal(answer.output,5);
  const {args,input,cwd}=cli.seen();
  assert.equal(input,'secret cards Ah Kd');
  assert.ok(!args.join(' ').includes('secret cards'),'the cards aren’t in the process list');
  assert.equal(flagValue(args,'--tools'),'','every tool is off');
  assert.equal(flagValue(args,'--setting-sources'),'');
  for(const flag of ['-p','--strict-mcp-config','--disable-slash-commands','--no-session-persistence'])assert.ok(args.includes(flag),flag);
  assert.equal(flagValue(args,'--model'),'claude-opus-5-5');assert.equal(flagValue(args,'--effort'),'low');
  assert.equal(flagValue(args,'--system-prompt'),INSTRUCTIONS);
  assert.deepEqual(JSON.parse(flagValue(args,'--json-schema')),replyFormat(bet()));
  assert.match(cwd,/stacks-llm-/);assert.ok(!existsSync(cwd),'and the folder is gone afterwards');
 });
});
test('started from inside a Claude Code session, the CLI keeps to its own login and settings',async()=>{
 const cli=fakeCli(speaking({is_error:false,structured_output:{action:'call'}}));
 const session={CLAUDECODE:'1',CLAUDE_CODE_SIMPLE:'1',CLAUDE_CODE_SESSION_ID:'x',CLAUDE_AGENT_SDK_VERSION:'1',CLAUDE_EFFORT:'max',CLAUDE_PID:'9',ANTHROPIC_BASE_URL:'https://session.example',MY_OWN_SETTING:'kept',CLAUDE_CONFIG_DIR:'/mine'};
 await withEnv(session,()=>cliBackend({command:cli.file})(request()));
 const {env}=cli.seen();
 for(const name of ['CLAUDECODE','CLAUDE_CODE_SIMPLE','CLAUDE_CODE_SESSION_ID','CLAUDE_AGENT_SDK_VERSION','CLAUDE_EFFORT','CLAUDE_PID','ANTHROPIC_BASE_URL'])assert.equal(env[name],undefined,name);
 assert.equal(env.MY_OWN_SETTING,'kept');assert.equal(env.CLAUDE_CONFIG_DIR,'/mine');
 await withEnv({CLAUDECODE:undefined,ANTHROPIC_BASE_URL:'https://mine.example'},()=>cliBackend({command:cli.file})(request()));
 assert.equal(cli.seen().env.ANTHROPIC_BASE_URL,'https://mine.example','outside a session, that setting is the user’s own');
});
test('the CLI’s failures are reported as themselves',async()=>{
 const expired=fakeCli(`${speaking({type:'result',is_error:true,result:'Failed to authenticate: OAuth session expired'})}process.exit(1);`);
 await assert.rejects(cliBackend({command:expired.file})(request()),/OAuth session expired/);
 const crashed=fakeCli(`console.error('it broke');process.exit(3);`);
 await assert.rejects(cliBackend({command:crashed.file})(request()),/it broke/);
 const silent=fakeCli('process.exit(4);');
 await assert.rejects(cliBackend({command:silent.file})(request()),/exited 4/);
 await assert.rejects(cliBackend({command:'/nonexistent/claude'})(request()),/couldn’t run/);
});
test('a slow CLI is killed when the time’s up, with whatever it started',async()=>{
 const cli=fakeCli(`const c=require('child_process').spawn('sleep',['30'],{stdio:'ignore'});fs.writeFileSync(process.env.FAKE_CLI_STARTED,String(c.pid));setTimeout(()=>{},30000);`);
 const controller=new AbortController();
 const running=withEnv({FAKE_CLI_STARTED:cli.started},()=>cliBackend({command:cli.file})(request({signal:controller.signal})));
 for(let i=0;i<100&&!existsSync(cli.started);i++)await pause(50);
 assert.ok(existsSync(cli.started),'it got going');
 await pause(50);
 const aborted=Date.now();
 controller.abort();
 await assert.rejects(running);
 assert.ok(Date.now()-aborted<3000,`it stopped at once, not when it finished by itself: ${Date.now()-aborted} ms`);
 const {pid,cwd}=cli.seen(),inner=Number(readFileSync(cli.started,'utf8'));
 assert.ok(await gone(pid),'the command is gone');
 assert.ok(await gone(inner),'and so is what it started');
 assert.ok(!existsSync(cwd));
});
// The whole thing as an agent runs it: its own process, questions on stdin, answers on stdout.
test('the program answers through the same interface as any other, and logs privately',()=>withKey(async()=>{
 const seen=[];
 const api=await fakeApi(({body})=>{
  seen.push(body.messages[0].content);
  return reply(body.output_config.format.schema.properties.show?{show:true}:{action:'raise',to:60000});
 });
 const directory=mkdtempSync(join(tmpdir(),'llm-bot-')),logFile=join(directory,'decisions.jsonl');
 const logs=[];
 const program=new DecisionProgram(`${JSON.stringify(process.execPath)} examples/llm-bot.js --api anthropic --base-url ${api.url} --log ${logFile}`,{limitMs:15000,log:line=>logs.push(line),env:{...process.env,AGENT_STACKS_RPC:'https://secret.example/key'}});
 try{
  const view={seat:0,hand:1,hands:2,street:1,button:0,cards:[0,1],board:[2,3,4],stacks:[960000,940000],bets:[0,20000],pot:100000,owed:20000,bigBlind:20000,legal:LEGAL,history:[]};
  assert.deepEqual(await program.ask({type:'bet',view}),{action:3,amount:60000});
  program.tell({seat:0,hand:1,winner:0,reason:0,stacks:[1100000,900000],cards:[0,1],opponentCards:[],board:[2,3,4],betting:[]});
  assert.equal(await program.ask({type:'show',view:{seat:0,hand:2,hands:2,cards:[0,1],opponentCards:[5,6],board:[2,3,4,7,8],winning:false,tied:false,pot:1000}}),true);
  assert.match(seen[1],/"winner":"you"/,'it remembers the earlier hand');
  const lines=readFileSync(logFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(lines.length,2);assert.deepEqual(lines[0].reply,{action:'raise',to:60000});
  assert.equal(statSync(logFile).mode&0o077,0,'only its owner can read the log');
  assert.ok(logs.some(line=>line.includes('llm {')),'and the agent’s log has each decision');
 }finally{program.close();api.close();}
}));
test('--check says whether the model is reachable, with an exit code a script can use',()=>withKey(async()=>{
 const run=(url,...flags)=>new Promise(done=>{
  const child=spawn(process.execPath,['examples/llm-bot.js','--api','anthropic','--base-url',url,'--check',...flags],{stdio:['ignore','pipe','ignore']});
  let out='';child.stdout.on('data',d=>{out+=d;});child.on('close',code=>done({code,result:JSON.parse(out)}));
 });
 let api=await fakeApi(()=>reply({action:'call'}));
 try{
  const {code,result}=await run(api.url);
  assert.equal(code,0);assert.equal(result.ok,true);assert.deepEqual(result.reply,{action:'call'});assert.equal(result.input,700);
 }finally{api.close();}
 api=await fakeApi(()=>({status:401,json:{type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}}}));
 try{
  const {code,result}=await run(api.url);
  assert.equal(code,1);assert.equal(result.ok,false);assert.match(result.failed,/invalid x-api-key/);
 }finally{api.close();}
}));
test('a model that can’t answer is found out before any money moves, however the bot is otherwise fine',()=>withKey(async()=>{
 const bot=url=>`${JSON.stringify(process.execPath)} examples/llm-bot.js --api anthropic --base-url ${url}`;
 let api=await fakeApi(({body})=>reply(body.output_config.format.schema.properties.show?{show:true}:{action:'call'}));
 try{await checkDecisionProgram(bot(api.url),{limitMs:15_000});}finally{api.close();}
 api=await fakeApi(()=>({status:401,json:{type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}}}));
 try{await assert.rejects(checkDecisionProgram(bot(api.url),{limitMs:15_000}),/only a fallback[^]*invalid x-api-key/,'the safe default is a valid answer, so only the bot can say what it is');}finally{api.close();}
 // It only says so when it's true: an answer the model did give carries no such flag in a real match.
 api=await fakeApi(()=>reply({action:'call'}));
 const program=new DecisionProgram(bot(api.url),{limitMs:15_000});
 try{
  assert.deepEqual(await program.ask({type:'bet',view:{seat:0,hand:1,hands:2,street:0,button:0,cards:[0,1],board:[],stacks:[1000,1000],bets:[10,20],pot:30,owed:10,bigBlind:20,legal:{fold:true,check:false,call:10,raise:{min:40,max:1010},allIn:1010},history:[]}}),{action:2,amount:0});
  assert.equal(program.lastRaw.failed,undefined);
 }finally{program.close();api.close();}
}));
