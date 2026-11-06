// The deal has to favour nobody. The thresholds are six standard deviations out, so a fair deal fails this
// about once in a billion runs, and a biased one fails it every time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {permutation} from '../src/mental-poker/shuffle.js';
import {evaluate,greater,owedPositions,P_BOARD_A,P_HOLE_A,P_HOLE_B} from '../src/channel/engine.js';
test('every card is equally likely to land in every position',()=>{
 const n=52,rounds=52_000,counts=Array.from({length:n},()=>Array(n).fill(0));
 for(let r=0;r<rounds;r++)permutation(n).forEach((card,position)=>{counts[position][card]++;});
 const expected=rounds/n,freedom=(n-1)*(n-1);
 const chi=counts.flat().reduce((sum,c)=>sum+(c-expected)**2/expected,0);
 assert.ok(chi<freedom+6*Math.sqrt(2*freedom),`chi-squared ${Math.round(chi)} on ${freedom} degrees of freedom`);
 assert.ok(chi>freedom-6*Math.sqrt(2*freedom),`too even to be random: ${Math.round(chi)}`);
});
test('dealt the way a match deals them, neither seat wins more often',()=>{
 // Seat 0 is dealt positions 0 and 2, seat 1 positions 1 and 3, and the board comes after them.
 const street=n=>({phase:P_BOARD_A,game:{street:n}});
 assert.deepEqual(owedPositions({phase:P_HOLE_B}),[0,2]);assert.deepEqual(owedPositions({phase:P_HOLE_A}),[1,3]);
 const board=[...owedPositions(street(1)),...owedPositions(street(2)),...owedPositions(street(3))];
 assert.deepEqual(board,[4,5,6,7,8]);
 const deals=30_000;let seat0=0,seat1=0,ties=0;
 for(let d=0;d<deals;d++){
  const deck=permutation(52),common=board.map(i=>deck[i]);
  const a=evaluate([deck[0],deck[2],...common]),b=evaluate([deck[1],deck[3],...common]);
  if(greater(a,b))seat0++;else if(greater(b,a))seat1++;else ties++;
 }
 const decided=seat0+seat1;
 assert.ok(Math.abs(seat0-seat1)<6*Math.sqrt(decided),`seat 0 won ${seat0}, seat 1 won ${seat1}`);
 // A real hold'em split is about 4.5%. Far from it would mean the hands are being ranked wrongly.
 assert.ok(ties/deals>0.03&&ties/deals<0.06,`${ties} ties in ${deals}`);
});
