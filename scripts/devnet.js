import { resolve } from 'node:path';
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {randomBytes} from 'node:crypto';
import { once } from 'node:events';
import { ChainClient,DEVNET,ensureWallet,PublicKey,SystemProgram,u64,u32,termsHash } from '../src/solana/client.js';
import {writePrivate,appendPrivate,privateDirectory} from '../src/private-files.js';
const directory=resolve('.agent-stacks/devnet');mkdirSync(directory,{recursive:true,mode:0o700});
privateDirectory(directory);
const payer=await ensureWallet(resolve(directory,'payer-keypair.json'));
const program=await ensureWallet(resolve(directory,'program-keypair.json'));
const rpc=process.env.AGENT_STACKS_RPC??DEVNET;
const local=process.env.AGENT_STACKS_ALLOW_LOCAL==='1';
const client=new ChainClient(rpc,program.publicKey,payer,{allowLocal:local,onTransaction:(signature,details)=>appendPrivate(resolve(directory,'transactions.ndjson'),JSON.stringify({at:new Date().toISOString(),signature,...details})+'\n')});
const command=process.argv[2]??'status';
try {
 const genesis=await client.checkNetwork();const balance=Number(await client.connection.getBalance(payer.publicKey,'confirmed'));
 const status={network:genesis=== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'?'devnet':'explicit-local-validator',rpc,genesis,payer:payer.publicKey.toBase58(),balanceSOL:balance/1e9,program:program.publicKey.toBase58(),programDeployed:!!(await client.connection.getAccountInfo(program.publicKey))};
 if(command==='status'){console.log(JSON.stringify(status,null,2));}
 else if(command==='deploy'){
  if(local)throw Error('Use validator --bpf-program for local testing; this deployment command is devnet-only');
  const artifact=resolve('target/deploy/agent_stacks_escrow.so');if(!existsSync(artifact))throw Error('Run npm run solana:build first');
  const size=readFileSync(artifact).length;const rent=Number(await client.connection.getMinimumBalanceForRentExemption(size+45));
  if(balance<rent+50_000_000)throw Error(`Devnet wallet needs funding. Current ${balance/1e9} SOL; program rent is about ${rent/1e9} SOL. Fund ${status.payer} with test SOL.`);
  const cli=process.env.SOLANA_CLI??resolve('.tools/solana-release/bin/solana');
  const bufferFile=resolve(directory,'deploy-buffer-keypair.json');await ensureWallet(bufferFile);
  const args=['program','deploy',artifact,'--program-id',resolve(directory,'program-keypair.json'),'--buffer',bufferFile,'--keypair',resolve(directory,'payer-keypair.json'),'--upgrade-authority',resolve(directory,'payer-keypair.json'),'--url',rpc,'--use-rpc','--max-sign-attempts','5','--output','json'];
  console.log(`Deploying ${size} bytes to devnet program ${status.program}. Upgrade authority is the project devnet payer.`);
  const child=spawn(cli,args,{stdio:['ignore','pipe','inherit']});let output='';child.stdout.on('data',b=>{output+=b;process.stdout.write(b);});
  const [code]=await once(child,'exit');if(code!==0)throw Error(`Deployment exited ${code}; inspect the project-owned buffer before retrying`);
  const receipt={...status,deployedAt:new Date().toISOString(),artifactBytes:size,cli:JSON.parse(output)};
  writeFileSync(resolve(directory,'deployment.json'),JSON.stringify(receipt,null,2),{mode:0o600});
 } else if(command==='create'){
  const opponent=new PublicKey(process.argv[3]);const nonce=randomBytes(32);
  const [match]=await PublicKey.findProgramAddress([Buffer.from('escrow'),payer.publicKey.toBytes(),nonce],program.publicKey);
  const config={program:program.publicKey.toBase58(),players:[payer.publicKey.toBase58(),opponent.toBase58()],match:match.toBase58(),nonce:nonce.toString('hex'),buyIn:1_000_000,bigBlind:20_000,maxHands:Number(process.env.AGENT_STACKS_MAX_HANDS??2),turnSeconds:Number(process.env.AGENT_STACKS_TURN_SECONDS??86400),genesis,rpc};config.terms=termsHash(config);
  const manifest=resolve(directory,'matches',`${config.match}.json`);mkdirSync(resolve(directory,'matches'),{recursive:true,mode:0o700});
  writePrivate(manifest,JSON.stringify(config,null,2),{exclusive:true});
  const signature=await client.send([client.instruction(1,[nonce,u64(config.buyIn),u32(config.turnSeconds),Buffer.from(config.terms,'hex'),u64(config.bigBlind),u32(config.maxHands)],[{pubkey:payer.publicKey,isSigner:true,isWritable:true},{pubkey:opponent,isSigner:false,isWritable:false},{pubkey:match,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}])],[],null,{confirmation:'finalized'});
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
