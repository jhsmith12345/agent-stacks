// Read-only checks to run on each machine before a public devnet match. It signs nothing it sends:
// the one signed transaction is only simulated. Nothing private is printed, and that includes the RPC URL.
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {ChainClient,PublicKey,SystemProgram,DEVNET_GENESIS,LAYOUT,loadWallet,manifestRpc,redactRpc,termsHash} from '../src/solana/client.js';
import {Transaction,VersionedTransaction} from '@solana/web3.js';
import {loadTrustPolicy,validateAcceptedMatch,verifyPinnedProgram,strictFundingRequired,PROOF_ACCOUNT_BYTES} from '../src/solana/trusted-agent.js';
const args=process.argv.slice(2),value=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
if(!value('--policy')||!value('--wallet'))throw Error('Usage: node scripts/devnet-preflight.js --policy POLICY --wallet WALLET [--manifest MANIFEST] [--expect-sha256 HASH] [--samples N]');
const checks=[];
const note=(status,name,detail)=>{checks.push({status,name,...(detail===undefined?{}:{detail})});};
const pass=(name,detail)=>note('pass',name,detail),warn=(name,detail)=>note('warn',name,detail),fail=(name,detail)=>note('fail',name,detail);
const attempt=async(name,work)=>{try{return await work();}catch(error){fail(name,error.message);return null;}};
const pause=wait=>new Promise(done=>setTimeout(done,wait));

const policy=loadTrustPolicy(value('--policy'));
const wallet=await loadWallet(resolve(value('--wallet')));
const me=wallet.publicKey.toBase58();
const client=new ChainClient(policy.rpc,policy.program,wallet,{allowLocal:policy.allowLocal,commitment:'finalized'});
// One failed request from a hosted endpoint says little about that endpoint, so look again before reporting it.
// Only RPC failures are retried. A slot the node hasn't reached is an answer, not a failure.
client.connection=new Proxy(client.connection,{get(target,key){
 const method=target[key];if(typeof method!=='function')return method;
 return async(...args)=>{for(let tries=0;;tries++){try{return await method.apply(target,args);}catch(error){if(!error.rpcFailure||tries>=4||/-32016|context slot/i.test(`${error.code} ${error.message}`))throw error;await pause(500*2**tries);}}};
}});
const connection=client.connection;
const report={rpc:redactRpc(policy.rpc),wallet:me,program:policy.program};

const major=Number(process.versions.node.split('.')[0]);
if(major>=22)pass('Node version',process.versions.node);else fail('Node version',`${process.versions.node}; CI tests on 22 and later`);
if(policy.rpcOperator==='third-party')warn('RPC trust','This policy trusts a third-party provider. The run measures timing only and is not evidence for the trust boundary.');
else pass('RPC trust','Policy asserts a node you operate');

const genesis=await attempt('Cluster',()=>client.checkNetwork());
if(genesis)try{
 if(genesis!==policy.genesis)fail('Cluster',`Node reports genesis ${genesis}, but the policy pins ${policy.genesis}`);
 else pass('Cluster',genesis===DEVNET_GENESIS?'Official public devnet':'Explicit local validator');
 report.version=(await attempt('Cluster version',()=>connection.getVersion()))?.['solana-core'];

 // The agent's safety and recovery depend on these methods behaving as a validator's RPC does.
 const finalized=Number(await attempt('RPC methods',()=>connection.getSlot('finalized'))??0);
 const future=await connection.getAccountInfoAndContext(SystemProgram.programId,{commitment:'finalized',minContextSlot:finalized+1_000_000}).then(()=>'ignored',error=>/-32016|context slot/i.test(`${error.code} ${error.message}`)?'enforced':`failed: ${error.message}`);
 if(future==='enforced')pass('Minimum context slot','Enforced, so a lagging backend cannot pass old state to the rollback check');
 else fail('Minimum context slot',`The endpoint must enforce this. It ${future}`);
 const history=await attempt('Signature history',()=>connection.getSignatureStatuses(['1'.repeat(64)],{searchTransactionHistory:true}));
 if(history)pass('Signature history','Supported');
 const height=await attempt('Block height',()=>connection.getBlockHeight('finalized'));
 if(height!==null)pass('Block height',Number(height));
 const latest=await attempt('Simulation',()=>connection.getLatestBlockhash('confirmed'));
 if(latest){
  const tx=new Transaction({feePayer:wallet.publicKey,...latest}).add(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:wallet.publicKey,lamports:0n}));
  await attempt('Simulation',async()=>{await tx.sign(wallet);const {value:result}=await connection.simulateTransaction(VersionedTransaction.deserialize(await tx.serialize()),{sigVerify:true,replaceRecentBlockhash:false,commitment:'processed'});if(result.err&&JSON.stringify(result.err)!=='"AccountNotFound"')throw Error(`Rejected: ${JSON.stringify(result.err)}`);pass('Simulation','Available with signature checks');});
 }
 if(policy.maxComputeUnitPrice){const fees=await attempt('Priority fees',()=>connection.getRecentPrioritizationFees());if(fees){const sorted=fees.map(f=>Number(f.prioritizationFee)).sort((a,b)=>a-b);pass('Priority fees',`Recent 75th percentile ${sorted[Math.floor(sorted.length*0.75)]??0}; policy ceiling ${policy.maxComputeUnitPrice}`);}}
 else warn('Priority fees','Policy has no ceiling, so transactions cannot outbid congestion, and a policy cannot change mid-match');

 // Paced at the rate one busy agent uses, so a failure here is what the match would meet.
 const samples=Number(value('--samples')??30),times=[];let limited=0;
 // Raw requests, because the RPC library retries a 429 by itself and would hide it from this count.
 for(let i=0;i<samples;i++){const started=performance.now();const response=await fetch(policy.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:i,method:'getSlot',params:[{commitment:'confirmed'}]})}).catch(()=>null);if(response?.status===429)limited++;await response?.text();times.push(performance.now()-started);await pause(100);}
 times.sort((a,b)=>a-b);report.latencyMs={p50:Math.round(times[Math.floor(times.length/2)]),p95:Math.round(times[Math.floor(times.length*0.95)])};
 if(limited)warn('Rate limits',`${limited} of ${samples} requests were limited at about 10 per second. An agent can use this much, so expect slowdowns`);else pass('Rate limits',`None in ${samples} requests at about 10 per second`);
 if(report.latencyMs.p95>1000)warn('Latency',`95th percentile ${report.latencyMs.p95} ms. Every transaction takes several requests, so a shuffle will be slow`);else pass('Latency',report.latencyMs);
 const firstSlot=Number(await connection.getSlot('processed')),firstAt=performance.now();await pause(3000);const lastSlot=Number(await connection.getSlot('processed')),slotSeconds=(performance.now()-firstAt)/1000/Math.max(1,lastSlot-firstSlot);
 const gap=Number(await connection.getSlot('confirmed'))-Number(await connection.getSlot('finalized'));
 report.secondsPerSlot=+slotSeconds.toFixed(3);report.finalityGapSlots=gap;
 pass('Chain pace',`${report.secondsPerSlot}s per slot; finalized is ${gap} slots behind confirmed`);

 const deployed=await attempt('Program pin',()=>verifyPinnedProgram(connection,policy));
 if(deployed){
  pass('Program pin',`Deployed bytes match ${policy.programSha256}`);
  if(deployed.upgradeAuthority===me)warn('Upgrade authority','This wallet can upgrade the program. Keep that key off a machine running an agent');
  else if(deployed.upgradeAuthority)warn('Upgrade authority',`${deployed.upgradeAuthority} can replace this program. That is acceptable only on test funds`);
  else pass('Upgrade authority','None; the program is immutable');
 }
 const expected=value('--expect-sha256');
 if(expected&&expected!==policy.programSha256)fail('Expected program',`Policy pins ${policy.programSha256}, not the expected ${expected}`);else if(expected)pass('Expected program','Policy pins the expected hash');
 const artifact=resolve('target/deploy/agent_stacks_escrow.so');
 if(existsSync(artifact)){const hash=createHash('sha256').update(readFileSync(artifact)).digest('hex');if(hash===policy.programSha256)pass('Local build','Matches the pinned program');else warn('Local build',`This checkout's build is ${hash}, not the pinned program`);}

 const balance=Number(await connection.getBalance(wallet.publicKey,'confirmed'));
 const rent=async bytes=>Number(await connection.getMinimumBalanceForRentExemption(bytes));
 report.rentSOL={proofBuffer:await rent(PROOF_ACCOUNT_BYTES)/1e9};report.balanceSOL=balance/1e9;
 const manifestFile=value('--manifest');
 let needed=strictFundingRequired({rent:await rent(PROOF_ACCOUNT_BYTES),buyIn:policy.maxBuyIn,hands:policy.maxHands,maxFeePerTransaction:policy.maxFeePerTransaction});
 if(manifestFile){
  const config=JSON.parse(readFileSync(resolve(manifestFile),'utf8'));
  await attempt('Accepted terms',async()=>{
   validateAcceptedMatch(policy,config,me);if(config.terms!==termsHash(config))throw Error('Manifest terms do not match its contents');
   const seat=config.players.indexOf(me);
   report.terms={seat,opponent:config.players[1-seat],buyIn:config.buyIn,bigBlind:config.bigBlind,hands:config.maxHands??1,turnSeconds:config.turnSeconds,match:config.match};
   pass('Accepted terms','Within policy. Read `terms` in this report and confirm them before starting an agent');
   needed=strictFundingRequired({rent:await rent(PROOF_ACCOUNT_BYTES),buyIn:config.buyIn,hands:config.maxHands??1,maxFeePerTransaction:policy.maxFeePerTransaction});
   if(config.rpc&&!manifestRpc(config.rpc).rpc)warn('Manifest RPC','This manifest names a private-looking RPC URL. Replace that key, because the file has been shared');
   const account=await connection.getAccountInfo(new PublicKey(config.match),'finalized');
   if(!account){warn('Match on chain','Not visible at finalized commitment yet');return;}
   const m=await client.validateMatch(config.match,account,config);
   pass('Match on chain',`Terms match; phase ${m.phase}, hand ${m.handNo}`);
   // The creator pays its deposit when creating the match, and the joiner when joining.
   needed=m.phase===6?0:strictFundingRequired({rent:await rent(PROOF_ACCOUNT_BYTES),buyIn:seat===1&&m.phase===0?config.buyIn:0,hands:(config.maxHands??1)-m.handNo+1,maxFeePerTransaction:policy.maxFeePerTransaction});
   if(m.phase!==0&&m.phase!==6){const left=m.deadline-await client.chainTime();if(left<600)warn('Turn clock',`${left}s left on the current turn`);else pass('Turn clock',`${left}s left on the current turn`);}
   if(seat===0&&account.data.length!==LAYOUT.size)fail('Match on chain','Unexpected account size');
  });
 }
 if(balance<needed)fail('Funding',`Balance ${balance/1e9} SOL is below the ${needed/1e9} SOL needed for the deposit, a full-proof buffer and worst-case fees`);
 else pass('Funding',`${balance/1e9} SOL covers the ${needed/1e9} SOL needed`);
}catch(error){fail('RPC',`The node stopped answering: ${error.message}`);}
const failed=checks.filter(c=>c.status==='fail').length;
console.log(JSON.stringify({ready:failed===0,failed,warnings:checks.filter(c=>c.status==='warn').length,...report,checks},null,2));
process.exit(failed?1:0);
