// The referee that checks finished hands in the simulation. A check that can't fail proves nothing, so this
// confirms it notices each kind of mistake, and that it agrees with real poker on hands worked out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import {coverage,referee} from '../src/channel/referee.js';
const card=text=>'23456789TJQKA'.indexOf(text[0])*4+'cdhs'.indexOf(text[1]);
const cards=text=>text.split(' ').map(card);
// Both players' records of one hand. Seat 0 has the button in hand 1.
function hand({hand=1,winner,reason,stacks,seat0,seat1,board='',betting,aggressor=255,firstToShow=null}){
 const first=firstToShow??(aggressor<2?aggressor:(hand%2===1?1:0));
 const shared={hand,winner,reason,stacks,board:board?cards(board):[],betting,aggressor,firstToShow:first};
 const shown=reason===1;
 return [{...shared,seat:0,cards:cards(seat0),opponentCards:shown?cards(seat1):[]},{...shared,seat:1,cards:cards(seat1),opponentCards:shown||reason===3?cards(seat0):[]}];
}
const BET=[{seq:1,street:0,seat:0,action:2},{seq:2,street:0,seat:1,action:1},{seq:3,street:1,seat:1,action:1},{seq:4,street:1,seat:0,action:3,to:40},{seq:5,street:1,seat:1,action:2},{seq:6,street:2,seat:1,action:1},{seq:7,street:2,seat:0,action:1},{seq:8,street:3,seat:1,action:1},{seq:9,street:3,seat:0,action:3,to:100},{seq:10,street:3,seat:1,action:2}];
const good=()=>hand({winner:0,reason:1,stacks:[1160,840],seat0:'Ah Ad',seat1:'Kh Kd',board:'2c 7s 9d Ts 3s',betting:BET,aggressor:0});
test('a correct hand passes',()=>{assert.deepEqual(referee(1000,20,[good()]),[]);});
test('it notices stacks that are wrong, by even one lamport',()=>{
 const [a,b]=good();
 const faults=referee(1000,20,[[{...a,stacks:[1161,839]},b]]);
 assert.equal(faults.length,1);assert.match(faults[0],/the stacks/);
});
test('it notices the wrong winner, using a hand evaluator of its own',()=>{
 const [a,b]=good();
 assert.match(referee(1000,20,[[{...a,winner:1},b]])[0],/winner/);
 // A straight beats a pair of aces.
 const straight=hand({winner:1,reason:1,stacks:[840,1160],seat0:'Ah Ad',seat1:'8c 6h',board:'2c 7s 9d Ts 3s',betting:BET,aggressor:0});
 assert.deepEqual(referee(1000,20,[straight]),[]);
 const wheel=hand({winner:1,reason:1,stacks:[840,1160],seat0:'Kh Kd',seat1:'Ac 4d',board:'2c 3s 5d Ts Jh',betting:BET,aggressor:0});
 assert.deepEqual(referee(1000,20,[wheel]),[],'an ace-low straight counts');
 const flush=hand({winner:0,reason:1,stacks:[1160,840],seat0:'2s 4s',seat1:'Ah Ad',board:'7s 9s Ts Ac Ks',betting:BET,aggressor:0});
 assert.deepEqual(referee(1000,20,[flush]),[]);
});
test('a tie splits the pot',()=>{
 const tie=hand({winner:2,reason:1,stacks:[1000,1000],seat0:'2c 3d',seat1:'2d 3c',board:'As Ks Qs Js Ts',betting:BET,aggressor:0});
 assert.deepEqual(referee(1000,20,[tie]),[]);
 const [a,b]=tie;
 assert.ok(referee(1000,20,[[{...a,stacks:[1160,840]},b]]).length>0);
});
test('it notices the wrong player showing first',()=>{
 const [a,b]=good();
 assert.match(referee(1000,20,[[{...a,firstToShow:1},b]])[0],/shows first/);
});
test('a bet on an earlier street doesn’t decide who shows first',()=>{
 // A bet on the flop, then checks through the river: the first to act on the river shows first.
 const betting=[...BET.slice(0,8),{seq:9,street:3,seat:0,action:1}];
 const h=hand({winner:0,reason:1,stacks:[1060,940],seat0:'Ah Ad',seat1:'Kh Kd',board:'2c 7s 9d Ts 3s',betting,aggressor:255});
 assert.deepEqual(referee(1000,20,[h]),[]);
 const [a,b]=h;
 assert.match(referee(1000,20,[[{...a,firstToShow:0},b]])[0],/shows first/);
});
test('an all-in that gets called shows first even with no betting after it',()=>{
 const betting=[{seq:1,street:0,seat:0,action:4,to:1000},{seq:2,street:0,seat:1,action:2}];
 const h=hand({winner:1,reason:3,stacks:[2000,0].reverse(),seat0:'Ah Ad',seat1:'Kh Kd',board:'2c 7s 9d Ts 3s',betting,aggressor:0});
 assert.deepEqual(referee(1000,20,[[{...h[0],winner:1},{...h[1],winner:1}]]),[]);
});
test('the hand the simulation caught: an all-in for less than the bet, which closes the round',()=>{
 // Seat 0 starts with 175,000 and is left with 21,984 when it calls a 76,508 bet all-in.
 const betting=[{seq:59,street:0,seat:1,action:2},{seq:60,street:0,seat:0,action:3,to:153_016},{seq:61,street:0,seat:1,action:2},{seq:68,street:1,seat:0,action:1},{seq:69,street:1,seat:1,action:3,to:76_508},{seq:70,street:1,seat:0,action:4}];
 const records=hand({hand:2,winner:1,reason:3,stacks:[0,350_000],seat0:'Js 3h',seat1:'9s 3c',board:'7s 9c 5h 8h 8s',betting,aggressor:1});
 assert.deepEqual(referee(175_000,50_000,[records]),[]);
});
test('an all-in for less leaves the extra with the player who bet it, across hands',()=>{
 const first=hand({hand:1,winner:0,reason:1,stacks:[1700,300],seat0:'Ah Ad',seat1:'Kh Kd',board:'2c 7s 9d Ts 3s',betting:[{seq:1,street:0,seat:0,action:3,to:700},{seq:2,street:0,seat:1,action:2}],aggressor:0});
 // Seat 1 has only 300 behind, so of seat 0's 500 raise, 200 goes straight back.
 const betting=[{seq:3,street:0,seat:1,action:2},{seq:4,street:0,seat:0,action:3,to:500},{seq:5,street:0,seat:1,action:4}];
 const lost=hand({hand:2,winner:0,reason:1,stacks:[2000,0],seat0:'Ah Ad',seat1:'Kh Kd',board:'2c 7s 9d Ts 3s',betting,aggressor:0});
 assert.deepEqual(referee(1000,20,[first,lost]),[]);
 const won=hand({hand:2,winner:1,reason:1,stacks:[1400,600],seat0:'Kh Kd',seat1:'Ah Ad',board:'2c 7s 9d Ts 3s',betting,aggressor:0});
 assert.deepEqual(referee(1000,20,[first,won]),[]);
 assert.ok(referee(1000,20,[first,hand({hand:2,winner:1,reason:1,stacks:[1200,800],seat0:'Kh Kd',seat1:'Ah Ad',board:'2c 7s 9d Ts 3s',betting,aggressor:0})]).length>0,'winning more than was matched is wrong');
});
test('a muck can’t leave both sides having seen each other’s cards',()=>{
 const [a,b]=hand({winner:1,reason:3,stacks:[840,1160],seat0:'Ah Ad',seat1:'Kh Kd',board:'2c 7s 9d Ts 3s',betting:BET,aggressor:0});
 assert.deepEqual(referee(1000,20,[[a,b]]),[]);
 assert.match(referee(1000,20,[[{...a,opponentCards:cards('Kh Kd')},b]])[0],/both sides/);
});
test('a showdown has to show the cards that were held',()=>{
 const [a,b]=good();
 assert.match(referee(1000,20,[[{...a,opponentCards:cards('Qh Qd')},b]])[0],/cards shown/);
});
test('coverage counts what actually happened',()=>{
 const seen={};
 const short=[{seq:1,street:0,seat:0,action:3,to:100},{seq:2,street:0,seat:1,action:4,to:130},{seq:3,street:0,seat:0,action:2}];
 coverage(seen,[good(),hand({winner:0,reason:0,stacks:[1020,980],seat0:'2c 3d',seat1:'4c 5d',betting:[{seq:1,street:0,seat:0,action:3,to:40},{seq:2,street:0,seat:1,action:0}]}),hand({winner:2,reason:1,stacks:[1000,1000],seat0:'2c 3d',seat1:'2d 3c',board:'As Ks Qs Js Ts',betting:short})],20);
 assert.equal(seen.hands,3);assert.equal(seen['ended by showdown'],2);assert.equal(seen['ended by fold'],1);assert.equal(seen['split pots'],1);
 assert.equal(seen['all-in raises below the minimum'],1);assert.equal(seen['fold on preflop'],1);assert.equal(seen['hands with a re-raise'],1);
});
