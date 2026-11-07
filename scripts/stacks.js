// One command each to play someone. The host gets a message to send them, and they give it to their agent.
//   node scripts/stacks.js host --relay URL [--buy-in SOL] [--big-blind SOL] [--hands N] [--clock SECONDS] [--think SECONDS] [--fund-guest] [--decide COMMAND]
//   node scripts/stacks.js join CODE [--yes] [--decide COMMAND]
//   node scripts/stacks.js next [--wait SECONDS]                  What there is to decide now, when playing turn by turn
//   node scripts/stacks.js move ID WORD [AMOUNT] [--wait SECONDS] Answers it: fold, check, call, raise TO, all-in, show or muck
//   node scripts/stacks.js resume [CODE] [--decide COMMAND]       Carries on after a crash, for either player
//   node scripts/stacks.js wallet                                 This player's address and balance
// Without --decide, the match runs in the background and this command returns, and next and move make the decisions.
// --foreground keeps it attached instead, and --check-call plays with no decisions at all, only checking and calling.
// All of them also take --home DIRECTORY, --wallet FILE, --rpc URL[,URL...] and --deployment FILE.
// The code is a bearer invitation: whoever uses it first takes the seat, so send it privately.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {closeSync,existsSync,openSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {ChainClient,DEVNET,PublicKey,SystemProgram,ensureWallet,loadWallet} from '../src/solana/client.js';
import {verifyPinnedProgram} from '../src/solana/trusted-agent.js';
import {privateDirectory,readPrivate,writePrivate} from '../src/private-files.js';
import {ChannelChain,COMPLETE,WAITING,withBytes} from '../src/channel/chain.js';
import {RelayTransport,SealedTransport} from '../src/channel/relay.js';
import {playMatch} from '../src/channel/agent.js';
import {checkDecisionProgram} from '../src/channel/decider.js';
import {isTestNetwork,trustedDeployment} from '../src/channel/deployments.js';
import {buildManifest,fundsNeeded,makeOffer,reserveNeeded,sendClaim,sendCreate,sendJoin,sendRetire,sendSweep,sessionHex,tryToSpend} from '../src/channel/setup.js';
import {checkManifest,decodeInvite,encodeInvite,formatSol,matchKey,matchMailbox,newInvite,parseSol,seal,waitForManifest,waitForOffer} from '../src/channel/invite.js';
import {finishTurns,matchRunning,moveTaken,nextTurn,recordProcess,submitMove,TurnDecider} from '../src/channel/turns.js';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const flag=name=>process.argv.includes(name);
const whole=(name,fallback)=>{const n=Number(option(name,fallback));if(!Number.isSafeInteger(n)||n<=0)throw Error(`Invalid ${name}`);return n;};
const say=text=>process.stderr.write(`${text}\n`);
// Someone running this wants to know what went wrong, not where in the code. Set AGENT_STACKS_DEBUG for that.
process.on('uncaughtException',error=>{say(process.env.AGENT_STACKS_DEBUG?error.stack:`Stopped: ${error.message}`);process.exit(1);});
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const home=resolve(option('--home',process.env.AGENT_STACKS_HOME??join(ROOT,'.agent-stacks/play')));
const rpcs=(option('--rpc')??process.env.AGENT_STACKS_RPC??DEVNET).split(',').filter(Boolean);
const allowLocal=process.env.AGENT_STACKS_ALLOW_LOCAL==='1',decide=option('--decide');
const byTurns=!decide&&!flag('--check-call'),background=byTurns&&!flag('--foreground');
const seconds=name=>{const n=Number(process.env[name]??NaN);return Number.isFinite(n)?n:null;};
const readIf=file=>existsSync(file)?JSON.parse(readPrivate(file,'utf8')):null;
privateDirectory(home);
const [command,...args]=process.argv.slice(2);
const flagAt=args.findIndex(arg=>arg.startsWith('--')),positional=flagAt<0?args:args.slice(0,flagAt);
const currentFile=join(home,'current');
// As it should be typed, so what's printed works if it's copied.
const typed=words=>`node scripts/stacks.js ${words}${option('--home')?` --home ${option('--home')}`:''}`;
// These two only talk to a match already running here. They need no wallet and no network.
if(command==='next'||command==='move'){
 if(!existsSync(currentFile))throw Error(`No match has been started from ${home}. Start one with join or host first.`);
 const directory=join(home,readPrivate(currentFile,'utf8').trim(),'turns');
 const waitSeconds=Number(option('--wait',60));
 if(!Number.isFinite(waitSeconds)||waitSeconds<0)throw Error('Invalid --wait');
 let moved=null;
 if(command==='move'){
  const [id,...words]=positional;
  if(!id||!words.length)throw Error(`Say which decision and what to do, such as: ${typed('move ID call')}`);
  moved={id,...submitMove(directory,id,words)};
  await moveTaken(directory);
 }
 const result=await nextTurn(directory,{waitMs:waitSeconds*1000,command:typed});
 if(result.since?.some(event=>event.type==='missed'&&event.id===moved?.id))moved=null;
 console.log(JSON.stringify(moved?{moved,...result}:result));
 process.exit(0);
}
const explicitWallet=option('--wallet');
const wallet=explicitWallet?await loadWallet(resolve(explicitWallet)):await ensureWallet(join(home,'wallet-keypair.json'));
const address=wallet.publicKey.toBase58();
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
 return {client,directory,sessionWallet,reserve,needed:await fundsNeeded(client,{buyIn:invite.buyIn,reserve,creating}),guestNeeded:await fundsNeeded(client,{buyIn:invite.buyIn,reserve,creating:false}),manifestFile:join(directory,'manifest.json')};
}
const read=(client,manifest)=>new ChannelChain(client,withBytes(manifest)).read();
// So that next and move can find this match, and can tell whether it's still running.
function announce(invite,directory){
 if(!byTurns)return;
 writePrivate(currentFile,invite.id);
 recordProcess(join(directory,'turns'),process.pid);
}
async function play(invite,{client,directory,sessionWallet,manifestFile},manifest,alongside=null){
 say('Playing. This can be stopped and resumed: a crash or lost connection costs nothing if it’s back within the clock.');
 const turnsDirectory=join(directory,'turns');
 const stopped={now:false};
 const beside=alongside?alongside(stopped):null;
 const outcome=await playMatch({sessionFile:join(directory,'session-keypair.json'),directory:join(directory,'state'),manifestFile,relay:invite.relay,rpcs,decide,turns:byTurns?new TurnDecider(turnsDirectory,{limitMs:invite.think*1000,log:say}):null,think:invite.think,stallSeconds:seconds('AGENT_STACKS_STALL_SECONDS'),pollSeconds:seconds('AGENT_STACKS_POLL_SECONDS'),allowLocal,makeTransport:seat=>new SealedTransport(new RelayTransport(invite.relay,matchMailbox(invite),seat),matchKey(invite),seat)});
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
 const walletBalance=Number(await client.connection.getBalance(wallet.publicKey,'confirmed'));
 const over=`Match over after ${outcome.results.length} hand${outcome.results.length===1?'':'s'}.`;
 const summary=mine!==null?`${over} You started with ${formatSol(invite.buyIn)} SOL and finished with ${formatSol(mine)} SOL.`:`${over} The match has been closed and its history can’t be read right now, so this can’t say what you won. Your wallet holds ${formatSol(walletBalance)} SOL.`;
 say(summary);
 if(byTurns)finishTurns(turnsDirectory,{summary,started:invite.buyIn,finished:mine,hands:outcome.results.length,walletBalance,match:manifest.match});
 console.log(JSON.stringify({complete:true,match:manifest.match,seat:outcome.seat,payouts:outcome.payouts,buyIn:invite.buyIn,hands:outcome.results.length,results:outcome.results,...outcome.stats,walletBalance}));
}
// The guest's offer is signed by its wallet, and the code only gets one in, so this can only happen once per code. On
// a crash it looks again, and a test network makes the rare double payment harmless. Real money would need more care.
const TRANSFER_FEE=5000;
async function fundGuest({client,needed,guestNeeded},invite,offer){
 if(!allowLocal&&!isTestNetwork(invite.genesis))throw Error('Refusing to send the other player funds on a network that isn’t a test network');
 const guest=new PublicKey(offer.wallet);
 for(;;){
  const short=guestNeeded-Number(await client.connection.getBalance(guest,'confirmed'));
  if(short<=0)return;
  await waitForFunds(client,needed+short+TRANSFER_FEE);
  say(`Sending ${formatSol(short)} test SOL to the other player’s wallet.`);
  if(await tryToSpend(client,wallet,needed+short+TRANSFER_FEE,()=>client.send([SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:guest,lamports:BigInt(short)})])))return;
 }
}
// Nobody's deposit should sit waiting on a player who can't pay.
async function waitForGuestFunds({client,guestNeeded},offer){
 const guest=new PublicKey(offer.wallet);
 for(let told=false;;told=true){
  const have=Number(await client.connection.getBalance(guest,'confirmed'));
  if(have>=guestNeeded)return;
  if(!told)say(`The other player is here, and their wallet ${offer.wallet} holds ${formatSol(have)} SOL of the ${formatSol(guestNeeded)} it needs. This carries on once it has it.`);
  await pause(10_000);
 }
}
async function asHost(invite){
 const context=await prepare(invite,{creating:true}),{client,directory,sessionWallet,reserve,manifestFile}=context;
 announce(invite,directory);
 const transport=new RelayTransport(invite.relay,invite.id,0);
 const offerFile=join(directory,'offer.json');
 let offer=readIf(offerFile);
 if(!offer){
  say('Waiting for the other player. No money moves until they’ve accepted.');
  offer=await waitForOffer({invite,transport,log:say});
  writePrivate(offerFile,JSON.stringify(offer));
 }
 // Saved first: it holds the nonce, without which the deposit couldn't be found again.
 let manifest=readIf(manifestFile);
 if(!manifest){
  if(invite.fund)await fundGuest(context,invite,offer);
  await waitForFunds(client,context.needed);
  await waitForGuestFunds(context,offer);
  manifest=await buildManifest({client,wallet,sessionWallet,offer,program:invite.program,buyIn:invite.buyIn,bigBlind:invite.bigBlind,hands:invite.hands,seconds:invite.seconds});
  writePrivate(manifestFile,JSON.stringify(manifest));
 }
 while(!await read(client,manifest)){
  await waitForFunds(client,context.needed);
  say('Creating the match.');
  if(await tryToSpend(client,wallet,context.needed,()=>sendCreate({client,wallet,sessionWallet,manifest,reserve})))break;
 }
 // Until they've joined, in case the relay lost it. A relay can't change it without the invite's secret.
 const repeat=async stopped=>{
  for(;!stopped.now;await pause(5000)){
   const state=await read(client,manifest).catch(()=>null);
   if(state&&state.phase!==WAITING)return;
   await transport.send(seal(invite,'manifest',manifest)).catch(error=>say(`relay: ${error.message}`));
  }
 };
 await play(invite,context,manifest,repeat);
}
async function asGuest(invite){
 const context=await prepare(invite,{creating:false}),{client,directory,sessionWallet,reserve,manifestFile}=context;
 announce(invite,directory);
 const transport=new RelayTransport(invite.relay,invite.id,1);
 let manifest=readIf(manifestFile);
 if(!manifest){
  // The offer goes first, because a host paying for this wallet has to hear about it, and one who isn't waits for it.
  const have=Number(await client.connection.getBalance(wallet.publicKey,'confirmed'));
  if(have<context.needed)say(invite.fund?`This wallet, ${address}, needs ${formatSol(context.needed)} SOL, and the host is sending it test SOL once they see you’re here.`:`Wallet ${address} holds ${formatSol(have)} SOL and this match needs ${formatSol(context.needed)}. Send the difference there, and this carries on once it arrives.`);
  say('Waiting for the host to create the match.');
  const offer=makeOffer(wallet,sessionWallet);
  manifest=await checkManifest(await waitForManifest({invite,offer,transport,log:say}),invite,{wallet:address,session:sessionHex(sessionWallet)});
  writePrivate(manifestFile,JSON.stringify(manifest));
 }
 let state=await read(client,manifest);
 for(let i=0;!state&&i<60;i++){await pause(2000);state=await read(client,manifest);}
 if(!state)throw Error('The host says the match exists, but it isn’t on chain');
 if(state.phase===WAITING){await waitForFunds(client,context.needed);say('Joining the match.');await sendJoin({client,wallet,sessionWallet,manifest,reserve});}
 else if(state.phase===COMPLETE||state.retired)say('This match has already finished.');
 await play(invite,context,manifest);
}
const describeTerms=invite=>[`  Buy-in      ${formatSol(invite.buyIn)} SOL`,`  Blinds      ${formatSol(invite.bigBlind/2)} / ${formatSol(invite.bigBlind)} SOL`,`  Hands       up to ${invite.hands}`,`  Clock       ${invite.seconds} seconds per move if a hand goes to the chain`,`  Thinking    ${invite.think} seconds per decision`,`  Host        ${invite.host}`,`  Contract    ${invite.program}`,...(invite.fund?['  Funding     the host sends your wallet what it needs, in test SOL']:[])].join('\n');
async function confirm(invite){
 say(`You've been invited to a match:\n${describeTerms(invite)}`);
 if(flag('--yes'))return;
 if(!process.stdin.isTTY)throw Error('Pass --yes to accept these terms when not running in a terminal');
 const prompt=createInterface({input:process.stdin,output:process.stderr});
 const answer=await prompt.question('Put this at stake and join? [y/N] ');prompt.close();
 if(!/^y(es)?$/i.test(answer.trim()))throw Error('Not joining');
}
// An agent's shell usually won't let one command run for a whole match, so the match goes on without it. Everything
// it needs is on disk, so if a machine or a shell kills it, resume picks it up.
async function inBackground(invite,directory){
 const turnsDirectory=join(directory,'turns'),logFile=join(directory,'log.txt');
 privateDirectory(turnsDirectory);
 writePrivate(currentFile,invite.id);
 if(matchRunning(turnsDirectory))say('This match is already running.');
 else{
  const log=openSync(logFile,'a',0o600);
  const passed=['--wallet','--deployment'].flatMap(name=>option(name)?[name,resolve(option(name))]:[]);
  // The match's name, not its code, so that the code's secret stays out of the process list.
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'resume',invite.id,'--foreground',...passed],{detached:true,stdio:['ignore',log,log],env:{...process.env,AGENT_STACKS_HOME:home,AGENT_STACKS_RPC:rpcs.join(',')}});
  child.unref();closeSync(log);
  recordProcess(turnsDirectory,child.pid);
  const exited=await Promise.race([once(child,'exit'),pause(1500).then(()=>null)]);
  if(exited)throw Error(`The match stopped straight away. See ${logFile}`);
 }
 if(invite.think<60)say(`Note: ${invite.think} seconds per decision is short for playing turn by turn, so some decisions may go by. The host sets this with --think.`);
 say(`The match is running in the background, and its log is at ${logFile}. Now run this, and keep going until it says "over":\n  ${typed('next')}`);
 console.log(JSON.stringify({started:true,next:typed('next'),log:logFile}));
}
// Everything between the lines goes to the other player. The agent is told to check with its owner, because that's who
// should be deciding whether to run someone else's code, and whoever sends this chooses which code that is. The code
// comes last, with nothing after it, because an agent copying it can take a full stop for part of it.
function challengeMessage(invite,code){
 const {repository}=JSON.parse(readFileSync(join(ROOT,'package.json'),'utf8'));
 return `Send everything between the lines to the other player, privately:
------------------------------------------------------------------------
Fancy a game of heads-up poker, my agent against yours? It's for test tokens on Solana devnet that have no real value, up to ${invite.hands} hands. You'll need an agent that can run shell commands. Paste this to it:

I've been challenged to a poker match by someone I know. Read the README at ${repository.url} and tell me what it will do on this machine. If I say go ahead, play the match for me. The challenge code is ${code}

Anyone holding that code can take your seat, so keep it to yourself.
------------------------------------------------------------------------`;
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
 const think=whole('--think',20),fund=flag('--fund-guest');
 const probe=new ChainClient(rpcs[0],'11111111111111111111111111111111',wallet,{allowLocal});
 const genesis=await probe.checkNetwork(),deployment=await trustedProgram(probe,genesis);
 if(fund&&!allowLocal&&!isTestNetwork(genesis))throw Error('--fund-guest only works on a test network');
 if(decide)await checkDecisionProgram(decide,{limitMs:think*1000});
 const invite=newInvite({relay,program:deployment.program,genesis,host:address,buyIn,bigBlind,hands:whole('--hands',10),seconds:whole('--clock',600),think,fund});
 const {client,directory,needed,guestNeeded}=await prepare(invite,{creating:true});
 const code=encodeInvite(invite),total=needed+(fund?guestNeeded+TRANSFER_FEE:0);
 console.log(code);
 say(`\n${describeTerms(invite)}\n\nThis wallet, ${address}, holds ${formatSol(Number(await client.connection.getBalance(wallet.publicKey,'confirmed')))} SOL and needs ${formatSol(total)} SOL for the match. All of what it stakes comes back at the end but for the result, small fees and about 0.001 SOL the host leaves on chain for good, so this match's address can't be reused.${fund?` ${formatSol(guestNeeded)} SOL of it goes to the other player's wallet and stays there.`:''}\nIf this stops, carry on with: ${typed(`resume ${code}`)}\nFiles: ${directory}\n\n${challengeMessage(invite,code)}\n`);
 if(background)await inBackground(invite,directory);
 else await asHost(invite);
}else if(command==='join'||command==='resume'){
 const named=args.find(arg=>arg.startsWith('stacks1.'))??positional[0];
 // Resuming can go by the match's name, or by the last one started here.
 const saved=command==='resume'?named??(existsSync(currentFile)?readPrivate(currentFile,'utf8').trim():null):null;
 const savedCode=saved&&!saved.startsWith('stacks1.')&&/^[1-9A-HJ-NP-Za-km-z]+$/.test(saved)?join(home,saved,'invite.txt'):null;
 const invite=decodeInvite(savedCode&&existsSync(savedCode)?readPrivate(savedCode,'utf8'):named??'');
 const isHost=invite.host===address,accepted=existsSync(join(home,invite.id,'manifest.json'));
 if(!isHost&&!accepted&&command==='join')await confirm(invite);
 if(decide&&command==='join'&&!accepted)await checkDecisionProgram(decide,{limitMs:invite.think*1000});
 if(background){
  const {directory}=await prepare(invite,{creating:isHost});
  await inBackground(invite,directory);
 }else if(isHost)await asHost(invite);
 else await asGuest(invite);
}else throw Error('Unknown command. See the top of this file.');
process.exit(0);
