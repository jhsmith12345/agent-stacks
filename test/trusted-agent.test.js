import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Transaction,TransactionInstruction,ComputeBudgetProgram} from '@solana/web3.js';
import {TrustedAgentGuard,validateTrustPolicy,validateAcceptedMatch,verifyPinnedProgram,reconcilePending,priorityPrice,strictFundingRequired} from '../src/solana/trusted-agent.js';
import {Keypair,PublicKey,SystemProgram,DEVNET_GENESIS,termsHash,keyContext,PHYSICAL} from '../src/solana/client.js';
import {makeKey} from '../src/mental-poker/proofs.js';
import {initialDeck,encodeCipher,reencrypt} from '../src/mental-poker/deck.js';
import {point,randomScalar} from '../src/mental-poker/group.js';
import {canonical} from '../src/crypto.js';
import {readPrivate,writePrivate} from '../src/private-files.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'stacks-guard-'));
 const [wallet,peer,program,match]=await Promise.all(Array.from({length:4},()=>Keypair.generate()));
 const config={program:program.publicKey.toBase58(),match:match.publicKey.toBase58(),players:[wallet.publicKey.toBase58(),peer.publicKey.toBase58()],genesis:DEVNET_GENESIS,buyIn:1000000,bigBlind:20000,turnSeconds:86400,maxHands:2};config.terms=termsHash(config);
 const artifact=Buffer.from('pinned test program');
 const policy={schema:'agent-stacks/trusted-node/v1',trust:'operator-controlled-validator',network:'test-only',rpc:'http://127.0.0.1:8899',genesis:config.genesis,program:config.program,programSha256:hash(artifact),programBytes:artifact.length,allowLocal:true,allowUpgradeable:false,allowTestControls:false,allowCooperative:true,maxBuyIn:1000000,maxHands:2,minTurnSeconds:3600,maxTransactions:100,maxFeePerTransaction:10000,maxTotalFees:500000,maxAccountRent:5000000000,maxTotalOutflow:10000000000};
 const key=makeKey(keyContext(config.program,config.match,0,config.terms,1)),other=makeKey('test/peer');
 const joint=point(key.registration.publicKey).add(point(other.registration.publicKey));
 const deck=initialDeck().map(c=>encodeCipher(reencrypt({a:point(c.a),b:point(c.b)},joint,randomScalar())));
 const state={phase:7,version:7,handNo:1,keys:[key.registration.publicKey,other.registration.publicKey],deck,cursor:0,game:{street:0,actor:0},deadline:20000};
 const client={chainTime:async()=>10000,connection:{getFeeForMessage:async()=>({value:5000n}),getAccountInfo:async()=>({owner:new PublicKey('BPFLoader2111111111111111111111111111111111'),executable:true,data:artifact})}};
 const options={policy,config,wallet,directory,client};
 const guard=new TrustedAgentGuard(options);
 const observe=(g,m=state,slot=100)=>g.observe({state:m,slot,hash:hash(canonical(m))});
 const tx=()=>new Transaction({feePayer:wallet.publicKey,blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}).add(new TransactionInstruction({programId:program.publicKey,keys:[{pubkey:match.publicKey,isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:false}],data:Buffer.from([15])}));
 return {directory,options,guard,observe,state,key,policy,config,client,wallet,peer,program,artifact,tx,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('trusted policy requires explicit provenance, code pins, test-only scope and conservative deadlines',async()=>{
 const f=await fixture();try{
  assert.equal(validateTrustPolicy(f.policy).network,'test-only');
  for(const change of [{trust:'public-provider'},{network:'mainnet'},{programSha256:'bad'},{minTurnSeconds:30},{rpc:'http://elsewhere.example'},{maxTransactions:Infinity},{allowLocal:'yes'}])assert.throws(()=>validateTrustPolicy({...f.policy,...change}));
  for(const change of [{buyIn:2000000},{maxHands:3},{turnSeconds:30},{program:f.peer.publicKey.toBase58()}]){const c={...f.config,...change};c.terms=termsHash(c);assert.throws(()=>validateAcceptedMatch(f.policy,c,f.wallet.publicKey.toBase58()));}
 }finally{f.cleanup();}
});
test('guard rejects rollback, equivocation, replaced deck and registered keys across restart',async()=>{
 const f=await fixture();try{
  f.observe(f.guard);
  const restored=new TrustedAgentGuard(f.options);
  for(const [change,slot] of [[{},99],[{version:6},101],[{deadline:20001},100],[{version:8,deck:[f.state.deck[1],f.state.deck[0],...f.state.deck.slice(2)]},101],[{version:8,keys:[f.state.keys[1],f.state.keys[0]]},101]])assert.throws(()=>f.observe(restored,{...f.state,...change},slot));
  assert.throws(()=>new TrustedAgentGuard({...f.options,policy:{...f.policy,maxTotalFees:600000}}),/another policy/);
  assert.equal(f.observe(restored).version,7);
 }finally{f.cleanup();}
});
test('share decision is durable before release and binds exact phase/card/state',async()=>{
 const f=await fixture();try{
  const m=f.observe(f.guard);const released=await f.guard.share(m,f.key);assert.equal(released.logical,1);
  const record=JSON.parse(readPrivate(f.guard.file,'utf8'));assert.equal(record.releases['1/7/1'].logical,1);
  const restored=new TrustedAgentGuard(f.options);await restored.share(f.observe(restored),f.key);
  await assert.rejects(restored.share({...m,phase:11},f.key),/not accepted/);
  await assert.rejects(restored.share({...m,deck:[m.deck[1],m.deck[0],...m.deck.slice(2)]},f.key),/not accepted/);
  f.client.chainTime=async()=>20000;await assert.rejects(restored.share(m,f.key),/deadline/);
 }finally{f.cleanup();}
});
test('share guard rejects invalid cursors and unauthorized phases without writing a release',async()=>{
 for(const change of [{phase:8},{phase:5},{cursor:2},{cursor:255}]){
  const f=await fixture();try{const m=f.observe(f.guard,{...f.state,...change});await assert.rejects(f.guard.share(m,f.key));assert.deepEqual(f.guard.record.releases,{});}finally{f.cleanup();}
 }
});
test('persistence failure prevents secret-dependent share computation and further work',async()=>{
 const f=await fixture();try{
  const m=f.observe(f.guard);f.guard.file='/dev/null/not-a-directory';
  await assert.rejects(f.guard.share(m,f.key));assert.equal(f.guard.poisoned,true);
  await assert.rejects(f.guard.share(m,f.key),/persistence/);
 }finally{f.cleanup();}
});
test('guard permits fresh next-hand keys/deck but rejects skipped recovery',async()=>{
 const f=await fixture();try{f.observe(f.guard);assert.throws(()=>f.observe(f.guard,{...f.state,version:9,handNo:3},102));
  const m={...f.state,version:9,handNo:2,phase:1,keys:['0'.repeat(64),'0'.repeat(64)],deck:initialDeck()};f.observe(f.guard,m,102);assert.equal(f.guard.record.checkpoint.deck,null);assert.deepEqual(f.guard.record.releases,{});
 }finally{f.cleanup();}
});
test('program pin rejects changed code, unexpected loader and executable state',async()=>{
 const f=await fixture();try{
  assert.equal((await verifyPinnedProgram(f.client.connection,f.policy)).sha256,f.policy.programSha256);
  for(const account of [{owner:new PublicKey('BPFLoader2111111111111111111111111111111111'),executable:true,data:Buffer.from('replacement')},{owner:f.program.publicKey,executable:true,data:f.artifact},{owner:f.program.publicKey,executable:false,data:f.artifact}]){f.client.connection.getAccountInfo=async()=>account;await assert.rejects(verifyPinnedProgram(f.client.connection,f.policy));}
 }finally{f.cleanup();}
});
test('upgradeable loader pins ProgramData and rejects retained authority unless test policy explicitly permits it',async()=>{
 const f=await fixture();try{
  const owner=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');const [pda]=await PublicKey.findProgramAddress([f.program.publicKey.toBytes()],owner);
  const program=Buffer.alloc(36);program.writeUInt32LE(2);program.set(pda.toBytes(),4);
  const data=Buffer.alloc(45+f.artifact.length+8);data.writeUInt32LE(3);data[12]=1;data.set(f.wallet.publicKey.toBytes(),13);f.artifact.copy(data,45);
  const connection={getAccountInfo:async key=>key.equals(f.program.publicKey)?{owner,executable:true,data:program}:{owner,executable:false,data}};
  await assert.rejects(verifyPinnedProgram(connection,f.policy),/upgrade authority/);
  assert.equal((await verifyPinnedProgram(connection,{...f.policy,allowUpgradeable:true})).upgradeAuthority,f.wallet.publicKey.toBase58());
  data[12]=0;await verifyPinnedProgram(connection,f.policy);
  data[data.length-1]=1;await assert.rejects(verifyPinnedProgram(connection,f.policy),/differs/);
 }finally{f.cleanup();}
});
test('signing budgets persist, reject unexpected destinations and block after uncertain send',async()=>{
 const f=await fixture();try{
  await f.guard.authorize(f.tx());assert.equal(f.guard.record.budget.fees,5000);
  f.guard.transaction('original-signature',{status:'prepared'});
  const restored=new TrustedAgentGuard(f.options);await assert.rejects(restored.authorize(f.tx()),/uncertain/);
  assert.throws(()=>restored.transaction('another-signature',{status:'confirmed'}),/does not match/);
  restored.transaction('original-signature',{status:'confirmed'});await restored.authorize(f.tx());assert.equal(restored.record.budget.fees,10000);
  const transfer=new Transaction({feePayer:f.wallet.publicKey,blockhash:'11111111111111111111111111111111'}).add(SystemProgram.transfer({fromPubkey:f.wallet.publicKey,toPubkey:f.peer.publicKey,lamports:10n}));
  await assert.rejects(restored.authorize(transfer),/authorized test rent/);
  f.client.connection.getFeeForMessage=async()=>({value:10001n});await assert.rejects(restored.authorize(f.tx()),/fee exceeds/);
 }finally{f.cleanup();}
});
test('cumulative signing limits survive restart and cannot be reset by resubmitting',async()=>{
 const f=await fixture();try{
  const options={...f.options,policy:{...f.policy,maxTransactions:1}};const g=new TrustedAgentGuard(options);await g.authorize(f.tx());
  await assert.rejects(new TrustedAgentGuard(options).authorize(f.tx()),/Cumulative/);
 }finally{f.cleanup();}
});
test('malformed persisted budgets fail closed instead of resetting spending counters',async()=>{
 const f=await fixture();try{
  f.observe(f.guard);const good=JSON.parse(readPrivate(f.guard.file,'utf8'));
  for(const change of [{fees:null},{transactions:-1},{outflow:'0'},{pending:42}]){
   writePrivate(f.guard.file,JSON.stringify({...good,budget:{...good.budget,...change}}));
   assert.throws(()=>new TrustedAgentGuard(f.options),/Malformed guard/);
  }
 }finally{f.cleanup();}
});
test('reconciliation clears only the original finalized receipt, never retries unknown payments',async()=>{
 const f=await fixture();try{
  f.guard.transaction('original',{status:'prepared'});
  f.client.connection.getSignatureStatuses=async()=>({value:[{confirmationStatus:'confirmed',err:null}]});
  assert.equal((await reconcilePending(f.guard)).outcome,'uncertain');await assert.rejects(reconcilePending(f.guard,{apply:true}),/No finalized/);
  f.client.connection.getSignatureStatuses=async()=>({value:[null]});await assert.rejects(reconcilePending(f.guard,{apply:true}),/No finalized/);
  f.client.connection.getSignatureStatuses=async()=>({value:[{confirmationStatus:'finalized',err:null}]});
  assert.equal((await reconcilePending(f.guard)).outcome,'succeeded');assert.equal(f.guard.record.budget.pending,'original');
  assert.equal((await reconcilePending(f.guard,{apply:true})).applied,true);assert.equal(f.guard.record.budget.pending,null);
  f.guard.transaction('failed-original',{status:'prepared'});f.client.connection.getSignatureStatuses=async()=>({value:[{confirmationStatus:'finalized',err:{InstructionError:[0,'error']}}]});
  assert.equal((await reconcilePending(f.guard,{apply:true})).outcome,'failed');assert.equal(f.guard.record.budget.pending,null);
 }finally{f.cleanup();}
});

const noStatus=async()=>({value:[null]});
const prepare=(guard,signature='dead',lastValidBlockHeight='100',bytes=Buffer.from('original signed bytes'))=>guard.transaction(signature,{status:'prepared',lastValidBlockHeight,transactionBase64:bytes.toString('base64')});
test('a transaction that can no longer land clears only after its blockhash has provably expired',async()=>{
 const f=await fixture();try{
  await f.guard.authorize(f.tx());prepare(f.guard);
  const c=f.client.connection;c.getSignatureStatuses=noStatus;c.getBlockHeight=async()=>100n;
  assert.equal((await reconcilePending(f.guard)).outcome,'uncertain');
  await assert.rejects(reconcilePending(f.guard,{apply:true}),/No finalized/);
  await assert.rejects(f.guard.authorize(f.tx()),/uncertain/);
  c.getBlockHeight=async()=>101n;
  assert.equal((await reconcilePending(f.guard)).outcome,'expired');assert.equal(f.guard.record.budget.pending,'dead','inspection alone must not clear it');
  const result=await reconcilePending(f.guard,{apply:true});assert.equal(result.outcome,'expired');assert.equal(result.applied,true);
  assert.deepEqual([f.guard.record.budget.pending,f.guard.record.budget.pendingExpiry,f.guard.record.budget.pendingTransaction],[null,null,null]);
  await f.guard.authorize(f.tx());assert.equal(f.guard.record.budget.transactions,2,'budgets are never reset by recovery');
 }finally{f.cleanup();}
});
test('a receipt always outranks expiry, and height is read before status so a landing cannot be missed',async()=>{
 const f=await fixture();try{
  prepare(f.guard);const c=f.client.connection,order=[];c.getBlockHeight=async()=>{order.push('height');return 500n;};
  c.getSignatureStatuses=async()=>{order.push('status');return {value:[{confirmationStatus:'confirmed',err:null}]};};
  assert.equal((await reconcilePending(f.guard)).outcome,'uncertain','seen but not finalized is not dead');
  assert.deepEqual(order,['height','status']);
  c.getSignatureStatuses=async()=>({value:[{confirmationStatus:'finalized',err:null}]});assert.equal((await reconcilePending(f.guard)).outcome,'succeeded');
  c.getSignatureStatuses=async()=>({value:[{confirmationStatus:'finalized',err:{InstructionError:[0,'error']}}]});assert.equal((await reconcilePending(f.guard)).outcome,'failed');
 }finally{f.cleanup();}
});
test('a pending record with no expiry height can never be presumed dead',async()=>{
 const f=await fixture();try{
  f.guard.transaction('legacy',{status:'prepared'});
  const c=f.client.connection;c.getSignatureStatuses=noStatus;c.getBlockHeight=async()=>{throw Error('height is irrelevant without a recorded expiry');};
  assert.equal((await reconcilePending(f.guard)).outcome,'uncertain');
  await assert.rejects(reconcilePending(f.guard,{apply:true}),/No finalized/);
  await assert.rejects(f.guard.settlePending(),/no recorded expiry/);
  assert.equal(f.guard.record.budget.pending,'legacy');
  f.guard.persist({...f.guard.record,budget:{transactions:0,fees:0,outflow:0,pending:'older-format'}});
  assert.equal(new TrustedAgentGuard(f.options).record.budget.pending,'older-format','records written before this field still load');
 }finally{f.cleanup();}
});
test('recovery redelivers only the original bytes, past a withholding relay, and only when asked',async()=>{
 const f=await fixture();try{
  const original=Buffer.from('original signed bytes'),seen=[];prepare(f.guard,'dead','100',original);
  const c=f.client.connection;c.getSignatureStatuses=noStatus;c.getBlockHeight=async()=>100n;
  c.sendRawTransaction=async(bytes,options)=>{assert.equal(options.skipPreflight,true);seen.push(Buffer.from(bytes));};
  f.client.submissionConnection={sendRawTransaction:async()=>{throw Error('relay withholding');}};
  await reconcilePending(f.guard);assert.equal(seen.length,0,'reconciliation stays read-only by default');
  await reconcilePending(f.guard,{rebroadcast:true});assert.equal(seen.length,1);assert.ok(seen[0].equals(original));
  assert.equal(f.guard.record.budget.transactions,0,'redelivery is not a new authorization');
  c.getBlockHeight=async()=>101n;await reconcilePending(f.guard,{rebroadcast:true});assert.equal(seen.length,1,'expired bytes are never redelivered');
 }finally{f.cleanup();}
});
test('settlePending waits for resolution, journals it and survives a restart',{timeout:15000},async()=>{
 const f=await fixture();try{
  prepare(f.guard);const heights=[100n,100n,101n],c=f.client.connection,journal=[];let polls=0;
  c.getSignatureStatuses=noStatus;c.sendRawTransaction=async()=>{};c.getBlockHeight=async()=>{if(++polls>20)throw Error('settlePending did not resolve after expiry');return heights.shift()??101n;};
  const restored=new TrustedAgentGuard({...f.options,journal:(signature,details)=>journal.push({signature,...details})});
  assert.equal(restored.record.budget.pendingExpiry,'100','recovery evidence must be durable before transmission');
  await restored.settlePending({pollMs:1});
  assert.equal(polls,3);assert.equal(restored.record.budget.pending,null);assert.deepEqual(journal,[{signature:'dead',status:'expired',reconciled:true}]);
  assert.equal(new TrustedAgentGuard(f.options).record.budget.pending,null);
  await restored.settlePending();assert.equal(polls,3,'no RPC work when nothing is pending');
 }finally{f.cleanup();}
});
test('malformed recovery evidence fails closed',async()=>{
 const f=await fixture();try{
  f.observe(f.guard);const good=JSON.parse(readPrivate(f.guard.file,'utf8'));
  for(const change of [{pendingExpiry:5},{pendingExpiry:'soon'},{pendingExpiry:'9'.repeat(21)},{pendingTransaction:7},{pendingTransaction:'not base64!'},{pendingTransaction:'A'.repeat(2049)}]){
   writePrivate(f.guard.file,JSON.stringify({...good,budget:{...good.budget,...change}}));
   assert.throws(()=>new TrustedAgentGuard(f.options),/Malformed guard/);
  }
 }finally{f.cleanup();}
});

test('a transaction rejected before release returns its whole reservation, durably',async()=>{
 const f=await fixture();try{
  const rent=SystemProgram.createAccount({fromPubkey:f.wallet.publicKey,newAccountPubkey:f.peer.publicKey,lamports:4_000_000_000n,space:100n,programId:f.program.publicKey});
  const create=()=>new Transaction({feePayer:f.wallet.publicKey,blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}).add(rent);
  // Far more rejected attempts than the outflow limit could absorb if they stayed reserved.
  for(let i=0;i<10;i++){await f.guard.authorize(create());assert.equal(f.guard.record.budget.outflow,4_000_000_000);f.guard.release();}
  assert.deepEqual([f.guard.record.budget.transactions,f.guard.record.budget.fees,f.guard.record.budget.outflow],[0,0,0]);
  f.guard.release();assert.equal(f.guard.record.budget.transactions,0,'releasing twice must not go negative');
  assert.equal(new TrustedAgentGuard(f.options).record.budget.outflow,0,'the return survives a restart');
 }finally{f.cleanup();}
});
test('anything actually released keeps its reservation',async()=>{
 const f=await fixture();try{
  await f.guard.authorize(f.tx());f.guard.transaction('sent',{status:'prepared'});f.guard.release();
  assert.equal(f.guard.record.budget.transactions,1,'bytes were released, so this stays consumed');assert.equal(f.guard.record.budget.fees,5000);
  f.guard.transaction('sent',{status:'failed'});f.guard.release();assert.equal(f.guard.record.budget.transactions,1,'a failed receipt does not refund it either');
 }finally{f.cleanup();}
});
test('priority fees need explicit policy approval and stay under the policy ceiling',async()=>{
 const f=await fixture();try{
  const priced=microLamports=>f.tx().add(ComputeBudgetProgram.setComputeUnitPrice({microLamports}));
  await assert.rejects(f.guard.authorize(priced(1)),/policy-approved priority fees/,'refused by default');
  for(const bad of [-1,1.5,'100',NaN])assert.throws(()=>validateTrustPolicy({...f.policy,maxComputeUnitPrice:bad}),/maxComputeUnitPrice/);
  const g=new TrustedAgentGuard({...f.options,policy:{...f.policy,maxComputeUnitPrice:1000}});
  await g.authorize(priced(1000));assert.equal(g.record.budget.transactions,1);
  await assert.rejects(g.authorize(priced(1001)),/policy-approved priority fees/);
  f.client.connection.getFeeForMessage=async()=>({value:10001n});
  await assert.rejects(g.authorize(priced(1)),/fee exceeds/,'the per-transaction fee cap still applies to the total');
 }finally{f.cleanup();}
});
test('a fee estimate for an expired blockhash can be retried, an unaffordable fee cannot',async()=>{
 const f=await fixture();try{
  f.client.connection.getFeeForMessage=async()=>({value:null});
  await assert.rejects(f.guard.authorize(f.tx()),e=>e.retryable===true&&/expired/.test(e.message));
  f.client.connection.getFeeForMessage=async()=>({value:10001n});
  await assert.rejects(f.guard.authorize(f.tx()),e=>e.retryable===undefined&&/fee exceeds/.test(e.message));
  assert.equal(f.guard.record.budget.transactions,0);
 }finally{f.cleanup();}
});
test('priority pricing is capped three ways and never blocks an action',async()=>{
 const f=await fixture();try{
  const policy={...f.policy,maxFeePerTransaction:15000,maxComputeUnitPrice:50000},payer=f.wallet.publicKey,ix=[{keys:[{pubkey:f.peer.publicKey,isWritable:true,isSigner:false},{pubkey:f.program.publicKey,isWritable:false,isSigner:false}]}];
  let asked;const connection=fees=>({getRecentPrioritizationFees:async config=>{asked=config.lockedWritableAccounts.map(k=>k.toBase58());return fees.map(prioritizationFee=>({slot:1,prioritizationFee}));}});
  assert.equal(await priorityPrice(connection([10,20,30,40]),policy,ix,payer,200000),40,'p75 of recent fees');
  assert.deepEqual(asked.sort(),[payer.toBase58(),f.peer.publicKey.toBase58()].sort(),'priced on accounts this transaction write-locks');
  assert.equal(await priorityPrice(connection([60000]),policy,ix,payer,200000),50000,'capped by the policy ceiling');
  assert.equal(await priorityPrice(connection([60000]),policy,ix,payer,1400000),7142,'capped by what fits under the per-transaction fee');
  assert.equal(await priorityPrice(connection([]),policy,ix,payer,200000),0);
  assert.equal(await priorityPrice({getRecentPrioritizationFees:async()=>{throw Error('down');}},policy,ix,payer,200000),0,'a failed estimate sends without a fee');
  let called=false;await priorityPrice({getRecentPrioritizationFees:async()=>{called=true;return [];}},f.policy,ix,payer,200000);assert.equal(called,false,'disabled policies make no extra RPC call');
 }finally{f.cleanup();}
});
test('strict funding covers the deposit, one reusable proof buffer and fees for remaining hands',()=>{
 assert.equal(strictFundingRequired({rent:4_541_928_960,buyIn:1_000_000,hands:2,maxFeePerTransaction:15000}),4_541_928_960+1_000_000+2*710*15000);
 assert.equal(strictFundingRequired({rent:100,buyIn:0,hands:1,maxFeePerTransaction:10}),100+7100);
});

test('settlePending keeps waiting through RPC failures but stops on anything else',{timeout:15000},async()=>{
 const f=await fixture();try{
  prepare(f.guard);const c=f.client.connection;let polls=0;c.sendRawTransaction=async()=>{};c.getSignatureStatuses=noStatus;
  c.getBlockHeight=async()=>{polls++;if(polls<4)throw Object.assign(Error('HTTP 503'),{rpcFailure:true});return 101n;};
  let noticed=0;await f.guard.settlePending({pollMs:1,onRpcFailure:()=>noticed++});assert.equal(polls,4);assert.equal(noticed,3,'the wait is reported, not silent');assert.equal(f.guard.record.budget.pending,null);
  prepare(f.guard,'second');c.getBlockHeight=async()=>{throw Error('a client bug');};
  await assert.rejects(f.guard.settlePending({pollMs:1}),/a client bug/);assert.equal(f.guard.record.budget.pending,'second');
 }finally{f.cleanup();}
});

test('the guard confines protocol instructions to this match and this wallet',async()=>{
 const f=await fixture();try{
  const me=f.wallet.publicKey,match=await Keypair.generate(),other=match.publicKey;
  const m=k=>({pubkey:k,isSigner:false,isWritable:true}),own={pubkey:me,isSigner:true,isWritable:true},theMatch=f.tx().instructions[0].keys[0].pubkey;
  const ix=(tag,keys)=>new Transaction({feePayer:me,blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}).add(new TransactionInstruction({programId:f.program.publicKey,keys,data:Buffer.from([tag])}));
  await f.guard.authorize(ix(20,[m(theMatch),own,m(me)]));
  await assert.rejects(f.guard.authorize(ix(20,[m(theMatch),own,m(other)])),/only pay this wallet/);
  await assert.rejects(f.guard.authorize(ix(20,[m(other),own,m(me)])),/another match/);
  await f.guard.authorize(ix(16,[m(other),own,m(theMatch)]));
  await assert.rejects(f.guard.authorize(ix(16,[m(other),own,m(other)])),/another match/);
  for(const tag of [8,9,10,11,12,17,19]){
   await f.guard.authorize(ix(tag,[m(other),own]));
   await assert.rejects(f.guard.authorize(ix(tag,[m(other),m(other)])),/this wallet as authority/);
  }
 }finally{f.cleanup();}
});
test('accepted matches must fit the clock and blind limits',async()=>{
 const f=await fixture();try{
  const player=f.wallet.publicKey.toBase58(),with_=change=>{const c={...f.config,...change};c.terms=termsHash(c);return c;};
  assert.throws(()=>validateAcceptedMatch(f.policy,with_({turnSeconds:86401}),player),/deadline policy/,'default ceiling is 24 hours');
  validateAcceptedMatch(f.policy,with_({turnSeconds:86400}),player);
  validateAcceptedMatch({...f.policy,maxTurnSeconds:259200},with_({turnSeconds:259200}),player);
  assert.throws(()=>validateAcceptedMatch({...f.policy,maxTurnSeconds:7200},with_({turnSeconds:7201}),player),/deadline policy/);
  assert.throws(()=>validateTrustPolicy({...f.policy,maxTurnSeconds:60}),/maxTurnSeconds/,'a ceiling below the floor is meaningless');
  for(const bigBlind of [0,21,100002])assert.throws(()=>validateAcceptedMatch(f.policy,with_({bigBlind}),player),/blind policy/,`big blind ${bigBlind}`);
  assert.throws(()=>validateAcceptedMatch(f.policy,{...with_({}),bigBlind:undefined},player));
  validateAcceptedMatch(f.policy,with_({bigBlind:100000}),player);
  assert.throws(()=>validateAcceptedMatch({...f.policy,maxBigBlind:50000},with_({bigBlind:60000}),player),/blind policy/);
  assert.throws(()=>validateTrustPolicy({...f.policy,maxBigBlind:-1}),/maxBigBlind/);
 }finally{f.cleanup();}
});
test('co-signing spends no signing budget, and each match version gets one deck and a bounded number of signatures',async()=>{
 const f=await fixture();try{
  const actor=f.peer.publicKey,me=f.wallet.publicKey,meta=(k,w=false)=>({pubkey:k,isSigner:true,isWritable:w}),buffer=(await Keypair.generate()).publicKey,theMatch=f.tx().instructions[0].keys[0].pubkey;
  const acceptance=(version,fill)=>{const data=Buffer.alloc(41,fill);data[0]=18;data.writeBigUInt64LE(BigInt(version),1);return new Transaction({feePayer:actor,blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}).add(new TransactionInstruction({programId:f.program.publicKey,data,keys:[{pubkey:theMatch,isSigner:false,isWritable:true},meta(actor,true),meta(me),{pubkey:buffer,isSigner:false,isWritable:false}]}));};
  for(let i=0;i<5;i++)await f.guard.authorize(acceptance(7,1));
  assert.deepEqual([f.guard.record.budget.transactions,f.guard.record.budget.fees,f.guard.record.budget.outflow],[0,0,0],'repeated offers cannot use up the budget for our own moves');
  await assert.rejects(f.guard.authorize(acceptance(7,1)),/limit reached/);
  await assert.rejects(f.guard.authorize(acceptance(7,2)),/different deck/);
  await assert.rejects(new TrustedAgentGuard(f.options).authorize(acceptance(7,2)),/different deck/,'the limit survives a restart');
  await f.guard.authorize(acceptance(8,2));assert.equal(f.guard.record.budget.cosign.version,'8','a new version starts over');
  await f.guard.authorize(f.tx());assert.equal(f.guard.record.budget.transactions,1,'own transactions still count');
  const good=JSON.parse(readPrivate(f.guard.file,'utf8'));
  for(const cosign of [{version:8},{version:'8',hash:'nope',count:1},{version:'8',hash:'0'.repeat(64),count:-1}]){writePrivate(f.guard.file,JSON.stringify({...good,budget:{...good.budget,cosign}}));assert.throws(()=>new TrustedAgentGuard(f.options),/Malformed guard/);}
 }finally{f.cleanup();}
});
