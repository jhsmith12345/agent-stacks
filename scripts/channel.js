// Sets up a channel match. Wallets sign only this part. The agents hold session keys and do the rest.
//   node scripts/channel.js session FILE
//   node scripts/channel.js offer WALLET SESSION_FILE                 What the opponent sends the creator
//   node scripts/channel.js create WALLET SESSION_FILE OFFER_FILE MANIFEST_OUT --program ID --rpc URL [--buy-in N --big-blind N --hands N --seconds N --reserve N --low-reserve]
//   node scripts/channel.js join WALLET SESSION_FILE MANIFEST --rpc URL [--reserve N --low-reserve]
//   node scripts/channel.js status MANIFEST --rpc URL
//   node scripts/channel.js retire WALLET MANIFEST --rpc URL
//   node scripts/channel.js sweep SESSION_FILE DESTINATION PROGRAM --rpc URL   Returns what's left in a session key
//   node scripts/channel.js deploy PAYER PROGRAM_KEYPAIR BUFFER_KEYPAIR ARTIFACT --rpc URL    Devnet only, never over an existing program
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ChainClient,DEVNET_GENESIS,ensureWallet,loadWallet} from '../src/solana/client.js';
import {sessionFromSeed} from '../src/channel/keys.js';
import {ChannelChain,channelTerms,withBytes} from '../src/channel/chain.js';
import {buildManifest,checkOffer,makeOffer,reserveNeeded,sendCreate,sendJoin,sendRetire,sendSweep,sessionHex} from '../src/channel/setup.js';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const number=(name,fallback)=>{const n=Number(option(name,fallback));if(!Number.isSafeInteger(n)||n<0)throw Error(`Invalid ${name}`);return n;};
const sessionOf=wallet=>sessionFromSeed(Buffer.from(wallet.secretKey).subarray(0,32));
const clientFor=(wallet,program)=>new ChainClient(option('--rpc',process.env.AGENT_STACKS_RPC),program,wallet,{allowLocal:process.env.AGENT_STACKS_ALLOW_LOCAL==='1'});
const [command,...args]=process.argv.slice(2);
const print=value=>console.log(JSON.stringify(value,null,2));
async function checkReserve(client,reserve){
 if(process.argv.includes('--low-reserve'))return;
 const needed=await reserveNeeded(client);
 if(reserve<needed)throw Error(`A reserve of ${reserve} lamports can't post a state in a dispute, which takes ${needed}. Raise --reserve, or pass --low-reserve to accept the risk of losing a dispute.`);
}
if(command==='session'){
 const wallet=await ensureWallet(resolve(args[0]));
 print({address:wallet.publicKey.toBase58(),session:Buffer.from(sessionOf(wallet).publicKey).toString('hex')});
}else if(command==='offer'){
 print(makeOffer(await loadWallet(resolve(args[0])),await loadWallet(resolve(args[1]))));
}else if(command==='create'){
 const wallet=await loadWallet(resolve(args[0])),sessionWallet=await loadWallet(resolve(args[1]));
 const offer=JSON.parse(readFileSync(resolve(args[2]),'utf8'));
 checkOffer(offer);
 const program=option('--program');if(!program)throw Error('--program is required');
 const client=clientFor(wallet,program);
 const manifest=await buildManifest({client,wallet,sessionWallet,offer,program,buyIn:number('--buy-in',1_000_000),bigBlind:number('--big-blind',20_000),hands:number('--hands',2),seconds:number('--seconds',3600)});
 const reserve=number('--reserve',50_000_000);await checkReserve(client,reserve);
 // Saved first: it holds the nonce, without which the deposit couldn't be found again.
 writeFileSync(resolve(args[3]),JSON.stringify(manifest,null,2));
 const signature=await sendCreate({client,wallet,sessionWallet,manifest,reserve});
 print({match:manifest.match,signature,manifest:resolve(args[3])});
}else if(command==='join'){
 const wallet=await loadWallet(resolve(args[0])),sessionWallet=await loadWallet(resolve(args[1]));
 const manifest=JSON.parse(readFileSync(resolve(args[2]),'utf8'));
 if(channelTerms(manifest)!==manifest.terms)throw Error('The manifest’s terms hash does not match its terms');
 if(manifest.players[1]!==wallet.publicKey.toBase58()||manifest.sessions[1]!==sessionHex(sessionWallet))throw Error('This manifest names a different player or session key');
 const client=clientFor(wallet,manifest.program);await client.checkNetwork();
 const reserve=number('--reserve',50_000_000);await checkReserve(client,reserve);
 print({match:manifest.match,signature:await sendJoin({client,wallet,sessionWallet,manifest,reserve})});
}else if(command==='status'){
 const manifest=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
 const client=clientFor(null,manifest.program);await client.checkNetwork();
 const chain=new ChannelChain(client,withBytes(manifest)),state=await chain.read();
 if(!state)print({exists:false});
 else{const {blob,nonce,game,...rest}=state;print({...rest,stacks:game?.stacks});void blob;void nonce;}
}else if(command==='retire'){
 const wallet=await loadWallet(resolve(args[0])),manifest=JSON.parse(readFileSync(resolve(args[1]),'utf8'));
 const client=clientFor(wallet,manifest.program);await client.checkNetwork();
 print({signature:await sendRetire({client,wallet,manifest})});
}else if(command==='deploy'){
 const [payerFile,programFile,bufferFile,artifact]=args.map(a=>resolve(a));
 const payer=await loadWallet(payerFile),programKey=await ensureWallet(programFile);await ensureWallet(bufferFile);
 const client=clientFor(payer,programKey.publicKey),genesis=await client.checkNetwork();
 if(genesis!==DEVNET_GENESIS)throw Error('This deploy command is devnet-only');
 const existing=await client.connection.getAccountInfo(programKey.publicKey,'confirmed');
 if(existing?.executable)throw Error('This program is already deployed, and redeploying would replace code agents rely on');
 const rpc=option('--rpc',process.env.AGENT_STACKS_RPC),cli=process.env.SOLANA_CLI??resolve('.tools/solana-release/bin/solana');
 // Writes go straight to validators, because the public RPC's limits refuse most of them.
 const result=spawnSync(cli,['program','deploy',artifact,'--program-id',programFile,'--buffer',bufferFile,'--keypair',payerFile,'--upgrade-authority',payerFile,'--url',rpc,'--max-sign-attempts','20','--output','json'],{encoding:'utf8'});
 if(result.status!==0)throw Error(`Deployment exited ${result.status}: ${(result.stderr||result.stdout).slice(-400)}. Run it again to resume the same buffer.`);
 print(JSON.parse(result.stdout));
}else if(command==='sweep'){
 const session=await loadWallet(resolve(args[0])),client=clientFor(session,args[2]);await client.checkNetwork();
 print(await sendSweep({client,session,destination:args[1]}));
}else throw Error('Unknown command. See the top of this file.');
