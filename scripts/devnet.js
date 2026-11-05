import { resolve } from 'node:path';
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {randomBytes} from 'node:crypto';
import { once } from 'node:events';
import { ChainClient,DEVNET,DEVNET_GENESIS,ensureWallet,loadWallet,manifestRpc,redactRpc,PublicKey,SystemProgram,u64,u32,termsHash,LAYOUT } from '../src/solana/client.js';
import {PROOF_ACCOUNT_BYTES,strictFundingRequired} from '../src/solana/trusted-agent.js';
import {writePrivate,appendPrivate,privateDirectory} from '../src/private-files.js';
const directory=resolve('.agent-stacks/devnet');mkdirSync(directory,{recursive:true,mode:0o700});
privateDirectory(directory);
const payer=await ensureWallet(resolve(directory,'payer-keypair.json'));
const program=await ensureWallet(resolve(directory,'program-keypair.json'));
// The payer holds the upgrade authority. A player's wallet sits on an online agent, so it can be a separate key.
const player=process.env.AGENT_STACKS_WALLET?await loadWallet(resolve(process.env.AGENT_STACKS_WALLET)):payer;
const rpc=process.env.AGENT_STACKS_RPC??DEVNET;
const local=process.env.AGENT_STACKS_ALLOW_LOCAL==='1';
const client=new ChainClient(rpc,program.publicKey,player,{allowLocal:local,onTransaction:(signature,details)=>appendPrivate(resolve(directory,'transactions.ndjson'),JSON.stringify({at:new Date().toISOString(),signature,...details})+'\n')});
const command=process.argv[2]??'status';
const artifact=resolve('target/deploy/agent_stacks_escrow.so');
const hands=Number(process.env.AGENT_STACKS_MAX_HANDS??2);
// Priced from the cluster's current rent, which is not the same everywhere and is changing.
async function budget(){
 const rent=async bytes=>Number(await client.connection.getMinimumBalanceForRentExemption(bytes));
 const deployer=existsSync(artifact)?await rent(readFileSync(artifact).length+45)+await rent(36)+50_000_000:null;
 const joiner=strictFundingRequired({rent:await rent(PROOF_ACCOUNT_BYTES),buyIn:1_000_000,hands,maxFeePerTransaction:15_000});
 const creator=joiner+await rent(LAYOUT.size)+10_000;
 return {hands,deployerSOL:deployer===null?null:deployer/1e9,playerASOL:creator/1e9,playerBSOL:joiner/1e9,totalSOL:((deployer??0)+creator+joiner)/1e9,returnedAfterMatchSOL:(2*await rent(PROOF_ACCOUNT_BYTES))/1e9};
}
try {
 const genesis=await client.checkNetwork();const balance=Number(await client.connection.getBalance(payer.publicKey,'confirmed'));
 const status={network:genesis===DEVNET_GENESIS?'devnet':'explicit-local-validator',rpc:redactRpc(rpc),genesis,payer:payer.publicKey.toBase58(),balanceSOL:balance/1e9,...(player===payer?{}:{player:player.publicKey.toBase58(),playerBalanceSOL:Number(await client.connection.getBalance(player.publicKey,'confirmed'))/1e9}),program:program.publicKey.toBase58(),programDeployed:!!(await client.connection.getAccountInfo(program.publicKey))?.executable};
 if(command==='status'){console.log(JSON.stringify({...status,budget:await budget()},null,2));}
 else if(command==='deploy'){
  if(status.programDeployed)throw Error('This program is already deployed, and redeploying would replace code that agents have pinned. Use a new program keypair for a new version.');
  if(genesis!==DEVNET_GENESIS)throw Error('Use validator --bpf-program for local testing; this deployment command is devnet-only');
  if(!existsSync(artifact))throw Error('Run npm run solana:build first');
  const size=readFileSync(artifact).length;const rent=Number(await client.connection.getMinimumBalanceForRentExemption(size+45));
  // A deploy that stopped partway has already paid its rent into the buffer, and resuming needs only fees.
  const bufferFile=resolve(directory,'deploy-buffer-keypair.json');const buffer=await ensureWallet(bufferFile);
  const paid=Number((await client.connection.getAccountInfo(buffer.publicKey,'confirmed'))?.lamports??0);
  if(balance+paid<rent+50_000_000)throw Error(`Devnet wallet needs funding. Current ${balance/1e9} SOL; program rent is about ${rent/1e9} SOL. Fund ${status.payer} with test SOL.`);
  const cli=process.env.SOLANA_CLI??resolve('.tools/solana-release/bin/solana');
  const args=['program','deploy',artifact,'--program-id',resolve(directory,'program-keypair.json'),'--buffer',bufferFile,'--keypair',resolve(directory,'payer-keypair.json'),'--upgrade-authority',resolve(directory,'payer-keypair.json'),'--url',rpc,'--max-sign-attempts','20','--output','json'];
  console.log(`Deploying ${size} bytes to devnet program ${status.program}. Upgrade authority is the project devnet payer.`);
  const child=spawn(cli,args,{stdio:['ignore','pipe','inherit']});let output='';child.stdout.on('data',b=>{output+=b;process.stdout.write(b);});
  const [code]=await once(child,'exit');if(code!==0)throw Error(`Deployment exited ${code}; inspect the project-owned buffer before retrying`);
  const receipt={...status,deployedAt:new Date().toISOString(),artifactBytes:size,cli:JSON.parse(output)};
  writeFileSync(resolve(directory,'deployment.json'),JSON.stringify(receipt,null,2),{mode:0o600});
 } else if(command==='create'){
  const opponent=new PublicKey(process.argv[3]);const nonce=randomBytes(32);
  const [match]=await PublicKey.findProgramAddress([Buffer.from('escrow'),player.publicKey.toBytes(),nonce],program.publicKey);
  const config={program:program.publicKey.toBase58(),players:[player.publicKey.toBase58(),opponent.toBase58()],match:match.toBase58(),nonce:nonce.toString('hex'),buyIn:1_000_000,bigBlind:20_000,maxHands:hands,turnSeconds:Number(process.env.AGENT_STACKS_TURN_SECONDS??86400),genesis,...manifestRpc(rpc)};config.terms=termsHash(config);
  const manifest=resolve(directory,'matches',`${config.match}.json`);mkdirSync(resolve(directory,'matches'),{recursive:true,mode:0o700});
  writePrivate(manifest,JSON.stringify(config,null,2),{exclusive:true});
  const signature=await client.send([client.instruction(1,[nonce,u64(config.buyIn),u32(config.turnSeconds),Buffer.from(config.terms,'hex'),u64(config.bigBlind),u32(config.maxHands)],[{pubkey:player.publicKey,isSigner:true,isWritable:true},{pubkey:opponent,isSigner:false,isWritable:false},{pubkey:match,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}])],[],null,{confirmation:'finalized'});
  console.log(JSON.stringify({match:config.match,signature,manifest},null,2));
 } else if(command==='cancel'){
  console.log(JSON.stringify({signature:await client.cancelInvitation(process.argv[3]),match:process.argv[3]},null,2));
 } else if(command==='close'){
  // Permanent: the address is retired and scripts/verify-chain-match.js can no longer read it.
  const signature=await client.closeMatch(process.argv[3]);console.log(JSON.stringify({signature,match:process.argv[3],retired:true},null,2));
 } else if(command==='timeout'){
  const id=process.argv[3];const m=await client.match(id);const signature=await client.command(id,5,[],m.players.map(p=>({pubkey:new PublicKey(p),isSigner:false,isWritable:true})),null,m.version);console.log(JSON.stringify({signature,match:await client.match(id)},null,2));
 } else if(command==='play') {await import('../examples/chain-demo.js');}
 else throw Error('Usage: node scripts/devnet.js status|deploy|play|create OPPONENT|cancel MATCH|close MATCH|timeout MATCH');
} catch(error){console.error(JSON.stringify({error:error.message,signature:error.signature??null}));process.exitCode=1;}
