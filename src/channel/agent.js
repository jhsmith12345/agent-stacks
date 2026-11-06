// Runs one player's side of a match to the end, with its keys and saved state on this machine.
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {ChainClient,ensureWallet} from '../solana/client.js';
import {acquireLock} from '../lock.js';
import {privateDirectory,readPrivate,writePrivate} from '../private-files.js';
import {sessionFromSeed} from './keys.js';
import {ChannelChain,withBytes} from './chain.js';
import {ChannelPeer} from './peer.js';
import {ChannelRunner} from './runner.js';
import {RelayTransport} from './relay.js';
import {DecisionProgram} from './decider.js';
import {acceptedManifest} from './manifest.js';
// `decide` is a command that makes the poker decisions, within `think` seconds each. Without one, this agent
// only checks and calls. It goes to the chain after `stallSeconds` of silence from the opponent, and that's
// never less than three times the thinking time, since the opponent may be thinking.
export async function playMatch({sessionFile,directory:directoryArg,manifestFile,relay,rpcs,decide=null,think=20,stallSeconds=null,pollSeconds=null,allowLocal=false,log:write=text=>process.stderr.write(`${text}\n`)}){
 const directory=resolve(directoryArg);mkdirSync(directory,{recursive:true,mode:0o700});privateDirectory(directory);
 // A crash or power cut leaves a lock behind. The agent takes it over only once its holder is provably gone.
 const release=acquireLock(directory,'agent.lock',{reclaimDead:true});process.once('exit',release);
 const wallet=await ensureWallet(resolve(sessionFile));
 const session=sessionFromSeed(Buffer.from(wallet.secretKey).subarray(0,32));
 // Everything an agent acts on is checked against terms its owner accepted, not read from a node.
 const manifest=await acceptedManifest(manifestFile,directory);
 const seat=manifest.sessions.indexOf(Buffer.from(session.publicKey).toString('hex'));
 if(seat<0)throw Error('This session key is not in the match');
 const log=text=>write(`Agent ${seat}: ${text}`);
 const config=withBytes(manifest);
 const file=resolve(directory,`${manifest.match}.state.json`);
 const store={save:state=>writePrivate(file,JSON.stringify(state))};
 const state=existsSync(file)?JSON.parse(readPrivate(file,'utf8')):null;
 const strategy=view=>view.owed>0?{action:2}:{action:1};
 const decider=decide?new DecisionProgram(decide,{limitMs:think*1000,log}):null;
 const closeDecider=()=>decider?.close();process.once('exit',closeDecider);
 if(!decider)log('No decision program, so this agent only checks and calls');
 const peer=new ChannelPeer(config,session,seat,{strategy,store,state,outside:!!decider});
 const chains=rpcs.map(url=>new ChannelChain(new ChainClient(url,manifest.program,wallet,{allowLocal}),config));
 for(const chain of chains){const genesis=await chain.client.checkNetwork();if(genesis!==manifest.genesis)throw Error('This RPC is on a different chain from the manifest');}
 const stallMs=Math.max((stallSeconds??60)*1000,think*3000);
 const runner=new ChannelRunner({peer,chains,transport:new RelayTransport(relay,manifest.match,seat),bufferKey:(seq,attempt)=>ensureWallet(resolve(directory,`${manifest.match}.buffer-${seq}-${attempt}-keypair.json`)),log,decider,stallMs,
  ...(pollSeconds===null?{}:{pollMs:pollSeconds*1000,chainPollMs:Math.max(1000,pollSeconds*5000),disputePollMs:Math.max(1000,pollSeconds*5000)})});
 try{
  const result=await runner.run();
  return {manifest,seat,payouts:result.payouts,stats:result.stats,seq:peer.state.latest?.seq??0,hand:peer.state.hand,rejected:peer.state.rejected,results:peer.state.results??[]};
 }finally{closeDecider();release();process.removeListener('exit',release);process.removeListener('exit',closeDecider);}
}
