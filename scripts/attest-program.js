import {loadTrustPolicy,verifyPinnedProgram} from '../src/solana/trusted-agent.js';
import {ChainClient} from '../src/solana/client.js';
const policy=loadTrustPolicy(process.env.AGENT_STACKS_TRUST_POLICY);
const client=new ChainClient(policy.rpc,policy.program,null,{allowLocal:policy.allowLocal});
if(await client.checkNetwork()!==policy.genesis)throw Error('Wrong genesis');
console.log(JSON.stringify({genesis:policy.genesis,program:policy.program,testOnly:true,trust:'operator-controlled-validator',...await verifyPinnedProgram(client.connection,policy)},null,2));
