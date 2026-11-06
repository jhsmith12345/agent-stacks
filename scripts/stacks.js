// One command each to play someone. The host gets a code to send them, and they paste it.
//   node scripts/stacks.js host --relay URL [--buy-in SOL] [--big-blind SOL] [--hands N] [--clock SECONDS] [--think SECONDS] [--decide COMMAND]
//   node scripts/stacks.js join CODE [--yes] [--decide COMMAND]
//   node scripts/stacks.js resume CODE [--decide COMMAND]    Carries on after a crash, for either player
//   node scripts/stacks.js wallet                            This player's address and balance
// All of them also take --home DIRECTORY, --wallet FILE, --rpc URL[,URL...] and --deployment FILE.
// The code is a bearer invitation: whoever pastes it first takes the seat, so send it privately.
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {ChainClient,DEVNET,ensureWallet,loadWallet} from '../src/solana/client.js';
import {verifyPinnedProgram} from '../src/solana/trusted-agent.js';
import {privateDirectory,readPrivate,writePrivate} from '../src/private-files.js';
import {ChannelChain,COMPLETE,WAITING,withBytes} from '../src/channel/chain.js';
import {RelayTransport} from '../src/channel/relay.js';
import {playMatch} from '../src/channel/agent.js';
import {trustedDeployment} from '../src/channel/deployments.js';
import {buildManifest,fundsNeeded,makeOffer,reserveNeeded,sendClaim,sendCreate,sendJoin,sendRetire,sendSweep,sessionHex} from '../src/channel/setup.js';
import {checkManifest,decodeInvite,encodeInvite,formatSol,newInvite,parseSol,seal,waitForManifest,waitForOffer} from '../src/channel/invite.js';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const whole=(name,fallback)=>{const n=Number(option(name,fallback));if(!Number.isSafeInteger(n)||n<=0)throw Error(`Invalid ${name}`);return n;};
const say=text=>process.stderr.write(`${text}\n`);
// Someone running this wants to know what went wrong, not where in the code. Set AGENT_STACKS_DEBUG for that.
process.on('uncaughtException',error=>{say(process.env.AGENT_STACKS_DEBUG?error.stack:`Stopped: ${error.message}`);process.exit(1);});
const home=resolve(option('--home',process.env.AGENT_STACKS_HOME??'.agent-stacks/play'));
const rpcs=(option('--rpc')??process.env.AGENT_STACKS_RPC??DEVNET).split(',').filter(Boolean);
const allowLocal=process.env.AGENT_STACKS_ALLOW_LOCAL==='1',decide=option('--decide');
const seconds=name=>{const n=Number(process.env[name]??NaN);return Number.isFinite(n)?n:null;};
const readIf=file=>existsSync(file)?JSON.parse(readPrivate(file,'utf8')):null;
privateDirectory(home);
const explicitWallet=option('--wallet');
const wallet=explicitWallet?await loadWallet(resolve(explicitWallet)):await ensureWallet(join(home,'wallet-keypair.json'));
const address=wallet.publicKey.toBase58();
const [command,...args]=process.argv.slice(2);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>process.exit(130));
// The contract is the one thing a player must not take anyone's word for, since it holds the deposit.
async function trustedProgram(client,genesis){
 const custom=option('--deployment');
 const deployment=trustedDeployment(genesis,custom?JSON.parse(readFileSync(resolve(custom),'utf8')):null);
 await verifyPinnedProgram(client.connection,deployment);
 return deployment;
}
async function waitForFunds(client,needed){
 for(let told=false;;told=true){
  const have=Number(await client.connection.getBalance(wallet.publicKey,'confirmed'));
  if(have>=needed)return;
  if(!told)say(`Wallet ${address} holds ${formatSol(have)} SOL and this match needs ${formatSol(needed)}. Send the difference there, and this carries on once it arrives.`);
  await pause(10_000);
 }
}
async function prepare(invite,{creating}){
 const client=new ChainClient(rpcs[0],invite.program,wallet,{allowLocal});
 const genesis=await client.checkNetwork();
 if(genesis!==invite.genesis)throw Error('This RPC is on a different network from the invite');
 const deployment=await trustedProgram(client,genesis);
 if(deployment.program!==invite.program)throw Error(`This invite uses contract ${invite.program}, which isn’t the one this software trusts. Refusing to put any money in it.`);
 const directory=join(home,invite.id);privateDirectory(directory);
 const code=join(directory,'invite.txt');if(!existsSync(code))writePrivate(code,encodeInvite(invite));
 const sessionWallet=await ensureWallet(join(directory,'session-keypair.json'));
 const reserve=await reserveNeeded(client);
 return {client,directory,sessionWallet,reserve,needed:await fundsNeeded(client,{buyIn:invite.buyIn,reserve,creating}),manifestFile:join(directory,'manifest.json')};
}
const read=(client,manifest)=>new ChannelChain(client,withBytes(manifest)).read();
async function play(invite,{client,directory,sessionWallet,manifestFile},manifest,alongside=null){
 say('Playing. This can be stopped and resumed: a crash or lost connection costs nothing if it’s back within the clock.');
 const stopped={now:false};
 const beside=alongside?alongside(stopped):null;
 const outcome=await playMatch({sessionFile:join(directory,'session-keypair.json'),directory:join(directory,'state'),manifestFile,relay:invite.relay,rpcs,decide,think:invite.think,stallSeconds:seconds('AGENT_STACKS_STALL_SECONDS'),pollSeconds:seconds('AGENT_STACKS_POLL_SECONDS'),allowLocal});
 stopped.now=true;await beside;
 // Everything that isn't part of the result comes back: the match's rent, and what's left in the session key.
 const session=new ChainClient(rpcs[0],invite.program,sessionWallet,{allowLocal});
 await sendSweep({client:session,session:sessionWallet,destination:address}).catch(error=>say(`Some SOL stays in the session key: ${error.message}`));
 let state=await read(client,manifest).catch(()=>null);
 if(state&&!state.retired&&state.pendingPayouts&(1<<outcome.seat)){
  await sendClaim({client,wallet,manifest,seat:outcome.seat}).catch(error=>say(`Your payout is held until it’s claimed: ${error.message}`));
  state=await read(client,manifest).catch(()=>null);
 }
 if(invite.host===address&&state&&!state.retired&&!state.pendingPayouts)await sendRetire({client,wallet,manifest}).catch(error=>say(`The match’s rent stays until it’s retired: ${error.message}`));
 const mine=outcome.payouts?.[outcome.seat]??null;
 if(mine!==null)say(`Match over after ${outcome.results.length} hand${outcome.results.length===1?'':'s'}. You started with ${formatSol(invite.buyIn)} SOL and finished with ${formatSol(mine)} SOL.`);
 console.log(JSON.stringify({complete:true,match:manifest.match,seat:outcome.seat,payouts:outcome.payouts,buyIn:invite.buyIn,hands:outcome.results.length,results:outcome.results,...outcome.stats,walletBalance:Number(await client.connection.getBalance(wallet.publicKey,'confirmed'))}));
}
async function asHost(invite){
 const context=await prepare(invite,{creating:true}),{client,directory,sessionWallet,reserve,manifestFile}=context;
 const transport=new RelayTransport(invite.relay,invite.id,0);
 const offerFile=join(directory,'offer.json');
 let offer=readIf(offerFile);
 if(!offer){
  say('Waiting for the other player. No money moves until they’ve accepted.');
  offer=await waitForOffer({invite,transport,log:say});
  writePrivate(offerFile,JSON.stringify(offer));
 }
 await waitForFunds(client,context.needed);
 // Saved first: it holds the nonce, without which the deposit couldn't be found again.
 let manifest=readIf(manifestFile);
 if(!manifest){manifest=await buildManifest({client,wallet,sessionWallet,offer,program:invite.program,buyIn:invite.buyIn,bigBlind:invite.bigBlind,hands:invite.hands,seconds:invite.seconds});writePrivate(manifestFile,JSON.stringify(manifest));}
 if(!await read(client,manifest)){say('Creating the match.');await sendCreate({client,wallet,sessionWallet,manifest,reserve});}
 // Until they've joined, in case the relay lost it. A relay can't change it without the invite's secret.
 const announce=async stopped=>{
  for(;!stopped.now;await pause(5000)){
   const state=await read(client,manifest).catch(()=>null);
   if(state&&state.phase!==WAITING)return;
   await transport.send(seal(invite,'manifest',manifest)).catch(error=>say(`relay: ${error.message}`));
  }
 };
 await play(invite,context,manifest,announce);
}
async function asGuest(invite){
 const context=await prepare(invite,{creating:false}),{client,sessionWallet,reserve,manifestFile}=context;
 const transport=new RelayTransport(invite.relay,invite.id,1);
 let manifest=readIf(manifestFile);
 if(!manifest){
  await waitForFunds(client,context.needed);
  say('Waiting for the host to create the match.');
  const offer=makeOffer(wallet,sessionWallet);
  manifest=await checkManifest(await waitForManifest({invite,offer,transport,log:say}),invite,{wallet:address,session:sessionHex(sessionWallet)});
  writePrivate(manifestFile,JSON.stringify(manifest));
 }
 let state=await read(client,manifest);
 for(let i=0;!state&&i<60;i++){await pause(2000);state=await read(client,manifest);}
 if(!state)throw Error('The host says the match exists, but it isn’t on chain');
 if(state.phase===WAITING){say('Joining the match.');await sendJoin({client,wallet,sessionWallet,manifest,reserve});}
 else if(state.phase===COMPLETE||state.retired)say('This match has already finished.');
 await play(invite,context,manifest);
}
const describeTerms=invite=>[`  Buy-in      ${formatSol(invite.buyIn)} SOL`,`  Blinds      ${formatSol(invite.bigBlind/2)} / ${formatSol(invite.bigBlind)} SOL`,`  Hands       up to ${invite.hands}`,`  Clock       ${invite.seconds} seconds per move if a hand goes to the chain`,`  Thinking    ${invite.think} seconds per decision`,`  Host        ${invite.host}`,`  Contract    ${invite.program}`].join('\n');
async function confirm(invite){
 say(`You've been invited to a match:\n${describeTerms(invite)}`);
 if(process.argv.includes('--yes'))return;
 if(!process.stdin.isTTY)throw Error('Pass --yes to accept these terms when not running in a terminal');
 const prompt=createInterface({input:process.stdin,output:process.stderr});
 const answer=await prompt.question('Put this at stake and join? [y/N] ');prompt.close();
 if(!/^y(es)?$/i.test(answer.trim()))throw Error('Not joining');
}
if(command==='wallet'){
 const client=new ChainClient(rpcs[0],'11111111111111111111111111111111',wallet,{allowLocal});
 const genesis=await client.checkNetwork();
 console.log(JSON.stringify({address,balance:formatSol(Number(await client.connection.getBalance(wallet.publicKey,'confirmed'))),network:genesis}));
}else if(command==='host'){
 const relay=option('--relay',process.env.AGENT_STACKS_RELAY);
 if(!relay)throw Error('--relay is required: the address of a relay both players can reach');
 const buyIn=parseSol(option('--buy-in','0.001'));
 const bigBlind=option('--big-blind')?parseSol(option('--big-blind')):Math.max(2,Math.floor(buyIn/100)*2);
 const probe=new ChainClient(rpcs[0],'11111111111111111111111111111111',wallet,{allowLocal});
 const genesis=await probe.checkNetwork(),deployment=await trustedProgram(probe,genesis);
 const invite=newInvite({relay,program:deployment.program,genesis,host:address,buyIn,bigBlind,hands:whole('--hands',10),seconds:whole('--clock',600),think:whole('--think',20)});
 const {directory,needed}=await prepare(invite,{creating:true});
 say(`Send this code to the other player, privately. Whoever uses it first takes the seat:\n`);
 console.log(encodeInvite(invite));
 say(`\n${describeTerms(invite)}\nThis wallet needs ${formatSol(needed)} SOL for the match. All of it but the stake comes back at the end, apart from small fees and about 0.001 SOL the host leaves on chain for good, so this match's address can't be reused.\nIf this stops, carry on with: node scripts/stacks.js resume <the code above>\nFiles: ${directory}`);
 await asHost(invite);
}else if(command==='join'||command==='resume'){
 const invite=decodeInvite(args[0]??'');
 if(invite.host===address)await asHost(invite);
 else{if(!existsSync(join(home,invite.id,'manifest.json'))&&command==='join')await confirm(invite);await asGuest(invite);}
}else throw Error('Unknown command. See the top of this file.');
process.exit(0);
