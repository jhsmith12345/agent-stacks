// Plays real channel matches against a local validator, with real agent processes and a real relay, and
// attacks them. Local test funds only. It prints one JSON summary and writes each scenario's working files
// under the directory given.
// Usage: AGENT_STACKS_ALLOW_LOCAL=1 node scripts/channel-rehearsal.js RPC PROGRAM_ID FUNDER_KEYPAIR WORK_DIRECTORY [SCENARIO...]
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {ChainClient,PublicKey,SystemProgram,ensureWallet,loadWallet} from '../src/solana/client.js';
import {sessionFromSeed,signMessage} from '../src/channel/keys.js';
import {ChannelChain,withBytes,COMPLETE} from '../src/channel/chain.js';
import {startRelay} from '../src/channel/relay.js';
import {KIND_HAND,sha256,signedMessage} from '../src/channel/engine.js';
import {toHex} from '../src/channel/wire.js';
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
function agent(m,seat,relayUrl,{rpcUrl=rpc,stall=20,poll=POLL}={}){
 const label=seat===0?'a':'b';
 const child=spawn(process.execPath,[join(root,'examples/channel-agent.js'),m.file(`session-${label}.json`),m.file(`state-${label}`),'--manifest',m.file('manifest.json'),'--relay',relayUrl,'--rpc',rpcUrl],{cwd:root,env:{...ENV,AGENT_STACKS_STALL_SECONDS:String(stall),AGENT_STACKS_POLL_SECONDS:String(poll)},stdio:['ignore','pipe','pipe']});
 const a={child,out:'',err:'',exit:null,seat};
 child.stdout.on('data',d=>{a.out+=d;});child.stderr.on('data',d=>{a.err+=d;});
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
   return {seconds:Math.round((Date.now()-started)/1000),onChainMoves:moves,matchTransactions:count,payouts:state.payouts,finalStep:state.seq,walletChanges:await delta(m)};
  }finally{stop(a,b);relay.close();}
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
 if(only.length&&!only.includes(name))continue;
 log(`scenario ${name}`);
 try{summary[name]={ok:true,...await SCENARIOS[name]()};log(`${name}: passed`);}
 catch(error){summary[name]={ok:false,error:error.message};log(`${name}: FAILED: ${error.message}`);}
}
console.log(JSON.stringify(summary,null,1));
process.exit(Object.values(summary).every(s=>s.ok)?0:1);
