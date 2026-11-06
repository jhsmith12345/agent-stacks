import { Connection,PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram,Keypair,VersionedTransaction } from '@solana/web3.js';
import { readPrivate, writePrivate } from '../private-files.js';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import {getBase58Decoder} from '@solana/kit';
import { canonical } from '../crypto.js';
export {PublicKey,Keypair,SystemProgram};
export const DEVNET='https://api.devnet.solana.com';
export const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const LOOPBACK=['127.0.0.1','localhost','[::1]'];
// Hosted RPC URLs usually carry an API key in the path or query, so logs and receipts get this form.
export const redactRpc=url=>{const u=new URL(url);return `${u.protocol}//${u.host}${u.pathname==='/'&&!u.search?'':'/…'}`;};
// A manifest goes to the other player. Only endpoints with nothing private in them may travel with it.
export const manifestRpc=url=>{const u=new URL(url);return (url===DEVNET||LOOPBACK.includes(u.hostname))&&u.pathname==='/'&&!u.search?{rpc:url}:{};};
export const LAYOUT={size:4260,deck:250,deckEnd:3578,blind:3578,game:3586,shares:3675,cursor:4251,hand:4252,maxHands:4256};
export async function loadWallet(file){const bytes=JSON.parse(readPrivate(file,'utf8'));if(!Array.isArray(bytes)||bytes.length!==64||bytes.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error('Invalid wallet secret encoding');return Keypair.fromSecretKey(Uint8Array.from(bytes));}
export async function ensureWallet(file){try{return await loadWallet(file);}catch(error){if(error.code!=='ENOENT')throw error;}const key=await Keypair.generate();try{writePrivate(file,JSON.stringify([...key.secretKey]),{exclusive:true});}catch(error){if(error.code!=='EEXIST')throw error;}return loadWallet(file);}
export const u64=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('Expected safe unsigned integer');const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
export const u32=n=>{if(!Number.isInteger(n)||n<0||n>0xffffffff)throw Error('Expected u32');const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
export const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const number=(b,i)=>{const n=b.readBigUInt64LE(i);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Unsafe u64');return Number(n);};
export function keyContext(program,match,seat,terms,hand=1){return `agent-stacks/escrow/key/v2/${program}/${match}/${hand}/${seat}/${terms}`;}
export function shuffleContext(program,match,seat,terms,hand=1){return `agent-stacks/escrow/shuffle/v3/${program}/${match}/${hand}/${seat}/${terms}`;}
export function shareContext(program,match,phase,seat,position,terms,hand=1){return `agent-stacks/escrow/share/v2/${program}/${match}/${hand}/${phase}/${seat}/${position}/${terms}`;}
export function termsHash(config){return createHash('sha256').update(canonical({protocol:'agent-stacks/escrow/v5',genesis:config.genesis??DEVNET_GENESIS,program:config.program,players:config.players,buyIn:config.buyIn,bigBlind:config.bigBlind,turnSeconds:config.turnSeconds,handLimit:config.maxHands??1})).digest('hex');}
export function decodeMatch(b){
 if(b.length===8&&b.toString()==='ASTKEND5')throw Error('Match address is permanently retired; create a new match nonce');
 if(b.length!==LAYOUT.size||b.subarray(0,8).toString()!=='ASTKESC5')throw Error('Unsupported escrow layout');
 const g=LAYOUT.game;
 return {pendingPayouts:b[8]===6?b[LAYOUT.cursor]:0,handNo:b.readUInt32LE(LAYOUT.hand),maxHands:b.readUInt32LE(LAYOUT.maxHands),phase:b[8],version:number(b,9),players:[new PublicKey(b.subarray(17,49)).toBase58(),new PublicKey(b.subarray(49,81)).toBase58()],buyIn:number(b,81),turnSeconds:number(b,89),deadline:Number(b.readBigInt64LE(97)),terms:b.subarray(105,137).toString('hex'),keys:[b.subarray(137,169).toString('hex'),b.subarray(169,201).toString('hex')],payouts:[number(b,201),number(b,209)],nonce:b.subarray(217,249),bump:b[249],bigBlind:number(b,LAYOUT.blind),deck:Array.from({length:52},(_,i)=>({a:b.subarray(250+i*64,282+i*64).toString('hex'),b:b.subarray(282+i*64,314+i*64).toString('hex')})),game:{stacks:[number(b,g),number(b,g+8)],bets:[number(b,g+16),number(b,g+24)],contributed:[number(b,g+32),number(b,g+40)],currentBet:number(b,g+48),minRaise:number(b,g+56),bigBlind:number(b,g+64),actor:b[g+72],street:b[g+75],stage:b[g+76],button:b[g+77],winner:b[g+78],reason:b[g+79],board:[...b.subarray(g+80,g+85)],holes:[[...b.subarray(g+85,g+87)],[...b.subarray(g+87,g+89)]]},shares:Array.from({length:9},(_,i)=>[b.subarray(LAYOUT.shares+i*64,LAYOUT.shares+i*64+32).toString('hex'),b.subarray(LAYOUT.shares+i*64+32,LAYOUT.shares+i*64+64).toString('hex')]),cursor:b[LAYOUT.cursor]};
}
export function obligated(m){if([1,3,7,9,11].includes(m.phase))return 0;if([2,4,5,10,12].includes(m.phase))return 1;if(m.phase===8)return m.game.actor;return null;}
export function positions(m){if([5,11].includes(m.phase))return [0,2];if([7,12].includes(m.phase))return [1,3];if([9,10].includes(m.phase)){if(m.game.street===1)return [4,5,6];if(m.game.street===2)return [7];if(m.game.street===3)return [8];throw Error('Invalid board street');}throw Error('No card-share obligation');}
export const PHYSICAL=[0,1,2,3,5,6,7,9,11];
const DEFAULT_COMPUTE_UNITS=200_000;
// For read-only tools that make many requests in a row: one refused request says little about a node,
// so look again before giving up. Only RPC failures are retried, and a slot the node hasn't reached is an
// answer, not a failure.
export function patientConnection(connection,{tries=4,firstPauseMs=500}={}){
 return new Proxy(connection,{get(target,key){
  const method=target[key];if(typeof method!=='function')return method;
  return async(...args)=>{for(let attempt=0;;attempt++){try{return await method.apply(target,args);}catch(error){if(!error.rpcFailure||attempt>=tries||/-32016|context slot/i.test(`${error.code} ${error.message}`))throw error;await setTimeout(firstPauseMs*2**attempt);}}};
 }});
}
// Every failure from the RPC layer is tagged, so a caller can retry it without guessing from error
// text and cannot mistake it for a security check failing. Requests are time-limited because a node
// that never answers would otherwise stall an agent past its deadline.
function rpcConnection(url,commitment,timeoutMs){
 const connection=new Connection(url,{commitment,fetch:(target,options)=>fetch(target,{...options,signal:AbortSignal.timeout(timeoutMs)})});
 return new Proxy(connection,{get(target,key){
  const value=target[key];if(typeof value!=='function')return value;
  return (...args)=>{
   const result=value.apply(target,args);
   return typeof result?.then==='function'?result.catch(error=>{error.rpcFailure=true;throw error;}):result;
  };
 }});
}
const isLocal=url=>['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname);
// The RPC client returns numbers inside a transaction's error as BigInts, which JSON can't write.
export const readable=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
export class ChainClient {
 constructor(url,program,wallet,{allowLocal=false,onTransaction=()=>{},commitment='confirmed',submitUrl=null,authorizeTransaction=async()=>{},releaseAuthorization=async()=>{},computeUnitPrice=async()=>0,rpcTimeoutMs=30_000,confirmMs=null}={}){this.url=url;this.confirmMs=confirmMs;this.program=program instanceof PublicKey?program:new PublicKey(program);this.wallet=wallet;this.allowLocal=allowLocal;this.commitment=commitment;this.connection=rpcConnection(url,commitment,rpcTimeoutMs);this.submissionConnection=submitUrl?rpcConnection(submitUrl,commitment,rpcTimeoutMs):null;this.authorizeTransaction=authorizeTransaction;this.releaseAuthorization=releaseAuthorization;this.computeUnitPrice=computeUnitPrice;this.onTransaction=onTransaction;this.networkChecked=false;}
 async checkNetwork(){const url=new URL(this.url);const local=isLocal(this.url);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&this.allowLocal&&local))throw Error('RPC requires HTTPS; HTTP is allowed only for an explicit local validator');const genesis=await this.connection.getGenesisHash();if(genesis!==DEVNET_GENESIS&&!(this.allowLocal&&local))throw Error('Refusing non-devnet RPC. Local validator requires explicit allowLocal.');this.genesis=genesis;this.networkChecked=true;return genesis;}
 async validateMatch(id,info,config){const address=new PublicKey(id);if(!info){const error=Error(`Match ${id} is not visible at ${this.commitment} commitment yet; if it was just created, wait for it to finalize`);error.notYetVisible=true;throw error;}if(!info.owner.equals(this.program))throw Error('Match not owned by expected program');const m=decodeMatch(Buffer.from(info.data));const [pda,bump]=await PublicKey.findProgramAddress([Buffer.from('escrow'),new PublicKey(m.players[0]).toBytes(),m.nonce],this.program);if(!pda.equals(address)||bump!==m.bump)throw Error('Invalid match PDA');if(config&&(config.genesis!==this.genesis||config.program!==this.program.toBase58()||config.match!==address.toBase58()||config.terms!==termsHash(config)||m.terms!==config.terms||m.buyIn!==config.buyIn||m.turnSeconds!==config.turnSeconds||m.bigBlind!==config.bigBlind||m.maxHands!==(config.maxHands??1)||JSON.stringify(m.players)!==JSON.stringify(config.players)))throw Error('On-chain terms differ from accepted configuration');return m;}
 async match(id,config=null){if(!this.networkChecked)await this.checkNetwork();return this.validateMatch(id,await this.connection.getAccountInfo(new PublicKey(id),this.commitment),config);}
 async matchSnapshot(id,config,{minContextSlot=0}={}){
  if(!this.networkChecked)await this.checkNetwork();
  const result=await this.connection.getAccountInfoAndContext(new PublicKey(id),{commitment:'finalized',minContextSlot});
  const slot=Number(result.context.slot);if(!Number.isSafeInteger(slot)||slot<minContextSlot)throw Error('Invalid or regressed finalized slot');
  const state=await this.validateMatch(id,result.value,config);
  return {state,slot,hash:createHash('sha256').update(result.value.data).digest('hex')};
 }
 async chainTime(){
  if(!this.networkChecked)await this.checkNetwork();
  const info=await this.connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'),this.commitment);
  if(!info||info.owner.toBase58()!=='Sysvar1111111111111111111111111111111111111'||info.data.length!==40)throw Error('Invalid chain Clock account');
  const seconds=Number(Buffer.from(info.data).readBigInt64LE(32));if(!Number.isSafeInteger(seconds))throw Error('Invalid chain timestamp');return seconds;
 }
 instruction(tag,args,accounts){return new TransactionInstruction({programId:this.program,data:Buffer.concat([Buffer.from([tag]),...args]),keys:accounts});}
 async send(instructions,extraSigners=[],units=null,{confirmation=this.commitment}={}){
  if(!this.networkChecked)await this.checkNetwork();const latest=await this.connection.getLatestBlockhash('confirmed');
  const tx=new Transaction({feePayer:this.wallet.publicKey,...latest}),limit=units??DEFAULT_COMPUTE_UNITS;
  // A priority fee is charged on the requested limit, so a price always comes with an explicit one.
  const price=await this.computeUnitPrice(instructions,this.wallet.publicKey,limit);
  if(units||price)tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:limit}));
  if(price)tx.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports:price}));
  tx.add(...instructions);await this.authorizeTransaction(tx);await tx.sign(this.wallet,...extraSigners);
  return this.submit(tx,{confirmation});
 }
 // Runs before anything is recorded or handed to a relay. A rejection here means
 // these bytes were never released, so there is nothing uncertain to reconcile.
 // Processed state is used because a prior step may be confirmed but not yet
 // visible in the node's confirmed bank; on-chain execution remains authoritative.
 async simulate(bytes){
  const {value}=await this.connection.simulateTransaction(VersionedTransaction.deserialize(bytes),{sigVerify:true,replaceRecentBlockhash:false,commitment:'processed'});
  if(value.err)throw new Error(`Transaction rejected in simulation and not sent: ${readable(value.err)}`);
 }
 async submit(tx,{confirmation=this.commitment}={}){
  if(!this.networkChecked)await this.checkNetwork();
  if(!tx.feePayer?.equals(this.wallet.publicKey))throw Error('Unexpected transaction fee payer');
  let bytes;
  try{bytes=await tx.serialize();if(bytes.length>1232)throw Error(`Transaction is ${bytes.length} bytes, exceeds packet limit`);}
  catch(error){await this.releaseAuthorization(tx);throw error;}
  try{await this.simulate(bytes);}
  catch(error){error.notSent=true;await this.releaseAuthorization(tx);throw error;}
  // Persist/inspect the original signature on uncertainty; never silently re-sign an action.
  const sig=getBase58Decoder().decode(tx.signature);
  await this.onTransaction(sig,{status:'prepared',blockhash:tx.recentBlockhash,lastValidBlockHeight:String(tx.lastValidBlockHeight),transactionBase64:Buffer.from(bytes).toString('base64')});
  try {
  const sender=this.submissionConnection??this.connection;
  // Already simulated against the trusted node; a relay's own preflight adds only false failures.
  await sender.sendRawTransaction(bytes,{skipPreflight:true,maxRetries:3});
  const final=confirmation==='finalized';
  // Public RPCs allow a method only a few calls a second per address, and players at home can share an address.
  // Going over costs far more than waiting: it's refused for 10 seconds, and the RPC library's retries don't wait that long.
  const interval=isLocal(this.url)?25:1000;
  // The limit is on time, not on polls, because a single refused poll can spend many seconds inside the RPC library.
  // Giving up here is safe, since the caller reads the chain and carries on, and a move's clock is running.
  const deadline=Date.now()+(this.confirmMs??(final?60_000:32_000));
  let resent=Date.now();
  while(Date.now()<deadline){
   // A failed poll says nothing about the transaction, so it must not abandon a healthy send.
   let status=null;
   try{status=(await this.connection.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];}
   catch(error){if(!error.rpcFailure)throw error;}
   const settled=status&&(final?status.confirmationStatus==='finalized':['confirmed','finalized'].includes(status.confirmationStatus));
   if(settled&&status.err){const reason=readable(status.err);await this.onTransaction(sig,{status:'failed',error:JSON.parse(reason)});throw Error(`Transaction ${sig} failed: ${reason}`);}
   if(settled){await this.onTransaction(sig,{status:'confirmed'});return sig;}
   if(Date.now()-resent>=3_000){resent=Date.now();await sender.sendRawTransaction(bytes,{skipPreflight:true,maxRetries:0}).catch(error=>{if(!error.rpcFailure)throw error;});}
   await setTimeout(interval);
  }
  const error=new Error(`Confirmation uncertain for ${sig}; inspect signature and current state before retrying`);error.signature=sig;throw error;
  } catch(error) {if(!error.signature)error.signature=sig;throw error;}
 }
 // Creator-only housekeeping. The protected agent never sends these: cancelling and retiring a match
 // are operator decisions, and retiring is permanent.
 async creatorCommand(id,tag,check){
  const m=await this.match(id);
  if(m.players[0]!==this.wallet.publicKey.toBase58())throw Error('Only the match creator can do this');
  check(m);
  return this.command(id,tag,[],[{pubkey:this.wallet.publicKey,isSigner:true,isWritable:true}],null,m.version);
 }
 cancelInvitation(id){return this.creatorCommand(id,6,m=>{if(m.phase!==0)throw Error('Only an invitation nobody has joined can be cancelled');});}
 closeMatch(id){return this.creatorCommand(id,7,m=>{if(m.phase!==6)throw Error('Only a completed match can be closed');if(m.pendingPayouts)throw Error('Payout claims are still outstanding');});}
 async command(match,tag,args=[],extra=[],units=null,expectedVersion=null){const version=expectedVersion??(await this.match(match)).version;return this.send([this.instruction(tag,[u64(version),...args],[{pubkey:new PublicKey(match),isSigner:false,isWritable:true},...extra])],[],units);}
}
