// Read-only accounting for a fully cooperative match, including its closed buffers.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {getBase58Encoder} from '@solana/kit';
import {ChainClient,DEVNET,PublicKey} from '../src/solana/client.js';
const config=JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'));
const client=new ChainClient(process.env.AGENT_STACKS_RPC??config.rpc??DEVNET,config.program,null,{allowLocal:process.env.AGENT_STACKS_ALLOW_LOCAL==='1'});
const genesis=await client.checkNetwork();if(genesis!==config.genesis)throw Error('Wrong genesis');
const state=await client.match(config.match,config);if(state.phase!==6||state.game.stage!==3)throw Error('Expected completed poker match');
const transactions=new Map();
async function collect(address){let before;for(;;){const batch=await client.connection.getSignaturesForAddress(new PublicKey(address),{limit:1000,...(before?{before}:{})},'confirmed');
 for(const s of batch){if(s.err||transactions.has(s.signature))continue;const tx=await client.connection.getTransaction(s.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});if(!tx)throw Error('Incomplete RPC history');transactions.set(s.signature,tx);}
 if(batch.length<1000)break;before=batch.at(-1).signature;
}}
function instructions(tx){const msg=tx.transaction.message,keys=msg.accountKeys??msg.staticAccountKeys;return (msg.instructions??msg.compiledInstructions).filter(ix=>keys[ix.programIdIndex].toBase58()===config.program).map(ix=>({tag:(typeof ix.data==='string'?getBase58Encoder().encode(ix.data):ix.data)[0],accounts:(ix.accounts??ix.accountKeyIndexes).map(i=>keys[i].toBase58())}));}
await collect(config.match);const buffers=new Set();
for(const tx of transactions.values())for(const ix of instructions(tx))if(ix.tag===16)buffers.add(ix.accounts[0]);
for(const buffer of buffers)await collect(buffer);
let totalFees=0,setupFees=0,setupTransactions=0,signatureCount=0;const tags={};
// Anyone can mention a public address in their own transaction; that is not protocol cost.
for(const [signature,tx] of transactions){
 const ix=instructions(tx);if(!ix.length){transactions.delete(signature);continue;}const fee=Number(tx.meta.fee);totalFees+=fee;signatureCount+=tx.transaction.message.header.numRequiredSignatures;
 if(ix.some(i=>[1,2].includes(i.tag))){setupFees+=fee;setupTransactions++;}
 for(const i of ix)tags[i.tag]=(tags[i.tag]??0)+1;
}
if(tags[13]||tags[18]!==2*state.handNo||buffers.size!==2*state.handNo)throw Error('This cost tool requires every shuffle to use joint acceptance; full-proof accounts need separate accounting');
const receipt={network:process.env.AGENT_STACKS_ALLOW_LOCAL==='1'?'explicit-local-validator':'devnet',genesis,match:config.match,hands:state.handNo,programTransactions:transactions.size,signatures:signatureCount,totalFeesLamports:totalFees,oneTimeSetupFeesLamports:setupFees,perHandFeesLamports:(totalFees-setupFees)/state.handNo,perHandTransactions:(transactions.size-setupTransactions)/state.handNo,temporaryDeckRentLamports:Number(await client.connection.getMinimumBalanceForRentExemption(3409)),instructionCounts:tags,verifiedAt:new Date().toISOString()};
const output=resolve(process.argv[3]??'.agent-stacks/reports/compact-cost.json');mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
