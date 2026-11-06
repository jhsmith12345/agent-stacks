// Plays channel matches between two Lima VMs on public devnet, with faults a laptop or home network really has.
// Each VM holds its own keys and shares only public files. The relay runs on this host, so neither VM depends
// on the other's. Test funds only: this host funds each VM's wallets and they sweep what's left back afterwards.
// Usage: node scripts/channel-vm-rehearsal.js FUNDER_KEYPAIR PROGRAM_ID LOG_DIRECTORY [SCENARIO...]
// Set AGENT_STACKS_VM_RELAY to send the invite scenario through a relay elsewhere, such as a public one.
// VMs: limactl start --name=stacks-a --cpus=2 --memory=2 --disk=4 --mount-none --vm-type=vz --network=vzNAT --containerd=none template:alpine-3.23
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {ChainClient,DEVNET,PublicKey,SystemProgram,loadWallet} from '../src/solana/client.js';
import {COMPLETE,decodeChannel} from '../src/channel/chain.js';
import {startRelay} from '../src/channel/relay.js';
const [funderFile,program,logArg,...only]=process.argv.slice(2);
if(!funderFile||!program||!logArg)throw Error('Usage: node scripts/channel-vm-rehearsal.js FUNDER_KEYPAIR PROGRAM_ID LOG_DIRECTORY [SCENARIO...]');
const logs=resolve(logArg);mkdirSync(logs,{recursive:true,mode:0o700});
const VMS=['stacks-a','stacks-b'],HOST='192.168.64.1',PORT=8787,RELAY=`http://${HOST}:${PORT}`;
// Rent for the match account, one deposit and fees. Any account with SOL in it must keep the rent minimum,
// so wallets and session keys both hold that on top. A reserve is what a session key may spend in a dispute:
// a player that posts needs the buffer's rent as well, and one that only moves needs just fees.
const MATCH_RENT=22_700_000,DEPOSIT=1_000_000,FEES=50_000,RENT_MINIMUM=900_000,JUST_FEES=RENT_MINIMUM+200_000,CAN_POST=RENT_MINIMUM+7_700_000+300_000;
const funder=await loadWallet(resolve(funderFile));
const direct=new ChainClient(DEVNET,program,funder);await direct.checkNetwork();
const log=(...parts)=>process.stderr.write(`[${new Date().toISOString().slice(11,19)}] ${parts.join(' ')}\n`);
const lamports=async key=>Number(await direct.connection.getBalance(new PublicKey(key),'confirmed'));
function run(command,args,{input=null,timeout=180_000}={}){
 return new Promise((done,fail)=>{
  const child=spawn(command,args,{stdio:[input===null?'ignore':'pipe','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');fail(Error(`Timed out: ${command} ${args.slice(0,5).join(' ')}`));},timeout);
  child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
  child.on('exit',code=>{clearTimeout(timer);code===0?done(out):fail(Error(`${args.slice(-1)[0].slice(0,80)} exited ${code}: ${err.slice(-300)}`));});
  if(input!==null){child.stdin.write(input);child.stdin.end();}
 });
}
const vm=(seat,script,options)=>run('limactl',['shell','--workdir','/',VMS[seat],'sh','-c',`cd ~/agent-stacks && ${script}`],options);
const put=(seat,path,content)=>vm(seat,`cat > ${path}`,{input:content});
const channel=(seat,args)=>vm(seat,`node scripts/channel.js ${args} --rpc ${DEVNET}`);
const label=seat=>seat===0?'a':'b';
async function setup(name,{hands=1,seconds=3600,reserves=[JUST_FEES,JUST_FEES]}){
 const dir=`~/runs/${name}-${Date.now()}`;
 const keys=[];
 const returnFunds=async error=>{
  for(const seat of [0,1])for(const key of ['session','wallet'])await channel(seat,`sweep ${dir}/${key}.json ${funder.publicKey.toBase58()} ${program}`).catch(()=>{});
  throw error;
 };
 try{
 for(const seat of [0,1]){
  await vm(seat,`mkdir -p ${dir} && chmod 700 ${dir}`);
  const wallet=JSON.parse(await vm(seat,`node scripts/channel.js session ${dir}/wallet.json`));
  const session=JSON.parse(await vm(seat,`node scripts/channel.js session ${dir}/session.json`));
  keys.push({wallet:wallet.address,session:session.address});
  await direct.send([SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:new PublicKey(wallet.address),lamports:BigInt((seat===0?MATCH_RENT:0)+DEPOSIT+reserves[seat]+RENT_MINIMUM+FEES)})]);
 }
 // Only these two public files ever cross between the machines.
 await put(0,`${dir}/offer.json`,await vm(1,`node scripts/channel.js offer ${dir}/wallet.json ${dir}/session.json`));
 await channel(0,`create ${dir}/wallet.json ${dir}/session.json ${dir}/offer.json ${dir}/manifest.json --program ${program} --buy-in 1000000 --big-blind 20000 --hands ${hands} --seconds ${seconds} --reserve ${reserves[0]} --low-reserve`);
 const manifestText=await vm(0,`cat ${dir}/manifest.json`);
 await put(1,`${dir}/manifest.json`,manifestText);
 await channel(1,`join ${dir}/wallet.json ${dir}/session.json ${dir}/manifest.json --reserve ${reserves[1]} --low-reserve`);
 return {name,dir,keys,manifest:JSON.parse(manifestText)};
 }catch(error){return returnFunds(error);}
}
const startAgent=(m,seat,{stall,poll=0.5,decide=null,think=10})=>vm(seat,`AGENT_STACKS_STALL_SECONDS=${stall} AGENT_STACKS_POLL_SECONDS=${poll} setsid nohup node examples/channel-agent.js ${m.dir}/session.json ${m.dir}/state --manifest ${m.dir}/manifest.json --relay ${RELAY} --rpc ${DEVNET}${decide?` --decide '${decide}' --think ${think}`:''} >> ${m.dir}/agent.out 2>> ${m.dir}/agent.err < /dev/null & echo started`);
const bot=args=>`node examples/decision-bot.js ${args}`;
// The brackets stop the pattern matching this very shell command.
const AGENT="'examples/channel-agen[t]'";
const killAgent=seat=>vm(seat,`pkill -9 -f ${AGENT}; sleep 1; pgrep -f ${AGENT} >/dev/null && echo alive || echo gone`);
// Reading the chain directly, from outside either VM.
async function chainState(m){
 const info=await direct.connection.getAccountInfo(new PublicKey(m.manifest.match),'confirmed');
 return info?decodeChannel(Buffer.from(info.data)):null;
}
const transactionCount=async m=>(await direct.connection.getSignaturesForAddress(new PublicKey(m.manifest.match),{limit:200},'confirmed')).filter(s=>!s.err).length;
async function waitFor(what,check,ms=420_000){
 const started=Date.now();
 for(;;){
  const value=await check().catch(()=>null);
  if(value)return value;
  if(Date.now()-started>ms)throw Error(`Timed out waiting for ${what}`);
  await pause(1500);
 }
}
async function agentFinished(m,seat,ms){
 return waitFor(`player ${label(seat)} to finish`,async()=>{
  const out=(await vm(seat,`cat ${m.dir}/agent.out 2>/dev/null || true`)).trim();
  return out?JSON.parse(out.split('\n').at(-1)):null;
 },ms);
}
async function keepLogs(m){
 for(const seat of [0,1]){
  const text=await vm(seat,`cat ${m.dir}/agent.err 2>/dev/null || true`).catch(()=>'(VM not reachable)');
  writeFileSync(join(logs,`${m.name}-${label(seat)}.log`),text);
 }
}
// Everything left returns to the funder. Throwaway keys stay where they are on each VM. An unfinished
// match is left alone, with its agents still running, so they can finish and free its funds.
async function cleanUp(m){
 await keepLogs(m);
 const state=await chainState(m);
 if(state?.phase!==COMPLETE){log(`${m.name}: match ${m.manifest.match} isn't settled, so its agents keep running`);return;}
 for(const seat of [0,1])await vm(seat,`pkill -9 -f ${AGENT}; true`).catch(()=>{});
 if(!state.pendingPayouts)await channel(0,`retire ${m.dir}/wallet.json ${m.dir}/manifest.json`).catch(error=>log(`retire: ${error.message}`));
 for(const seat of [0,1])for(const key of ['session','wallet'])await channel(seat,`sweep ${m.dir}/${key}.json ${funder.publicKey.toBase58()} ${program}`).catch(error=>log(`sweep: ${error.message}`));
}
const on={tap:null};
const relay=await startRelay({host:HOST,port:PORT,tap:(seat,body)=>(on.tap?on.tap(seat,body):[body])});
// Runs `action` once, when enough messages have crossed the relay that a hand is under way.
function whenMessages(count,action){
 let seen=0;const state={done:null};
 state.done=new Promise((resolve,reject)=>{
  on.tap=(_seat,body)=>{seen++;if(seen===count){log(`${seen} messages crossed the relay`);Promise.resolve().then(action).then(resolve,reject);}return [body];};
 });
 return state.done;
}
const SCENARIOS={
 // Real bets, between two machines. Seat 0 bets every street and seat 1 calls, and shows only a winner.
 async bets(){
  const m=await setup('bets',{hands:4,seconds:600});on.tap=null;
  const started=Date.now();
  try{
   await startAgent(m,0,{stall:180,poll:0.25,decide:bot('raise')});await startAgent(m,1,{stall:180,poll:0.25,decide:bot('call')});
   const finals=await Promise.all([0,1].map(seat=>agentFinished(m,seat)));
   const state=await chainState(m);
   if(state.phase!==COMPLETE)throw Error('Not settled');
   const records=finals[0].results;
   if(!records?.length||records.length!==finals[1].results.length)throw Error('Both should record every hand');
   for(const r of records)if(r.aggressor!==0||r.firstToShow!==0||(r.reason!==1&&r.reason!==3)||r.betting.filter(e=>e.action===3).length<4)throw Error(`Hand ${r.hand} didn't go as bet: ${JSON.stringify({aggressor:r.aggressor,first:r.firstToShow,reason:r.reason})}`);
   const last=records.at(-1);
   if(state.payouts[0]!==last.stacks[0]||state.payouts[1]!==last.stacks[1])throw Error(`The contract paid ${state.payouts}, but the last hand left ${last.stacks}`);
   return {seconds:Math.round((Date.now()-started)/1000),hands:records.length,raises:records.reduce((n,r)=>n+r.betting.filter(e=>e.action===3).length,0),mucks:records.filter(r=>r.reason===3).length,shown:records.filter(r=>r.reason===1).length,transactions:await transactionCount(m),payouts:state.payouts,match:m.manifest.match};
  }finally{await cleanUp(m);}
 },
 // A firewall cuts machine B off with real money in the pot, and it mucks on chain after being the caller.
 async betsnetwork(){
  const m=await setup('betsnetwork',{seconds:180,reserves:[CAN_POST,JUST_FEES]});
  const started=Date.now();
  try{
   const fault=whenMessages(26,async()=>{
    await vm(1,`sudo -n iptables -A OUTPUT -d ${HOST} -j DROP && echo blocked`);log('machine B can no longer reach the relay');
   });
   await startAgent(m,0,{stall:25,decide:bot('raise')});await startAgent(m,1,{stall:600,decide:bot('call --show never')});
   await fault;
   await Promise.all([0,1].map(seat=>agentFinished(m,seat,540_000)));
   const state=await chainState(m);
   if(state.phase!==COMPLETE)throw Error('Not settled');
   const moves=[];
   for(const seat of [0,1])moves.push(Number((await vm(seat,`grep -c 'on-chain move' ${m.dir}/agent.err || true`)).trim()));
   if(moves[1]===0)throw Error('Machine B made no moves on chain');
   if(state.game.reason!==3||state.game.winner!==0||state.aggressor!==0)throw Error(`Expected the caller to muck on chain: reason ${state.game.reason}, winner ${state.game.winner}, aggressor ${state.aggressor}`);
   if(state.game.holes[1].some(c=>c!==255))throw Error('The mucked cards reached the chain');
   return {seconds:Math.round((Date.now()-started)/1000),onChainMoves:moves,transactions:await transactionCount(m),payouts:state.payouts,settledBy:'muck',finalStep:state.seq,match:m.manifest.match};
  }finally{on.tap=null;await vm(1,`sudo -n iptables -D OUTPUT -d ${HOST} -j DROP; true`).catch(()=>{});await cleanUp(m);}
 },
 // One command on each machine, and only the code crosses between them.
 async invite(){
  on.tap=null;
  const dir=`~/runs/invite-${Date.now()}`,started=Date.now();
  const FUND=MATCH_RENT+DEPOSIT+CAN_POST+RENT_MINIMUM+300_000;
  const stacks=(seat,args)=>`node scripts/stacks.js ${args} --home ${dir}/home --rpc ${DEVNET}`;
  const homes=[];
  for(const seat of [0,1]){
   await vm(seat,`mkdir -p ${dir} && chmod 700 ${dir}`);
   const {address}=JSON.parse((await vm(seat,stacks(seat,'wallet'))).trim().split('\n').at(-1));
   homes.push(address);
   await direct.send([SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:new PublicKey(address),lamports:BigInt(FUND)})]);
  }
  const returnFunds=async()=>{for(const seat of [0,1])await channel(seat,`sweep ${dir}/home/wallet-keypair.json ${funder.publicKey.toBase58()} ${program}`).catch(error=>log(`sweep: ${error.message}`));};
  try{
   await vm(0,`AGENT_STACKS_STALL_SECONDS=120 AGENT_STACKS_POLL_SECONDS=0.25 setsid nohup ${stacks(0,`host --relay ${process.env.AGENT_STACKS_VM_RELAY??RELAY} --buy-in 0.001 --big-blind 0.00002 --hands 2 --clock 600 --think 10 --decide '${bot('raise')}'`)} >> ${dir}/out 2>> ${dir}/err < /dev/null & echo started`);
   const code=await waitFor('the invite code',async()=>{const text=await vm(0,`cat ${dir}/out 2>/dev/null || true`);return text.split('\n').find(l=>l.startsWith('stacks1.'));},120_000);
   log('the code crossed to machine B');
   await vm(1,`AGENT_STACKS_STALL_SECONDS=120 AGENT_STACKS_POLL_SECONDS=0.25 setsid nohup ${stacks(1,`join ${code} --yes --decide '${bot('call')}'`)} >> ${dir}/out 2>> ${dir}/err < /dev/null & echo started`);
   const finish=seat=>waitFor(`machine ${label(seat)} to finish`,async()=>{const lines=(await vm(seat,`cat ${dir}/out 2>/dev/null || true`)).trim().split('\n');const last=lines.at(-1);return last.startsWith('{')?JSON.parse(last):null;},420_000);
   const [a,b]=await Promise.all([finish(0),finish(1)]);
   if(a.payouts[0]!==b.payouts[0]||a.payouts[0]+a.payouts[1]!==2*DEPOSIT)throw Error(`Bad payouts: ${a.payouts} and ${b.payouts}`);
   const count=(await direct.connection.getSignaturesForAddress(new PublicKey(a.match),{limit:200},'confirmed')).filter(s=>!s.err).length;
   return {seconds:Math.round((Date.now()-started)/1000),hands:a.results.length,payouts:a.payouts,transactions:count,walletsAfter:[a.walletBalance,b.walletBalance],match:a.match};
  }finally{
   for(const seat of [0,1]){
    const text=await vm(seat,`cat ${dir}/err 2>/dev/null || true`).catch(()=>'(VM not reachable)');
    writeFileSync(join(logs,`invite-${label(seat)}.log`),text);
    await vm(seat,`pkill -9 -f 'scripts/stacks.j[s]'; true`).catch(()=>{});
   }
   await returnFunds();
  }
 },
 // Two machines, nothing going wrong.
 async clean(){
  const m=await setup('clean',{hands:2});on.tap=null;
  const started=Date.now();
  try{
   await Promise.all([0,1].map(seat=>startAgent(m,seat,{stall:180,poll:0.25})));
   const results=await Promise.all([0,1].map(seat=>agentFinished(m,seat)));
   const state=await chainState(m);
   if(state.phase!==COMPLETE)throw Error('Not settled');
   return {seconds:Math.round((Date.now()-started)/1000),transactions:await transactionCount(m),payouts:state.payouts,steps:results[0].seq,match:m.manifest.match};
  }finally{await cleanUp(m);}
 },
 // The agent process dies mid-hand and restarts from disk, before the other player gives up on it.
 async crash(){
  const m=await setup('crash',{});
  const started=Date.now();
  try{
   const fault=whenMessages(14,async()=>{
    log('kill -9 the agent on machine B:',(await killAgent(1)).trim());
    await pause(4000);await startAgent(m,1,{stall:180});log('restarted it from its saved state');
   });
   await Promise.all([0,1].map(seat=>startAgent(m,seat,{stall:180})));
   await fault;
   await Promise.all([0,1].map(seat=>agentFinished(m,seat)));
   const state=await chainState(m);
   if(state.phase!==COMPLETE)throw Error('Not settled');
   return {seconds:Math.round((Date.now()-started)/1000),transactions:await transactionCount(m),payouts:state.payouts,match:m.manifest.match};
  }finally{on.tap=null;await cleanUp(m);}
 },
 // Machine B loses power mid-hand and boots again. Only what reached its disk survives.
 async power(){
  const m=await setup('power',{});
  const started=Date.now();let downFor=0;
  try{
   const fault=whenMessages(14,async()=>{
    log('power cut on machine B');
    const off=Date.now();
    await run('limactl',['stop','--force',VMS[1]]);await pause(3000);
    await run('limactl',['start','--tty=false',VMS[1]],{timeout:240_000});
    downFor=Math.round((Date.now()-off)/1000);log(`machine B is back after ${downFor}s`);
    await startAgent(m,1,{stall:300});
   });
   await Promise.all([0,1].map(seat=>startAgent(m,seat,{stall:300})));
   await fault;
   await Promise.all([0,1].map(seat=>agentFinished(m,seat)));
   const state=await chainState(m);
   if(state.phase!==COMPLETE)throw Error('Not settled');
   return {seconds:Math.round((Date.now()-started)/1000),downForSeconds:downFor,transactions:await transactionCount(m),payouts:state.payouts,match:m.manifest.match};
  }finally{on.tap=null;await cleanUp(m);}
 },
 // Machine B's firewall blocks the relay but not the chain, so both agents finish the hand on chain.
 async network(){
  const m=await setup('network',{seconds:120,reserves:[CAN_POST,JUST_FEES]});
  const started=Date.now();
  try{
   const fault=whenMessages(14,async()=>{
    await vm(1,`sudo -n iptables -A OUTPUT -d ${HOST} -j DROP && echo blocked`);log('machine B can no longer reach the relay');
   });
   // Machine A notices first and posts. Machine B sees the dispute on chain and plays its part there.
   await startAgent(m,0,{stall:25});await startAgent(m,1,{stall:600});
   await fault;
   await Promise.all([0,1].map(seat=>agentFinished(m,seat,540_000)));
   const state=await chainState(m);
   if(state.phase!==COMPLETE)throw Error('Not settled');
   const moves=(await vm(0,`grep -c 'on-chain move' ${m.dir}/agent.err || true`)).trim();
   const movesB=(await vm(1,`grep -c 'on-chain move' ${m.dir}/agent.err || true`)).trim();
   // Machine B is alive and can reach the chain, so it has to defend itself rather than time out.
   if(Number(movesB)===0)throw Error('Machine B made no moves on chain');
   return {seconds:Math.round((Date.now()-started)/1000),onChainMoves:[Number(moves),Number(movesB)],transactions:await transactionCount(m),payouts:state.payouts,finalStep:state.seq,match:m.manifest.match};
  }finally{on.tap=null;await vm(1,`sudo -n iptables -D OUTPUT -d ${HOST} -j DROP; true`).catch(()=>{});await cleanUp(m);}
 },
 // Machine B dies for good. Machine A goes to the chain alone, and B loses only the pot.
 async vanish(){
  const m=await setup('vanish',{seconds:30,reserves:[CAN_POST,JUST_FEES]});
  const started=Date.now();let cut=0,restored=false;
  try{
   const fault=whenMessages(14,async()=>{log('machine B goes away for good');cut=Date.now();await run('limactl',['stop','--force',VMS[1]]);});
   await Promise.all([0,1].map(seat=>startAgent(m,seat,{stall:25})));
   await fault;
   const result=await agentFinished(m,0);
   const state=await chainState(m);
   if(state.phase!==COMPLETE)throw Error('Not settled');
   const lost=m.manifest.buyIn-state.payouts[1];
   if(lost<0||lost>m.manifest.buyIn/2)throw Error(`Machine B should lose only the pot, lost ${lost}`);
   await run('limactl',['start','--tty=false',VMS[1]],{timeout:240_000});restored=true;
   return {seconds:Math.round((Date.now()-started)/1000),secondsFromVanishingToPayout:Math.round((Date.now()-cut)/1000),transactions:await transactionCount(m),payouts:state.payouts,lostByTheVanishedPlayer:lost,agentOnChainTransactions:result.onChainTransactions,match:m.manifest.match};
  }finally{on.tap=null;if(!restored)await run('limactl',['start','--tty=false',VMS[1]],{timeout:240_000}).catch(()=>{});await cleanUp(m);}
 },
};
const summary={};
for(const name of Object.keys(SCENARIOS)){
 if(only.length&&!only.includes(name))continue;
 log(`scenario ${name}; funder has ${await lamports(funder.publicKey)/1e9} test SOL`);
 try{summary[name]={ok:true,...await SCENARIOS[name]()};log(`${name}: passed`);}
 catch(error){summary[name]={ok:false,error:error.message};log(`${name}: FAILED: ${error.message}`);}
}
relay.close();
summary.funderLeft=await lamports(funder.publicKey)/1e9;
console.log(JSON.stringify(summary,null,1));
process.exit(Object.values(summary).every(s=>typeof s!=='object'||s.ok)?0:1);
