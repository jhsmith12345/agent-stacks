// Runs the actual agent process against a scripted RPC: buffer housekeeping and transaction
// uncertainty must never be able to stop an agent from playing the rest of its match.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fork,spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Transaction} from '@solana/web3.js';
import {getBase58Decoder} from '@solana/kit';
import {ensureWallet,Keypair,PublicKey,termsHash,LAYOUT,u64,u32,DEVNET_GENESIS,keyContext,shuffleContext} from '../src/solana/client.js';
import {writePrivate} from '../src/private-files.js';
import {ask} from '../src/solana/agent-messages.js';
import {makeKey} from '../src/mental-poker/proofs.js';
import {point,randomScalar} from '../src/mental-poker/group.js';
import {initialDeck,encodeCipher,reencrypt} from '../src/mental-poker/deck.js';
import {shuffleAndProve,encodeShuffle} from '../src/mental-poker/shuffle.js';

const SYSTEM='11111111111111111111111111111111';
const SYSVAR='Sysvar1111111111111111111111111111111111111';
const LOADER='BPFLoader2111111111111111111111111111111111';
const CLOCK='SysvarC1ock11111111111111111111111111111111';

const nearlyUploaded=({config,deck,joint,agentDirectory,wallet})=>{
 const wire=encodeShuffle(deck,shuffleAndProve(deck,joint,shuffleContext(config.program,config.match,0,config.terms,1)));
 writePrivate(join(agentDirectory,`${config.match}.hand-1.shuffle.bin`),wire,{exclusive:true});
 const data=Buffer.alloc(84+wire.length),written=wire.length-1000;
 data.write('ASTKSHF1');data.set(wallet.publicKey.toBytes(),8);u32(wire.length).copy(data,40);u32(written).copy(data,44);wire.copy(data,84,0,written);
 return data;
};

async function scenario(t,{buffer,phase=7,seat=0,balance=100_000_000_000,policyChanges={},simulateError=null,sendFails=()=>false,prepare=null,statusFor=null}){
 const directory=mkdtempSync(join(tmpdir(),'stacks-recovery-'));
 const walletFile=join(directory,'wallet.json');
 const wallet=await ensureWallet(walletFile),opponent=await Keypair.generate(),program=await Keypair.generate();
 const creator=seat===0?wallet:opponent,joiner=seat===0?opponent:wallet;
 const nonce=Buffer.alloc(32,9),[address,bump]=await PublicKey.findProgramAddress([Buffer.from('escrow'),creator.publicKey.toBytes(),nonce],program.publicKey);
 const config={program:program.publicKey.toBase58(),match:address.toBase58(),players:[creator.publicKey.toBase58(),joiner.publicKey.toBase58()],genesis:DEVNET_GENESIS,buyIn:1000000,bigBlind:20000,turnSeconds:86400,maxHands:1};config.terms=termsHash(config);
 const a=makeKey(keyContext(config.program,config.match,seat,config.terms,1)),b=makeKey('test/peer');
 const joint=point(a.registration.publicKey).add(point(b.registration.publicKey));
 const deck=initialDeck().map(c=>encodeCipher(reencrypt({a:point(c.a),b:point(c.b)},joint,randomScalar())));
 const state=Buffer.alloc(LAYOUT.size);state.write('ASTKESC5');state[8]=phase;u64(7).copy(state,9);
 state.set(creator.publicKey.toBytes(),17);state.set(joiner.publicKey.toBytes(),49);u64(config.buyIn).copy(state,81);u64(config.turnSeconds).copy(state,89);
 state.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)+86400),97);Buffer.from(config.terms,'hex').copy(state,105);
 Buffer.from(a.registration.publicKey+b.registration.publicKey,'hex').copy(state,137);nonce.copy(state,217);state[249]=bump;u64(config.bigBlind).copy(state,LAYOUT.blind);
 state.writeUInt32LE(1,LAYOUT.hand);state.writeUInt32LE(1,LAYOUT.maxHands);
 Buffer.concat(deck.map(c=>Buffer.from(c.a+c.b,'hex'))).copy(state,LAYOUT.deck);
 const agentDirectory=join(directory,'agent');
 writePrivate(join(agentDirectory,`${config.match}.hand-1.private.json`),JSON.stringify(a),{exclusive:true});
 const proofKey=await ensureWallet(join(agentDirectory,`${config.match}.hand-1.proof-keypair.json`));
 const proofData=prepare?prepare({config,deck,joint:joint.toHex(),agentDirectory,wallet}):null;
 const artifact=Buffer.from('test program fixture');
 const rpc={calls:[],sent:[],tags:new Map(),height:50n,status:null,failNext:0,failEvery:0,requests:0,hideMatch:0,matchOwner:config.program,programBytes:artifact,balance,recentFees:[]};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(rpc.failNext>0||(rpc.failEvery&&++rpc.requests%rpc.failEvery===0)){if(rpc.failNext>0)rpc.failNext--;res.writeHead(503);res.end('temporarily unavailable');return;}
  const request=JSON.parse(raw);let result,error;rpc.calls.push(request.method);
  const account=(bytes,owner,lamports=100000000,executable=false)=>({context:{slot:1},value:{owner,lamports,executable,rentEpoch:0,data:[bytes.toString('base64'),'base64'],space:bytes.length}});
  switch(request.method){
   case 'getGenesisHash':result=DEVNET_GENESIS;break;
   case 'getAccountInfo':{
    const key=request.params[0];
    if(key===config.program)result=account(rpc.programBytes,LOADER,1,true);
    else if(key===CLOCK){const bytes=Buffer.alloc(40);bytes.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32);result=account(bytes,SYSVAR);}
    else if(key===config.match){if(rpc.hideMatch>0){rpc.hideMatch--;result={context:{slot:1},value:null};}else result=account(state,rpc.matchOwner);}
    else if(key===proofKey.publicKey.toBase58())result=proofData?account(proofData,config.program):buffer==='closed'?{context:{slot:1},value:null}:buffer==='dust'?account(Buffer.alloc(0),SYSTEM,1000000):account(Buffer.alloc(16),config.program);
    else result={context:{slot:1},value:null};
    break;
   }
   case 'getFeeForMessage':result={context:{slot:1},value:5000};break;
   case 'getLatestBlockhash':result={context:{slot:1},value:{blockhash:SYSTEM,lastValidBlockHeight:100}};break;
   case 'simulateTransaction':result={context:{slot:1},value:{err:simulateError,logs:[]}};break;
   case 'sendTransaction':{const tx=await Transaction.from(Buffer.from(request.params[0],'base64'));rpc.tags.set(getBase58Decoder().decode(tx.signature),tx.instructions.map(ix=>Buffer.from(ix.data)).filter((_,i)=>tx.instructions[i].programId.toBase58()===config.program)[0]?.[0]);}
    rpc.sent.push(request.params[0]);if(sendFails(rpc.sent.length))error={code:-32002,message:'node unavailable'};else result=SYSTEM;break;
   case 'getBlockHeight':result=Number(rpc.height);break;
   case 'getBalance':result={context:{slot:1},value:rpc.balance};break;
   case 'getMinimumBalanceForRentExemption':result=4541928960;break;
   case 'getRecentPrioritizationFees':result=rpc.recentFees;break;
   case 'getSignatureStatuses':result={context:{slot:1},value:[statusFor?statusFor(rpc.tags.get(request.params[0][0])):rpc.status]};break;
   default:error={code:-32601,message:`Unsupported test RPC method ${request.method}`};
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,...(error?{error}:{result})}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}`,policyFile=join(directory,'policy.json');
 writePrivate(policyFile,JSON.stringify({schema:'agent-stacks/trusted-node/v1',trust:'operator-controlled-validator',network:'test-only',rpc:url,genesis:config.genesis,program:config.program,programSha256:createHash('sha256').update(artifact).digest('hex'),programBytes:artifact.length,allowLocal:true,allowUpgradeable:false,allowTestControls:false,allowCooperative:false,maxBuyIn:1000000,maxHands:1,minTurnSeconds:3600,maxTransactions:100,maxFeePerTransaction:10000,maxTotalFees:1000000,maxAccountRent:5000000000,maxTotalOutflow:10000000000,...policyChanges}));
 const manifest=join(directory,'manifest.json');writePrivate(manifest,JSON.stringify(config));
 const children=[];
 const start=async()=>{
  const child=fork(new URL('../examples/chain-agent.js',import.meta.url),[walletFile,agentDirectory],{env:{...process.env,AGENT_STACKS_TRUST_POLICY:policyFile},stdio:['ignore','ignore','ignore','ipc']});
  children.push(child);await once(child,'message',{signal:AbortSignal.timeout(5000)});
  await ask(child,{kind:'initialize',config,rpc:url,allowLocal:true},5000);return child;
 };
 const stop=async child=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}};
 // The standalone path, with no coordinator: what an operator actually runs.
 const standalone=()=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../examples/chain-agent.js',import.meta.url)),walletFile,agentDirectory,'--manifest',manifest],{env:{...process.env,AGENT_STACKS_TRUST_POLICY:policyFile},stdio:['ignore','pipe','pipe']});
  children.push(child);child.output='';child.stderr.on('data',x=>{child.output+=x;});child.stdout.on('data',x=>{child.output+=x;});
  child.finished=new Promise(resolve=>child.on('exit',code=>resolve(code)));return child;
 };
 const finish=()=>{state[8]=6;u64(8).copy(state,9);};
 t.after(async()=>{for(const child of children)await stop(child);server.close();server.closeAllConnections();rmSync(directory,{recursive:true,force:true});});
 const guard=()=>JSON.parse(readFileSync(join(agentDirectory,`${config.match}.guard.json`),'utf8')).budget;
 const journal=()=>readFileSync(join(agentDirectory,'transactions.ndjson'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 return {rpc,start,stop,guard,journal,standalone,finish,proofKey,agentDirectory,config};
}

test('dust on a closed, public buffer address produces no transaction and leaves the agent able to sign',{timeout:20000},async t=>{
 const s=await scenario(t,{buffer:'dust'});const child=await s.start();
 assert.equal((await ask(child,{kind:'cleanup-proof'},5000)).kind,'proof-clean');
 assert.equal(s.rpc.calls.includes('simulateTransaction'),false);assert.equal(s.rpc.sent.length,0);
 assert.equal(s.guard().pending,null);assert.equal(s.guard().transactions,0,'no signing budget was spent on it');
});

test('cleanup still closes a real program-owned buffer, and skips one that is already gone',{timeout:20000},async t=>{
 const s=await scenario(t,{buffer:'program'});s.rpc.status={slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus:'finalized'};
 const child=await s.start();await ask(child,{kind:'cleanup-proof'},5000);
 assert.equal(s.rpc.sent.length,1);assert.equal(s.guard().pending,null);
 const gone=await scenario(t,{buffer:'closed'});const other=await gone.start();await ask(other,{kind:'cleanup-proof'},5000);
 assert.equal(gone.rpc.sent.length,0);
});

test('a close that fails simulation is deferred: never sent, never pending, never fatal',{timeout:20000},async t=>{
 const s=await scenario(t,{buffer:'program',simulateError:{InstructionError:[0,'InvalidInstructionData']}});const child=await s.start();
 assert.equal((await ask(child,{kind:'cleanup-proof'},5000)).kind,'proof-clean');
 assert.ok(s.rpc.calls.includes('simulateTransaction'));assert.equal(s.rpc.sent.length,0);assert.equal(s.guard().pending,null);
});

test('after a failed send the agent redelivers the same bytes and recovers once the blockhash expires, across a restart',{timeout:30000},async t=>{
 const s=await scenario(t,{buffer:'program',sendFails:count=>count===1});
 let child=await s.start();await ask(child,{kind:'cleanup-proof'},5000);
 assert.equal(s.guard().pending!==null,true);assert.equal(s.guard().pendingExpiry,'100');
 await assert.rejects(ask(child,{kind:'step'},5000),/uncertain/,'still refuses to sign while the outcome is open');
 await s.stop(child);child=await s.start();
 const settled=ask(child,{kind:'settle'});
 for(const stop=Date.now()+15000;s.rpc.sent.length<2;){if(Date.now()>stop)throw Error('No redelivery in time');await new Promise(resolve=>setTimeout(resolve,50));}
 assert.equal(s.rpc.sent[1],s.rpc.sent[0],'recovery must redeliver the original signed bytes, never a new signature');
 assert.equal(s.guard().pending!==null,true,'blockhash has not expired yet');
 s.rpc.height=101n;
 assert.equal((await settled).kind,'settled');
 assert.equal(s.guard().pending,null);assert.equal(s.guard().pendingExpiry,null);
 const last=s.journal().at(-1);assert.equal(last.status,'expired');assert.equal(last.reconciled,true);
});

test('strict proof steps clear at confirmed while the consuming transaction still waits for finality',{timeout:60000},async t=>{
 const receipt=confirmationStatus=>({slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus});
 const seen=[];let consumePolls=0;
 const s=await scenario(t,{phase:3,buffer:'program',
  // Almost fully uploaded, so the test exercises the last chunk, the seal and all 32 verification rounds.
  prepare:nearlyUploaded,
  // Bulk steps never reach finality here, so an agent waiting on them would time out.
  statusFor:tag=>{
   if(seen.at(-1)!==tag)seen.push(tag);
   if([9,10,11].includes(tag))return receipt('confirmed');
   if(tag===13)return ++consumePolls<4?receipt('confirmed'):receipt('finalized');
   return receipt('finalized');
  }});
 const child=await s.start();
 assert.equal((await ask(child,{kind:'step'},45000)).kind,'result');
 assert.deepEqual(seen,[9,10,11,13,12]);
 assert.equal(s.rpc.sent.length,1+1+32+1+1,'last chunk, seal, 32 rounds, consume, close');
 assert.equal(consumePolls,4,'the transaction that consumes the proof must wait for finalized');
 assert.equal(s.guard().pending,null);
});

const until=async(condition,seconds=20)=>{const stop=Date.now()+seconds*1000;while(!condition()){if(Date.now()>stop)throw Error('Condition not reached in time');await new Promise(resolve=>setTimeout(resolve,50));}};
test('the standalone agent survives RPC failures and plays on',{timeout:30000},async t=>{
 const s=await scenario(t,{buffer:'closed',phase:5});const child=s.standalone();
 await until(()=>s.rpc.calls.filter(m=>m==='getAccountInfo').length>6);
 s.rpc.failNext=1;await until(()=>/retrying in/.test(child.output));
 assert.equal(child.exitCode,null,'one 503 must not end the agent');
 s.rpc.failNext=3;await until(()=>(child.output.match(/retrying in/g)??[]).length>=4);
 s.finish();
 assert.equal(await child.finished,0);assert.match(child.output,/"kind":"complete"/);
});
test('a security failure still stops the standalone agent instead of being retried',{timeout:30000},async t=>{
 const s=await scenario(t,{buffer:'closed',phase:5});const child=s.standalone();
 await until(()=>s.rpc.calls.filter(m=>m==='getAccountInfo').length>6);
 s.rpc.programBytes=Buffer.from('replaced program bytes');
 assert.notEqual(await child.finished,0);assert.match(child.output,/differs from pinned/);
 assert.doesNotMatch(child.output,/retrying in/);
});
test('a waiting agent eases off polling and keeps watching the match',{timeout:30000},async t=>{
 const s=await scenario(t,{buffer:'closed',phase:2});const child=s.standalone();
 const reads=()=>s.rpc.calls.filter(method=>method==='getAccountInfo').length;
 await new Promise(done=>setTimeout(done,3000));const before=reads();
 await new Promise(done=>setTimeout(done,6000));const during=reads()-before;
 assert.ok(during>0,'it is still watching');
 // Each look is three reads, so polling every second would be about 18 here.
 assert.ok(during<=9,`${during} reads in six seconds`);
 assert.equal(s.rpc.sent.length,0);child.kill('SIGTERM');
});

test('an agent started before its match finalizes waits, then plays',{timeout:30000},async t=>{
 const s=await scenario(t,{buffer:'closed',phase:5});s.rpc.hideMatch=2;const child=s.standalone();
 await until(()=>/retrying in .*not visible at finalized/.test(child.output));
 await until(()=>s.rpc.hideMatch===0&&s.rpc.calls.filter(m=>m==='getAccountInfo').length>8);
 assert.equal(child.exitCode,null);s.finish();assert.equal(await child.finished,0);
});
test('a match owned by the wrong program is refused immediately, not waited for',{timeout:30000},async t=>{
 const s=await scenario(t,{buffer:'closed',phase:5});s.rpc.matchOwner=SYSTEM;const child=s.standalone();
 assert.notEqual(await child.finished,0);assert.match(child.output,/not owned by expected program/);assert.doesNotMatch(child.output,/retrying in/);
});
test('an agent refuses to join without funding for the full-proof fallback',{timeout:30000},async t=>{
 const required=1_000_000+4541928960+710*10000;
 const s=await scenario(t,{buffer:'closed',phase:0,seat:1,balance:required-1});let child=await s.start();
 await assert.rejects(ask(child,{kind:'step'},5000),new RegExp(`Refusing to join: balance ${required-1} is below the ${required} lamports`));
 assert.equal(s.rpc.sent.length,0);assert.equal(s.rpc.calls.includes('simulateTransaction'),false,'no deposit is even attempted');
 s.rpc.balance=required;s.rpc.status={slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus:'finalized'};
 await ask(child,{kind:'step'},5000);assert.equal(s.rpc.sent.length,1);
 assert.equal(s.rpc.tags.values().next().value,2,'the deposit went through once funded');
});
test('test-controls policies keep coordinator-lent funding, as the demo relies on',{timeout:20000},async t=>{
 const s=await scenario(t,{buffer:'closed',phase:0,seat:1,balance:20_000_000,policyChanges:{allowTestControls:true}});
 s.rpc.status={slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus:'finalized'};
 const child=await s.start();await ask(child,{kind:'step'},5000);assert.equal(s.rpc.sent.length,1);
});
test('priority fees: uploads stay inside the packet limit and carry the capped price',{timeout:60000},async t=>{
 const receipt=confirmationStatus=>({slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus});
 const s=await scenario(t,{phase:3,buffer:'program',policyChanges:{maxComputeUnitPrice:5000},
  prepare:nearlyUploaded,statusFor:()=>receipt('finalized')});
 s.rpc.recentFees=[{slot:1,prioritizationFee:100},{slot:2,prioritizationFee:200},{slot:3,prioritizationFee:300},{slot:4,prioritizationFee:9000}];
 const child=await s.start();await ask(child,{kind:'step'},45000);
 const COMPUTE='ComputeBudget111111111111111111111111111111';
 const uploads=[];
 for(const encoded of s.rpc.sent){
  const bytes=Buffer.from(encoded,'base64'),tx=await Transaction.from(bytes);assert.ok(bytes.length<=1232,'every transaction fits a packet');
  const data=tx.instructions.map(ix=>[ix.programId.toBase58(),Buffer.from(ix.data)]);
  const price=data.find(([p,d])=>p===COMPUTE&&d[0]===3)?.[1].readBigUInt64LE(1);
  const limit=data.find(([p,d])=>p===COMPUTE&&d[0]===2)?.[1].readUInt32LE(1);
  assert.ok(limit,'a price always comes with an explicit limit');
  // p75 of recent fees is 9000. The ceiling caps it at 5000, and the 10,000-lamport per-transaction
  // cap (5,000 after the signature fee) lowers it further on high-compute transactions.
  assert.equal(price,BigInt(Math.min(5000,Math.floor(5000*1e6/limit))));
  const upload=data.find(([p,d])=>p!==COMPUTE&&d[0]===9);if(upload)uploads.push(upload[1].length-5);
 }
 assert.deepEqual(uploads,[960,40],'chunks shrink to leave room for the fee instructions');
});

test('backoff stays short while transactions keep landing',{timeout:90000},async t=>{
 const receipt={slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus:'finalized'};
 const s=await scenario(t,{phase:3,buffer:'program',prepare:nearlyUploaded,statusFor:()=>receipt});
 const child=s.standalone();await until(()=>s.rpc.sent.length>=2,30);
 // Often enough to interrupt most steps, but with room for a transaction to land between failures.
 s.rpc.failEvery=17;
 const waits=()=>[...child.output.matchAll(/retrying in (\d+)s/g)].map(m=>Number(m[1]));
 await until(()=>waits().length>=5&&s.rpc.sent.length>=8,35);
 assert.ok(Math.max(...waits())<=2,`a working agent must not back off for long: ${waits()}`);
});
// This agent has nothing to send, so no transaction can be left uncertain during the outage.
test('backoff grows while the node stays down',{timeout:60000},async t=>{
 const s=await scenario(t,{buffer:'closed',phase:5});const child=s.standalone();
 await until(()=>s.rpc.calls.filter(m=>m==='getAccountInfo').length>6);
 s.rpc.failNext=1000;
 await until(()=>(child.output.match(/retrying in/g)??[]).length>=4,30);
 const waits=[...child.output.matchAll(/retrying in (\d+)s/g)].map(m=>Number(m[1]));
 assert.deepEqual(waits.slice(0,4),[1,2,4,8]);
});
test('the funding warning counts rent already held by an open proof buffer',{timeout:30000},async t=>{
 const receipt={slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus:'finalized'};
 const open=await scenario(t,{phase:3,buffer:'program',prepare:nearlyUploaded,statusFor:()=>receipt,balance:100_000_000});
 const opened=open.standalone();await until(()=>open.rpc.calls.includes('getBalance'),20);
 await until(()=>open.rpc.sent.length>=1,20);
 assert.doesNotMatch(opened.output,/warning: balance/);
 const closed=await scenario(t,{phase:5,buffer:'closed',balance:100_000_000});
 const shut=closed.standalone();await until(()=>/warning: balance 100000000 is below/.test(shut.output),20);
});

test('a buffer address someone funded before creation is abandoned for a fresh one',{timeout:40000},async t=>{
 const receipt={slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus:'finalized'};
 const s=await scenario(t,{phase:3,buffer:'dust',prepare:input=>{nearlyUploaded(input);return null;},statusFor:()=>receipt});
 const child=await s.start();
 // This scripted node never shows the new buffer, so the step ends there; a real validator run covers the rest.
 await assert.rejects(ask(child,{kind:'step'},30000),/Unexpected proof account owner/);
 assert.equal(s.rpc.sent.length,1,'exactly one attempt to create a buffer');
 const tx=await Transaction.from(Buffer.from(s.rpc.sent[0],'base64')),created=tx.instructions.find(ix=>ix.programId.toBase58()===SYSTEM).keys[1].pubkey.toBase58();
 assert.notEqual(created,s.proofKey.publicKey.toBase58(),'the funded address cannot be created, so it must not be reused');
 assert.equal(readdirSync(s.agentDirectory).filter(name=>name.includes('.proof-abandoned-')).length,1,'the old key is kept for the record');
 assert.equal(s.guard().pending,null);
});
