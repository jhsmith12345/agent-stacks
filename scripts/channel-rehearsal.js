// Plays real channel matches against a local validator, with real agent processes and a real relay, and
// attacks them. Local test funds only. It prints one JSON summary and writes each scenario's working files
// under the directory given.
// Usage: AGENT_STACKS_ALLOW_LOCAL=1 node scripts/channel-rehearsal.js RPC PROGRAM_ID FUNDER_KEYPAIR WORK_DIRECTORY [SCENARIO...]
// The invite scenarios check the deployed program against target/deploy-channel, or AGENT_STACKS_PROGRAM_SO.
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {appendFileSync,existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {ChainClient,PublicKey,SystemProgram,ensureWallet,loadWallet} from '../src/solana/client.js';
import {sessionFromSeed,signMessage} from '../src/channel/keys.js';
import {ChannelChain,withBytes,COMPLETE} from '../src/channel/chain.js';
import {startRelay} from '../src/channel/relay.js';
import {KIND_HAND,sha256,signedMessage} from '../src/channel/engine.js';
import {toHex} from '../src/channel/wire.js';
import {decodeInvite,parseSol} from '../src/channel/invite.js';
import {coverage,referee} from '../src/channel/referee.js';
import {seededRandom} from '../src/channel/solver.js';
const [rpc,program,funderFile,workArg,...only]=process.argv.slice(2);
if(!rpc||!program||!funderFile||!workArg)throw Error('Usage: node scripts/channel-rehearsal.js RPC PROGRAM_ID FUNDER_KEYPAIR WORK_DIRECTORY [SCENARIO...]');
const root=fileURLToPath(new URL('..',import.meta.url)),work=resolve(workArg);
const ENV={...process.env,AGENT_STACKS_ALLOW_LOCAL:'1'};
// On public devnet test SOL is scarce, so these can be set to just what a match needs.
const WALLET_LAMPORTS=(process.env.AGENT_STACKS_WALLET_LAMPORTS??'1000000000,1000000000').split(',').map(Number);
const RESERVE_LAMPORTS=Number(process.env.AGENT_STACKS_RESERVE_LAMPORTS??50_000_000);
const POLL=Number(process.env.AGENT_STACKS_REHEARSAL_POLL??0.25);
const funder=await loadWallet(resolve(funderFile));
const direct=new ChainClient(rpc,program,funder,{allowLocal:true});await direct.checkNetwork();
const lamports=async key=>Number(await direct.connection.getBalance(new PublicKey(key),'confirmed'));
const fund=(key,amount)=>direct.send([SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:key,lamports:BigInt(amount)})]);
const run=(file,args,env={})=>new Promise((done,fail)=>{const c=spawn(process.execPath,[join(root,file),...args],{cwd:root,env:{...ENV,...env},stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',d=>{out+=d;});c.stderr.on('data',d=>{err+=d;});c.on('exit',code=>code===0?done(out):fail(Error(`${file} exited ${code}: ${err.slice(-500)}`)));});
const log=(...parts)=>process.stderr.write(`[${new Date().toISOString().slice(11,19)}] ${parts.join(' ')}\n`);
async function setup(name,{hands=1,seconds=30,buyIn=1_000_000,bigBlind=20_000}={}){
 // A fresh directory each run. Nothing here ever deletes a key file, even a throwaway one.
 const dir=join(work,`${name}-${Date.now()}`);mkdirSync(dir,{recursive:true,mode:0o700});
 const file=n=>join(dir,n);
 const wallets=[await ensureWallet(file('wallet-a.json')),await ensureWallet(file('wallet-b.json'))];
 const sessions=[await ensureWallet(file('session-a.json')),await ensureWallet(file('session-b.json'))];
 for(const [i,w] of wallets.entries())await fund(w.publicKey,WALLET_LAMPORTS[i]);
 writeFileSync(file('offer.json'),await run('scripts/channel.js',['offer',file('wallet-b.json'),file('session-b.json')]));
 const common=['--rpc',rpc,'--reserve',String(RESERVE_LAMPORTS)];
 await run('scripts/channel.js',['create',file('wallet-a.json'),file('session-a.json'),file('offer.json'),file('manifest.json'),'--program',program,'--buy-in',String(buyIn),'--big-blind',String(bigBlind),'--hands',String(hands),'--seconds',String(seconds),...common]);
 await run('scripts/channel.js',['join',file('wallet-b.json'),file('session-b.json'),file('manifest.json'),...common]);
 const manifest=JSON.parse(readFileSync(file('manifest.json'),'utf8'));
 return {name,dir,file,wallets,sessions,manifest,config:withBytes(manifest),before:await Promise.all(wallets.map(w=>lamports(w.publicKey)))};
}
const bot=(...args)=>`${JSON.stringify(process.execPath)} examples/decision-bot.js ${args.join(' ')}`;
function agent(m,seat,relayUrl,{rpcUrl=rpc,stall=20,poll=POLL,decide=null,think=10}={}){
 const label=seat===0?'a':'b';
 const child=spawn(process.execPath,[join(root,'examples/channel-agent.js'),m.file(`session-${label}.json`),m.file(`state-${label}`),'--manifest',m.file('manifest.json'),'--relay',relayUrl,'--rpc',rpcUrl,...(decide?['--decide',decide,'--think',String(think)]:[])],{cwd:root,env:{...ENV,AGENT_STACKS_STALL_SECONDS:String(stall),AGENT_STACKS_POLL_SECONDS:String(poll)},stdio:['ignore','pipe','pipe']});
 const a={child,out:'',err:'',exit:null,seat};
 // On disk too, because a run that times out has nothing else to show why.
 child.stdout.on('data',d=>{a.out+=d;});child.stderr.on('data',d=>{a.err+=d;appendFileSync(m.file(`agent-${label}.log`),d);});
 a.done=new Promise(done=>child.on('exit',(code,signal)=>{a.exit={code,signal};done(a.exit);}));
 return a;
}
const reader=m=>new ChannelChain(new ChainClient(rpc,program,funder,{allowLocal:true}),m.config);
const stateOf=(m,label)=>JSON.parse(readFileSync(m.file(`state-${label}/${m.manifest.match}.state.json`),'utf8'));
async function waitFor(what,check,ms=240_000){
 const started=Date.now();
 for(;;){const value=await check();if(value)return value;if(Date.now()-started>ms)throw Error(`Timed out waiting for ${what}`);await pause(250);}
}
const withTimeout=(promise,ms,what)=>Promise.race([promise,pause(ms).then(()=>{throw Error(`Timed out: ${what}`);})]);
const settled=(m,ms=240_000)=>waitFor('settlement',async()=>{const s=await reader(m).read();return s?.phase===COMPLETE?s:null;},ms);
async function matchTransactions(m){const list=await direct.connection.getSignaturesForAddress(new PublicKey(m.manifest.match),{limit:1000},'confirmed');return list.filter(s=>!s.err).length;}
const delta=async m=>Promise.all(m.wallets.map(async(w,i)=>await lamports(w.publicKey)-m.before[i]));
function assert(ok,message){if(!ok)throw Error(`Check failed: ${message}`);}
const stop=(...agents)=>{for(const a of agents)if(a.exit===null)a.child.kill('SIGKILL');};
const finalOf=a=>JSON.parse(a.out.trim().split('\n').at(-1));
// What each player recorded has to agree, hand by hand, with each other and with the contract.
function checkResults(m,state,agents){
 const records=agents.map(a=>finalOf(a).results);
 assert(records[0].length>0&&records[0].length===records[1].length,`both record every hand: ${records.map(r=>r.length)}`);
 records[0].forEach((r,i)=>{
  const o=records[1][i];
  for(const field of ['hand','winner','reason','aggressor','firstToShow'])assert(r[field]===o[field],`hand ${r.hand}: both agree on ${field}`);
  assert(r.stacks[0]===o.stacks[0]&&r.stacks[1]===o.stacks[1],`hand ${r.hand}: both agree on the stacks`);
  assert(r.stacks[0]+r.stacks[1]===2*m.manifest.buyIn,`hand ${r.hand}: nothing is created or lost`);
 });
 const last=records[0].at(-1);
 assert(state.payouts[0]===last.stacks[0]&&state.payouts[1]===last.stacks[1],`the contract paid what the last hand left: ${state.payouts} and ${last.stacks}`);
 return records[0];
}
const raises=r=>r.betting.filter(e=>e.action===3||e.action===4).length;
// The one-command way in, as two people would use it. Only the code passes between them.
const ARTIFACT=resolve(process.env.AGENT_STACKS_PROGRAM_SO??join(root,'target/deploy-channel/agent_stacks_escrow.so'));
function stacks(dir,home,args,{extraEnv={}}={}){
 const child=spawn(process.execPath,[join(root,'scripts/stacks.js'),...args,'--home',join(dir,home),'--rpc',rpc,'--deployment',join(dir,'deployment.json')],{cwd:root,env:{...ENV,AGENT_STACKS_STALL_SECONDS:'20',AGENT_STACKS_POLL_SECONDS:String(POLL),...extraEnv},stdio:['ignore','pipe','pipe']});
 const p={child,out:'',err:'',exit:null};
 child.stdout.on('data',d=>{p.out+=d;});child.stderr.on('data',d=>{p.err+=d;});
 p.done=new Promise(done=>child.on('exit',(code,signal)=>{p.exit={code,signal};done(p.exit);}));
 return p;
}
const lastJson=p=>JSON.parse(p.out.trim().split('\n').at(-1));
// `fundEach` can give each player a different amount, and a player given nothing starts with an empty wallet.
async function inviteSetup(name,{fundEach=1_000_000_000}={}){
 const dir=join(work,`${name}-${Date.now()}`);mkdirSync(dir,{recursive:true,mode:0o700});
 const code=readFileSync(ARTIFACT);
 writeFileSync(join(dir,'deployment.json'),JSON.stringify({program,programBytes:code.length,programSha256:createHash('sha256').update(code).digest('hex'),allowUpgradeable:true}));
 const wallets=[];
 for(const home of ['home-a','home-b']){
  const p=stacks(dir,home,['wallet']);await p.done;
  assert(p.exit.code===0,`wallet: ${p.err.slice(-300)}`);
  const {address}=lastJson(p);wallets.push(address);
  const amount=Array.isArray(fundEach)?fundEach[wallets.length-1]:fundEach;
  if(amount)await fund(new PublicKey(address),amount);
 }
 return {dir,wallets};
}
async function hosted(dir,args){
 const host=stacks(dir,'home-a',['host',...args]);
 const code=await waitFor('the invite code',async()=>{const line=host.out.split('\n').find(l=>l.startsWith('stacks1.'));if(host.exit&&!line)throw Error(`host exited: ${host.err.slice(-400)}`);return line;},60_000);
 return {host,code};
}
// Stands in for the Messages API. It plays plausibly, and now and then fails the way a real service can.
async function standInModel(seed){
 const random=seededRandom(seed);
 let served=0;
 const answer=({messages,output_config})=>{
  const question=JSON.parse(messages[0].content.split('Your decision:\n')[1]),roll=random();
  if(output_config.format.schema.properties.show)return {show:question.winning||question.tied};
  const {legal}=question;
  if(question.hand===0)return {action:'call'};
  if(roll<0.06)return {action:legal.check?'call':'check'};
  if(roll<0.12)return 'I would like to think about this some more.';
  if(legal.raise&&roll<0.55)return {action:'raise',to:legal.raise.min+Math.floor(random()*legal.raise.min)};
  return legal.check?{action:'check'}:{action:'call'};
 };
 const server=createServer((request,response)=>{
  let body='';
  request.on('data',data=>{body+=data;});
  request.on('end',()=>{
   const parsed=JSON.parse(body);
   // Each seat's first two questions are the check before a match, which a model having a bad moment would rightly fail.
   if(++served>4&&random()<0.05){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({type:'error',error:{type:'api_error',message:'a stand-in outage'}}));return;}
   const reply=answer(parsed),text=typeof reply==='string'?reply:JSON.stringify(reply);
   response.writeHead(200,{'content-type':'application/json'});
   response.end(JSON.stringify({id:'msg_stand_in',type:'message',role:'assistant',model:parsed.model,stop_reason:'end_turn',stop_sequence:null,content:[{type:'text',text}],usage:{input_tokens:1,output_tokens:1}}));
  });
 });
 await once(server.listen(0,'127.0.0.1'),'listening');
 return {url:`http://127.0.0.1:${server.address().port}`,close:()=>{server.closeAllConnections();server.close();}};
}
const SCENARIOS={
 // The normal case. The contract should see only a create, a join and a close.
 async clean(){
  const m=await setup('clean',{hands:2});
  const relay=await startRelay();
  const started=Date.now(),agents=[agent(m,0,relay.url),agent(m,1,relay.url)];
  try{
   const exits=await withTimeout(Promise.all(agents.map(a=>a.done)),300_000,'clean match');
   assert(exits.every(e=>e.code===0),`agents exited ${JSON.stringify(exits)}: ${agents.map(a=>a.err.slice(-300)).join(' | ')}`);
   const state=await settled(m),count=await matchTransactions(m),seconds=(Date.now()-started)/1000;
   const results=agents.map(a=>JSON.parse(a.out.trim().split('\n').at(-1)));
   assert(state.payouts[0]+state.payouts[1]===2*m.manifest.buyIn,'payouts add up');
   assert(count<=4,`expected about three transactions on the match, saw ${count}`);
   return {hands:2,seconds:Math.round(seconds),matchTransactions:count,payouts:state.payouts,relayMessages:results.map(r=>r.relayMessages),steps:results[0].seq,walletChanges:await delta(m)};
  }finally{stop(...agents);relay.close();}
 },
 // A player disappears partway through a hand. The other gets their money, and the pot is all that's lost.
 async vanish(){
  const m=await setup('vanish',{seconds:30});
  const relay=await startRelay();
  const a=agent(m,0,relay.url,{stall:20}),b=agent(m,1,relay.url,{stall:20});
  try{
   await waitFor('play to begin',async()=>{try{return stateOf(m,'b').latest?.seq>=4;}catch{return false;}});
   b.child.kill('SIGKILL');log('killed player B mid-hand');
   const started=Date.now();
   const exit=await withTimeout(a.done,240_000,'player A settling');
   assert(exit.code===0,`A exited ${JSON.stringify(exit)}: ${a.err.slice(-400)}`);
   const state=await settled(m);
   assert(state.payouts[0]>=m.manifest.buyIn&&state.payouts[1]>0,`only the pot changes hands: ${state.payouts}`);
   return {secondsFromVanishingToPayout:Math.round((Date.now()-started)/1000),payouts:state.payouts,matchTransactions:await matchTransactions(m),aLog:a.err.split('\n').filter(l=>l.includes('on-chain')).map(l=>l.replace(/^Agent \d: on-chain: /,''))};
  }finally{stop(a,b);relay.close();}
 },
 // The relay cuts out but both agents are alive, so they finish the hand on chain, card by card.
 async onchain(){
  const m=await setup('onchain',{seconds:30});
  let cut=false,seen=0;
  const relay=await startRelay({tap:(seat,body)=>{seen++;if(seen>18)cut=true;return cut?[]:[body];}});
  const a=agent(m,0,relay.url,{stall:20}),b=agent(m,1,relay.url,{stall:20});
  const started=Date.now();
  try{
   const exits=await withTimeout(Promise.all([a.done,b.done]),420_000,'hand finishing on chain');
   assert(exits.every(e=>e.code===0),`agents exited ${JSON.stringify(exits)}: ${a.err.slice(-300)} | ${b.err.slice(-300)}`);
   const state=await settled(m),count=await matchTransactions(m);
   assert(cut,'the relay really did cut out');
   assert(state.payouts[0]+state.payouts[1]===2*m.manifest.buyIn,'payouts add up');
   const moves=[a,b].flatMap(x=>x.err.split('\n').filter(l=>l.includes('on-chain move'))).length;
   assert(moves>0,'moves really happened on chain');
   return {seconds:Math.round((Date.now()-started)/1000),onChainMoves:moves,matchTransactions:count,payouts:state.payouts,finalStep:state.seq,settledBy:['fold','showdown','timeout','muck'][state.game.reason],walletChanges:await delta(m)};
  }finally{stop(a,b);relay.close();}
 },
 // Real betting across several hands: seat 0 bets every street and seat 1 calls, then shows only a winner.
 // Whoever got called shows first, so every hand ends with seat 0's cards public, and a loss means a muck.
 async bets(){
  const hands=8,m=await setup('bets',{hands,seconds:600});
  const relay=await startRelay();
  const started=Date.now(),agents=[agent(m,0,relay.url,{decide:bot('raise')}),agent(m,1,relay.url,{decide:bot('call')})];
  try{
   const exits=await withTimeout(Promise.all(agents.map(a=>a.done)),480_000,'betting match');
   assert(exits.every(e=>e.code===0),`agents exited ${JSON.stringify(exits)}: ${agents.map(a=>a.err.slice(-300)).join(' | ')}`);
   const state=await settled(m),records=checkResults(m,state,agents),count=await matchTransactions(m);
   for(const r of records){
    assert(raises(r)>=4,`hand ${r.hand}: seat 0 bet every street, ${raises(r)} raises`);
    assert(r.aggressor===0&&r.firstToShow===0,`hand ${r.hand}: the player who got called shows first`);
    assert(r.reason===1||r.reason===3,`hand ${r.hand}: it reached the end, reason ${r.reason}`);
   }
   const mucks=records.filter(r=>r.reason===3),shown=records.filter(r=>r.reason===1);
   assert(mucks.length>0&&shown.length>0,`saw both endings: ${mucks.length} mucks, ${shown.length} shown`);
   for(const r of mucks)assert(r.opponentCards.length===0&&r.winner===0,`hand ${r.hand}: a muck hides the caller's cards from seat 0`);
   assert(count<=4,`a clean match stays off chain, saw ${count} transactions`);
   assert(agents.every(a=>!a.err.includes('safe default')),'no decision fell back to the default');
   return {seconds:Math.round((Date.now()-started)/1000),hands:records.length,raises:records.reduce((n,r)=>n+raises(r),0),mucks:mucks.length,shown:shown.length,matchTransactions:count,payouts:state.payouts,walletChanges:await delta(m)};
  }finally{stop(...agents);relay.close();}
 },
 // An all-in that gets called: the board runs out, and the player who got called shows first.
 async allin(){
  const m=await setup('allin',{hands:3,seconds:600});
  const relay=await startRelay();
  const agents=[agent(m,0,relay.url,{decide:bot('shove')}),agent(m,1,relay.url,{decide:bot('call')})];
  try{
   const exits=await withTimeout(Promise.all(agents.map(a=>a.done)),300_000,'all-in match');
   assert(exits.every(e=>e.code===0),`agents exited ${JSON.stringify(exits)}: ${agents.map(a=>a.err.slice(-300)).join(' | ')}`);
   const state=await settled(m),records=checkResults(m,state,agents);
   for(const r of records){
    assert(r.aggressor===0&&r.firstToShow===0,`hand ${r.hand}: the all-in shows first`);
    assert(r.board.length===5,`hand ${r.hand}: the board ran out`);
   }
   return {hands:records.length,endings:records.map(r=>['fold','showdown','forfeit','muck'][r.reason]),payouts:state.payouts,matchTransactions:await matchTransactions(m)};
  }finally{stop(...agents);relay.close();}
 },
 // The relay cuts out with real money in the pot, and the caller mucks on chain. The contract itself decides
 // whether that's allowed, so this is the rule for who shows first, enforced for real after a real bet.
 async betsonchain(){
  const m=await setup('betsonchain',{seconds:60});
  let cut=false,seen=0;
  const relay=await startRelay({tap:(seat,body)=>{seen++;if(seen>24)cut=true;return cut?[]:[body];}});
  const a=agent(m,0,relay.url,{stall:20,decide:bot('raise')}),b=agent(m,1,relay.url,{stall:20,decide:bot('call','--show','never')});
  const started=Date.now();
  try{
   const exits=await withTimeout(Promise.all([a.done,b.done]),480_000,'betting on chain');
   assert(exits.every(e=>e.code===0),`agents exited ${JSON.stringify(exits)}: ${a.err.slice(-300)} | ${b.err.slice(-300)}`);
   const state=await settled(m),count=await matchTransactions(m);
   assert(cut,'the relay really did cut out');
   const moves=[a,b].flatMap(x=>x.err.split('\n').filter(l=>l.includes('on-chain move'))).length;
   assert(moves>0,'moves really happened on chain');
   assert(state.game.reason===3&&state.game.winner===0,`the caller mucked on chain, reason ${state.game.reason}, winner ${state.game.winner}`);
   assert(state.aggressor===0,'the contract recorded who got called');
   assert(state.payouts[0]>m.manifest.buyIn+20_000,`seat 0 won a pot with real bets in it: ${state.payouts}`);
   assert(state.game.holes[1].every(c=>c===255),'the mucked cards are not on chain');
   return {seconds:Math.round((Date.now()-started)/1000),onChainMoves:moves,matchTransactions:count,payouts:state.payouts,settledBy:'muck',walletChanges:await delta(m)};
  }finally{stop(a,b);relay.close();}
 },
 // A decision program that's slow, talks nonsense, or won't start. The match still ends, and fairly.
 async badbots(){
  const results={};
  for(const [name,decide,think,check] of [
   ['slow',bot('call','--delay','1500'),10,r=>r.reason!==0],
   ['nonsense',`${JSON.stringify(process.execPath)} -e "process.stdin.on('data',()=>console.log('rubbish'))"`,1,r=>r.reason===0],
   ['missing','/no/such/program',10,r=>r.reason===0],
  ]){
   const m=await setup(`badbot-${name}`,{seconds:600});
   const relay=await startRelay();
   const agents=[agent(m,0,relay.url,{decide:bot('raise')}),agent(m,1,relay.url,{decide,think})];
   try{
    const exits=await withTimeout(Promise.all(agents.map(a=>a.done)),240_000,`${name} program`);
    assert(exits.every(e=>e.code===0),`${name}: agents exited ${JSON.stringify(exits)}: ${agents.map(a=>a.err.slice(-300)).join(' | ')}`);
    const state=await settled(m),[r]=checkResults(m,state,agents),count=await matchTransactions(m);
    assert(check(r),`${name}: ended by ${r.reason}`);
    assert(count<=4,`${name}: no dispute came of it, saw ${count} transactions`);
    results[name]={ending:['fold','showdown','forfeit','muck'][r.reason],payouts:state.payouts};
   }finally{stop(...agents);relay.close();}
  }
  return results;
 },
 // Two players, one command each, real betting. Everything but the stake and small fees comes back.
 async invite(){
  const {dir,wallets}=await inviteSetup('invite');
  const relay=await startRelay();
  let host,guest;
  try{
   ({host}=await hosted(dir,['--relay',relay.url,'--buy-in','0.001','--big-blind','0.00002','--hands','3','--clock','600','--think','10','--decide',bot('raise')]));
   const code=host.out.split('\n').find(l=>l.startsWith('stacks1.'));
   guest=stacks(dir,'home-b',['join',code,'--yes','--decide',bot('call')]);
   const exits=await withTimeout(Promise.all([host.done,guest.done]),300_000,'invited match');
   assert(exits.every(e=>e.code===0),`exited ${JSON.stringify(exits)}: ${host.err.slice(-400)} | ${guest.err.slice(-400)}`);
   const [a,b]=[lastJson(host),lastJson(guest)];
   assert(a.payouts[0]===b.payouts[0]&&a.payouts[1]===b.payouts[1],'both report the same result');
   assert(a.payouts[0]+a.payouts[1]===2_000_000,'nothing is created or lost');
   assert(a.results.length>=1&&a.results.every(r=>r.betting.length>0),'real hands were played');
   const balances=await Promise.all(wallets.map(lamports));
   const spent=balances.map((balance,i)=>1_000_000_000-1_000_000+[a,b][i].payouts[i]-balance);
   // The contract keeps a tombstone at the match's address for good, so it can't be reused. The host pays that.
   const tombstone=Number(await direct.connection.getMinimumBalanceForRentExemption(8));
   assert(spent[0]>=tombstone&&spent[0]<tombstone+100_000,`the host lost only fees and the tombstone (${tombstone}): ${spent[0]}`);
   assert(spent[1]>=0&&spent[1]<100_000,`the guest lost only fees: ${spent[1]}`);
   const list=await direct.connection.getSignaturesForAddress(new PublicKey(a.match),{limit:100},'confirmed');
   const count=list.filter(s=>!s.err).length;
   assert(count<=4,`a clean match stays off chain, saw ${count} transactions`);
   return {hands:a.results.length,payouts:a.payouts,lostBesidesTheStake:spent,tombstone,matchTransactions:count};
  }finally{for(const p of [host,guest])if(p&&p.exit===null)p.child.kill('SIGKILL');relay.close();}
 },
 // A language model in a real match, through the normal invite, against the solver. Only when named. Unless
 // AGENT_STACKS_LLM_BOT names the program to run, a stand-in server answers, so this costs nothing and needs no login.
 // AGENT_STACKS_LLM_BOTH puts it in both seats. AGENT_STACKS_LLM_HANDS, _THINK and _FUND set the rest.
 async llm(){
  const hands=process.env.AGENT_STACKS_LLM_HANDS??'3',think=process.env.AGENT_STACKS_LLM_THINK??'60';
  const {dir,wallets}=await inviteSetup('llm',{fundEach:Number(process.env.AGENT_STACKS_LLM_FUND??1_000_000_000)});
  const relay=process.env.AGENT_STACKS_LLM_RELAY?{url:process.env.AGENT_STACKS_LLM_RELAY,close:()=>{}}:await startRelay();
  const fake=process.env.AGENT_STACKS_LLM_BOT?null:await standInModel(Number(process.env.SOAK_SEED??7));
  if(fake)ENV.ANTHROPIC_API_KEY='stand-in';
  const program=process.env.AGENT_STACKS_LLM_BOT??`${JSON.stringify(process.execPath)} examples/llm-bot.js --api anthropic --base-url ${fake.url}`;
  const files=['host','guest'].map(seat=>join(dir,`decisions-${seat}.jsonl`));
  const guestBot=process.env.AGENT_STACKS_LLM_BOTH?`${program} --log ${files[1]}`:`${JSON.stringify(process.execPath)} examples/solver-bot.js --seed 5 --style balanced`;
  let host,guest;
  try{
   ({host}=await hosted(dir,['--relay',relay.url,'--buy-in','0.001','--big-blind','0.00002','--hands',hands,'--clock','900','--think',think,'--decide',`${program} --log ${files[0]}`]));
   const code=host.out.split('\n').find(l=>l.startsWith('stacks1.'));
   guest=stacks(dir,'home-b',['join',code,'--yes','--decide',guestBot]);
   const started=Date.now();
   const exits=await withTimeout(Promise.all([host.done,guest.done]),Number(process.env.AGENT_STACKS_LLM_SECONDS??900)*1000,'match with a model');
   assert(exits.every(e=>e.code===0),`exited ${JSON.stringify(exits)}: ${host.err.slice(-400)} | ${guest.err.slice(-400)}`);
   const [a,b]=[lastJson(host),lastJson(guest)];
   assert(a.payouts?.[0]===b.payouts?.[0]&&a.payouts[0]+a.payouts[1]===2_000_000,`both report the same result, with nothing lost: ${a.payouts} and ${b.payouts}`);
   const pairs=a.results.flatMap(r=>{const o=b.results.find(x=>x.hand===r.hand);return o?[[r,o]]:[];});
   const list=await direct.connection.getSignaturesForAddress(new PublicKey(a.match),{limit:200},'confirmed');
   const transactions=list.filter(s=>!s.err).length,disputed=transactions>4;
   const judged=disputed?pairs.slice(0,-1):pairs,faults=referee(1_000_000,20_000,judged);
   assert(!faults.length,`the referee disagrees: ${faults.join('; ')}`);
   const decisions=files.filter(existsSync).flatMap(file=>readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)));
   assert(decisions.length>0,'the model made decisions');
   const answered=decisions.filter(d=>!d.failed),seen={};coverage(seen,judged,20_000);
   const mix={};for(const d of answered){const name=d.reply.action??(d.reply.show?'show':'muck');mix[name]=(mix[name]??0)+1;}
   const reasons={};for(const d of decisions)if(d.failed)reasons[d.failed.slice(0,60)]=(reasons[d.failed.slice(0,60)]??0)+1;
   const seconds=answered.map(d=>d.ms/1000);
   return {realModel:!fake,seconds:Math.round((Date.now()-started)/1000),hands:a.results.length,payouts:a.payouts,transactions,decisions:decisions.length,answered:answered.length,mix,failed:reasons,thinkingSeconds:seconds.length?{mean:Number((seconds.reduce((x,y)=>x+y,0)/seconds.length).toFixed(1)),max:Math.max(...seconds)}:null,tokens:{input:answered.reduce((n,d)=>n+(d.input??0),0),output:answered.reduce((n,d)=>n+(d.output??0),0)},play:seen,wallets,dir};
  }finally{for(const p of [host,guest])if(p&&p.exit===null)p.child.kill('SIGKILL');relay.close();fake?.close();if(fake)delete ENV.ANTHROPIC_API_KEY;}
 },
 // The guest's machine crashes mid-match. The same code picks it up again, and asks nothing twice.
 async inviteresume(){
  const {dir}=await inviteSetup('inviteresume');
  const relay=await startRelay();
  let host,guest,again,late;
  try{
   ({host}=await hosted(dir,['--relay',relay.url,'--buy-in','0.001','--hands','2','--clock','600','--think','10','--decide',bot('call')]));
   const code=host.out.split('\n').find(l=>l.startsWith('stacks1.'));
   guest=stacks(dir,'home-b',['join',code,'--yes','--decide',bot('call')]);
   const stateFile=()=>{const id=readdirSync(join(dir,'home-b')).find(n=>!n.endsWith('.json'));return id?join(dir,'home-b',id,'state'):null;};
   await waitFor('a hand under way',async()=>{try{const d=stateFile();const f=d&&readdirSync(d).find(n=>n.endsWith('.state.json'));return f&&JSON.parse(readFileSync(join(d,f),'utf8')).latest?.seq>=4;}catch{return false;}});
   guest.child.kill('SIGKILL');await guest.done;log('killed the guest mid-hand');
   await pause(2000);
   // No --yes this time: it has already accepted these terms.
   again=stacks(dir,'home-b',['resume',code,'--decide',bot('call')]);
   const exits=await withTimeout(Promise.all([host.done,again.done]),300_000,'match after the crash');
   assert(exits.every(e=>e.code===0),`exited ${JSON.stringify(exits)}: ${host.err.slice(-400)} | ${again.err.slice(-400)}`);
   const [a,b]=[lastJson(host),lastJson(again)];
   assert(a.payouts[0]===b.payouts[0],'both report the same result');
   // The host has retired the match by now, so the account can't say what anyone won. A guest who looks later still finds out.
   const info=await direct.connection.getAccountInfo(new PublicKey(a.match),'confirmed');
   assert(info?.data.length===8,'the match is retired');
   late=stacks(dir,'home-b',['resume',code,'--decide',bot('call')]);
   const [lateExit]=await withTimeout(Promise.all([late.done]),120_000,'a late resume');
   assert(lateExit.code===0,`the late resume exited ${JSON.stringify(lateExit)}: ${late.err.slice(-400)}`);
   const seen=lastJson(late).payouts;
   assert(seen?.[0]===a.payouts[0]&&seen?.[1]===a.payouts[1],`a late look finds the same result: ${seen} against ${a.payouts}`);
   return {payouts:a.payouts,hands:a.results.length,afterRetiring:seen};
  }finally{for(const p of [host,guest,again,late])if(p&&p.exit===null)p.child.kill('SIGKILL');relay.close();}
 },
 // A code that points at a contract this player doesn't trust. No money moves, and nothing is offered.
 async invitebadcontract(){
  const {dir,wallets}=await inviteSetup('invitebadcontract');
  const relay=await startRelay();
  let host;
  try{
   ({host}=await hosted(dir,['--relay',relay.url,'--buy-in','0.001','--think','10','--check-call']));
   const code=host.out.split('\n').find(l=>l.startsWith('stacks1.'));
   const before=await lamports(wallets[1]);
   // This player's software trusts a different build at this address, as if the contract had been swapped.
   const honest=JSON.parse(readFileSync(join(dir,'deployment.json'),'utf8'));
   writeFileSync(join(dir,'deployment.json'),JSON.stringify({...honest,programSha256:'00'.repeat(32)}));
   const wrongCode=stacks(dir,'home-b',['join',code,'--yes']);await wrongCode.done;
   assert(wrongCode.exit.code!==0&&/differs from pinned/.test(wrongCode.err),`refused swapped code: ${wrongCode.err.slice(-300)}`);
   // And a different address altogether.
   writeFileSync(join(dir,'deployment.json'),JSON.stringify({...honest,program:'11111111111111111111111111111112'}));
   const wrongAddress=stacks(dir,'home-b',['join',code,'--yes']);await wrongAddress.done;
   assert(wrongAddress.exit.code!==0,'refused another address');
   writeFileSync(join(dir,'deployment.json'),JSON.stringify(honest));
   // With terms it hasn't seen, and nobody at a keyboard, it won't guess.
   const unattended=stacks(dir,'home-b',['join',code]);await unattended.done;
   assert(unattended.exit.code!==0&&/--yes/.test(unattended.err),`refused without consent: ${unattended.err.slice(-300)}`);
   assert(await lamports(wallets[1])===before,'not a lamport moved');
   assert((relay.boxes.get(`${decodeInvite(code).id}/0`)?.items.length??0)===0,'and the host heard nothing');
   return {refused:true};
  }finally{if(host&&host.exit===null)host.child.kill('SIGKILL');relay.close();}
 },
 // A decision program that can't answer is found out before anyone has spent anything, on either side.
 async notready(){
  const {dir,wallets}=await inviteSetup('notready');
  const relay=await startRelay(),before=await Promise.all(wallets.map(lamports));
  const broken=`${JSON.stringify(process.execPath)} -e "console.error('no login');process.exit(1)"`;
  let host,guest;
  try{
   const noHost=stacks(dir,'home-a',['host','--relay',relay.url,'--buy-in','0.001','--think','5','--decide',broken]);await noHost.done;
   assert(noHost.exit.code!==0&&/isn’t ready/.test(noHost.err)&&/no login/.test(noHost.err),`the host was refused: ${noHost.err.slice(-300)}`);
   assert(!noHost.out.includes('stacks1.'),'and got no code to send');
   ({host}=await hosted(dir,['--relay',relay.url,'--buy-in','0.001','--big-blind','0.00002','--hands','1','--clock','600','--think','10','--decide',bot('call')]));
   const code=host.out.split('\n').find(l=>l.startsWith('stacks1.'));
   const noGuest=stacks(dir,'home-b',['join',code,'--yes','--decide',broken]);await noGuest.done;
   assert(noGuest.exit.code!==0&&/isn’t ready/.test(noGuest.err)&&/no login/.test(noGuest.err),`the guest was refused: ${noGuest.err.slice(-300)}`);
   assert((relay.boxes.get(`${decodeInvite(code).id}/0`)?.items.length??0)===0,'and the host heard nothing');
   assert((await Promise.all(wallets.map(lamports))).every((balance,i)=>balance===before[i]),'not a lamport moved');
   // The code still works, once the guest has it fixed.
   guest=stacks(dir,'home-b',['join',code,'--yes','--decide',bot('call')]);
   const exits=await withTimeout(Promise.all([host.done,guest.done]),240_000,'the match after the fix');
   assert(exits.every(e=>e.code===0),`exited ${JSON.stringify(exits)}: ${host.err.slice(-300)} | ${guest.err.slice(-300)}`);
   return {refusedBeforeSpending:2,payouts:lastJson(host).payouts};
  }finally{for(const p of [host,guest])if(p&&p.exit===null)p.child.kill('SIGKILL');relay.close();}
 },
 // A guest with no funds yet, and a host who isn't paying. Nobody's deposit goes in until the guest can match it.
 async guestpayslate(){
  const {dir,wallets}=await inviteSetup('guestpayslate',{fundEach:[1_000_000_000,0]});
  const relay=await startRelay();
  let host,guest;
  try{
   ({host}=await hosted(dir,['--relay',relay.url,'--buy-in','0.001','--big-blind','0.00002','--hands','1','--clock','600','--think','10','--decide',bot('call')]));
   const code=host.out.split('\n').find(l=>l.startsWith('stacks1.')),before=await lamports(wallets[0]);
   guest=stacks(dir,'home-b',['join',code,'--yes','--decide',bot('call')]);
   await waitFor('the host to see an empty wallet',async()=>/their wallet/.test(host.err)||null,60_000);
   assert(/Send the difference/.test(guest.err),`the guest is told what to do: ${guest.err.slice(-300)}`);
   assert(!/Sending/.test(host.err)&&await lamports(wallets[0])===before,'the host hasn’t paid for them, or put in a deposit');
   assert(!/Creating the match/.test(host.err),'and hasn’t created the match');
   await fund(new PublicKey(wallets[1]),20_000_000);
   const exits=await withTimeout(Promise.all([host.done,guest.done]),240_000,'the match once funded');
   assert(exits.every(e=>e.code===0),`exited ${JSON.stringify(exits)}: ${host.err.slice(-300)} | ${guest.err.slice(-300)}`);
   return {payouts:lastJson(host).payouts};
  }finally{for(const p of [host,guest])if(p&&p.exit===null)p.child.kill('SIGKILL');relay.close();}
 },
 // Two agents that can only run commands, as someone's coding agent would. The guest starts with an empty wallet, the
 // host has exactly what it's told to have for both of them, and each is killed partway through and picks up again.
 async turnbyturn(){
  const buyIn=1_000_000;
  const {dir,wallets}=await inviteSetup('turnbyturn',{fundEach:[0,0]});
  const relay=await startRelay();
  const shell=async(home,...args)=>{const p=stacks(dir,home,args);await p.done;return p;};
  let id=null;
  const running=home=>JSON.parse(readFileSync(join(dir,home,id,'turns/process.json'),'utf8')).pid;
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  const started=Date.now();
  try{
   const hostStart=await shell('home-a','host','--relay',relay.url,'--buy-in','0.001','--big-blind','0.00002','--hands','3','--clock','600','--think','60','--fund-guest');
   assert(hostStart.exit.code===0,`host: ${hostStart.err.slice(-400)}`);
   const code=hostStart.out.split('\n').find(l=>l.startsWith('stacks1.'));
   id=decodeInvite(code).id;
   // Exactly what it says it needs, with nothing to spare, so that figure has to be right.
   const needs=/needs ([\d.]+) SOL for the match/.exec(hostStart.err);
   assert(needs,`the host is told what it needs: ${hostStart.err.slice(0,400)}`);
   await fund(new PublicKey(wallets[0]),parseSol(needs[1]));
   assert(decodeInvite(code).fund===true,'the code says the host pays');
   assert(/Send everything between the lines/.test(hostStart.err)&&hostStart.err.includes(`challenge code is ${code}\n`)&&/github\.com/.test(hostStart.err),'the host gets a message to send');
   const guestStart=await shell('home-b','join',code,'--yes');
   assert(guestStart.exit.code===0,`guest: ${guestStart.err.slice(-400)}`);
   assert(JSON.parse(guestStart.out.trim().split('\n').at(-1)).next.includes('next'),'and says what to run');
   assert(/host sends your wallet/.test(guestStart.err),'the guest is told who’s paying');
   for(const home of ['home-a','home-b'])assert(!execFileSync('ps',['-o','args=','-p',String(running(home))],{encoding:'utf8'}).includes('stacks1.'),'the code’s secret stays out of the process list');
   const raiser=t=>t.type==='show'?[t.winning||t.tied?'show':'muck']:t.legal.raise&&t.street==='flop'?['raise',String(t.legal.raise.min)]:t.legal.check?['check']:['call'];
   const caller=t=>t.type==='show'?[t.winning||t.tied?'show':'muck']:t.legal.check?['check']:['call'];
   const play=async(home,choose,killAt)=>{
    const seen={decisions:0,commands:0,results:[],missed:[],refused:0,restarts:0};
    let command=['next','--wait','3'];
    for(;seen.commands<3000;seen.commands++){
     const p=await shell(home,...command);
     assert(p.exit.code===0,`${home} ${command.join(' ')}: ${p.err.slice(-300)}`);
     const turn=lastJson(p);
     for(const event of turn.since??[])(event.type==='missed'?seen.missed:seen.results).push(event);
     command=['next','--wait','3'];
     if(turn.type==='over')return {...seen,over:turn};
     if(turn.type==='waiting')continue;
     if(turn.type==='stopped'){
      assert(turn.resume.includes('resume'),'it says how to carry on');
      const again=await shell(home,'resume');
      assert(again.exit.code===0,`resume: ${again.err.slice(-300)}`);
      seen.restarts++;
      continue;
     }
     assert(turn.type==='bet'||turn.type==='show',`an unknown turn: ${JSON.stringify(turn).slice(0,200)}`);
     seen.decisions++;
     if(seen.decisions===killAt){
      const pid=running(home);process.kill(pid,'SIGKILL');
      await waitFor('the match to die',async()=>!alive(pid)||null,10_000);
      continue;
     }
     if(turn.type==='bet'&&!seen.refused){
      const bad=await shell(home,'move',turn.id,'raise','1');
      assert(bad.exit.code===1&&(/out of range/.test(bad.err)||/can’t bet or raise/.test(bad.err)),`a bad move is refused: ${bad.err.slice(-200)}`);
      const stale=await shell(home,'move','0/0','call');
      assert(stale.exit.code===1&&/has passed/.test(stale.err),`and so is one for another decision: ${stale.err.slice(-200)}`);
      seen.refused++;
     }
     command=['move',turn.id,...choose(turn),'--wait','3'];
    }
    throw Error('Too many commands');
   };
   const [a,b]=await withTimeout(Promise.all([play('home-a',raiser,3),play('home-b',caller,4)]),420_000,'a match played by commands');
   assert(a.over.finished+b.over.finished===2*buyIn,`nothing is created or lost: ${a.over.finished} and ${b.over.finished}`);
   assert(a.over.hands===b.over.hands&&a.results.length===a.over.hands&&b.results.length===b.over.hands,`each hand is reported once: ${a.results.length}, ${b.results.length} of ${a.over.hands}`);
   assert(a.results.at(-1).stacks.you===a.over.finished&&b.results.at(-1).stacks.you===b.over.finished,'and the last one matches the result');
   assert(!a.missed.length&&!b.missed.length,`no decision went by: ${JSON.stringify([a.missed,b.missed]).slice(0,300)}`);
   assert(a.restarts>=1&&b.restarts>=1,'both were killed and came back');
   assert(a.results.flatMap(r=>r.history).some(h=>h.action==='raise'),'and real bets were made');
   assert(await lamports(wallets[1])>=b.over.finished,'the guest, who started with nothing, holds what they won');
   const list=await direct.connection.getSignaturesForAddress(new PublicKey(a.over.match),{limit:100},'confirmed');
   const count=list.filter(s=>!s.err).length;
   assert(count<=4,`it stayed off chain, saw ${count} transactions`);
   await waitFor('the matches to end',async()=>(!alive(running('home-a'))&&!alive(running('home-b')))||null,30_000);
   return {seconds:Math.round((Date.now()-started)/1000),hands:a.over.hands,finished:[a.over.finished,b.over.finished],decisions:[a.decisions,b.decisions],commands:[a.commands,b.commands],restarts:[a.restarts,b.restarts],transactions:count};
  }finally{
   if(id)for(const home of ['home-a','home-b']){try{process.kill(running(home),'SIGKILL');}catch{}}
   relay.close();
  }
 },
 // One wallet hosting three matches at once, with only enough for two. The third waits its turn rather than failing.
 async sharedwallet(){
  const {dir,wallets}=await inviteSetup('sharedwallet',{fundEach:[0,0]});
  const relay=await startRelay(),hosts=[],guests=[];
  const options=seed=>['--relay',relay.url,'--buy-in','0.001','--big-blind','0.00002','--hands','1','--clock','600','--think','10','--fund-guest','--decide',bot(seed)];
  try{
   for(let i=0;i<3;i++)hosts.push((await hosted(dir,options('call'))).host);
   const needs=/needs ([\d.]+) SOL for the match/.exec(hosts[0].err);
   assert(needs,`the host is told what it needs: ${hosts[0].err.slice(0,300)}`);
   await fund(new PublicKey(wallets[0]),2*parseSol(needs[1]));
   ['home-b','home-c','home-d'].forEach((home,i)=>guests.push(stacks(dir,home,['join',hosts[i].out.split('\n').find(l=>l.startsWith('stacks1.')),'--yes','--decide',bot('call')])));
   const everyone=[...hosts,...guests];
   const exits=await withTimeout(Promise.all(everyone.map(p=>p.done)),300_000,'three matches from one wallet');
   assert(exits.every(e=>e.code===0),`exited ${JSON.stringify(exits)}: ${everyone.map(p=>p.err.slice(-200)).join(' | ')}`);
   for(const p of hosts)assert(lastJson(p).payouts[0]+lastJson(p).payouts[1]===2_000_000,'each match paid out what went in');
   const waited=hosts.filter(p=>/Send the difference/.test(p.err)).length;
   assert(waited>=1,'at least one had to wait for funds, or this tested nothing');
   return {matches:3,waitedForFunds:waited,payouts:hosts.map(p=>lastJson(p).payouts)};
  }finally{for(const p of [...hosts,...guests])if(p.exit===null)p.child.kill('SIGKILL');relay.close();}
 },
 // Many matches at varied stack depths, with bots that play differently, and with things going wrong. After
 // each one, every finished hand has to agree with a referee that shares no code with the engine or contract.
 // SOAK_MATCHES and SOAK_WORKERS set the size, and SOAK_SEED makes a run repeatable.
 async soak(){
  const total=Number(process.env.SOAK_MATCHES??24),workers=Number(process.env.SOAK_WORKERS??5),base=Number(process.env.SOAK_SEED??Date.now()%1_000_000);
  const seen={},failures=[],kinds={};let finished=0;
  const LATE_RESEND=new Set(['Key is not due','Key already recorded','Shuffle is not due','Move is not due','Acknowledgement is not due']);
  const solver=(seed,style,extra='')=>`${JSON.stringify(process.execPath)} examples/solver-bot.js --seed ${seed} --style ${style} ${extra}`.trim();
  const STYLES=['balanced','tight','loose','aggressive','passive'];
  async function one(index){
   const seed=base+index*7919;
   const rng=seededRandom(seed),pick=list=>list[Math.floor(rng()*list.length)];
   const kind=pick(['none','none','none','none','restart','restart','mess','mess','drop','cut','cut','wipe']);
   const bigBlind=pick([2_000,10_000,20_000,50_000,100_000]),hands=3+Math.floor(rng()*6),seconds=kind==='cut'?90:600;
   const sizes=pick(['0.33,0.75,1.5','0.5,1','0.25,0.66,1,2','0.75']),noise=pick([0,0,0.05,0.1]);
   const bots=[0,1].map(i=>rng()<0.15?bot('random','--seed',seed+i):solver(seed+i,pick(STYLES),`--sizes ${sizes} --noise ${noise} --show ${pick(['default','default','sometimes'])}`));
   const label=`match ${index} (seed ${seed}, ${kind}, ${bigBlind} big blind, ${hands} hands)`;
   kinds[kind]=(kinds[kind]??0)+1;
   const m=await setup(`soak-${index}`,{hands,seconds,bigBlind});
   const held=[[],[]];let messages=0,cut=false,relayRef=null,wipeAt=20+Math.floor(rng()*200),cutAt=20+Math.floor(rng()*160);
   const tap=(seat,body)=>{
    messages++;
    if(kind==='cut'){if(messages>cutAt)cut=true;return cut?[]:[body];}
    if(kind==='drop')return rng()<0.12?[]:[body];
    if(kind==='wipe'&&messages===wipeAt){relayRef.boxes.clear();return [body];}
    if(kind==='mess'){
     const roll=rng();
     if(roll<0.1)return [body,body];
     if(roll<0.2&&held[seat].length<8){held[seat].push(body);return [];}
     const out=[body,...held[seat]];held[seat].length=0;return out;
    }
    return [body];
   };
   const relay=await startRelay({tap});relayRef=relay;
   const options=seat=>({stall:kind==='cut'?20:90,decide:bots[seat],think:5});
   const agents=[agent(m,0,relay.url,options(0)),agent(m,1,relay.url,options(1))];
   let stopped=false,restarting=false;const running=[];
   // The state files only exist once play has begun, so a restart lands mid-match.
   if(kind==='restart')running.push((async()=>{
    for(let time=0;time<2&&!stopped;time++){
     await pause(15_000+rng()*40_000);
     const seat=rng()<0.5?0:1;
     if(stopped||agents[seat].exit)return;
     restarting=true;
     agents[seat].child.kill('SIGKILL');await agents[seat].done;
     await pause(500+rng()*4000);
     agents[seat]=agent(m,seat,relay.url,options(seat));
     restarting=false;
     seen.restarts=(seen.restarts??0)+1;
    }
   })());
   try{
    const deadline=Date.now()+1_500_000;
    // A restart replaces an agent, so this always waits on whichever is current.
    for(;;){
     if(!restarting&&agents.every(a=>a.exit))break;
     if(Date.now()>deadline)throw Error('Timed out');
     await pause(500);
    }
    stopped=true;await Promise.all(running);
    assert(agents.every(a=>a.exit.code===0),`agents exited ${JSON.stringify(agents.map(a=>a.exit))}: ${agents.map(a=>a.err.slice(-400)).join(' | ')}`);
    const state=await settled(m,120_000),finals=agents.map(finalOf);
    assert(state.payouts[0]+state.payouts[1]===2*m.manifest.buyIn,`payouts add up: ${state.payouts}`);
    const onChain=await matchTransactions(m);
    const disputed=onChain>4;
    if(disputed){seen['disputed matches']=(seen['disputed matches']??0)+1;seen['on-chain moves']=(seen['on-chain moves']??0)+agents.flatMap(a=>a.err.split('\n').filter(l=>l.includes('on-chain move'))).length;}
    const walletDeltas=await delta(m);
    assert(walletDeltas[0]===state.payouts[0]&&walletDeltas[1]===state.payouts[1],`wallets got what the contract paid: ${walletDeltas} and ${state.payouts}`);
    // Match up what each side recorded. A hand that ended on chain may be recorded by only one of them.
    const pairs=finals[0].results.flatMap(r=>{const o=finals[1].results.find(x=>x.hand===r.hand);return o?[[r,o]]:[];});
    for(const [a,b] of pairs)for(const field of ['winner','reason','aggressor','firstToShow'])assert(a[field]===b[field],`hand ${a.hand}: both agree on ${field}: ${a[field]} and ${b[field]}`);
    const clean=disputed?pairs.slice(0,-1):pairs;
    const faults=referee(m.manifest.buyIn,bigBlind,clean);
    assert(!faults.length,faults.join('; '));
    if(!disputed){
     const last=pairs.at(-1)?.[0];
     assert(last&&state.payouts[0]===last.stacks[0]&&state.payouts[1]===last.stacks[1],`the contract paid what the last hand left: ${state.payouts} and ${last?.stacks}`);
     assert(finals[0].results.length===finals[1].results.length,'both recorded every hand');
    }
    if(kind==='none'){
     assert(!disputed,`nothing went wrong, but it went to the chain: ${onChain} transactions`);
     assert(agents.every(a=>!/isn’t allowed|didn’t answer|exited/.test(a.err)),`no decision failed: ${agents.map(a=>a.err.slice(-300)).join(' | ')}`);
    }
    // Every rejection has to be something a resend that arrived late would cause. Anything else is a bug or an attack.
    for(const f of finals)for(const [why,count] of Object.entries(f.rejectedWhy??{})){
     seen[`rejected: ${why}`]=(seen[`rejected: ${why}`]??0)+count;
     assert(LATE_RESEND.has(why),`rejected a message for an unexpected reason: ${why} (${count})`);
    }
    coverage(seen,clean,bigBlind);
    finished++;log(`${label}: passed with ${pairs.length} hands, ${onChain} transactions (${finished} done, ${failures.length} failed)`);
   }catch(error){
    failures.push({label,error:error.message.slice(0,1200),directory:m.dir,logs:agents.map(a=>a.err.slice(-1500))});
    log(`${label}: FAILED: ${error.message.slice(0,400)}`);
   }finally{stopped=true;await Promise.all(running).catch(()=>{});stop(...agents);relay.close();}
  }
  let next=0;
  await Promise.all(Array.from({length:workers},async()=>{for(;;){const index=next++;if(index>=total)return;await one(index).catch(error=>{failures.push({label:`match ${index}`,error:error.message});log(`match ${index}: setup failed: ${error.message.slice(0,300)}`);});}}));
  writeFileSync(join(work,`soak-${base}.json`),JSON.stringify({base,total,kinds,seen,failures},null,1));
  assert(!failures.length,`${failures.length} of ${total} matches failed; first: ${failures[0]?.label}: ${failures[0]?.error}`);
  return {base,matches:total,faults:kinds,seen};
 },
 // A player too short to pay the blind in full. Hand 1 leaves one player with 50,000 against a 100,000 big blind,
 // so hand 2 starts with that player all-in on the blind, and the board runs out with no betting at all.
 // It's played over the relay, and then with the relay cut as hand 2 begins, so the contract has to do it too.
 async shortblind(){
  const results={};
  for(const onChain of [false,true]){
   const m=await setup(`shortblind-${onChain?'chain':'relay'}`,{hands:3,seconds:60,bigBlind:100_000});
   let cut=false,after=0;
   const relay=await startRelay({tap:(_seat,body)=>{
    if(!onChain)return [body];
    if(!after&&body.includes('"type":"key"')&&body.includes('"hand":2'))after=1;
    // Late enough that both have signed hand 2. Any sooner and it correctly settles at hand 1's stacks.
    else if(after&&++after>13)cut=true;
    return cut?[]:[body];
   }});
   const a=agent(m,0,relay.url,{stall:20,decide:bot('plan','--to','950000')}),b=agent(m,1,relay.url,{stall:20,decide:bot('call')});
   try{
    const exits=await withTimeout(Promise.all([a.done,b.done]),Number(process.env.AGENT_STACKS_SHORTBLIND_SECONDS??420)*1000,'short blind');
    assert(exits.every(e=>e.code===0),`agents exited ${JSON.stringify(exits)}: ${a.err.slice(-300)} | ${b.err.slice(-300)}`);
    const state=await settled(m),finals=[a,b].map(finalOf);
    assert(state.payouts[0]+state.payouts[1]===2*m.manifest.buyIn,`payouts add up: ${state.payouts}`);
    const pairs=finals[0].results.flatMap(r=>{const o=finals[1].results.find(x=>x.hand===r.hand);return o?[[r,o]]:[];});
    const [first,second]=pairs;
    assert(first&&Math.min(...first[0].stacks)===50_000||first?.[0].winner===2,`hand 1 left someone short: ${first?.[0].stacks}`);
    if(first[0].winner===2){results[onChain?'chain':'relay']={skipped:'hand 1 split the pot'};continue;}
    const moves=[a,b].flatMap(x=>x.err.split('\n').filter(l=>l.includes('on-chain move'))).length;
    if(onChain)assert(cut&&moves>0,`it went to the chain: cut ${cut}, ${moves} moves`);
    // On chain the contract's word is the result, and the last hand needn't be recorded by both.
    if(second){
     assert(second[0].betting.length===0,`hand 2 had no betting: ${JSON.stringify(second[0].betting)}`);
     assert(second[0].board.length===5,'the board ran out');
     const faults=referee(m.manifest.buyIn,100_000,onChain?[first]:pairs);
     assert(!faults.length,faults.join('; '));
    }
    const shortSeat=first[0].stacks[0]<first[0].stacks[1]?0:1;
    const possible=[50_000*2,50_000,0];
    assert(possible.includes(state.payouts[shortSeat]),`the short player can win at most what it put in: ${state.payouts}`);
    results[onChain?'chain':'relay']={payouts:state.payouts,hand2:second?['fold','showdown','forfeit','muck'][second[0].reason]:'settled on chain',moves,transactions:await matchTransactions(m)};
   }finally{stop(a,b);relay.close();}
  }
  return results;
 },
 // A player posts an old state hoping the other is asleep. The other's newest state must win.
 async stale(){
  const m=await setup('stale',{seconds:30});
  const relay=await startRelay();
  const a=agent(m,0,relay.url,{stall:300}),b=agent(m,1,relay.url,{stall:300});
  try{
   // Let play run a little, and take a snapshot of an early co-signed state before it moves on.
   const early=await waitFor('an early signed state',async()=>{try{const s=stateOf(m,'b');return s.latest?.seq>=1&&s.latest.kind===KIND_HAND?s.latest:null;}catch{return null;}});
   await waitFor('play to move on',async()=>{try{return stateOf(m,'a').latest?.seq>=early.seq+3;}catch{return false;}});
   b.child.kill('SIGKILL');await b.done;
   const newest=stateOf(m,'a').latest.seq;
   log(`player B posts old state ${early.seq}; player A knows ${newest}`);
   const cheat=new ChannelChain(new ChainClient(rpc,program,m.sessions[1],{allowLocal:true}),m.config);
   const signed=signedMessage({program:m.config.programBytes,match:m.config.matchBytes,terms:m.config.termsBytes},KIND_HAND,early.seq,sha256(Buffer.from(early.payload,'hex')));
   await cheat.postHand(signed,early.seq,Buffer.from(early.payload,'hex'),early.sigs,await ensureWallet(m.file('cheat-buffer.json')));
   const answered=await waitFor('player A to answer',async()=>{const s=await reader(m).read();return s.seq>early.seq?s:null;},60_000);
   assert(answered.seq>=newest,`A posted its newest state: chain ${answered.seq}, A ${newest}`);
   const exit=await withTimeout(a.done,240_000,'player A settling');
   assert(exit.code===0,`A exited ${JSON.stringify(exit)}: ${a.err.slice(-400)}`);
   const state=await settled(m);
   return {oldStatePosted:early.seq,answeredWith:answered.seq,payouts:state.payouts,walletChanges:await delta(m)};
  }finally{stop(a,b);relay.close();}
 },
 // A player signs two different states at one step. Those two signatures forfeit the whole escrow.
 async fork(){
  const m=await setup('fork',{seconds:3600});
  const relay=await startRelay();
  const a=agent(m,0,relay.url,{stall:300}),b=agent(m,1,relay.url,{stall:300});
  try{
   const seen=await waitFor('a signed state',async()=>{try{const s=stateOf(m,'b');return s.latest?.seq>=2?s.latest:null;}catch{return null;}});
   b.child.kill('SIGKILL');await b.done;
   const session=sessionFromSeed(Buffer.from(m.sessions[1].secretKey).subarray(0,32));
   const other=sha256(Buffer.from('a different state at the same step'));
   const signature=signMessage(session,signedMessage({program:m.config.programBytes,match:m.config.matchBytes,terms:m.config.termsBytes},KIND_HAND,seen.seq,other));
   const response=await fetch(`${relay.url}/${m.manifest.match}/0`,{method:'POST',body:JSON.stringify({type:'ack',seq:seen.seq,kind:KIND_HAND,hash:toHex(other),sig:toHex(signature)})});
   assert(response.ok,'the forged acknowledgement reached the relay');
   const exit=await withTimeout(a.done,120_000,'player A proving the fork');
   assert(exit.code===0,`A exited ${JSON.stringify(exit)}: ${a.err.slice(-400)}`);
   const state=await settled(m);
   assert(state.payouts[0]===2*m.manifest.buyIn&&state.payouts[1]===0,`the forger forfeits: ${state.payouts}`);
   return {payouts:state.payouts,walletChanges:await delta(m)};
  }finally{stop(a,b);relay.close();}
 },
 // The card-leak attack from the audit, against the new agent. Its RPC lies that showdown is due,
 // on the real chain state with the deadline open, and asks it to reveal its hole cards.
 async liar(){
  const m=await setup('liar',{seconds:3600});
  const relay=await startRelay();
  const sent=[];let lying=false;
  const proxy=createServer(async(req,res)=>{
   let raw='';for await(const c of req)raw+=c;
   const request=JSON.parse(raw),upstream=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:raw});
   let text=await upstream.text();
   if(request.method==='sendTransaction')sent.push(request.params[0]);
   if(lying&&request.method==='getAccountInfo'&&request.params?.[0]===m.manifest.match){
    const parsed=JSON.parse(text);const data=Buffer.from(parsed.result.value.data[0],'base64');
    const truth=stateOf(m,'a');
    // Show the agent's own hand with the phase changed to its showdown, and the window closed.
    const blob=Buffer.from(truth.latest.payload,'hex');
    data[8]=11;data[4251]=0;data.writeBigUInt64LE(BigInt(truth.latest.seq),4324);data.writeBigInt64LE(1n,4332);data.writeBigInt64LE(9_999_999_999n,97);
    blob.subarray(6,70).copy(data,137);
    [0,1,2,3,5,6,7,9,11].forEach((p,i)=>blob.subarray(70+i*64,134+i*64).copy(data,250+p*64));
    blob.subarray(646,735).copy(data,3586);blob.subarray(735,1311).copy(data,3675);
    parsed.result.value.data[0]=data.toString('base64');text=JSON.stringify(parsed);
   }
   res.writeHead(upstream.status,{'content-type':'application/json'});res.end(text);
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const url=`http://127.0.0.1:${proxy.address().port}`;
  const a=agent(m,0,relay.url,{rpcUrl:url,stall:300}),b=agent(m,1,relay.url,{stall:300});
  try{
   await waitFor('seat 0 to hold a signed hand state',async()=>{try{const s=stateOf(m,'a');return s.latest?.seq>=2&&s.s?.phase===8;}catch{return false;}});
   const beforeShares=stateOf(m,'a').s.shares[0][0];
   lying=true;sent.length=0;log('the RPC starts lying that showdown is due');
   await pause(8000);
   const after=stateOf(m,'a');
   // Whatever the agent did next, it must not have released a share for its own hole cards.
   const ownHoleShare=after.s.shares[0][0];
   assert(beforeShares===ownHoleShare,'seat 0 released no share for its own hidden card');
   const outbox=JSON.stringify(after.outbox);
   assert(!outbox.includes('"logical":0')&&!outbox.includes('"logical":2'),'no hole-card share in the outbox');
   const bytes=sent.map(t=>Buffer.from(t,'base64').toString('latin1'));
   const released=bytes.filter(t=>t.includes(`/share/v2/`)&&t.includes(`/11/0/`));
   assert(released.length===0,`no showdown share was broadcast: ${released.length}`);
   return {transactionsWhileLiedTo:sent.length,showdownSharesReleased:released.length,agentLog:a.err.split('\n').filter(l=>/owes nothing|never signed|dispute/.test(l)).slice(0,3)};
  }finally{stop(a,b);relay.close();proxy.closeAllConnections();proxy.close();}
 },
};
const summary={};
for(const name of Object.keys(SCENARIOS)){
 if(only.length?!only.includes(name):name==='soak'||name==='llm')continue;
 log(`scenario ${name}`);
 try{summary[name]={ok:true,...await SCENARIOS[name]()};log(`${name}: passed`);}
 catch(error){summary[name]={ok:false,error:error.message};log(`${name}: FAILED: ${error.message}`);}
}
console.log(JSON.stringify(summary,null,1));
process.exit(Object.values(summary).every(s=>s.ok)?0:1);
