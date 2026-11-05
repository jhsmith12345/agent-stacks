// Reads settlement evidence out of transaction history. Anyone can mention a public match address in
// their own transaction, and any program can log any text, so neither is treated as evidence alone.
import {getBase58Encoder} from '@solana/kit';

export function programInstructions(tx,program){
 const message=tx.transaction.message,keys=(message.accountKeys??message.staticAccountKeys).map(k=>k.toString());
 return (message.instructions??message.compiledInstructions).filter(ix=>keys[ix.programIdIndex]===program).map(ix=>{
  const data=typeof ix.data==='string'?getBase58Encoder().encode(ix.data):ix.data;
  return {tag:data[0],data:Uint8Array.from(data),accounts:(ix.accounts??ix.accountKeyIndexes).map(i=>keys[i])};
 });
}
// Newest first. Only a card share or betting action can finish a poker hand, and a completed match
// rejects both, so the newest successful one on this match is the one that settled it.
export function findSettlement(transactions,program,match){
 return transactions.find(({tx})=>programInstructions(tx,program).some(ix=>[14,15].includes(ix.tag)&&ix.accounts[0]===match))??null;
}
// Nodes discard old transaction history. Without the match's creation there is no way to tell what's missing,
// so a receipt must not be built from what remains.
export function hasCreation(transactions,program,match){
 return transactions.some(({tx})=>programInstructions(tx,program).some(ix=>ix.tag===1&&ix.accounts[2]===match));
}
// Seats whose award was withheld at settlement and claimed afterwards with tag 20.
export function claimedSeats(transactions,program,match){
 return new Set(transactions.flatMap(({tx})=>programInstructions(tx,program).filter(ix=>ix.tag===20&&ix.accounts[0]===match).map(ix=>ix.data[9])));
}
// Checks the settlement's balance changes. An award below the recipient's rent minimum stays in escrow at
// settlement for its owner to claim, so that seat shows no credit if its claim is pending or was made.
export function deferredSeatsFrom({deltas,payouts,fees,pendingPayouts,claimed}){
 const deferred=[];
 for(let seat=0;seat<2;seat++){
  if(deltas[seat]===payouts[seat]-fees[seat])continue;
  if(deltas[seat]===-fees[seat]&&((pendingPayouts&(1<<seat))||claimed.has(seat))){deferred.push(seat);continue;}
  throw Error('Settlement balances do not match recorded payouts');
 }
 return deferred;
}
// Hand transitions logged by the escrow program itself, not text from another program in the same transaction.
export function handTransitions(logs,program){
 const stack=[],hands=[];
 for(const line of logs??[]){
  const invoke=line.match(/^Program (\S+) invoke \[\d+\]$/);
  if(invoke){stack.push(invoke[1]);continue;}
  if(/^Program \S+ (success|failed: .*)$/.test(line)){stack.pop();continue;}
  const hand=line.match(/^Program log: Starting hand (\d+)$/);
  if(hand&&stack.at(-1)===program)hands.push(Number(hand[1]));
 }
 return hands;
}
