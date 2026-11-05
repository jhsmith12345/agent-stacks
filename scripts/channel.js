// Sets up a channel match. Wallets sign only this part. The agents hold session keys and do the rest.
//   node scripts/channel.js session FILE
//   node scripts/channel.js offer WALLET SESSION_FILE                 What the opponent sends the creator
//   node scripts/channel.js create WALLET SESSION_FILE OFFER_FILE MANIFEST_OUT --program ID --rpc URL [--buy-in N --big-blind N --hands N --seconds N --reserve N --low-reserve]
//   node scripts/channel.js join WALLET SESSION_FILE MANIFEST --rpc URL [--reserve N --low-reserve]
//   node scripts/channel.js status MANIFEST --rpc URL
//   node scripts/channel.js retire WALLET MANIFEST --rpc URL
//   node scripts/channel.js sweep SESSION_FILE DESTINATION PROGRAM --rpc URL   Returns what's left in a session key
//   node scripts/channel.js deploy PAYER PROGRAM_KEYPAIR BUFFER_KEYPAIR ARTIFACT --rpc URL    Devnet only, never over an existing program
import {createPublicKey,randomBytes,verify,sign} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ChainClient,DEVNET_GENESIS,PublicKey,SystemProgram,ensureWallet,loadWallet,u32,u64} from '../src/solana/client.js';
import {sessionFromSeed} from '../src/channel/keys.js';
import {BUFFER_SPACE,ChannelChain,channelAddress,channelTerms,withBytes} from '../src/channel/chain.js';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const number=(name,fallback)=>{const n=Number(option(name,fallback));if(!Number.isSafeInteger(n)||n<0)throw Error(`Invalid ${name}`);return n;};
const OFFER=Buffer.from('agent-stacks/channel/offer/v1:');
const SPKI=Buffer.from('302a300506032b6570032100','hex');
const sessionOf=wallet=>sessionFromSeed(Buffer.from(wallet.secretKey).subarray(0,32));
const clientFor=(wallet,program)=>new ChainClient(option('--rpc',process.env.AGENT_STACKS_RPC),program,wallet,{allowLocal:process.env.AGENT_STACKS_ALLOW_LOCAL==='1'});
const [command,...args]=process.argv.slice(2);
const print=value=>console.log(JSON.stringify(value,null,2));
// A session key that can't afford to post a state can't defend its player in a dispute. It has to pay the
// buffer's rent and some fees, and keep the rent minimum itself.
async function checkReserve(client,reserve){
 if(process.argv.includes('--low-reserve'))return;
 const needed=Number(await client.connection.getMinimumBalanceForRentExemption(BUFFER_SPACE))+Number(await client.connection.getMinimumBalanceForRentExemption(0))+300_000;
 if(reserve<needed)throw Error(`A reserve of ${reserve} lamports can't post a state in a dispute, which takes ${needed}. Raise --reserve, or pass --low-reserve to accept the risk of losing a dispute.`);
}
if(command==='session'){
 const wallet=await ensureWallet(resolve(args[0]));
 print({address:wallet.publicKey.toBase58(),session:Buffer.from(sessionOf(wallet).publicKey).toString('hex')});
}else if(command==='offer'){
 const wallet=await loadWallet(resolve(args[0])),session=sessionOf(await loadWallet(resolve(args[1])));
 const signature=sign(null,Buffer.concat([OFFER,session.publicKey]),sessionOf(wallet).key);
 print({wallet:wallet.publicKey.toBase58(),session:Buffer.from(session.publicKey).toString('hex'),signature:signature.toString('hex')});
}else if(command==='create'){
 const wallet=await loadWallet(resolve(args[0])),sessionWallet=await loadWallet(resolve(args[1]));
 const offer=JSON.parse(readFileSync(resolve(args[2]),'utf8'));
 // Binds the opponent's session key to its wallet, so nobody else can slip in a key of their own.
 const opponent=new PublicKey(offer.wallet);
 const key=createPublicKey({key:Buffer.concat([SPKI,Buffer.from(opponent.toBytes())]),format:'der',type:'spki'});
 if(!verify(null,Buffer.concat([OFFER,Buffer.from(offer.session,'hex')]),key,Buffer.from(offer.signature,'hex')))throw Error('The opponent’s offer is not signed by its wallet');
 const program=option('--program');if(!program)throw Error('--program is required');
 const client=clientFor(wallet,program),genesis=await client.checkNetwork();
 const sessions=[Buffer.from(sessionOf(sessionWallet).publicKey).toString('hex'),offer.session];
 const nonce=randomBytes(32),[match]=await channelAddress(program,wallet.publicKey,nonce);
 const manifest={protocol:'agent-stacks/channel/v1',genesis,program,players:[wallet.publicKey.toBase58(),offer.wallet],sessions,match:match.toBase58(),nonce:nonce.toString('hex'),buyIn:number('--buy-in',1_000_000),bigBlind:number('--big-blind',20_000),maxHands:number('--hands',2),turnSeconds:number('--seconds',3600)};
 manifest.terms=channelTerms(manifest);
 const accounts=[{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:opponent,isSigner:false,isWritable:false},{pubkey:match,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}];
 const reserve=number('--reserve',50_000_000);await checkReserve(client,reserve);
 const signature=await client.send([client.instruction(30,[nonce,u64(manifest.buyIn),u32(manifest.turnSeconds),Buffer.from(new PublicKey(genesis).toBytes()),u64(manifest.bigBlind),u32(manifest.maxHands),Buffer.from(sessions[0],'hex'),Buffer.from(sessions[1],'hex')],accounts),SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:sessionWallet.publicKey,lamports:BigInt(reserve)})]);
 writeFileSync(resolve(args[3]),JSON.stringify(manifest,null,2));
 print({match:manifest.match,signature,manifest:resolve(args[3])});
}else if(command==='join'){
 const wallet=await loadWallet(resolve(args[0])),sessionWallet=await loadWallet(resolve(args[1]));
 const manifest=JSON.parse(readFileSync(resolve(args[2]),'utf8'));
 if(channelTerms(manifest)!==manifest.terms)throw Error('The manifest’s terms hash does not match its terms');
 if(manifest.players[1]!==wallet.publicKey.toBase58()||manifest.sessions[1]!==Buffer.from(sessionOf(sessionWallet).publicKey).toString('hex'))throw Error('This manifest names a different player or session key');
 const client=clientFor(wallet,manifest.program);await client.checkNetwork();
 // Joining commits to these exact terms. If the account holds anything else, the contract refuses.
 const reserve=number('--reserve',50_000_000);await checkReserve(client,reserve);
 const signature=await client.send([client.instruction(31,[Buffer.from(manifest.terms,'hex')],[{pubkey:new PublicKey(manifest.match),isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}]),SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:sessionWallet.publicKey,lamports:BigInt(reserve)})]);
 print({match:manifest.match,signature});
}else if(command==='status'){
 const manifest=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
 const client=clientFor(null,manifest.program);await client.checkNetwork();
 const chain=new ChannelChain(client,withBytes(manifest)),state=await chain.read();
 if(!state)print({exists:false});
 else{const {blob,nonce,game,...rest}=state;print({...rest,stacks:game?.stacks});void blob;void nonce;}
}else if(command==='retire'){
 const wallet=await loadWallet(resolve(args[0])),manifest=JSON.parse(readFileSync(resolve(args[1]),'utf8'));
 const client=clientFor(wallet,manifest.program);await client.checkNetwork();
 const signature=await client.send([client.instruction(44,[],[{pubkey:new PublicKey(manifest.match),isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true}])]);
 print({signature});
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
 const balance=Number(await client.connection.getBalance(session.publicKey,'confirmed'));
 if(balance<=5000)print({swept:0});
 else print({swept:balance-5000,signature:await client.send([SystemProgram.transfer({fromPubkey:session.publicKey,toPubkey:new PublicKey(args[1]),lamports:BigInt(balance-5000)})])});
}else throw Error('Unknown command. See the top of this file.');
