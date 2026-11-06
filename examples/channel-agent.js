// A player's agent for a channel match. It holds the session key and the match state, and nothing else.
// --decide runs your own program to make the poker decisions. See docs/connect-your-agent.md.
//   node examples/channel-agent.js SESSION_KEYPAIR STATE_DIRECTORY --manifest FILE --relay URL --rpc URL[,URL...] [--decide COMMAND --think SECONDS]
import {playMatch} from '../src/channel/agent.js';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const [sessionFile,directory]=process.argv.slice(2);
const manifestFile=option('--manifest'),relay=option('--relay'),rpcs=(option('--rpc')??process.env.AGENT_STACKS_RPC??'').split(',').filter(Boolean);
if(!sessionFile||!directory||!manifestFile||!relay||!rpcs.length)throw Error('Usage: node examples/channel-agent.js SESSION_KEYPAIR STATE_DIRECTORY --manifest FILE --relay URL --rpc URL[,URL...] [--decide COMMAND --think SECONDS]');
const think=Number(option('--think',20));
if(!Number.isFinite(think)||think<=0)throw Error('--think must be a number of seconds');
const seconds=name=>{const n=Number(process.env[name]??NaN);return Number.isFinite(n)?n:null;};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>process.exit(0));
const {manifest,...result}=await playMatch({sessionFile,directory,manifestFile,relay,rpcs,decide:option('--decide'),think,stallSeconds:seconds('AGENT_STACKS_STALL_SECONDS'),pollSeconds:seconds('AGENT_STACKS_POLL_SECONDS'),allowLocal:process.env.AGENT_STACKS_ALLOW_LOCAL==='1'});
void manifest;
const {stats,...rest}=result;
console.log(JSON.stringify({complete:true,...rest,...stats}));
process.exit(0);
