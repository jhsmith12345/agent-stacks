// A policy is an operator assertion, not a discovery or certification of trust.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {ChainClient,PublicKey} from '../src/solana/client.js';
import {writePrivate} from '../src/private-files.js';
import {validateTrustPolicy,verifyPinnedProgram} from '../src/solana/trusted-agent.js';
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
for(const flag of ['--rpc','--genesis','--program','--artifact','--out'])if(!args.includes(flag)||!value(flag)||value(flag).startsWith('--'))throw Error(`Required ${flag}`);
if(!args.includes('--operator-controlled'))throw Error('Use --operator-controlled only for a validating node you operate and trust; this is not a public RPC allowlist');
const bytes=readFileSync(resolve(value('--artifact')));
const policy=validateTrustPolicy({schema:'agent-stacks/trusted-node/v1',trust:'operator-controlled-validator',network:'test-only',
 rpc:value('--rpc'),...(args.includes('--submit-rpc')?{submitRpc:value('--submit-rpc')}:{}),genesis:value('--genesis'),program:value('--program'),
 programSha256:createHash('sha256').update(bytes).digest('hex'),programBytes:bytes.length,
 allowLocal:args.includes('--allow-local'),allowUpgradeable:args.includes('--allow-upgradeable-test-program'),allowTestControls:args.includes('--test-controls'),allowCooperative:args.includes('--cooperative'),
 maxBuyIn:1_000_000,maxHands:2,minTurnSeconds:3600,maxTransactions:4000,maxFeePerTransaction:15000,maxTotalFees:25_000_000,maxAccountRent:5_000_000_000,maxTotalOutflow:20_000_000_000,maxBigBlind:100_000,maxTurnSeconds:args.includes('--max-turn-seconds')?Number(value('--max-turn-seconds')):86_400,...(args.includes('--max-compute-unit-price')?{maxComputeUnitPrice:Number(value('--max-compute-unit-price'))}:{})});
const client=new ChainClient(policy.rpc,policy.program,{publicKey:new PublicKey(policy.program)},{allowLocal:policy.allowLocal});
if(await client.checkNetwork()!==policy.genesis)throw Error('Node does not report the independently expected genesis');
const attestation=await verifyPinnedProgram(client.connection,policy);
writePrivate(resolve(value('--out')),JSON.stringify(policy,null,2),{exclusive:true});
console.log(JSON.stringify({policy:resolve(value('--out')),testOnly:true,...attestation},null,2));
