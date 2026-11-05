// The channel instructions in programs/escrow/src/channel.rs, and reading a channel account back.
import {createHash} from 'node:crypto';
import {PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {getBase58Encoder} from '@solana/kit';
import {u32,u64} from '../solana/client.js';
import {decodeGame,decodeHand,encodeGame,BLOB_BYTES,KIND_CLOSE,KIND_HAND,KIND_STACKS} from './engine.js';
import {fromHex,toHex} from './wire.js';
export const CHANNEL_SPACE=4341,BUFFER_SPACE=76+BLOB_BYTES,OPEN=20,EXIT=21,WAITING=0,COMPLETE=6;
const SESSIONS=4260,SEQ=SESSIONS+64,WINDOW=SEQ+8,AGGRESSOR=WINDOW+8,CURSOR=4251,HAND=4252,GAME=3586,SHARES=3675,DECK=250;
const PHYSICAL=[0,1,2,3,5,6,7,9,11];
export const ED25519=new PublicKey('Ed25519SigVerify111111111111111111111111111');
export const INSTRUCTIONS=new PublicKey('Sysvar1nstructions1111111111111111111111111');
// Must match terms_hash in channel.rs. The contract computes this from what it stores, and a joiner sends
// what it computes here, so a creator can't store different terms from the ones the joiner accepted.
export function channelTerms(c){
 const key=value=>Buffer.from(new PublicKey(value).toBytes());
 return createHash('sha256').update(Buffer.concat([Buffer.from('agent-stacks/channel/terms/v1'),key(c.program),key(c.players[0]),key(c.players[1]),key(c.genesis),u64(c.buyIn),u32(c.turnSeconds),u64(c.bigBlind),u32(c.maxHands),fromHex(c.sessions[0],32),fromHex(c.sessions[1],32)])).digest('hex');
}
export function channelAddress(program,creator,nonce){return PublicKey.findProgramAddress([Buffer.from('channel'),new PublicKey(creator).toBytes(),nonce],new PublicKey(program));}
// A manifest is public terms. These are the same terms as bytes, ready for signing.
export function withBytes(manifest){return {...manifest,programBytes:Buffer.from(new PublicKey(manifest.program).toBytes()),matchBytes:Buffer.from(new PublicKey(manifest.match).toBytes()),termsBytes:fromHex(manifest.terms,32)};}
export function decodeChannel(b){
 if(b.length===8&&b.toString()==='ASTKEND5')return {retired:true,phase:COMPLETE};
 if(b.length!==CHANNEL_SPACE||b.subarray(0,8).toString()!=='ASTKCHN1')throw Error('Not a channel account');
 const n=at=>Number(b.readBigUInt64LE(at));
 return {phase:b[8],version:n(9),players:[new PublicKey(b.subarray(17,49)).toBase58(),new PublicKey(b.subarray(49,81)).toBase58()],buyIn:n(81),turnSeconds:n(89),deadline:Number(b.readBigInt64LE(97)),terms:b.subarray(105,137).toString('hex'),payouts:[n(201),n(209)],sessions:[b.subarray(SESSIONS,SESSIONS+32).toString('hex'),b.subarray(SESSIONS+32,SESSIONS+64).toString('hex')],seq:n(SEQ),window:Number(b.readBigInt64LE(WINDOW)),hand:b.readUInt32LE(HAND),cursor:b[CURSOR],pendingPayouts:b[8]===COMPLETE?b[CURSOR]:0,game:decodeGame(b.subarray(GAME,GAME+89)),nonce:b.subarray(217,249),bump:b[249]};
}
// The hand state the account holds, in the bytes both players sign.
export function accountBlob(b){
 const out=Buffer.alloc(BLOB_BYTES);out[0]=b[8]===EXIT?COMPLETE:b[8];out[1]=b[CURSOR];b.copy(out,2,HAND,HAND+4);b.copy(out,6,137,201);
 PHYSICAL.forEach((p,i)=>b.copy(out,70+i*64,DECK+p*64,DECK+p*64+64));
 b.copy(out,646,GAME,GAME+89);b.copy(out,735,SHARES,SHARES+576);out[1311]=b[AGGRESSOR];
 return out;
}
export function ed25519Instruction(entries){
 const start=2+entries.length*14,offsets=[],body=[];let at=start;
 for(const {publicKey,signature,message} of entries){
  const keyAt=at,sigAt=keyAt+32,messageAt=sigAt+64;
  for(const field of [sigAt,0xffff,keyAt,0xffff,messageAt,message.length,0xffff]){const b=Buffer.alloc(2);b.writeUInt16LE(field);offsets.push(b);}
  body.push(publicKey,signature,message);at=messageAt+message.length;
 }
 return new TransactionInstruction({programId:ED25519,keys:[],data:Buffer.concat([Buffer.from([entries.length,0]),...offsets,...body])});
}
const meta=(pubkey,isSigner=false,isWritable=false)=>({pubkey:pubkey instanceof PublicKey?pubkey:new PublicKey(pubkey),isSigner,isWritable});
const UPLOAD=900,UNITS=400_000;
export class ChannelChain{
 constructor(client,config,{log=()=>{}}={}){this.client=client;this.config=config;this.keys=config.sessions.map(k=>fromHex(k,32));this.match=new PublicKey(config.match);this.log=log;}
 get me(){return this.client.wallet.publicKey;}
 ix(tag,args,accounts){return this.client.instruction(tag,args,accounts);}
 wallets(){return this.config.players.map(p=>meta(p,false,true));}
 async readRaw(){
  const info=await this.client.connection.getAccountInfo(this.match,'confirmed');
  if(!info)return null;
  if(!info.owner.equals(this.client.program))throw Error('Match is not owned by the expected program');
  return Buffer.from(info.data);
 }
 async read(){
  const raw=await this.readRaw();if(!raw)return null;
  const state=decodeChannel(raw);
  if(state.retired)return state;
  if(state.terms!==this.config.terms)throw Error('On-chain terms differ from the accepted terms');
  return {...state,blob:accountBlob(raw)};
 }
 chainTime(){return this.client.chainTime();}
 twoSigned(signed,sigs){
  return ed25519Instruction([0,1].map(seat=>({publicKey:this.keys[seat],signature:fromHex(sigs[seat],64),message:signed})));
 }
 async close(signed,proof){
  return this.client.send([this.twoSigned(signed,proof.sigs),this.ix(33,[u64(proof.seq),u64(proof.stacks[0]),u64(proof.stacks[1])],[meta(this.match,false,true),...this.wallets(),meta(INSTRUCTIONS)])],[],UNITS);
 }
 async exitWithDeposits(){
  return this.client.send([this.ix(34,[u64(0),u32(1),u64(this.config.buyIn),u64(this.config.buyIn)],[meta(this.match,false,true),meta(this.me,true),meta(INSTRUCTIONS)])],[],UNITS);
 }
 async postStacks(signed,seq,payload,sigs){
  return this.client.send([this.twoSigned(signed,sigs),this.ix(34,[u64(seq),payload],[meta(this.match,false,true),meta(this.me,true),meta(INSTRUCTIONS)])],[],UNITS);
 }
 // A hand state doesn't fit in one transaction, so it goes through a buffer whose rent comes back.
 async postHand(signed,seq,payload,sigs,bufferKey){
  const metas=[meta(bufferKey.publicKey,false,true),meta(this.me,true,true)];
  const existing=await this.client.connection.getAccountInfo(bufferKey.publicKey,'confirmed');
  // A buffer's address is public once used, and anyone can send it a little SOL, which makes it unusable.
  if(existing&&!existing.owner.equals(this.client.program)){const error=Error('This buffer address is blocked');error.bufferBlocked=true;throw error;}
  if(!existing){
   const lamports=await this.client.connection.getMinimumBalanceForRentExemption(BUFFER_SPACE);
   await this.client.send([SystemProgram.createAccount({fromPubkey:this.me,newAccountPubkey:bufferKey.publicKey,lamports,space:BigInt(BUFFER_SPACE),programId:this.client.program}),this.ix(35,[],[{...metas[0],isSigner:true},metas[1],meta(this.match)])],[bufferKey]);
  }
  const current=Buffer.from((await this.client.connection.getAccountInfo(bufferKey.publicKey,'confirmed')).data);
  let written=current.readUInt32LE(72);
  if(!current.subarray(76,76+written).equals(payload.subarray(0,written))){const error=Error('This buffer holds another state');error.bufferBlocked=true;throw error;}
  while(written<payload.length){
   const chunk=payload.subarray(written,written+UPLOAD);
   await this.client.send([this.ix(36,[u32(written),chunk],metas)]);written+=chunk.length;
  }
  return this.client.send([this.twoSigned(signed,sigs),this.ix(38,[u64(seq)],[meta(this.match,false,true),meta(this.me,true),meta(bufferKey.publicKey),meta(INSTRUCTIONS)])],[],UNITS);
 }
 // Returns a buffer's rent. Harmless if it's already gone.
 async closeBuffer(bufferKey){
  const existing=await this.client.connection.getAccountInfo(bufferKey.publicKey,'confirmed');
  if(!existing||!existing.owner.equals(this.client.program))return null;
  return this.client.send([this.ix(37,[],[meta(bufferKey.publicKey,false,true),meta(this.me,true,true)])]);
 }
 async move(seat,chainSeq,step,message,signature){
  const signed=ed25519Instruction([{publicKey:this.keys[seat],signature,message}]);
  const accounts=[meta(this.match,false,true),meta(this.me,true),meta(INSTRUCTIONS)];
  const [tag,args]=step.muck===true?[45,[u64(chainSeq)]]:step.logical!==undefined?[40,[u64(chainSeq),Buffer.from([step.logical]),fromHex(step.wire)]]:[39,[u64(chainSeq),Buffer.from([step.action]),u64(step.amount??0)]];
  return this.client.send([signed,this.ix(tag,args,accounts)],[],UNITS);
 }
 async timeout(){return this.client.send([this.ix(41,[],[meta(this.match,false,true),...this.wallets()])],[],UNITS);}
 async proveFork(evidence,firstMessage,secondMessage){
  const key=this.keys[evidence.seat];
  const signed=ed25519Instruction([{publicKey:key,signature:fromHex(evidence.first.sig,64),message:firstMessage},{publicKey:key,signature:fromHex(evidence.second.sig,64),message:secondMessage}]);
  return this.client.send([signed,this.ix(42,[Buffer.from([evidence.seat]),u64(evidence.seq),Buffer.from([evidence.first.kind]),fromHex(evidence.first.hash,32),Buffer.from([evidence.second.kind]),fromHex(evidence.second.hash,32)],[meta(this.match,false,true),...this.wallets(),meta(INSTRUCTIONS)])],[],UNITS);
 }
 // The moves an opponent made on chain, from public transactions. Nothing here is believed yet: the
 // agent verifies each signature against its own engine before it acts on any of them.
 // History comes newest first, and a transaction never changes, so only what's new is fetched. On a
 // rate-limited RPC, fetching the whole history every time could take longer than a move's clock.
 async onChainMoves(afterSeq){
  const moves=new Map(),signatures=await this.client.connection.getSignaturesForAddress(this.match,{limit:200},'confirmed');
  this.fetched??=new Map();
  for(const item of signatures){
   if(item.err)continue;
   let found=this.fetched.get(item.signature);
   if(!found){
    const tx=await this.client.connection.getTransaction(item.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
    if(!tx?.transaction?.message)continue;
    found=this.movesIn(tx);this.fetched.set(item.signature,found);
   }
   for(const move of found)if(move.seq>afterSeq&&!moves.has(move.seq))moves.set(move.seq,move);
   if(found.some(move=>move.seq<=afterSeq))break;
  }
  return moves;
 }
 movesIn(tx){
  const message=tx.transaction.message,found=[];
  const keys=(message.accountKeys??message.staticAccountKeys).map(k=>k.toString());
  const instructions=message.instructions??message.compiledInstructions;
  const bytes=ix=>typeof ix.data==='string'?Buffer.from(getBase58Encoder().encode(ix.data)):Buffer.from(ix.data);
  instructions.forEach((ix,i)=>{
   if(keys[ix.programIdIndex]!==this.client.program.toBase58())return;
   const data=bytes(ix);
   if(![39,40,45].includes(data[0])||data.length<9||i===0)return;
   const before=instructions[i-1],signedData=bytes(before);
   if(keys[before.programIdIndex]!==ED25519.toBase58()||signedData.length<16)return;
   const signature=signedData.subarray(signedData.readUInt16LE(2),signedData.readUInt16LE(2)+64);
   const step=data[0]===45?{muck:true}:data[0]===39?{action:data[9],amount:Number(data.readBigUInt64LE(10))}:{logical:data[9],wire:toHex(data.subarray(10))};
   found.push({seq:Number(data.readBigUInt64LE(1))+1,step,signature:Buffer.from(signature)});
  });
  return found;
 }
}
export {decodeHand,encodeGame,KIND_CLOSE,KIND_HAND,KIND_STACKS};
