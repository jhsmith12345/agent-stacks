// The operator tools for a public devnet run, driven as real processes against a scripted RPC whose URL
// carries an API key. That key must not reach a manifest, a report or any output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {getBase58Decoder} from '@solana/kit';
import {DEVNET,DEVNET_GENESIS,Keypair,LAYOUT,PublicKey,ensureWallet,manifestRpc,redactRpc,termsHash,u64} from '../src/solana/client.js';
import {PROOF_ACCOUNT_BYTES,strictFundingRequired} from '../src/solana/trusted-agent.js';
import {writePrivate} from '../src/private-files.js';

const SECRET='sentinel-api-key-do-not-leak';
const LOADER='BPFLoader2111111111111111111111111111111111';
const script=name=>fileURLToPath(new URL(`../scripts/${name}`,import.meta.url));
const ARTIFACT=Buffer.from('test program fixture');
const STATUS={slot:1,confirmations:null,err:null,status:{Ok:null},confirmationStatus:'finalized'};

async function scriptedNode(t,{genesis=DEVNET_GENESIS,balance=50_000_000_000,lamportsPerByte=5080,enforceMinContext=true,failEvery=0,failAfter=0,limitEvery=0}={}){
 const node={genesis,balance,lamportsPerByte,enforceMinContext,accounts:new Map(),history:[],sent:0,failEvery,failAfter,limitEvery,slotReads:0,requests:0};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  node.requests++;
  if((node.failEvery&&node.requests%node.failEvery===0)||(node.failAfter&&node.requests>node.failAfter)){res.writeHead(503);res.end('temporarily unavailable');return;}
  const request=JSON.parse(raw);let result,error;const slot=1000;
  if(node.limitEvery&&request.method==='getSlot'&&++node.slotReads%node.limitEvery===0){res.writeHead(429);res.end('Too many requests');return;}
  const context={context:{slot}};
  switch(request.method){
   case 'getGenesisHash':result=node.genesis;break;
   case 'getVersion':result={'solana-core':'4.4.0','feature-set':1};break;
   case 'getSlot':result=slot;break;
   case 'getBlockHeight':result=500;break;
   case 'getBalance':result={...context,value:node.balance};break;
   case 'getMinimumBalanceForRentExemption':result=(request.params[0]+128)*node.lamportsPerByte;break;
   case 'getRecentPrioritizationFees':result=[];break;
   case 'getLatestBlockhash':result={...context,value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:600}};break;
   case 'getFeeForMessage':result={...context,value:5000};break;
   case 'simulateTransaction':result={...context,value:{err:null,logs:[]}};break;
   case 'sendTransaction':node.sent++;result='11111111111111111111111111111111';break;
   case 'getSignatureStatuses':result={...context,value:[STATUS]};break;
   case 'getSignaturesForAddress':result=node.history.map(({signature})=>({signature,slot,err:null,memo:null,blockTime:1,confirmationStatus:'finalized'}));break;
   case 'getTransaction':result=node.history.find(({signature})=>signature===request.params[0])?.tx??null;break;
   case 'getAccountInfo':{
    if(node.enforceMinContext&&request.params[1]?.minContextSlot>slot){error={code:-32016,message:'Minimum context slot has not been reached'};break;}
    const account=node.accounts.get(request.params[0]);
    result={...context,value:account?{owner:account.owner,lamports:1,executable:!!account.executable,rentEpoch:0,data:[account.data.toString('base64'),'base64'],space:account.data.length}:null};
    break;
   }
   default:error={code:-32601,message:`Unsupported test RPC method ${request.method}`};
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,...(error?{error}:{result})}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.close();server.closeAllConnections();});
 node.url=`http://127.0.0.1:${server.address().port}/?api-key=${SECRET}`;
 return node;
}
function workspace(t){const directory=mkdtempSync(join(tmpdir(),'stacks-devnet-tools-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return directory;}
const run=(file,args,{cwd,env={}})=>new Promise(resolve=>{
 const child=spawn(process.execPath,[file,...args],{cwd,env:{...process.env,AGENT_STACKS_RPC:undefined,AGENT_STACKS_WALLET:undefined,AGENT_STACKS_TRUST_POLICY:undefined,...env},stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',x=>{out+=x;});child.stderr.on('data',x=>{err+=x;});
 child.on('exit',code=>resolve({code,out,err}));
});
const everything=directory=>readdirSync(directory,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name));

const matchState=(config,creator,joiner,nonce,bump,{phase,version=3,hand=1})=>{
 const state=Buffer.alloc(LAYOUT.size);state.write('ASTKESC5');state[8]=phase;u64(version).copy(state,9);
 state.set(creator.publicKey.toBytes(),17);state.set(joiner.publicKey.toBytes(),49);u64(config.buyIn).copy(state,81);u64(config.turnSeconds).copy(state,89);
 state.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)+86_400),97);Buffer.from(config.terms,'hex').copy(state,105);nonce.copy(state,217);state[249]=bump;u64(config.bigBlind).copy(state,LAYOUT.blind);
 state.writeUInt32LE(hand,LAYOUT.hand);state.writeUInt32LE(config.maxHands,LAYOUT.maxHands);
 return state;
};

async function preflightSetup(t,{policyChanges={},nodeOptions={},programBytes=ARTIFACT,manifest=null,seat=0,onChain=null}={}){
 const directory=workspace(t),node=await scriptedNode(t,nodeOptions);
 const walletFile=join(directory,'wallet.json'),wallet=await ensureWallet(walletFile),opponent=await Keypair.generate(),program=await Keypair.generate();
 node.accounts.set(program.publicKey.toBase58(),{owner:LOADER,executable:true,data:programBytes});
 const policyFile=join(directory,'policy.json');
 writePrivate(policyFile,JSON.stringify({schema:'agent-stacks/trusted-node/v1',trust:'operator-controlled-validator',network:'test-only',rpc:node.url,genesis:DEVNET_GENESIS,program:program.publicKey.toBase58(),programSha256:createHash('sha256').update(ARTIFACT).digest('hex'),programBytes:ARTIFACT.length,allowLocal:true,allowUpgradeable:false,allowTestControls:false,allowCooperative:false,maxBuyIn:1_000_000,maxHands:2,minTurnSeconds:3600,maxTransactions:4000,maxFeePerTransaction:15_000,maxTotalFees:25_000_000,maxAccountRent:5_000_000_000,maxTotalOutflow:20_000_000_000,...policyChanges}));
 const args=['--policy',policyFile,'--wallet',walletFile,'--samples','3'];
 if(manifest){
  const creator=seat===0?wallet:opponent,joiner=seat===0?opponent:wallet;
  const nonce=Buffer.alloc(32,4),[match,bump]=await PublicKey.findProgramAddress([Buffer.from('escrow'),creator.publicKey.toBytes(),nonce],program.publicKey);
  const config={program:program.publicKey.toBase58(),players:[creator.publicKey.toBase58(),joiner.publicKey.toBase58()],match:match.toBase58(),nonce:nonce.toString('hex'),buyIn:1_000_000,bigBlind:20_000,maxHands:2,turnSeconds:86_400,genesis:DEVNET_GENESIS,...manifest};config.terms=termsHash(config);
  if(onChain){
   node.accounts.set(config.match,{owner:config.program,data:matchState(config,creator,joiner,nonce,bump,onChain)});
   const clock=Buffer.alloc(40);clock.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32);node.accounts.set('SysvarC1ock11111111111111111111111111111111',{owner:'Sysvar1111111111111111111111111111111111111',data:clock});
  }
  const file=join(directory,'manifest.json');writeFileSync(file,JSON.stringify(config));args.push('--manifest',file);
 }
 const result=await run(script('devnet-preflight.js'),args,{cwd:directory});
 assert.equal(result.out.includes(SECRET)||result.err.includes(SECRET),false,'the API key must not be printed');
 const report=JSON.parse(result.out);
 return {...result,report,status:name=>report.checks.find(c=>c.name===name)?.status,detail:name=>report.checks.find(c=>c.name===name)?.detail};
}

test('only an RPC URL with nothing private in it may travel with a manifest',()=>{
 assert.deepEqual(manifestRpc(DEVNET),{rpc:DEVNET});
 assert.deepEqual(manifestRpc('http://127.0.0.1:8899'),{rpc:'http://127.0.0.1:8899'});
 for(const url of ['https://rpc.example.com/?api-key=abc','https://rpc.example.com/v2/abc','http://127.0.0.1:8899/?api-key=abc','https://my-own-node.example.com'])assert.deepEqual(manifestRpc(url),{},url);
});
test('a redacted RPC URL keeps the host and drops the key',()=>{
 assert.equal(redactRpc('https://rpc.example.com/?api-key=abc'),'https://rpc.example.com/…');
 assert.equal(redactRpc('https://rpc.example.com/v2/abc'),'https://rpc.example.com/…');
 assert.equal(redactRpc(DEVNET),DEVNET);
});

test('preflight passes on a healthy node, and shows the terms to be confirmed',{timeout:30000},async t=>{
 const s=await preflightSetup(t,{manifest:{}});
 assert.equal(s.code,0,s.out);assert.equal(s.report.ready,true);
 assert.match(s.report.rpc,/^http:\/\/127\.0\.0\.1:\d+\/…$/);
 assert.equal(s.report.terms.seat,0);assert.equal(s.report.terms.buyIn,1_000_000);assert.equal(s.report.terms.hands,2);
 assert.equal(s.status('Funding'),'pass');assert.equal(s.status('Program pin'),'pass');assert.equal(s.status('Minimum context slot'),'pass');assert.equal(s.status('Rate limits'),'pass');
 assert.equal(s.status('Match on chain'),'warn','this invitation is not on chain yet');
});
test('preflight refuses a wallet that cannot cover the deposit, a proof buffer and fees',{timeout:30000},async t=>{
 const s=await preflightSetup(t,{nodeOptions:{balance:1_000_000_000}});
 assert.equal(s.code,1);assert.equal(s.report.ready,false);assert.equal(s.status('Funding'),'fail');
 assert.match(s.detail('Funding'),/below/);
});
test('preflight doesn’t ask for a deposit that’s already been paid',{timeout:30000},async t=>{
 const rent=(PROOF_ACCOUNT_BYTES+128)*5080,fees=2*710*15_000,exact=rent+fees;
 // The creator paid its deposit in creating the match, so rent and fees are all it still needs.
 const creator=await preflightSetup(t,{manifest:{},onChain:{phase:0},nodeOptions:{balance:exact}});
 assert.equal(creator.status('Match on chain'),'pass');assert.equal(creator.status('Funding'),'pass',creator.detail('Funding'));
 const short=await preflightSetup(t,{manifest:{},onChain:{phase:0},nodeOptions:{balance:exact-1}});
 assert.equal(short.status('Funding'),'fail');
 // The joiner still owes its deposit until it joins.
 const joiner=await preflightSetup(t,{manifest:{},seat:1,onChain:{phase:0},nodeOptions:{balance:exact}});
 assert.equal(joiner.report.terms.seat,1);assert.equal(joiner.status('Funding'),'fail');
 const joined=await preflightSetup(t,{manifest:{},seat:1,onChain:{phase:1},nodeOptions:{balance:exact}});
 assert.equal(joined.status('Funding'),'pass',joined.detail('Funding'));
 // Fewer hands left means less to pay for, and a finished match needs nothing.
 const later=await preflightSetup(t,{manifest:{},onChain:{phase:3,hand:2},nodeOptions:{balance:rent+fees/2}});
 assert.equal(later.status('Funding'),'pass',later.detail('Funding'));
 const done=await preflightSetup(t,{manifest:{},onChain:{phase:6},nodeOptions:{balance:0}});
 assert.equal(done.status('Funding'),'pass',done.detail('Funding'));
});
test('preflight looks again after a passing failure instead of blaming the endpoint',{timeout:60000},async t=>{
 const s=await preflightSetup(t,{manifest:{},nodeOptions:{failEvery:4}});
 assert.equal(s.report.ready,true,JSON.stringify(s.report.checks.filter(c=>c.status==='fail')));assert.equal(s.code,0);
});
test('a node that goes down still produces a report, and it says not ready',{timeout:60000},async t=>{
 const s=await preflightSetup(t,{nodeOptions:{failAfter:3}});
 assert.equal(s.code,1);assert.equal(s.report.ready,false);
 assert.ok(s.report.checks.some(c=>c.status==='fail'&&/503/.test(String(c.detail))),JSON.stringify(s.report.checks));
});
test('preflight reports the rate limits that the RPC library retries and hides',{timeout:30000},async t=>{
 const s=await preflightSetup(t,{nodeOptions:{limitEvery:2}});
 assert.equal(s.status('Rate limits'),'warn');assert.match(s.detail('Rate limits'),/of 3 requests were limited/);
 assert.equal(s.report.ready,true,'being limited slows a run without harming it');
});
test('preflight refuses an endpoint that ignores the minimum context slot',{timeout:30000},async t=>{
 const s=await preflightSetup(t,{nodeOptions:{enforceMinContext:false}});
 assert.equal(s.code,1);assert.equal(s.status('Minimum context slot'),'fail');
});
test('preflight refuses a deployed program that differs from the pin',{timeout:30000},async t=>{
 const s=await preflightSetup(t,{programBytes:Buffer.from('some other program bytes')});
 assert.equal(s.code,1);assert.equal(s.status('Program pin'),'fail');
});
test('preflight refuses a node on the wrong chain',{timeout:30000},async t=>{
 const s=await preflightSetup(t,{policyChanges:{genesis:'GqtGDjjEVSNMFqQpz2SG45tGXnqaWVJS8Xre5VC321qS'}});
 assert.equal(s.code,1);assert.equal(s.status('Cluster'),'fail');
});
test('preflight refuses terms beyond the policy, and warns about a key in a shared manifest',{timeout:30000},async t=>{
 const high=await preflightSetup(t,{manifest:{buyIn:2_000_000}});
 assert.equal(high.code,1);assert.equal(high.status('Accepted terms'),'fail');
 const shared=await preflightSetup(t,{manifest:{rpc:'https://rpc.example.com/v2/abc'}});
 assert.equal(shared.status('Manifest RPC'),'warn');
});
test('preflight labels a third-party RPC run as timing evidence only',{timeout:30000},async t=>{
 const s=await preflightSetup(t,{policyChanges:{rpcOperator:'third-party'}});
 assert.equal(s.status('RPC trust'),'warn');assert.match(s.detail('RPC trust'),/timing only/);
 const own=await preflightSetup(t);assert.equal(own.status('RPC trust'),'pass');
});

test('a policy must say whose node it trusts, and a hosted endpoint is labelled',{timeout:30000},async t=>{
 const directory=workspace(t),node=await scriptedNode(t),program=await Keypair.generate(),artifact=join(directory,'program.so');
 writeFileSync(artifact,ARTIFACT);node.accounts.set(program.publicKey.toBase58(),{owner:LOADER,executable:true,data:ARTIFACT});
 const make=(out,...flags)=>run(script('trust-policy.js'),['--rpc',node.url,'--genesis',DEVNET_GENESIS,'--program',program.publicKey.toBase58(),'--artifact',artifact,'--out',join(directory,out),'--allow-local',...flags],{cwd:directory});
 const neither=await make('neither.json');assert.notEqual(neither.code,0);assert.match(neither.err,/--operator-controlled.*--third-party-rpc/);
 const hosted=await make('hosted.json','--third-party-rpc');assert.equal(hosted.code,0,hosted.err);assert.match(hosted.err,/timing runs on test funds only/);
 assert.equal(JSON.parse(readFileSync(join(directory,'hosted.json'),'utf8')).rpcOperator,'third-party');
 assert.equal(hosted.out.includes(SECRET),false);
 const own=await make('own.json','--operator-controlled');assert.equal(own.code,0,own.err);
 assert.equal(JSON.parse(readFileSync(join(directory,'own.json'),'utf8')).rpcOperator,undefined);assert.equal(own.err,'');
});

test('create uses the separate player wallet, and the shared manifest and all output stay free of the key',{timeout:30000},async t=>{
 const directory=workspace(t),node=await scriptedNode(t),env={AGENT_STACKS_RPC:node.url,AGENT_STACKS_ALLOW_LOCAL:'1'};
 mkdirSync(join(directory,'keys'),{mode:0o700});
 const playerFile=join(directory,'keys','player.json'),player=await ensureWallet(playerFile),opponent=await Keypair.generate();
 const made=await run(script('devnet.js'),['create',opponent.publicKey.toBase58()],{cwd:directory,env:{...env,AGENT_STACKS_WALLET:playerFile}});
 assert.equal(made.code,0,made.err);
 const manifest=JSON.parse(readFileSync(JSON.parse(made.out).manifest,'utf8'));
 assert.equal(manifest.players[0],player.publicKey.toBase58(),'the creator is the player, not the upgrade authority');
 const payer=await ensureWallet(join(directory,'.agent-stacks/devnet/payer-keypair.json'));
 assert.notEqual(manifest.players[0],payer.publicKey.toBase58());
 assert.equal('rpc' in manifest,false);assert.equal(manifest.terms,termsHash(manifest));
 assert.equal(made.out.includes(SECRET)||made.err.includes(SECRET),false);
 for(const file of everything(directory))assert.equal(readFileSync(file,'utf8').includes(SECRET),false,file);
});
test('without a separate wallet the project payer still creates the match',{timeout:30000},async t=>{
 const directory=workspace(t),node=await scriptedNode(t),opponent=await Keypair.generate();
 const made=await run(script('devnet.js'),['create',opponent.publicKey.toBase58()],{cwd:directory,env:{AGENT_STACKS_RPC:node.url,AGENT_STACKS_ALLOW_LOCAL:'1'}});
 assert.equal(made.code,0,made.err);
 const payer=await ensureWallet(join(directory,'.agent-stacks/devnet/payer-keypair.json'));
 assert.equal(JSON.parse(readFileSync(JSON.parse(made.out).manifest,'utf8')).players[0],payer.publicKey.toBase58());
});
async function settledMatch(t){
 const directory=workspace(t),node=await scriptedNode(t),creator=await Keypair.generate(),joiner=await Keypair.generate(),program=await Keypair.generate();
 const nonce=Buffer.alloc(32,4),[match,bump]=await PublicKey.findProgramAddress([Buffer.from('escrow'),creator.publicKey.toBytes(),nonce],program.publicKey);
 const config={program:program.publicKey.toBase58(),players:[creator.publicKey.toBase58(),joiner.publicKey.toBase58()],match:match.toBase58(),nonce:nonce.toString('hex'),buyIn:1_000_000,bigBlind:20_000,maxHands:2,turnSeconds:86_400,genesis:DEVNET_GENESIS};config.terms=termsHash(config);
 const state=matchState(config,creator,joiner,nonce,bump,{phase:6,hand:2});state[LAYOUT.game+76]=3;u64(1_020_000).copy(state,201);u64(980_000).copy(state,209);
 node.accounts.set(config.match,{owner:config.program,data:state});
 const manifest=join(directory,'manifest.json'),receipt=join(directory,'receipt.json');writeFileSync(manifest,JSON.stringify(config));
 const sent=(number,accounts,tag)=>{
  const keys=[config.program,...accounts],signature=`${number}`.repeat(64);
  return {signature,tx:{slot:1,blockTime:1,version:'legacy',meta:{err:null,fee:5000,preBalances:keys.map(()=>0),postBalances:keys.map(()=>0)},transaction:{signatures:[signature],message:{header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:1},accountKeys:keys,recentBlockhash:'11111111111111111111111111111111',instructions:[{programIdIndex:0,accounts:accounts.map((_,i)=>i+1),data:getBase58Decoder().decode(Uint8Array.of(tag,0,0,0,0,0,0,0,0))}]}}}};
 };
 const [a,b]=config.players,verify=()=>run(script('verify-chain-match.js'),[manifest,receipt],{cwd:directory,env:{AGENT_STACKS_RPC:node.url,AGENT_STACKS_ALLOW_LOCAL:'1'}});
 return {node,verify,receipt,creation:sent(1,[a,b,config.match],1),later:sent(2,[config.match,a,b],15)};
}
test('the verifier refuses a history that has lost the start of the match, and leaves no receipt',{timeout:30000},async t=>{
 const s=await settledMatch(t);s.node.history=[s.later];
 const pruned=await s.verify();
 assert.equal(pruned.code,1);assert.match(pruned.err,/no longer holds this match.s full history: it returned 1 transactions/);
 assert.equal(`${pruned.out}${pruned.err}`.includes(SECRET),false,'the API key must not be printed');
 assert.throws(()=>readFileSync(s.receipt),{code:'ENOENT'});
});
test('the verifier reads on when the creating transaction is still there',{timeout:30000},async t=>{
 const s=await settledMatch(t);s.node.history=[s.later,s.creation];
 const result=await s.verify();
 assert.equal(result.code,1,'this fixture ends before a complete hand');assert.doesNotMatch(result.err,/no longer holds/);
});

test('status prices the run from the cluster’s current rent and hides the key',{timeout:30000},async t=>{
 const directory=workspace(t),node=await scriptedNode(t),env={AGENT_STACKS_RPC:node.url,AGENT_STACKS_ALLOW_LOCAL:'1'};
 const before=await run(script('devnet.js'),['status'],{cwd:directory,env});assert.equal(before.code,0,before.err);
 assert.equal(before.out.includes(SECRET),false);
 const {budget}=JSON.parse(before.out);
 const expected=strictFundingRequired({rent:(PROOF_ACCOUNT_BYTES+128)*5080,buyIn:1_000_000,hands:2,maxFeePerTransaction:15_000});
 assert.equal(budget.playerBSOL,expected/1e9);assert.ok(budget.playerASOL>budget.playerBSOL);
 node.lamportsPerByte=696;
 const cheaper=JSON.parse((await run(script('devnet.js'),['status'],{cwd:directory,env})).out).budget;
 assert.ok(cheaper.playerBSOL<budget.playerBSOL/5,'lower rent lowers the budget');
});
test('deploy refuses to replace a program that is already deployed',{timeout:30000},async t=>{
 const directory=workspace(t),node=await scriptedNode(t),env={AGENT_STACKS_RPC:node.url,AGENT_STACKS_ALLOW_LOCAL:'1'};
 const {program}=JSON.parse((await run(script('devnet.js'),['status'],{cwd:directory,env})).out);
 node.accounts.set(program,{owner:LOADER,executable:true,data:ARTIFACT});
 const again=await run(script('devnet.js'),['deploy'],{cwd:directory,env});
 assert.equal(again.code,1);assert.match(again.err,/already deployed/);
 // Dust on the address isn't a deployment, so it must not read as one.
 node.accounts.set(program,{owner:'11111111111111111111111111111111',executable:false,data:Buffer.alloc(0)});
 assert.equal(JSON.parse((await run(script('devnet.js'),['status'],{cwd:directory,env})).out).programDeployed,false);
});
