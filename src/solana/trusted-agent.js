// This backend trusts an explicitly selected, operator-controlled validating
// node. It is NOT a Solana light client or proof of honest RPC responses.
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {readPrivate,writePrivate} from '../private-files.js';
import {canonical} from '../crypto.js';
import {ChainClient,PublicKey,SystemProgram,termsHash,obligated,positions,PHYSICAL,shareContext} from './client.js';
import {deckHash} from './compact-shuffle.js';
import {proveDLEQ,encodeDLEQ} from '../mental-poker/proofs.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const ZERO='0'.repeat(64);
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const LEGACY='BPFLoader2111111111111111111111111111111111';
const COMPUTE='ComputeBudget111111111111111111111111111111';
const positive=n=>Number.isSafeInteger(n)&&n>0;
const heightText=/^[0-9]{1,20}$/;
const optional=(value,valid)=>value===undefined||value===null||valid(value);
const validExpiry=value=>typeof value==='string'&&heightText.test(value);
const LAMPORTS_PER_SIGNATURE=5000;
// A match can hold funds for many obligations, each up to one clock long.
const DEFAULT_MAX_TURN_SECONDS=86_400;
// A re-offer with a fresh blockhash needs a new signature for the same deck; beyond that, offers are noise.
const MAX_COSIGNATURES_PER_VERSION=5;
const validCosign=c=>!!c&&typeof c==='object'&&typeof c.version==='string'&&/^[0-9]{1,20}$/.test(c.version)&&typeof c.hash==='string'&&/^[a-f0-9]{64}$/.test(c.hash)&&Number.isSafeInteger(c.count)&&c.count>=0;
// One player's full-proof hand, measured at 703 transactions; rounded up for retries.
const STRICT_TRANSACTIONS_PER_HAND=710;
// The most a player can need if the opponent refuses to co-sign. Proof rent is refunded after each
// shuffle, so one buffer's worth covers every hand.
export const strictFundingRequired=({rent,buyIn,hands,maxFeePerTransaction})=>buyIn+rent+hands*STRICT_TRANSACTIONS_PER_HAND*maxFeePerTransaction;
const validBytes=value=>typeof value==='string'&&value.length<=2048&&/^[A-Za-z0-9+/]+={0,2}$/.test(value);
function endpoint(value,allowLocal){
 const u=new URL(value);const loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
 if(u.username||u.password||u.hash||!(u.protocol==='https:'||(allowLocal&&loopback&&u.protocol==='http:')))throw Error('Policy requires HTTPS or explicit loopback HTTP');
 return u.href;
}
export function validateTrustPolicy(p){
 if(p?.schema!=='agent-stacks/trusted-node/v1'||p.trust!=='operator-controlled-validator')throw Error('Explicit operator-controlled validator policy required');
 // Production support stays closed until the independent review/release gates.
 if(p.network!=='test-only')throw Error('Only test-only node policies are supported');
 new PublicKey(p.genesis);new PublicKey(p.program);
 if(typeof p.allowLocal!=='boolean'||typeof p.allowUpgradeable!=='boolean'||typeof p.allowTestControls!=='boolean'||typeof p.allowCooperative!=='boolean')throw Error('Policy flags must be explicit booleans');
 endpoint(p.rpc,p.allowLocal);if(p.submitRpc)endpoint(p.submitRpc,p.allowLocal);
 if(!/^[a-f0-9]{64}$/.test(p.programSha256)||!positive(p.programBytes)||p.programBytes>10_000_000)throw Error('Policy requires pinned program bytes and SHA-256');
 for(const name of ['maxBuyIn','maxHands','minTurnSeconds','maxTransactions','maxFeePerTransaction','maxTotalFees','maxAccountRent','maxTotalOutflow'])if(!positive(p[name]))throw Error(`Invalid policy limit: ${name}`);
 if(p.minTurnSeconds<3600)throw Error('Hardened agents require at least a one-hour turn window');
 if(p.maxTurnSeconds!==undefined&&(!positive(p.maxTurnSeconds)||p.maxTurnSeconds<p.minTurnSeconds))throw Error('Invalid policy limit: maxTurnSeconds');
 if(p.maxBigBlind!==undefined&&!positive(p.maxBigBlind))throw Error('Invalid policy limit: maxBigBlind');
 if(p.maxComputeUnitPrice!==undefined&&(!Number.isSafeInteger(p.maxComputeUnitPrice)||p.maxComputeUnitPrice<0))throw Error('Invalid policy limit: maxComputeUnitPrice');
 return Object.freeze(structuredClone(p));
}
export function loadTrustPolicy(file){
 if(!file)throw Error('Set AGENT_STACKS_TRUST_POLICY to an owner-only policy for your own validating node; relay-provided RPC settings are not trusted');
 return validateTrustPolicy(JSON.parse(readPrivate(resolve(file),'utf8')));
}
export function validateAcceptedMatch(policy,config,player){
 if(config.program!==policy.program||config.genesis!==policy.genesis||config.terms!==termsHash(config))throw Error('Accepted match does not match pinned node/program/terms');
 if(!Array.isArray(config.players)||config.players.length!==2||config.players[0]===config.players[1]||!config.players.includes(player))throw Error('Invalid accepted players');
 new PublicKey(config.match);config.players.forEach(p=>new PublicKey(p));
 if(!positive(config.buyIn)||config.buyIn>policy.maxBuyIn||!positive(config.maxHands??1)||(config.maxHands??1)>policy.maxHands||!positive(config.turnSeconds)||config.turnSeconds<policy.minTurnSeconds||config.turnSeconds>(policy.maxTurnSeconds??DEFAULT_MAX_TURN_SECONDS))throw Error('Accepted match exceeds stake/hand/deadline policy');
 if(!positive(config.bigBlind)||config.bigBlind%2!==0||config.bigBlind>Math.floor(config.buyIn/10)||config.bigBlind>(policy.maxBigBlind??Infinity))throw Error('Accepted match exceeds blind policy');
}
export async function verifyPinnedProgram(connection,policy){
 const program=new PublicKey(policy.program);
 const account=await connection.getAccountInfo(program,'finalized');
 if(!account?.executable)throw Error('Pinned program is not executable');
 let bytes=Buffer.from(account.data),authority=null;
 if(account.owner.toBase58()===LOADER){
  if(bytes.length!==36||bytes.readUInt32LE(0)!==2)throw Error('Invalid upgradeable Program account');
  const dataAddress=new PublicKey(bytes.subarray(4));
  const [expected]=await PublicKey.findProgramAddress([program.toBytes()],new PublicKey(LOADER));
  if(!expected.equals(dataAddress))throw Error('Unexpected ProgramData address');
  const data=await connection.getAccountInfo(dataAddress,'finalized');
  if(!data||data.owner.toBase58()!==LOADER||data.executable)throw Error('Invalid ProgramData owner');
  bytes=Buffer.from(data.data);
  if(bytes.length<45||bytes.readUInt32LE(0)!==3||![0,1].includes(bytes[12]))throw Error('Invalid ProgramData metadata');
  if(bytes[12]===1)authority=new PublicKey(bytes.subarray(13,45)).toBase58();
  if(authority&&!policy.allowUpgradeable)throw Error('Program still has an upgrade authority');
  bytes=bytes.subarray(45);
 }else if(account.owner.toBase58()!==LEGACY)throw Error('Unsupported program loader');
 if(bytes.length<policy.programBytes||hash(bytes.subarray(0,policy.programBytes))!==policy.programSha256||bytes.subarray(policy.programBytes).some(n=>n!==0))throw Error('Deployed program differs from pinned artifact');
 return {sha256:policy.programSha256,bytes:policy.programBytes,upgradeAuthority:authority};
}
function readRecord(path,fallback){try{return JSON.parse(readPrivate(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}

export class TrustedAgentGuard {
 constructor({policy,config,wallet,directory,client,journal=null}){
  this.policy=validateTrustPolicy(policy);this.config=structuredClone(config);this.wallet=wallet;this.client=client;this.journal=journal;
  validateAcceptedMatch(this.policy,this.config,wallet.publicKey.toBase58());
  this.seat=this.config.players.indexOf(wallet.publicKey.toBase58());
  this.binding=hash(canonical({policy:this.policy,match:this.config.match,terms:this.config.terms,player:wallet.publicKey.toBase58()}));
  this.file=resolve(directory,`${this.config.match}.guard.json`);
  this.record=readRecord(this.file,{schema:'agent-stacks/guard/v1',binding:this.binding,checkpoint:null,releases:{},budget:{transactions:0,fees:0,outflow:0,pending:null,pendingExpiry:null,pendingTransaction:null}});
  if(this.record.schema!=='agent-stacks/guard/v1'||this.record.binding!==this.binding)throw Error('Guard checkpoint belongs to another policy or match; do not reset it blindly');
  const b=this.record.budget;
  if(!b||['transactions','fees','outflow'].some(k=>!Number.isSafeInteger(b[k])||b[k]<0)||!(b.pending===null||(typeof b.pending==='string'&&b.pending.length>0&&b.pending.length<=128))||!optional(b.pendingExpiry,validExpiry)||!optional(b.pendingTransaction,validBytes)||!optional(b.cosign,validCosign)||!this.record.releases||typeof this.record.releases!=='object'||Array.isArray(this.record.releases)||Object.keys(this.record.releases).length>20)throw Error('Malformed guard recovery record');
  this.poisoned=false;
 }
 persist(next){
  if(this.poisoned)throw Error('Guard persistence failed; stop and reconcile before restarting');
  try{writePrivate(this.file,JSON.stringify(next));this.record=next;}catch(e){this.poisoned=true;throw e;}
 }
 async read(){
  if(this.poisoned)throw Error('Guard is stopped after persistence failure');
  await verifyPinnedProgram(this.client.connection,this.policy);
  const previous=this.record.checkpoint;
  const snapshot=await this.client.matchSnapshot(this.config.match,this.config,{minContextSlot:previous?.slot??0});
  return this.observe(snapshot);
 }
 observe({state:m,slot,hash:stateHash}){
  const old=this.record.checkpoint;
  if(!Number.isSafeInteger(slot)||slot<0||!Number.isSafeInteger(m.version)||m.version<0||!positive(m.handNo)||m.handNo>(this.config.maxHands??1)||!/^[a-f0-9]{64}$/.test(stateHash))throw Error('Malformed finalized checkpoint');
  if(old&&(slot<old.slot||m.version<old.version||m.handNo<old.handNo||m.handNo>old.handNo+1))throw Error('Finalized state rolled back or skipped hand recovery');
  if(old&&m.version===old.version&&stateHash!==old.hash)throw Error('Conflicting state at the same version');
  const same=old?.handNo===m.handNo;
  if(same)for(let s=0;s<2;s++)if(old.keys[s]!==ZERO&&old.keys[s]!==m.keys[s])throw Error('Registered hand key changed');
  const activeDeck=[5,7,8,9,10,11,12].includes(m.phase);
  const currentDeck=deckHash(m.deck);
  if(same&&old.deck&&currentDeck!==old.deck)throw Error('Accepted final deck changed');
  const next=structuredClone(this.record);
  if(!same)next.releases={};
  next.checkpoint={slot,version:m.version,handNo:m.handNo,hash:stateHash,keys:[...m.keys],deck:(same&&old.deck)||(activeDeck?currentDeck:null),viewHash:hash(canonical(m))};
  this.persist(next);
  return structuredClone(m);
 }
 assertView(m){if(!this.record.checkpoint||hash(canonical(m))!==this.record.checkpoint.viewHash)throw Error('State was not accepted by the share guard');}
 async share(m,key){
  if(this.record.budget.pending)throw Error('An earlier transaction is uncertain; reconcile before computing another share');
  this.assertView(m);
  if(![5,7,9,10,11,12].includes(m.phase)||obligated(m)!==this.seat)throw Error('No authorized share obligation');
  const logical=positions(m)[m.cursor];
  if(!Number.isInteger(logical)||logical<0||logical>8)throw Error('Invalid share cursor');
  const ownHole=logical<4&&logical%2===this.seat;
  if(ownHole&&!((this.seat===0&&m.phase===11)||(this.seat===1&&m.phase===12)))throw Error('Own hole card cannot be released before showdown');
  if(key.registration.publicKey!==m.keys[this.seat])throw Error('Private key does not match finalized registration');
  if(await this.client.chainTime()>=m.deadline){const error=Error('Share deadline has passed');error.retryable=true;throw error;}
  const cipher=m.deck[PHYSICAL[logical]];
  const context=shareContext(this.config.program,this.config.match,m.phase,this.seat,logical,this.config.terms,m.handNo);
  const release={version:m.version,phase:m.phase,logical,cipherHash:hash(canonical(cipher)),context};
  const id=`${m.handNo}/${m.phase}/${logical}`;
  const previous=this.record.releases[id];
  if(previous&&canonical(previous)!==canonical(release))throw Error('Conflicting share release after restart');
  // No secret-dependent multiplication happens until this decision is durable.
  const next=structuredClone(this.record);next.releases[id]=release;this.persist(next);
  const p=proveDLEQ(key.secret,cipher.a,context);
  return {logical,proof:encodeDLEQ(context,p.publicKey,cipher.a,p.share,p.proof)};
 }
 async authorize(tx){
  if(this.record.budget.pending)throw Error('An earlier transaction is uncertain; reconcile its original signature before signing again');
  const ownPayer=tx.feePayer?.equals(this.wallet.publicKey);
  const me=this.wallet.publicKey.toBase58();
  let outflow=0,protocolCount=0,cooperative=false,acceptance=null;
  for(const ix of tx.instructions){
   const program=ix.programId.toBase58(),d=Buffer.from(ix.data);
   if(program===this.config.program){
    protocolCount++;const tag=d[0];
    if(![2,3,5,8,9,10,11,12,13,14,15,16,17,18,19,20].includes(tag))throw Error('Instruction not allowed by agent policy');
    const key=index=>ix.keys[index]?.pubkey.toBase58();
    if(([2,3,5,13,14,15,18,20].includes(tag)&&key(0)!==this.config.match)||(tag===16&&key(2)!==this.config.match))throw Error('Transaction targets another match');
    if([8,9,10,11,12,16,17,19].includes(tag)&&key(1)!==me)throw Error('Buffer instructions must name this wallet as authority');
    if(tag===20&&key(2)!==me)throw Error('Payout claims may only pay this wallet');
    if(tag===2)outflow+=this.config.buyIn;
    if(tag===18){cooperative=true;acceptance=d;}
   }else if(program===SystemProgram.programId.toBase58()){
    if(d.length<12||!ix.keys[0]?.pubkey.equals(this.wallet.publicKey))throw Error('Invalid System Program debit');
    const tag=d.readUInt32LE(0),amount=Number(d.readBigUInt64LE(4));
    if(!Number.isSafeInteger(amount)||amount>this.policy.maxAccountRent)throw Error('Account rent exceeds policy');
    if(tag===0){if(d.length!==52||new PublicKey(d.subarray(20,52)).toBase58()!==this.config.program)throw Error('Unexpected account allocation');}
    else if(tag===2){if(!this.policy.allowTestControls||d.length!==12||ix.keys[1]?.pubkey.toBase58()!==this.config.players[0]||this.seat!==1)throw Error('Transfer is not an authorized test rent return');}
    else throw Error('System Program operation is not allowed');
    outflow+=amount;
   }else if(program===COMPUTE){
    const limit=d.length===5&&d[0]===2&&d.readUInt32LE(1)<=1_400_000;
    const price=d.length===9&&d[0]===3&&d.readBigUInt64LE(1)<=BigInt(this.policy.maxComputeUnitPrice??0);
    if(!limit&&!price)throw Error('Only bounded compute limits and policy-approved priority fees are permitted');
   }
   else throw Error('Unexpected transaction program');
  }
  if(tx.instructions.length===0||protocolCount>1||(!ownPayer&&(!cooperative||tx.instructions.length!==1||tx.feePayer?.toBase58()!==this.config.players[1-this.seat])))throw Error('Invalid signer/fee-payer boundary');
  if(cooperative&&!this.policy.allowCooperative)throw Error('Cooperative signing disabled by policy');
  const estimate=await this.client.connection.getFeeForMessage(await tx.compileMessage(),'confirmed');
  if(estimate.value===null){const error=Error('Blockhash expired before signing');error.retryable=true;throw error;}
  const fee=Number(estimate.value);
  if(!Number.isSafeInteger(fee)||fee<0||fee>this.policy.maxFeePerTransaction)throw Error('Transaction fee exceeds policy');
  const next=structuredClone(this.record),b=next.budget;
  if(ownPayer){b.transactions++;b.fees+=fee;b.outflow+=outflow;}
  else{
   // A counterparty pays for and submits this, so it spends nothing of ours and must not use up our
   // signing budget, or repeated offers could stop us from signing our own moves.
   if(acceptance.length<41)throw Error('Malformed deck acceptance');
   const version=acceptance.readBigUInt64LE(1).toString(),hash=acceptance.subarray(9,41).toString('hex');
   const previous=b.cosign?.version===version?b.cosign:{version,hash,count:0};
   if(previous.hash!==hash)throw Error('Already co-signed a different deck for this match version');
   if(previous.count>=MAX_COSIGNATURES_PER_VERSION)throw Error('Co-signature limit reached for this match version');
   b.cosign={...previous,count:previous.count+1};
  }
  if(b.transactions>this.policy.maxTransactions||b.fees>this.policy.maxTotalFees||b.outflow>this.policy.maxTotalOutflow)throw Error('Cumulative signing/fee/outflow budget exceeded');
  // Conservative reservation: failed signing and rejected transactions still
  // consume the budget. Recovery never silently resets these counters.
  this.persist(next);
  this.reservation=ownPayer?{fees:fee,outflow}:null;
 }
 // Returns the reservation for a transaction that failed simulation. Its bytes were never released,
 // so it cannot spend. Keeping it would let retries of one 4.54 SOL proof-account creation use up
 // the whole outflow budget and lock the agent even after it was funded. Anything released stays
 // consumed, and a crash before this runs also leaves it consumed.
 release(){
  if(!this.reservation)return;
  const next=structuredClone(this.record),b=next.budget;
  b.transactions--;b.fees-=this.reservation.fees;b.outflow-=this.reservation.outflow;
  this.reservation=null;this.persist(next);
 }
 transaction(signature,details){
  const next=structuredClone(this.record);
  if(details.status==='prepared'){
   if(next.budget.pending&&next.budget.pending!==signature)throw Error('A different transaction is already pending');
   this.reservation=null;
   next.budget.pending=signature;
   // Durable before transmission: everything recovery needs to prove this signature
   // dead, or to redeliver these exact bytes, survives a crash.
   next.budget.pendingExpiry=validExpiry(details.lastValidBlockHeight)?details.lastValidBlockHeight:null;
   next.budget.pendingTransaction=validBytes(details.transactionBase64)?details.transactionBase64:null;
  }else if(['confirmed','failed','expired'].includes(details.status)){
   if(next.budget.pending!==signature)throw Error('Transaction receipt does not match pending signature');
   next.budget.pending=null;next.budget.pendingExpiry=null;next.budget.pendingTransaction=null;
  }
  this.persist(next);
 }
 // Waits for the uncertain transaction to resolve from the trusted node, redelivering
 // its original bytes meanwhile. Bounded by the blockhash lifetime. A record without an
 // expiry height cannot be proven dead, so it stays with the operator (fail closed).
 async settlePending({pollMs=1000,onRpcFailure=()=>{}}={}){
  while(this.record.budget.pending){
   let result;
   try{result=await reconcilePending(this,{rebroadcast:true});}
   catch(error){if(!error.rpcFailure)throw error;onRpcFailure(error);await pause(pollMs);continue;}
   if(result.outcome!=='uncertain'){
    const details={status:RECEIPT[result.outcome],reconciled:true};
    this.transaction(result.signature,details);await this.journal?.(result.signature,details);
    return result;
   }
   if(!this.record.budget.pendingExpiry)throw Error('An earlier transaction is uncertain and has no recorded expiry; reconcile its original signature manually');
   await pause(pollMs);
  }
  return {pending:false};
 }
}

// Priced from recent fees on the accounts this transaction locks, and capped twice: by the policy's
// price ceiling and by what still fits under maxFeePerTransaction at this compute limit. Pricing
// is best effort, so a failed estimate sends without a fee instead of blocking an action.
export async function priorityPrice(connection,policy,instructions,feePayer,units){
 const ceiling=policy.maxComputeUnitPrice??0;if(!ceiling)return 0;
 try{
  const metas=instructions.flatMap(ix=>ix.keys);
  const writable=new Map([[feePayer.toBase58(),feePayer],...metas.filter(m=>m.isWritable).map(m=>[m.pubkey.toBase58(),m.pubkey])]);
  const signers=new Set([feePayer.toBase58(),...metas.filter(m=>m.isSigner).map(m=>m.pubkey.toBase58())]).size;
  const recent=await connection.getRecentPrioritizationFees({lockedWritableAccounts:[...writable.values()]});
  const fees=recent.map(r=>Number(r.prioritizationFee)).sort((a,b)=>a-b);
  const wanted=fees.length?fees[Math.floor(fees.length*0.75)]:0;
  const affordable=Math.floor((policy.maxFeePerTransaction-LAMPORTS_PER_SIGNATURE*signers)*1_000_000/units);
  return Math.max(0,Math.min(ceiling,wanted,affordable));
 }catch{return 0;}
}

export function trustedClient(policy,config,wallet,directory,onTransaction){
 let guard;
 const client=new ChainClient(policy.rpc,policy.program,wallet,{allowLocal:policy.allowLocal,commitment:'finalized',submitUrl:policy.submitRpc,
  authorizeTransaction:tx=>guard.authorize(tx),releaseAuthorization:()=>guard.release(),computeUnitPrice:(instructions,feePayer,units)=>priorityPrice(client.connection,policy,instructions,feePayer,units),onTransaction:async(s,d)=>{guard.transaction(s,d);await onTransaction(s,d);}});
 guard=new TrustedAgentGuard({policy,config,wallet,directory,client,journal:onTransaction});
 client.match=async(id,accepted)=>{if(id!==config.match||accepted?.terms!==config.terms)throw Error('Guard requires the accepted match');return guard.read();};
 return {client,guard};
}

const RECEIPT={succeeded:'confirmed',failed:'failed',expired:'expired'};
// Best effort, and only ever the original signed bytes. The trusted node is also tried
// so that a relay withholding transmission cannot strand a transaction.
async function redeliver(client,raw){
 const bytes=Buffer.from(raw,'base64');
 for(const connection of new Set([client.submissionConnection,client.connection].filter(Boolean))){
  try{await connection.sendRawTransaction(bytes,{skipPreflight:true,maxRetries:0});}catch{/* the next poll re-checks */}
 }
}
// A transaction can only land at or below its lastValidBlockHeight. Once finalized height
// has passed that with no receipt, it can never land. Height is read BEFORE status, so a
// transaction that landed cannot be missed in the gap between the two reads. This relies
// on the node retaining transaction history for that window. Even if it did not, a wrong
// "expired" cannot double-apply: every instruction this agent signs is bound to the match
// version, an upload offset or a verification round, and test transfers keep their own
// transferOnce marker. Budgets stay consumed either way.
export async function reconcilePending(guard,{apply=false,rebroadcast=false}={}){
 const {pending:signature,pendingExpiry:expiry,pendingTransaction:raw}=guard.record.budget;
 if(!signature)return {pending:false};
 const connection=guard.client.connection;
 const height=expiry?BigInt(await connection.getBlockHeight('finalized')):null;
 const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
 const final=status?.confirmationStatus==='finalized';
 const expired=!status&&height!==null&&height>BigInt(expiry);
 const outcome=final?(status.err?'failed':'succeeded'):expired?'expired':'uncertain';
 const result={pending:true,signature,finalized:!!final,outcome,applied:false};
 if(outcome==='uncertain'&&rebroadcast&&raw)await redeliver(guard.client,raw);
 if(apply){
  if(outcome==='uncertain')throw Error('No finalized receipt and its blockhash has not provably expired; pending transaction remains blocked. Do not create a replacement payment.');
  guard.transaction(signature,{status:RECEIPT[outcome]});result.applied=true;
 }
 return result;
}
