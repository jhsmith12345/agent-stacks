// Read-only unless --apply or --rebroadcast is explicit. Never re-signs or sends a replacement;
// --rebroadcast redelivers only the original signed bytes.
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {loadTrustPolicy,trustedClient,reconcilePending,verifyPinnedProgram} from '../src/solana/trusted-agent.js';
import {PublicKey} from '../src/solana/client.js';
import {acquireLock} from '../src/lock.js';
import {appendPrivate} from '../src/private-files.js';
const [manifest,directory,player]=process.argv.slice(2);
if(!manifest||!directory||!player)throw Error('Usage: node scripts/reconcile-agent.js MANIFEST PRIVATE_DIRECTORY PLAYER_PUBLIC_KEY [--apply] [--rebroadcast]');
const config=JSON.parse(readFileSync(resolve(manifest),'utf8'));
const policy=loadTrustPolicy(process.env.AGENT_STACKS_TRUST_POLICY);
const release=acquireLock(resolve(directory),'agent.lock');
try{
 const {client,guard}=trustedClient(policy,config,{publicKey:new PublicKey(player)},resolve(directory),()=>{});
 if(await client.checkNetwork()!==policy.genesis)throw Error('Wrong pinned genesis');
 await verifyPinnedProgram(client.connection,policy);
 const result=await reconcilePending(guard,{apply:process.argv.includes('--apply'),rebroadcast:process.argv.includes('--rebroadcast')});
 if(result.applied)appendPrivate(resolve(directory,'transactions.ndjson'),JSON.stringify({at:new Date().toISOString(),signature:result.signature,status:{failed:'failed',expired:'expired',succeeded:'confirmed'}[result.outcome],reconciled:true})+'\n');
 console.log(JSON.stringify(result,null,2));
}finally{release();}
