// One player's agent for a channel match. It needs no node of its own: during play it only talks to a
// relay it doesn't trust, and it reads the chain only to notice a dispute and to settle.
// Usage: node examples/channel-agent.js SESSION_KEYPAIR STATE_DIRECTORY --manifest FILE --relay URL --rpc URL[,URL...]
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {ChainClient,ensureWallet} from '../src/solana/client.js';
import {readPrivate,writePrivate,privateDirectory} from '../src/private-files.js';
import {acquireLock} from '../src/lock.js';
import {sessionFromSeed} from '../src/channel/keys.js';
import {ChannelPeer} from '../src/channel/peer.js';
import {ChannelChain,channelAddress,channelTerms,withBytes} from '../src/channel/chain.js';
import {ChannelRunner} from '../src/channel/runner.js';
import {RelayTransport} from '../src/channel/relay.js';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const [sessionFile,directoryArg]=process.argv.slice(2);
const manifestFile=option('--manifest'),relayUrl=option('--relay'),rpcs=(option('--rpc')??process.env.AGENT_STACKS_RPC??'').split(',').filter(Boolean);
if(!sessionFile||!directoryArg||!manifestFile||!relayUrl||!rpcs.length)throw Error('Usage: node examples/channel-agent.js SESSION_KEYPAIR STATE_DIRECTORY --manifest FILE --relay URL --rpc URL[,URL...]');
const directory=resolve(directoryArg);mkdirSync(directory,{recursive:true,mode:0o700});privateDirectory(directory);
const release=acquireLock(directory,'agent.lock');process.once('exit',release);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>process.exit(0));
const wallet=await ensureWallet(resolve(sessionFile));
const session=sessionFromSeed(Buffer.from(wallet.secretKey).subarray(0,32));
const manifest=JSON.parse(readFileSync(resolve(manifestFile),'utf8'));
// Everything an agent acts on is checked here against terms its owner accepted, not read from a node.
if(channelTerms(manifest)!==manifest.terms)throw Error('The manifest’s terms hash does not match its terms');
const [address]=await channelAddress(manifest.program,manifest.players[0],Buffer.from(manifest.nonce,'hex'));
if(address.toBase58()!==manifest.match)throw Error('The manifest’s match address does not match its creator and nonce');
const seat=manifest.sessions.indexOf(Buffer.from(session.publicKey).toString('hex'));
if(seat<0)throw Error('This session key is not in the match');
const config=withBytes(manifest);
const file=resolve(directory,`${manifest.match}.state.json`);
const store={save:state=>writePrivate(file,JSON.stringify(state))};
const state=existsSync(file)?JSON.parse(readPrivate(file,'utf8')):null;
const strategy=view=>view.owed>0?{action:2}:{action:1};
const peer=new ChannelPeer(config,session,seat,{strategy,store,state});
const allowLocal=process.env.AGENT_STACKS_ALLOW_LOCAL==='1';
const chains=rpcs.map(url=>new ChannelChain(new ChainClient(url,manifest.program,wallet,{allowLocal}),config));
const log=text=>process.stderr.write(`Agent ${seat}: ${text}\n`);
for(const chain of chains){const genesis=await chain.client.checkNetwork();if(genesis!==manifest.genesis)throw Error('This RPC is on a different chain from the manifest');}
const seconds=name=>Number(process.env[name]??NaN);
const runner=new ChannelRunner({peer,chains,transport:new RelayTransport(relayUrl,manifest.match,seat),bufferKey:(seq,attempt)=>ensureWallet(resolve(directory,`${manifest.match}.buffer-${seq}-${attempt}-keypair.json`)),log,
 ...(Number.isFinite(seconds('AGENT_STACKS_STALL_SECONDS'))?{stallMs:seconds('AGENT_STACKS_STALL_SECONDS')*1000}:{}),
 ...(Number.isFinite(seconds('AGENT_STACKS_POLL_SECONDS'))?{pollMs:seconds('AGENT_STACKS_POLL_SECONDS')*1000,chainPollMs:Math.max(1000,seconds('AGENT_STACKS_POLL_SECONDS')*1000*5)}:{})});
const result=await runner.run();
console.log(JSON.stringify({complete:true,seat,payouts:result.payouts,seq:peer.state.latest?.seq??0,hand:peer.state.hand,rejected:peer.state.rejected,...result.stats}));
process.exit(0);
