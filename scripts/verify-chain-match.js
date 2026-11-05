// Read-only receipt for a completed poker match on devnet or an explicit local validator.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {ChainClient,DEVNET,PublicKey} from '../src/solana/client.js';
import {findSettlement,claimedSeats,handTransitions,deferredSeatsFrom,hasCreation} from '../src/solana/receipts.js';
const config=JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'));
const client=new ChainClient(process.env.AGENT_STACKS_RPC??config.rpc??DEVNET,config.program,null,{allowLocal:process.env.AGENT_STACKS_ALLOW_LOCAL==='1'});
const genesis=await client.checkNetwork();if(genesis!==config.genesis)throw Error('Manifest genesis mismatch');
const m=await client.match(config.match,config);
if(m.phase!==6||m.game.stage!==3||m.payouts[0]+m.payouts[1]!==config.buyIn*2)throw Error('Match has not completed normal poker settlement');
const signatures=[];let before;
for(;;){const batch=await client.connection.getSignaturesForAddress(new PublicKey(config.match),{limit:1000,...(before?{before}:{})},'confirmed');signatures.push(...batch);if(batch.length<1000)break;before=batch.at(-1).signature;}
const transactions=[];
for(const item of signatures.filter(s=>!s.err)){
 const tx=await client.connection.getTransaction(item.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});if(!tx)throw Error(`Missing history for ${item.signature}`);transactions.push({signature:item.signature,tx});
}
if(!hasCreation(transactions,config.program,config.match))throw Error(`This node no longer holds this match's full history: it returned ${transactions.length} transactions and not the one creating the match. Use a node that keeps longer history. The match itself is unaffected.`);
const final=findSettlement(transactions,config.program,config.match);if(!final)throw Error('No successful settlement transaction');
const claimed=claimedSeats(transactions,config.program,config.match);
const keys=(final.tx.transaction.message.staticAccountKeys??final.tx.transaction.message.accountKeys).map(k=>k.toBase58());
const fee=Number(final.tx.meta.fee),payer=keys[0];
const deltas=config.players.map(p=>{const i=keys.indexOf(p);if(i<0)throw Error('Settlement destination missing');return Number(final.tx.meta.postBalances[i]-final.tx.meta.preBalances[i]);});
const deferredSeats=deferredSeatsFrom({deltas,payouts:m.payouts,fees:config.players.map(p=>p===payer?fee:0),pendingPayouts:m.pendingPayouts,claimed});
const transitions=transactions.flatMap(({signature,tx})=>handTransitions(tx.meta.logMessages,config.program).map(handNo=>({signature,handNo}))).reverse();
if(transitions.length!==m.handNo-1||transitions.some((t,i)=>t.handNo!==i+2))throw Error('Incomplete hand-transition history');
const artifactPath=resolve('target/deploy/agent_stacks_escrow.so'),artifact=existsSync(artifactPath)?readFileSync(artifactPath):null;
const receipt={network:process.env.AGENT_STACKS_ALLOW_LOCAL==='1'?'explicit-local-validator':'devnet',genesis,program:config.program,match:config.match,handNo:m.handNo,maxHands:m.maxHands,version:m.version,payoutsLamports:m.payouts,board:m.game.board,holes:m.game.holes,successfulMatchTransactions:transactions.length,handTransitions:transitions,finalSignature:final.signature,deferredSeats,finalRequiredSignatures:final.tx.transaction.message.header.numRequiredSignatures,feeLamports:fee,playerBalanceDeltasLamports:deltas,computeUnits:String(final.tx.meta.computeUnitsConsumed),localArtifactSHA256:artifact?createHash('sha256').update(artifact).digest('hex'):null,verifiedAt:new Date().toISOString()};
const output=resolve(process.argv[3]??'.agent-stacks/reports/local-multihand.json');mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
