import test from 'node:test';
import assert from 'node:assert/strict';
import {getBase58Decoder} from '@solana/kit';
import {programInstructions,findSettlement,claimedSeats,handTransitions,deferredSeatsFrom,hasCreation} from '../src/solana/receipts.js';

const PROGRAM='ProgramAAA',MATCH='MatchAAA',A='WalletA',B='WalletB',OTHER='OtherProgram';
const encode=bytes=>getBase58Decoder().decode(Uint8Array.from(bytes));
const entry=(signature,instructions)=>{
 const keys=[...new Set(instructions.flatMap(ix=>[ix.program,...ix.accounts]))];
 return {signature,tx:{transaction:{message:{accountKeys:keys,instructions:instructions.map(ix=>({programIdIndex:keys.indexOf(ix.program),accounts:ix.accounts.map(k=>keys.indexOf(k)),data:encode(ix.data)}))}}}};
};
const action=(signature,tag=15)=>entry(signature,[{program:PROGRAM,accounts:[MATCH,A,A,B],data:[tag,0,0,0,0,0,0,0,0]}]);

test('the settlement is the newest card share or action, ignoring anything else that mentions the match',()=>{
 const settlement=action('settled',14);
 const history=[
  entry('stranger-mention',[{program:OTHER,accounts:[MATCH],data:[1]}]),
  entry('stranger-same-tag',[{program:OTHER,accounts:[MATCH],data:[14]}]),
  entry('claim',[{program:PROGRAM,accounts:[MATCH,B,B],data:[20,0,0,0,0,0,0,0,0,1]}]),
  entry('other-match',[{program:PROGRAM,accounts:['AnotherMatch',A],data:[15]}]),
  settlement,action('earlier-action'),
 ];
 assert.equal(findSettlement(history,PROGRAM,MATCH).signature,'settled');
 assert.equal(findSettlement(history.slice(0,4),PROGRAM,MATCH),null);
});
test('a receipt needs the match’s creation, because a node may have discarded the rest',()=>{
 const creation=entry('created',[{program:PROGRAM,accounts:[A,B,MATCH,'System'],data:[1]}]);
 assert.equal(hasCreation([action('later'),creation],PROGRAM,MATCH),true);
 assert.equal(hasCreation([action('later')],PROGRAM,MATCH),false,'history that starts partway through');
 assert.equal(hasCreation([entry('fake',[{program:OTHER,accounts:[A,B,MATCH],data:[1]}])],PROGRAM,MATCH),false,'another program');
 assert.equal(hasCreation([entry('other',[{program:PROGRAM,accounts:[A,B,'AnotherMatch'],data:[1]}])],PROGRAM,MATCH),false,'another match');
 assert.equal(hasCreation([entry('other-tag',[{program:PROGRAM,accounts:[A,B,MATCH],data:[2]}])],PROGRAM,MATCH),false,'another instruction');
});
test('only claims on this match count as claimed seats',()=>{
 const history=[entry('claim',[{program:PROGRAM,accounts:[MATCH,B,B],data:[20,0,0,0,0,0,0,0,0,1]}]),entry('elsewhere',[{program:PROGRAM,accounts:['AnotherMatch',A,A],data:[20,0,0,0,0,0,0,0,0,0]}]),action('settled')];
 assert.deepEqual([...claimedSeats(history,PROGRAM,MATCH)],[1]);
});
test('hand transitions count only what the escrow program itself logged',()=>{
 const logs=[`Program ${OTHER} invoke [1]`,'Program log: Starting hand 9',`Program ${OTHER} success`,`Program ${PROGRAM} invoke [1]`,'Program log: Starting hand 2',`Program ${OTHER} invoke [2]`,'Program log: Starting hand 8',`Program ${OTHER} success`,`Program ${PROGRAM} success`];
 assert.deepEqual(handTransitions(logs,PROGRAM),[2]);
 assert.deepEqual(handTransitions(null,PROGRAM),[]);
 assert.deepEqual(handTransitions([`Program ${PROGRAM} invoke [1]`,'Program log: Starting hand two',`Program ${PROGRAM} success`],PROGRAM),[]);
});
test('instructions decode both legacy and versioned message shapes',()=>{
 const legacy=action('a'),ix=legacy.tx.transaction.message.instructions[0];
 const versioned={transaction:{message:{staticAccountKeys:legacy.tx.transaction.message.accountKeys,compiledInstructions:[{programIdIndex:ix.programIdIndex,accountKeyIndexes:ix.accounts,data:[15,1]}]}}};
 assert.equal(programInstructions(legacy.tx,PROGRAM)[0].tag,15);
 assert.deepEqual(programInstructions(versioned,PROGRAM)[0].accounts,[MATCH,A,A,B]);
});
test('settlement balances must match the award, unless that seat\'s award was deferred and is claimable or claimed',()=>{
 const base={payouts:[1500,500],fees:[5000,0],pendingPayouts:0,claimed:new Set()};
 assert.deepEqual(deferredSeatsFrom({...base,deltas:[-3500,500]}),[]);
 assert.deepEqual(deferredSeatsFrom({...base,deltas:[-3500,0],pendingPayouts:2}),[1],'pending claim');
 assert.deepEqual(deferredSeatsFrom({...base,deltas:[-3500,0],claimed:new Set([1])}),[1],'claim already made');
 assert.deepEqual(deferredSeatsFrom({...base,deltas:[-5000,0],pendingPayouts:3}),[0,1]);
 assert.throws(()=>deferredSeatsFrom({...base,deltas:[-3500,0]}),/do not match/,'no credit and no claim is a mismatch');
 assert.throws(()=>deferredSeatsFrom({...base,deltas:[-3500,499],pendingPayouts:2}),/do not match/,'a wrong credit is not a deferral');
});
