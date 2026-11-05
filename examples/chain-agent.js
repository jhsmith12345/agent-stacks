import {resolve,dirname,basename} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {existsSync,readFileSync,mkdirSync,renameSync} from 'node:fs';
import {ensureWallet,PublicKey,SystemProgram,u64,u32,u16,keyContext,shuffleContext,obligated,PHYSICAL} from '../src/solana/client.js';
import {makeKey,encodeDLEQ,verifyKey} from '../src/mental-poker/proofs.js';
import {shuffleAndProve,encodeShuffle,decodeShuffle,verifyShuffle} from '../src/mental-poker/shuffle.js';
import {G,point,mul,scalar} from '../src/mental-poker/group.js';
import {COMPACT_SPACE,deckBytes,deckHash,compactTransaction,signVerifiedShuffle} from '../src/solana/compact-shuffle.js';
import {revealCard} from '../src/mental-poker/deck.js';
import {privateDirectory,readPrivate,writePrivate,appendPrivate,transferOnce} from '../src/private-files.js';
import {acquireLock} from '../src/lock.js';
import {loadTrustPolicy,trustedClient,strictFundingRequired} from '../src/solana/trusted-agent.js';
const wallet=await ensureWallet(process.argv[2]);
const directory=resolve(process.argv[3]);mkdirSync(directory,{recursive:true,mode:0o700});
privateDirectory(directory);
const walletPath=resolve(process.argv[2]);
const releaseWallet=acquireLock(dirname(walletPath),`${basename(walletPath)}.agent.lock`);
process.once('exit',releaseWallet);
const releaseState=acquireLock(directory,'agent.lock');
process.once('exit',releaseState);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>process.exit(0));
let client,config,seat,pendingCompact,guard,policy,landed=0;
const allowCooperative=process.env.AGENT_STACKS_COOPERATIVE_SHUFFLE==='1';
const own={pubkey:wallet.publicKey,isSigner:true,isWritable:true};
// Proof upload and verification only: they move no value and reveal no secret, each is bound
// to an on-chain offset or round, and a rolled-back step fails its next bound and resumes from
// chain progress. Tag 13 re-checks the finished proof on-chain and still waits for finality.
// Waiting for finality on each of ~690 sequential transactions takes longer than the turn clock.
const bulk=(instructions,units=null)=>client.send(instructions,[],units,{confirmation:'confirmed'});
const ownedByProgram=account=>!!account&&account.owner.equals(client.program);
// Priority-fee instructions add 52 bytes, which a full 1,000-byte chunk has no room for.
const uploadChunk=()=>policy.maxComputeUnitPrice?960:1000;
// A buffer address is exposed once its creation is broadcast, and anyone can then fund it, which
// makes that address uncreatable. No buffer exists there yet, so nothing is lost by moving on.
async function bufferKey(m,suffix){
 const path=resolve(directory,`${handId(m)}.${suffix}-keypair.json`);
 const key=await ensureWallet(path);
 const account=await client.connection.getAccountInfo(key.publicKey,'confirmed');
 if(!account||ownedByProgram(account))return {key,account};
 renameSync(path,resolve(directory,`${handId(m)}.${suffix}-abandoned-${Date.now()}-keypair.json`));
 return {key:await ensureWallet(path),account:null};
}
// A refused co-signature forces the full proof path, so its rent must be available before a stake
// is committed. An agent that can't afford the fallback loses the match to a simple refusal.
async function fundingShortfall(m,buyIn){
 const context=shuffleContext(config.program,config.match,seat,config.terms,m.handNo);
 // An open proof buffer already holds its rent, and closing it refunds that rent.
 const proofPath=resolve(directory,`${handId(m)}.proof-keypair.json`);
 const open=existsSync(proofPath)&&ownedByProgram(await client.connection.getAccountInfo((await ensureWallet(proofPath)).publicKey,'confirmed'));
 const rent=open?0:Number(await client.connection.getMinimumBalanceForRentExemption(652324+Buffer.byteLength(context)+84));
 const required=strictFundingRequired({rent,buyIn,hands:(config.maxHands??1)-m.handNo+1,maxFeePerTransaction:policy.maxFeePerTransaction});
 const balance=Number(await client.connection.getBalance(wallet.publicKey,'confirmed'));
 return balance<required?{balance,required}:null;
}
const handId=m=>`${config.match}.hand-${m.handNo}`;
const fileFor=m=>resolve(directory,`${handId(m)}.private.json`);
function handKey(m){
 const file=fileFor(m),context=keyContext(config.program,config.match,seat,config.terms,m.handNo);
 if(existsSync(file)){
  const key=JSON.parse(readPrivate(file,'utf8'));
  if(mul(G,scalar(key.secret,true)).toHex()!==key.registration?.publicKey||!verifyKey(key.registration,context))throw Error('Private hand key cache does not match accepted context');
  return key;
 }
 if(m.phase!==seat+1)throw Error('Private hand key missing; restore agent state before continuing');
 const key=makeKey(context);writePrivate(file,JSON.stringify(key),{exclusive:true});return key;
}
function extraPlayers(){return [own,...config.players.map(p=>({pubkey:new PublicKey(p),isSigner:false,isWritable:true}))];}
function shuffleMaterial(m){
 const context=shuffleContext(config.program,config.match,seat,config.terms,m.handNo);
 const joint=point(m.keys[0],true).add(point(m.keys[1],true)).toHex();
 const path=resolve(directory,`${handId(m)}.shuffle.bin`);
 let wire;
 if(existsSync(path)){wire=readPrivate(path);const decoded=decodeShuffle(wire);if(!verifyShuffle(m.deck,joint,context,decoded.proof))throw Error('Cached shuffle proof failed verification');}
 else{const proof=shuffleAndProve(m.deck,joint,context);wire=encodeShuffle(m.deck,proof);writePrivate(path,wire,{exclusive:true});}
 const ctx=wire.readUInt16LE(2);const inputAt=4+ctx+32;
 const expectedInput=Buffer.concat(m.deck.flatMap(c=>[Buffer.from(c.a,'hex'),Buffer.from(c.b,'hex')]));
 if(wire.readUInt16LE(0)!==52||wire.subarray(4,4+ctx).toString()!==context||wire.subarray(4+ctx,inputAt).toString('hex')!==joint||!wire.subarray(inputAt,inputAt+3328).equals(expectedInput))throw Error('Cached shuffle does not match this chain obligation');
 return {context,joint,wire};
}
async function shuffle(m){
 const {wire}=shuffleMaterial(m);
 const {key:proofKey,account:existing}=await bufferKey(m,'proof');
 const metas=[{pubkey:proofKey.publicKey,isSigner:false,isWritable:true},own];
 let account=existing;
 if(!account){const lamports=await client.connection.getMinimumBalanceForRentExemption(wire.length+84);await client.send([SystemProgram.createAccount({fromPubkey:wallet.publicKey,newAccountPubkey:proofKey.publicKey,lamports,space:BigInt(wire.length+84),programId:client.program}),client.instruction(8,[u32(wire.length)],[{...metas[0],isSigner:true},own])],[proofKey]);account=await client.connection.getAccountInfo(proofKey.publicKey,'confirmed');}
 if(!account||!account.owner.equals(client.program))throw Error('Unexpected proof account owner');
 const data=Buffer.from(account.data);if(data.subarray(0,8).toString()!=='ASTKSHF1'||!data.subarray(8,40).equals(Buffer.from(wallet.publicKey.toBytes()))||data.readUInt32LE(40)!==wire.length)throw Error('Invalid cached proof account');
 let written=data.readUInt32LE(44);if(!data.subarray(84,84+written).equals(wire.subarray(0,written)))throw Error('On-chain upload differs from cached proof');
 while(written<wire.length){const chunk=wire.subarray(written,Math.min(written+uploadChunk(),wire.length));await bulk([client.instruction(9,[u32(written),chunk],metas)]);written+=chunk.length;if(Math.ceil(written/1000)%100===0||written===wire.length)process.stderr.write(`Agent ${seat}: uploaded ${written}/${wire.length} proof bytes\n`);}
 if(data[48]===0)await bulk([client.instruction(10,[],metas)],1_400_000);
 let round=data.readUInt16LE(49);
 while(round<128){const count=Math.min(4,128-round);await bulk([client.instruction(11,[u16(round),Buffer.from([count])],metas)],1_400_000);round+=count;}
 await client.command(config.match,13,[],[own,{pubkey:proofKey.publicKey,isSigner:false,isWritable:false}],null,m.version);
 await client.send([client.instruction(12,[],metas)]);
}
async function prepareCompact(){
 if(!allowCooperative)throw Error('Cooperative mode disabled');
 const m=await client.match(config.match,config);if(m.phase!==3+seat)throw Error('Not this agent’s shuffle');
 const {wire}=shuffleMaterial(m);const {proof}=decodeShuffle(wire);
 const output=deckBytes(proof.output);const {key,account:existing}=await bufferKey(m,'compact');
 const metas=[{pubkey:key.publicKey,isSigner:false,isWritable:true},own];
 let account=existing;
 if(!account){const lamports=await client.connection.getMinimumBalanceForRentExemption(COMPACT_SPACE);await client.send([SystemProgram.createAccount({fromPubkey:wallet.publicKey,newAccountPubkey:key.publicKey,lamports,space:BigInt(COMPACT_SPACE),programId:client.program}),client.instruction(16,[],[{...metas[0],isSigner:true},own,{pubkey:new PublicKey(config.match),isSigner:false,isWritable:false}])],[key]);account=await client.connection.getAccountInfo(key.publicKey,'confirmed');}
 if(!account||!account.owner.equals(client.program)||account.data.length!==COMPACT_SPACE)throw Error('Invalid compact buffer owner/size');
 const data=Buffer.from(account.data);if(data.subarray(0,8).toString()!=='ASTKDK01'||!data.subarray(8,40).equals(Buffer.from(wallet.publicKey.toBytes()))||!data.subarray(40,72).equals(Buffer.from(new PublicKey(config.match).toBytes()))||data.readUInt32LE(72)!==m.handNo||data[76]!==seat)throw Error('Invalid compact buffer context');
 let written=data.readUInt32LE(77);if(written>3328||!data.subarray(81,81+written).equals(output.subarray(0,written)))throw Error('Compact upload mismatch');
 while(written<output.length){const chunk=output.subarray(written,written+uploadChunk());await client.send([client.instruction(17,[u32(written),chunk],metas)]);written+=chunk.length;}
 const latest=await client.connection.getLatestBlockhash('confirmed');
 pendingCompact={protocol:'agent-stacks/joint-shuffle/v1',match:config.match,handNo:m.handNo,version:m.version,buffer:key.publicKey.toBase58(),outputHash:deckHash(proof.output),blockhash:latest.blockhash,lastValidBlockHeight:String(latest.lastValidBlockHeight),wire:wire.toString('base64')};
 return pendingCompact;
}
async function finishCompact(signature){
 if(!pendingCompact)throw Error('No pending offer');
 const m=await client.match(config.match,config),offer=pendingCompact;
 const tx=compactTransaction(client,config,m,offer);await client.authorizeTransaction(tx);
 try{await tx.sign(wallet);tx.addSignature(new PublicKey(config.players[1-seat]),Buffer.from(signature,'base64'));}
 catch(error){guard.release();throw error;}
 const result=await client.submit(tx);
 await client.send([client.instruction(19,[],[{pubkey:new PublicKey(offer.buffer),isSigner:false,isWritable:true},own])]);pendingCompact=null;return result;
}
async function step(){
 const m=await client.match(config.match,config);
 if(m.phase===6){
  if(m.pendingPayouts&(1<<seat))await client.command(config.match,20,[Buffer.from([seat])],[own,{pubkey:wallet.publicKey,isSigner:false,isWritable:true}],null,m.version);
  return {phase:6,payouts:m.payouts};
 }
 if(obligated(m)!==seat&&!(m.phase===0&&seat===1))throw Error('Not this agent’s obligation');
 if(m.phase===0){
  if(existsSync(fileFor(m)))handKey(m);
  // The demo coordinator lends these funds as needed, which only a test-controls policy allows.
  if(!policy.allowTestControls){const short=await fundingShortfall(m,config.buyIn);if(short){const error=Error(`Refusing to join: balance ${short.balance} is below the ${short.required} lamports needed for the deposit and a full-proof fallback`);error.retryable=true;throw error;}}
  await client.command(config.match,2,[Buffer.from(config.terms,'hex')],[own,{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],null,m.version);}
 else if(m.phase===1||m.phase===2){const key=handKey(m);const context=keyContext(config.program,config.match,seat,config.terms,m.handNo);await client.command(config.match,3,[encodeDLEQ(context,key.registration.publicKey,G.toHex(),key.registration.publicKey,key.registration.proof)],[own],null,m.version);}
 else if(m.phase===3||m.phase===4){await shuffle(m);}
 else if(m.phase===8){
  const key=handKey(m);if(key.registration.publicKey!==m.keys[seat])throw Error('Private key does not match registered key');
  const holes=seat===0?[0,2]:[1,3];
  const yourCards=holes.map(i=>{const c=m.deck[PHYSICAL[i]],ownShare=mul(point(c.a,true),scalar(key.secret,true)).toHex();return revealCard(c,[{share:ownShare},{share:m.shares[i][1-seat]}]);});
  if(yourCards.length!==2)throw Error('Cannot decode own cards');
  const action=m.game.currentBet===m.game.bets[seat]?1:2;
  await client.command(config.match,15,[Buffer.from([action]),u64(0)],extraPlayers(),1_400_000,m.version);
 } else {
  const {logical,proof}=await guard.share(m,handKey(m));
  await client.command(config.match,14,[Buffer.from([logical]),proof],extraPlayers(),1_400_000,m.version);
 }
 return {phase:(await client.match(config.match,config)).phase};
}
const respond=message=>{if(process.send)process.send(message);else console.log(JSON.stringify(message));};
async function handle(message){
 const reply=payload=>respond({...payload,requestId:message.requestId});
 try{
  if(message.kind==='initialize'){
   if(client)throw Error('Already initialized');
   policy=loadTrustPolicy(process.env.AGENT_STACKS_TRUST_POLICY);
   if(message.rpc&&new URL(message.rpc).href!==new URL(policy.rpc).href)throw Error('Initialization cannot replace the trusted state RPC');
   config=structuredClone(message.config);seat=config.players.indexOf(wallet.publicKey.toBase58());if(seat<0)throw Error('Agent is not named');
   const next=trustedClient(policy,config,wallet,directory,(signature,details)=>{if(details.status==='confirmed')landed++;return appendPrivate(resolve(directory,'transactions.ndjson'),JSON.stringify({at:new Date().toISOString(),signature,...details})+'\n');});
   const genesis=await next.client.checkNetwork();if(genesis!==policy.genesis)throw Error('Wrong pinned genesis hash');await next.client.match(config.match,config);
   // Assigned only on success, so a failed attempt can be retried.
   ({client,guard}=next);reply({kind:'ready'});
  }else if(message.kind==='compact-offer'){reply({kind:'offer',offer:await prepareCompact()});}
  else if(message.kind==='compact-sign'){reply({kind:'signed',...await signVerifiedShuffle(client,config,wallet,message.offer,{allowCooperative})});}
  else if(message.kind==='compact-finish'){reply({kind:'accepted',signature:await finishCompact(message.signature)});}
  else if(message.kind==='step'){const result=await step();reply({kind:'result',...result});}
   else if(message.kind==='settle'){await guard.settlePending();reply({kind:'settled'});}
  else if(message.kind==='cleanup-proof'){
   const m=await client.match(config.match,config);
   for(let handNo=1;handNo<=m.handNo;handNo++){
    if(handNo===m.handNo&&m.phase!==6&&m.phase<=3+seat)continue;
    for(const [suffix,tag] of [['proof',12],['compact',19]]){
     const path=resolve(directory,`${config.match}.hand-${handNo}.${suffix}-keypair.json`);if(!existsSync(path))continue;
     const proofKey=await ensureWallet(path);
     // These addresses are public once used and anyone can fund one, which recreates a
     // system-owned account here. That is not ours to close, and it must not stop the match.
     if(!ownedByProgram(await client.connection.getAccountInfo(proofKey.publicKey)))continue;
     try{await client.send([client.instruction(tag,[],[{pubkey:proofKey.publicKey,isSigner:false,isWritable:true},own])]);}
     catch(error){process.stderr.write(`Agent ${seat}: buffer refund deferred: ${error.message}\n`);}
    }
   }
   reply({kind:'proof-clean'});
  }
  else if(message.kind==='return-rent'){
   if(!policy.allowTestControls)throw Error('Test rent-return control is disabled');
   if(seat!==1)throw Error('Only the funded test agent returns borrowed proof rent');
   const m=await client.match(config.match,config);const target=message.handNo;if(!Number.isInteger(target)||target<1||target>m.handNo)throw Error('Invalid rent recovery hand');if(target===m.handNo&&m.phase!==6&&m.phase<5)throw Error('Shuffle has not been consumed');m.handNo=target;
   const marker=resolve(directory,`${handId(m)}.rent-returned.json`);
   const proofPath=resolve(directory,`${handId(m)}.proof-keypair.json`);if(!existsSync(proofPath)){reply({kind:'rent-returned',unused:true});return;}
   const proofKey=await ensureWallet(proofPath);
   if(ownedByProgram(await client.connection.getAccountInfo(proofKey.publicKey)))throw Error('Proof account must close before returning rent');
   const wire=readPrivate(resolve(directory,`${handId(m)}.shuffle.bin`));
   const amount=await client.connection.getMinimumBalanceForRentExemption(wire.length+84);
   const result=await transferOnce(marker,{lamports:String(amount)},async()=>{
    if((await client.connection.getBalance(wallet.publicKey))<amount+10_000n)throw Error('Not enough balance to return proof rent; inspect transaction journal');
    return client.send([SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:new PublicKey(config.players[0]),lamports:amount})]);
   });
   reply({kind:'rent-returned',...result});
  }
  else throw Error('Unsupported agent request');
 }catch(error){reply({kind:'error',message:error.message,signature:error.signature??null});if(!process.send)throw error;}
}
if(process.send){let queue=Promise.resolve(),queued=0;respond({kind:'identity',player:wallet.publicKey.toBase58()});process.on('message',message=>{
 if(!message||typeof message!=='object'||JSON.stringify(message).length>900000||queued>=8){respond({kind:'error',requestId:message?.requestId,message:'Agent request quota exceeded'});return;}
 queued++;queue=queue.then(()=>handle(message)).finally(()=>{queued--;});
});}
else{
 // Retries only what can safely be tried again. Each attempt re-reads state and re-runs every guard
 // check, so nothing is released by retrying. A changed program, a rollback, a budget breach or a
 // persistence failure has none of these marks and still stops the agent.
 const retryable=error=>!!(error.rpcFailure||error.notSent||error.signature||error.retryable);
 const patiently=async(work,alsoRetry=()=>false)=>{
  let failures=0,seen=landed;
  for(;;){
   try{return await work();}
   catch(error){
    if(!retryable(error)&&!alsoRetry(error))throw error;
    // Backoff is for a node that isn't working. One step can span hundreds of transactions, so
    // only a transaction landing since the last failure shows the node is working.
    failures=landed===seen?failures+1:1;seen=landed;
    const wait=Math.min(60_000,1000*2**(failures-1));
    process.stderr.write(`Agent: retrying in ${wait/1000}s: ${error.message}\n`);await pause(wait);
   }
  }
 };
 // Waiting out an uncertain transaction is correct, but an operator should be able to see why.
 let lastNote=0;
 const settle=()=>guard.settlePending({onRpcFailure:error=>{if(Date.now()-lastNote>30_000){lastNote=Date.now();process.stderr.write(`Agent: waiting on an uncertain transaction, node not responding: ${error.message}\n`);}}});
 const index=process.argv.indexOf('--manifest');if(index<0)throw Error('Usage: node examples/chain-agent.js WALLET_KEYPAIR PRIVATE_DIRECTORY --manifest MATCH_MANIFEST');
 const accepted=JSON.parse(readFileSync(resolve(process.argv[index+1]),'utf8'));
 // The accepted manifest carries terms, not authority to select this host's node.
 // A new match takes a moment to finalize, so allow for that, but not forever: the manifest may be wrong.
 const started=Date.now();
 await patiently(()=>handle({kind:'initialize',config:accepted,rpc:process.env.AGENT_STACKS_RPC,allowLocal:process.env.AGENT_STACKS_ALLOW_LOCAL==='1'}),error=>error.notYetVisible&&Date.now()-started<120_000);
 await patiently(settle);
 await patiently(()=>handle({kind:'cleanup-proof'}));
 await patiently(async()=>{
  const m=await client.match(accepted.match,accepted);if(policy.allowTestControls||m.phase===6||(m.phase===0&&seat===1))return;
  const short=await fundingShortfall(m,0);
  if(short)process.stderr.write(`Agent ${seat}: warning: balance ${short.balance} is below the ${short.required} lamports a full-proof fallback can need\n`);
 });
 for(let complete=false;!complete;){
  complete=await patiently(async()=>{
   await settle();const m=await client.match(accepted.match,accepted);
   if(m.phase===6){await step();respond({kind:'complete',payouts:m.payouts});return true;}
   if(await client.chainTime()>=m.deadline)await client.command(accepted.match,5,[],accepted.players.map(p=>({pubkey:new PublicKey(p),isSigner:false,isWritable:true})),null,m.version);
   else if(obligated(m)===seat||(m.phase===0&&seat===1))await handle({kind:'step'});
   else await pause(1000);
   return false;
  });
 }
}
