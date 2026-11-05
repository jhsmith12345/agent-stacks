import {ask} from '../src/solana/agent-messages.js';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
import {ChainClient,DEVNET,ensureWallet,PublicKey,SystemProgram,u64,u32,termsHash,obligated} from '../src/solana/client.js';
import {writePrivate,appendPrivate,transferOnce,privateDirectory} from '../src/private-files.js';
import {loadTrustPolicy,verifyPinnedProgram} from '../src/solana/trusted-agent.js';
const directory=resolve('.agent-stacks/devnet');mkdirSync(resolve(directory,'matches'),{recursive:true,mode:0o700});
privateDirectory(directory);
const payerFile=resolve(directory,'payer-keypair.json'),programFile=resolve(directory,'program-keypair.json');
const payer=await ensureWallet(payerFile),program=await ensureWallet(programFile);
const cooperative=process.env.AGENT_STACKS_COOPERATIVE_SHUFFLE==='1';
const rpc=process.env.AGENT_STACKS_RPC??DEVNET,allowLocal=process.env.AGENT_STACKS_ALLOW_LOCAL==='1';
const policy=loadTrustPolicy(process.env.AGENT_STACKS_TRUST_POLICY);
if(new URL(rpc).href!==new URL(policy.rpc).href||program.publicKey.toBase58()!==policy.program)throw Error('Demo RPC/program must match the operator trust policy');
const client=new ChainClient(rpc,program.publicKey,payer,{allowLocal,commitment:'finalized',onTransaction:(signature,d)=>appendPrivate(resolve(directory,'transactions.ndjson'),JSON.stringify({at:new Date().toISOString(),signature,...d})+'\n')});
if(await client.checkNetwork()!==policy.genesis)throw Error('Demo genesis does not match trust policy');
await verifyPinnedProgram(client.connection,policy);
const children=[fork(new URL('./chain-agent.js',import.meta.url),[payerFile,resolve(directory,'agent-a')],{stdio:['ignore','ignore','inherit','ipc']}),fork(new URL('./chain-agent.js',import.meta.url),[resolve(directory,'agent-b-keypair.json'),resolve(directory,'agent-b')],{stdio:['ignore','ignore','inherit','ipc']})];

async function fund(publicKey,minimum,operation){const balance=Number(await client.connection.getBalance(publicKey,'confirmed'));if(balance>=minimum)return;const delta=minimum-balance;const available=Number(await client.connection.getBalance(payer.publicKey,'confirmed'));if(available<delta+10_000_000)throw Error(`Need additional devnet test funding at ${payer.publicKey.toBase58()}`);await transferOnce(resolve(directory,'funding',`${operation}.json`),{recipient:publicKey.toBase58(),lamports:String(delta)},()=>client.send([SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:publicKey,lamports:BigInt(delta)})]));}
try{
 const identities=await Promise.all(children.map(async c=>(await once(c,'message'))[0].player));
 const resumeIndex=process.argv.indexOf('--resume');let config,manifest;
 if(resumeIndex>=0){manifest=resolve(process.argv[resumeIndex+1]);config=JSON.parse(readFileSync(manifest,'utf8'));if(JSON.stringify(config.players)!==JSON.stringify(identities)||config.program!==program.publicKey.toBase58()||config.rpc!==rpc)throw Error('Resume manifest does not match agents/program/RPC');await client.match(config.match,config);}
 else{
  const nonce=randomBytes(32);const [match]=await PublicKey.findProgramAddress([Buffer.from('escrow'),payer.publicKey.toBytes(),nonce],program.publicKey);
  config={program:program.publicKey.toBase58(),players:identities,match:match.toBase58(),nonce:nonce.toString('hex'),buyIn:1_000_000,bigBlind:20_000,maxHands:Number(process.env.AGENT_STACKS_MAX_HANDS??2),turnSeconds:Number(process.env.AGENT_STACKS_TURN_SECONDS??86400),genesis:await client.connection.getGenesisHash(),rpc};config.terms=termsHash(config);
  manifest=resolve(directory,'matches',`${config.match}.json`);writePrivate(manifest,JSON.stringify(config,null,2),{exclusive:true});
  await fund(new PublicKey(identities[1]),20_000_000,`${config.match}-invitation`);
  await client.send([client.instruction(1,[nonce,u64(config.buyIn),u32(config.turnSeconds),Buffer.from(config.terms,'hex'),u64(config.bigBlind),u32(config.maxHands)],[{pubkey:payer.publicKey,isSigner:true,isWritable:true},{pubkey:new PublicKey(identities[1]),isSigner:false,isWritable:false},{pubkey:match,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}])]);
 }
 await Promise.all(children.map(child=>ask(child,{kind:'initialize',config,rpc,allowLocal})));
 await Promise.all(children.map(child=>ask(child,{kind:'settle'})));
 await Promise.all(children.map(child=>ask(child,{kind:'cleanup-proof'})));
 const initial=await client.match(config.match,config);
 for(let handNo=1;handNo<=initial.handNo;handNo++){if(handNo<initial.handNo||initial.phase>=5)await ask(children[1],{kind:'return-rent',handNo});}
 console.log(`On-chain match ${config.match}; ${config.maxHands} hands maximum, ${config.buyIn} lamports per player.\nResume manifest: ${manifest}`);
 let guard=0;
 while(++guard<100*config.maxHands){
  const m=await client.match(config.match,config);if(m.phase===6){if(m.pendingPayouts){for(let s=0;s<2;s++)if(m.pendingPayouts&(1<<s))await ask(children[s],{kind:'step'});continue;}config.result={handNo:m.handNo,payouts:m.payouts,reason:m.game.reason,board:m.game.board,holes:m.game.holes,completedAt:config.result?.completedAt??new Date().toISOString()};writePrivate(manifest,JSON.stringify(config,null,2));console.log(JSON.stringify({complete:true,match:config.match,result:config.result,manifest},null,2));break;}
  const seat=m.phase===0?1:obligated(m);if(seat===null)throw Error(`Unsupported phase ${m.phase}`);
  if(m.phase===4)await fund(new PublicKey(identities[1]),cooperative?40_000_000:4_600_000_000,`${config.match}-${m.handNo}-shuffle`);
  console.log(`Hand ${m.handNo}, player ${'AB'[seat]}: ${['waiting','key A','key B','shuffle A','shuffle B','hole shares B','complete','hole shares A','betting','board shares A','board shares B','showdown A','showdown B'][m.phase]}`);
  if(cooperative&&[3,4].includes(m.phase)){
   const {offer}=await ask(children[seat],{kind:'compact-offer'});
   // The counterparty reads chain state and verifies the full proof independently.
   const unilateral=async reason=>{console.log(`${reason}; using unilateral proof verification.`);if(seat===1)await fund(new PublicKey(identities[1]),4_600_000_000,`${config.match}-${m.handNo}-fallback`);await ask(children[seat],{kind:'step'});};
   let approval;
   try {approval=await ask(children[1-seat],{kind:'compact-sign',offer},15000);}
   catch(error){await unilateral(`Counterparty declined cooperative acceptance: ${error.message}`);}
   // A signature means the transaction was released, which --resume recovers. Without one it never left.
   if(approval){try{await ask(children[seat],{kind:'compact-finish',signature:approval.signature});}catch(error){if(error.signature)throw error;await unilateral(`Counterparty signature was unusable: ${error.message}`);}}
  }else await ask(children[seat],{kind:'step'});
  if([3,4].includes(m.phase))await ask(children[seat],{kind:'cleanup-proof'});
  if(m.phase===4)await ask(children[1],{kind:'return-rent',handNo:m.handNo});
 }
 if(guard>=100*config.maxHands)throw Error('Match exceeded action budget');
}finally{for(const child of children)child.kill();}
