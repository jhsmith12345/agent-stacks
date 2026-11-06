// One code that gets two players into a match, with a relay in the middle that can't be trusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {channelAddress,channelTerms} from '../src/channel/chain.js';
import {isTestNetwork,trustedDeployment} from '../src/channel/deployments.js';
import {checkManifest,decodeInvite,encodeInvite,formatSol,newInvite,parseSol,seal,unseal,waitForManifest,waitForOffer} from '../src/channel/invite.js';
import {RelayTransport,startRelay} from '../src/channel/relay.js';
import {checkOffer,makeOffer,sessionHex} from '../src/channel/setup.js';
const key=async()=>Keypair.generate();
const PROGRAM='DrUx4PvwUpW1mHPqhDM7Stabtx6JSyXycvtaZftGP1g4',GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const terms=(overrides={})=>({relay:'https://relay.example',program:PROGRAM,genesis:GENESIS,host:'11111111111111111111111111111112',buyIn:1_000_000,bigBlind:20_000,hands:10,seconds:600,think:20,...overrides});
const encodeRaw=fields=>`stacks1.${Buffer.from(JSON.stringify(fields)).toString('base64url')}`;
async function manifestFor(invite,host,guest,guestSession){
 const nonce=Buffer.alloc(32,9),[match]=await channelAddress(invite.program,host,nonce);
 const m={protocol:'agent-stacks/channel/v1',genesis:invite.genesis,program:invite.program,players:[host.toBase58(),guest.toBase58()],sessions:['ab'.repeat(32),guestSession],match:match.toBase58(),nonce:nonce.toString('hex'),buyIn:invite.buyIn,bigBlind:invite.bigBlind,maxHands:invite.hands,turnSeconds:invite.seconds};
 m.terms=channelTerms(m);
 return m;
}

test('amounts of SOL are exact, and anything unclear is refused',()=>{
 assert.equal(parseSol('0.001'),1_000_000);assert.equal(parseSol('1'),1_000_000_000);assert.equal(parseSol('1.5'),1_500_000_000);
 assert.equal(parseSol('0.000000001'),1);assert.equal(parseSol('0.1'),100_000_000);assert.equal(parseSol('0.29'),290_000_000,'no floating point rounding');
 for(const bad of ['','-1','1e3','0.0000000001','abc','1.','.5','1,5','0x10',' 1'])assert.throws(()=>parseSol(bad),/Not an amount/,bad);
 // Whatever floating point would get wrong, this has to get right.
 let n=1;
 for(let i=0;i<20_000;i++){n=(n*48271)%2147483647;const lamports=n*(1+i%400);assert.equal(parseSol(formatSol(lamports)),lamports);}
 assert.equal(formatSol(1_000_000),'0.001');assert.equal(formatSol(1_500_000_000),'1.5');assert.equal(formatSol(2_000_000_000),'2');assert.equal(formatSol(1),'0.000000001');assert.equal(formatSol(0),'0');
});

test('a code survives being sent, and gives the same match on both sides',()=>{
 const invite=newInvite(terms());
 const code=encodeInvite(invite);
 assert.match(code,/^stacks1\.[A-Za-z0-9_-]+$/,'safe to paste anywhere');
 assert.ok(code.length<1000);
 assert.deepEqual(decodeInvite(code),invite);
 assert.deepEqual(decodeInvite(`  ${code}\n`),invite,'stray whitespace from pasting is fine');
 assert.deepEqual(decodeInvite(`${code}.`),invite,'and so is the full stop of the sentence it came in');
 assert.notEqual(newInvite(terms()).secret,invite.secret);
 assert.notEqual(newInvite(terms()).id,invite.id);
});

test('a code can say the host pays, and one that doesn’t stays as it was',()=>{
 const funded=newInvite(terms({fund:true}));
 assert.equal(decodeInvite(encodeInvite(funded)).fund,true);
 const plain=newInvite(terms());
 assert.equal('fund' in plain,false);
 assert.equal('fund' in decodeInvite(encodeInvite(plain)),false);
 assert.equal('fund' in newInvite(terms({fund:false})),false);
});

test('the relay’s name for an invite doesn’t give away its secret',()=>{
 const invite=newInvite(terms());
 assert.match(invite.id,/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,'the relay accepts it as a mailbox name');
 assert.ok(!invite.id.includes(invite.secret));
 const code=encodeInvite(invite);
 assert.ok(!Buffer.from(code.slice(8),'base64url').toString().includes(invite.id),'and it’s derived, not chosen by whoever made the code');
 const forged={...JSON.parse(Buffer.from(code.slice(8),'base64url').toString()),id:'11111111111111111111111111111111'};
 assert.equal(decodeInvite(encodeRaw(forged)).id,invite.id);
});

test('a code that’s damaged or makes no sense is refused',()=>{
 const good=JSON.parse(Buffer.from(encodeInvite(newInvite(terms())).slice(8),'base64url').toString());
 for(const bad of ['','hello','stacks1.','stacks1.!!!','stacks1.e30',`stacks1.${'A'.repeat(3000)}`,encodeRaw(null),encodeRaw([]),encodeRaw('x')])assert.throws(()=>decodeInvite(bad),/invite/i,bad.slice(0,20));
 const cases={relay:['ftp://relay.example','not a url',null,7],program:['nope',null],genesis:['nope',null],host:['0OIl',null],secret:['short','zz'.repeat(32),null],buyIn:[0,-1,1.5,'5',2**60,null],bigBlind:[0,3,1.5,2_000_000,null],hands:[0,-1,1.5,null],seconds:[0,-1,1.5,10_000_000,null],think:[0,-1,1000,null,1.5],fund:[false,null,1,'yes']};
 for(const [field,values] of Object.entries(cases))for(const value of values)assert.throws(()=>decodeInvite(encodeRaw({...good,[field]:value})),/invite/i,`${field}=${value}`);
 assert.throws(()=>decodeInvite(encodeRaw({...good,seconds:30,think:20})),/thinking time/,'a decision has to fit the clock');
 assert.throws(()=>newInvite(terms({bigBlind:200_002})),/blinds/);
});

test('a message only counts if it was sealed with this invite’s secret',()=>{
 const invite=newInvite(terms()),other=newInvite(terms());
 const message=seal(invite,'offer',{a:1});
 assert.deepEqual(unseal(invite,'offer',message),{a:1});
 assert.equal(unseal(other,'offer',message),null,'another invite’s secret');
 assert.equal(unseal(invite,'manifest',message),null,'an offer can’t pass as a manifest');
 assert.equal(unseal(invite,'offer',{...message,type:'manifest'}),null);
 assert.equal(unseal(invite,'manifest',{...message,type:'manifest'}),null,'relabelling it doesn’t help: the seal covers the type');
 assert.equal(unseal(invite,'offer',{...message,body:{a:2}}),null,'changed in transit');
 assert.equal(unseal(invite,'offer',{...message,mac:'00'.repeat(32)}),null);
 for(const junk of [null,7,'x',[],{},{type:'offer'},{type:'offer',mac:7},{type:'offer',mac:'zz'},{type:'offer',body:{a:1},mac:'ab'}])assert.equal(unseal(invite,'offer',junk),null,JSON.stringify(junk));
});

test('an offer is only good from the wallet it names',async()=>{
 const wallet=await key(),session=await key();
 const offer=makeOffer(wallet,session);
 assert.doesNotThrow(()=>checkOffer(offer));
 assert.equal(offer.session,sessionHex(session));
 const stranger=await key();
 assert.throws(()=>checkOffer({...offer,wallet:stranger.publicKey.toBase58()}),/not signed/);
 assert.throws(()=>checkOffer({...offer,session:'ab'.repeat(32)}),/not signed/);
 assert.throws(()=>checkOffer({...offer,signature:'00'.repeat(64)}),/not signed/);
 assert.throws(()=>checkOffer({...offer,signature:'nope'}),/not signed/);
});

test('the guest only accepts the match it was promised',async()=>{
 const host=(await key()).publicKey,guest=(await key()).publicKey,session='cd'.repeat(32);
 const invite=newInvite(terms({host:host.toBase58()})),me={wallet:guest.toBase58(),session};
 const good=await manifestFor(invite,host,guest,session);
 assert.deepEqual(await checkManifest(good,invite,me),good);
 const stranger=(await key()).publicKey.toBase58();
 const rehash=m=>({...m,terms:channelTerms(m)});
 // Internally consistent, down to the address, so that only the comparison with the invite can catch it.
 const consistent=async m=>{const [match]=await channelAddress(m.program,m.players[0],Buffer.from(m.nonce,'hex'));return rehash({...m,match:match.toBase58()});};
 const swaps={
  protocol:{...good,protocol:'other'},
  program:await consistent({...good,program:stranger}),
  genesis:rehash({...good,genesis:stranger}),
  'host wallet':await consistent({...good,players:[stranger,good.players[1]]}),
  'guest wallet':rehash({...good,players:[good.players[0],stranger]}),
  'guest session':rehash({...good,sessions:[good.sessions[0],'ef'.repeat(32)]}),
  'bad host session':{...good,sessions:['xx',good.sessions[1]]},
  buyIn:rehash({...good,buyIn:good.buyIn*2}),
  blind:rehash({...good,bigBlind:good.bigBlind*2}),
  hands:rehash({...good,maxHands:good.maxHands+1}),
  clock:rehash({...good,turnSeconds:30}),
  'terms hash':{...good,terms:'00'.repeat(32)},
  'match address':rehash({...good,match:stranger}),
  nonce:rehash({...good,nonce:'00'.repeat(32)}),
 };
 for(const [name,manifest] of Object.entries(swaps))await assert.rejects(checkManifest(manifest,invite,me),undefined,name);
 for(const junk of [null,{},{protocol:'agent-stacks/channel/v1'}])await assert.rejects(checkManifest(junk,invite,me));
 await assert.rejects(checkManifest(good,invite,{...me,wallet:stranger}),/different players/,'it was made for someone else');
});

test('only devnet counts as a test network, so a host can only give away test funds',()=>{
 assert.equal(isTestNetwork(GENESIS),true);
 for(const other of ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',undefined,null,'',PROGRAM])assert.equal(isTestNetwork(other),false,String(other));
});

test('an invite can’t choose the contract',()=>{
 const trusted=trustedDeployment(GENESIS);
 assert.equal(trusted.program,PROGRAM);
 assert.match(trusted.programSha256,/^[0-9a-f]{64}$/);
 assert.throws(()=>trustedDeployment('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),/no trusted contract/,'mainnet has none yet');
 for(const bad of [{},{program:PROGRAM},{program:PROGRAM,programBytes:0,programSha256:'ab'.repeat(32)},{program:PROGRAM,programBytes:5,programSha256:'nope'}])assert.throws(()=>trustedDeployment(GENESIS,bad),/Invalid deployment/);
});

test('with a relay in the middle, both sides end up with the same match and nobody else gets in',{timeout:30000},async t=>{
 const injected=[];
 const relay=await startRelay({tap:(_seat,body)=>[...injected.splice(0),body]});
 t.after(()=>relay.close());
 const hostWallet=await key(),guestWallet=await key(),guestSession=await key(),intruder=await key();
 const invite=newInvite(terms({relay:relay.url,host:hostWallet.publicKey.toBase58()}));
 const hostSide=new RelayTransport(relay.url,invite.id,0),guestSide=new RelayTransport(relay.url,invite.id,1);
 const offer=makeOffer(guestWallet,guestSession);
 const manifest=await manifestFor(invite,hostWallet.publicKey,guestWallet.publicKey,sessionHex(guestSession));
 // What a relay might slip in ahead of the real messages: rubbish, an unsealed offer, one sealed with the
 // wrong secret, one sealed properly but from the host's own wallet, and one whose signature doesn't match.
 const otherInvite=newInvite(terms());
 const intruderOffer=makeOffer(intruder,intruder);
 injected.push('{"type":"offer"}','null','[]',JSON.stringify({type:'offer',body:intruderOffer}),JSON.stringify(seal(otherInvite,'offer',intruderOffer)),JSON.stringify(seal(invite,'offer',makeOffer(hostWallet,intruder))),JSON.stringify(seal(invite,'offer',{...intruderOffer,wallet:guestWallet.publicKey.toBase58()})));
 const hosting=waitForOffer({invite,transport:hostSide,pollMs:10,timeoutMs:10_000});
 const guesting=waitForManifest({invite,offer,transport:guestSide,pollMs:10,resendMs:50,timeoutMs:10_000});
 assert.deepEqual(await hosting,offer,'the host only took the real guest’s offer');
 // And a relay's forged match never reaches the guest's checks.
 const forged=await manifestFor(otherInvite,intruder.publicKey,guestWallet.publicKey,sessionHex(guestSession));
 injected.push(JSON.stringify({type:'manifest',body:forged}),JSON.stringify(seal(otherInvite,'manifest',forged)));
 await hostSide.send(seal(invite,'manifest',manifest));
 assert.deepEqual(await guesting,manifest);
 assert.deepEqual(await checkManifest(manifest,invite,{wallet:guestWallet.publicKey.toBase58(),session:sessionHex(guestSession)}),manifest);
});

test('a relay that’s down only means waiting, and giving up on time',{timeout:30000},async()=>{
 const invite=newInvite(terms()),logged=[];
 const failing={send:async()=>{throw Error('down');},receive:async()=>{throw Error('down');}};
 await assert.rejects(waitForOffer({invite,transport:failing,pollMs:5,timeoutMs:60,log:s=>logged.push(s)}),/Timed out/);
 assert.ok(logged.some(s=>/down/.test(s)));
 const wallet=await key();
 await assert.rejects(waitForManifest({invite,offer:makeOffer(wallet,wallet),transport:failing,pollMs:5,resendMs:5,timeoutMs:60}),/Timed out/);
});

test('the guest keeps offering until it hears back, in case a message was lost',{timeout:30000},async t=>{
 let dropped=0;
 const relay=await startRelay({tap:(seat,body)=>{if(seat===0&&dropped<2){dropped++;return [];}return [body];}});
 t.after(()=>relay.close());
 const wallet=await key(),session=await key();
 const invite=newInvite(terms({relay:relay.url}));
 const offer=makeOffer(wallet,session);
 const guest=waitForManifest({invite,offer,transport:new RelayTransport(relay.url,invite.id,1),pollMs:5,resendMs:20,timeoutMs:8000}).catch(()=>null);
 assert.deepEqual(await waitForOffer({invite,transport:new RelayTransport(relay.url,invite.id,0),pollMs:5,timeoutMs:8000}),offer);
 assert.equal(dropped,2);
 await new RelayTransport(relay.url,invite.id,0).send(seal(invite,'manifest',{any:'thing'}));
 assert.deepEqual(await guest,{any:'thing'});
});
