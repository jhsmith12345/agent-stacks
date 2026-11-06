// A relay anyone on the internet can reach. Whatever they do to it, it has to stay up and within its limits,
// and the players' messages have to stay private. Whether a relay can hurt a match is covered with the agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {RELAY_LIMITS,RelayTransport,SealedTransport,startRelay} from '../src/channel/relay.js';
import {decodeInvite,encodeInvite,matchKey,matchMailbox,newInvite} from '../src/channel/invite.js';
const MATCH='11111111111111111111111111111113',OTHER='11111111111111111111111111111114';
const pad=n=>({pad:'x'.repeat(n)});
const open=async(t,options)=>{const relay=await startRelay(options);t.after(()=>relay.close());return relay;};
const post=(relay,body,match=MATCH,seat=0)=>fetch(`${relay.url}/${match}/${seat}`,{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)});
const read=(relay,after=0,match=MATCH,seat=0)=>fetch(`${relay.url}/${match}/${seat}?after=${after}`).then(r=>r.json());

test('a mailbox keeps its newest messages, and a long match never runs out of room',{timeout:60000},async t=>{
 const relay=await open(t,{limits:{boxBytes:10_000,requestsPerMinute:1e6}});
 const a=new RelayTransport(relay.url,MATCH,1),b=new RelayTransport(relay.url,MATCH,0);
 // More messages than any fixed count allowed, read as they come, the way agents do.
 for(let i=0;i<4100;i++){
  await a.send({i});
  if(i%40===0)assert.equal((await b.receive()).at(-1).i,i);
 }
 assert.equal((await b.receive()).at(-1).i,4099,'still flowing');
 for(let i=0;i<20;i++)assert.equal((await post(relay,{n:i,...pad(1000)})).status,204);
 const box=relay.boxes.get(`${MATCH}/0`);
 assert.ok(box.bytes<=10_000,`stayed within the limit: ${box.bytes}`);
 assert.ok(box.first>0,'the oldest went');
 assert.equal((await fetch(`${relay.url}/health`).then(r=>r.json())).bytes,box.bytes,'and no longer counts towards the total');
 assert.equal(box.items.at(-1).includes('"n":19'),true,'the newest stayed');
 // A reader that fell behind picks up at what's left, and doesn't get stuck behind what was dropped.
 const lagging=new RelayTransport(relay.url,MATCH,0);
 const got=await lagging.receive();
 assert.ok(got.length>0&&got[0].n>0,'it starts at the oldest message kept');
 assert.equal(lagging.next,box.first+box.items.length);
 assert.deepEqual(await lagging.receive(),[],'and nothing comes twice');
});
test('one message is always kept and can always be read, whatever the limits',async t=>{
 const relay=await open(t,{limits:{boxBytes:10,readBytes:10}});
 assert.equal((await post(relay,pad(1000))).status,204);
 const {messages}=await read(relay);
 assert.equal(messages.length,1);
});
test('memory stays within its limit, and the mailbox unused for longest goes first',async t=>{
 const relay=await open(t,{limits:{totalBytes:30_000,boxBytes:30_000}});
 const name=i=>`1111111111111111111111111111111${'23456789'[i]}`;
 for(let i=0;i<3;i++)await post(relay,pad(9000),name(i));
 // Mailbox 0 is in use, so mailbox 1 is the one to go.
 await read(relay,0,name(0));
 await post(relay,pad(9000),name(3));
 const keys=[...relay.boxes.keys()];
 assert.ok(!keys.includes(`${name(1)}/0`),'the least recently used is gone');
 assert.ok(keys.includes(`${name(0)}/0`),'the one in use stays');
 assert.ok(keys.includes(`${name(3)}/0`),'and the newest');
 for(let i=0;i<20;i++)await post(relay,pad(9000),name(i%8));
 const total=[...relay.boxes.values()].reduce((sum,b)=>sum+b.bytes,0);
 assert.ok(total<=30_000,`total ${total}`);
 assert.equal((await fetch(`${relay.url}/health`).then(r=>r.json())).bytes,total,'and its count is exact');
});
test('the number of mailboxes is limited, and asking about one doesn’t create it',async t=>{
 const relay=await open(t,{limits:{boxes:2}});
 for(let i=0;i<30;i++){const {messages}=await read(relay,0,`1111111111111111111111111111${String(1000+i)}`.replaceAll('0','2'));assert.deepEqual(messages,[]);}
 assert.equal(relay.boxes.size,0);
 for(const n of ['2','3','4','5'])await post(relay,{n},`1111111111111111111111111111111${n}`);
 assert.equal(relay.boxes.size,2);
});
test('idle mailboxes expire, and busy ones stay',async t=>{
 let time=1_000_000;
 const relay=await open(t,{now:()=>time,limits:{idleMs:1000}});
 await post(relay,{a:1},MATCH);await post(relay,{b:1},OTHER);
 time+=600;await read(relay,0,MATCH);
 time+=600;relay.sweep();
 assert.ok(relay.boxes.has(`${MATCH}/0`),'it was read recently');
 assert.ok(!relay.boxes.has(`${OTHER}/0`),'nobody touched this one');
 time+=2000;relay.sweep();
 assert.equal(relay.boxes.size,0);
 assert.equal((await fetch(`${relay.url}/health`).then(r=>r.json())).bytes,0);
});
test('each address has a limit on requests, and it resets',async t=>{
 let time=1_000_000;
 const relay=await open(t,{now:()=>time,limits:{requestsPerMinute:5}});
 for(let i=0;i<5;i++)assert.equal((await fetch(`${relay.url}/${MATCH}/0`)).status,200);
 const refused=await fetch(`${relay.url}/${MATCH}/0`);
 assert.equal(refused.status,429);assert.equal(refused.headers.get('retry-after'),'30');
 assert.equal((await post(relay,{a:1})).status,429,'writes count too');
 time+=61_000;
 assert.equal((await fetch(`${relay.url}/${MATCH}/0`)).status,200);
});
test('each address has a limit on what it writes and reads',async t=>{
 const writing=await open(t,{limits:{writeBytesPerMinute:5000}});
 assert.equal((await post(writing,pad(6000))).status,204,'it stops at the limit, not partway through a message');
 assert.equal((await post(writing,pad(10))).status,429);
 const reading=await open(t,{limits:{readBytesPerMinute:5000}});
 await post(reading,pad(6000));
 assert.equal((await fetch(`${reading.url}/${MATCH}/0`)).status,200);
 assert.equal((await fetch(`${reading.url}/${MATCH}/0`)).status,429);
});
test('outgoing traffic has a daily budget, because whoever runs a relay pays for it',async t=>{
 let time=1_000_000;
 const relay=await open(t,{now:()=>time,limits:{dailyEgressBytes:5000,requestsPerMinute:1e6,readBytesPerMinute:1e9}});
 await post(relay,pad(3000));
 assert.equal((await fetch(`${relay.url}/${MATCH}/0`)).status,200);
 assert.equal((await fetch(`${relay.url}/${MATCH}/0`)).status,200);
 const refused=await fetch(`${relay.url}/${MATCH}/0`);
 assert.equal(refused.status,503);assert.equal(refused.headers.get('retry-after'),'3600');
 assert.equal((await post(relay,{a:1})).status,204,'messages can still be left, since incoming traffic is free');
 time+=86_400_001;
 assert.equal((await fetch(`${relay.url}/${MATCH}/0`)).status,200);
});
test('one read is limited, and what’s left comes with the next',async t=>{
 const relay=await open(t,{limits:{readBytes:2500}});
 for(let i=0;i<5;i++)await post(relay,{i,...pad(1000)});
 const first=await read(relay);
 assert.equal(first.messages.length,2);assert.equal(first.next,2);
 const second=await read(relay,first.next);
 assert.deepEqual(second.messages.map(m=>m.i),[2,3]);
 for(let i=0;i<60;i++)await post(relay,{i},OTHER);
 assert.equal((await read(relay,0,OTHER)).messages.length,50);
});
test('a relay that restarts is picked up again',async t=>{
 const relay=await open(t,{});
 const a=new RelayTransport(relay.url,MATCH,1),b=new RelayTransport(relay.url,MATCH,0);
 for(let i=0;i<5;i++)await a.send({i});
 assert.equal((await b.receive()).length,5);
 relay.boxes.clear();
 assert.deepEqual(await b.receive(),[]);
 assert.equal(b.next,0,'it starts again from the beginning');
 await a.send({again:1});
 assert.deepEqual(await b.receive(),[{again:1}]);
});
test('requests that make no sense are refused without storing anything',async t=>{
 const relay=await open(t,{});
 for(const path of ['/','/x/0','/admin','/../etc/passwd',`/${MATCH}/2`,`/${MATCH}`,`/${MATCH}/0?after=abc`,`/${MATCH}/0?after=${'9'.repeat(40)}`,'/favicon.ico'])assert.equal((await fetch(relay.url+path)).status,404,path);
 assert.equal((await post(relay,'not json')).status,400);
 assert.equal((await fetch(`${relay.url}/${MATCH}/0`,{method:'POST',body:Buffer.alloc(1_600_000)})).status,413);
 assert.equal(relay.boxes.size,0);
 assert.deepEqual(await fetch(`${relay.url}/health`).then(r=>r.json()),{ok:true,boxes:0,bytes:0});
});
test('the limits are what the deployment relies on',()=>{
 // The most it could ever hold, including messages still arriving, has to fit a small VM's 700 MB limit.
 assert.ok(RELAY_LIMITS.totalBytes+RELAY_LIMITS.connections*1_500_000<=700_000_000);
});

// What the relay and the network get to see.
const sealedPair=(url,box,key)=>[0,1].map(seat=>new SealedTransport(new RelayTransport(url,box,seat),key,seat));
test('sealed messages get through, and the relay sees nothing but sizes',async t=>{
 const seen=[];
 const relay=await open(t,{tap:(_seat,body)=>{seen.push(body);return [body];}});
 const invite=decodeInvite(encodeInvite(newInvite({relay:relay.url,program:MATCH,genesis:OTHER,host:MATCH,buyIn:1_000_000,bigBlind:20_000,hands:2,seconds:600,think:20})));
 const [a,b]=sealedPair(relay.url,matchMailbox(invite),matchKey(invite));
 const move={type:'move',seq:7,step:{action:3,amount:60_000},sig:'secretive'};
 await a.send(move);
 assert.deepEqual(await b.receive(),[move]);
 assert.deepEqual(await b.receive(),[]);
 await b.send({type:'ack',seq:7});
 assert.deepEqual(await a.receive(),[{type:'ack',seq:7}]);
 for(const body of seen)for(const word of ['move','ack','action','60000','secretive','seq'])assert.ok(!body.includes(word),word);
 assert.notEqual(seen[0],JSON.stringify(move));
});
test('the mailbox and key come from the invite’s secret, and neither can be worked out without it',()=>{
 const make=()=>newInvite({relay:'https://relay.example',program:MATCH,genesis:OTHER,host:MATCH,buyIn:1_000_000,bigBlind:20_000,hands:2,seconds:600,think:20});
 const a=make(),b=make();
 assert.equal(matchMailbox(a),matchMailbox(decodeInvite(encodeInvite(a))),'both players get the same one');
 assert.deepEqual(matchKey(a),matchKey(decodeInvite(encodeInvite(a))));
 assert.notEqual(matchMailbox(a),matchMailbox(b));
 assert.notDeepEqual(matchKey(a),matchKey(b));
 // The handshake's mailbox is a different name, so it says nothing about where the match's messages go.
 assert.notEqual(matchMailbox(a),a.id);
 assert.match(matchMailbox(a),/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,'the relay accepts it');
 assert.equal(matchKey(a).length,32);
 assert.ok(!matchKey(a).toString('hex').includes(a.secret));
});
test('the same message never looks the same twice, because repeating a nonce would break the seal',async t=>{
 const bodies=[];
 const relay=await open(t,{tap:(_seat,body)=>{bodies.push(body);return [body];}});
 const [a,b]=sealedPair(relay.url,MATCH,randomBytes(32));
 for(let i=0;i<20;i++)await a.send({same:'message'});
 const sealed=bodies.map(body=>JSON.parse(body));
 assert.equal(new Set(sealed.map(s=>s.iv)).size,20,'every nonce differs');
 assert.equal(new Set(sealed.map(s=>s.data)).size,20,'so every ciphertext does');
 assert.equal((await b.receive()).length,20);
});
test('junk, tampering and the wrong key are dropped unread',async t=>{
 const bodies=[];
 const relay=await open(t,{tap:(_seat,body)=>{bodies.push(body);return [body];}});
 const key=randomBytes(32),[a,b]=sealedPair(relay.url,MATCH,key);
 const [stranger]=sealedPair(relay.url,MATCH,randomBytes(32));
 await stranger.send({type:'move',forged:true});
 for(const junk of [{},{iv:1},{iv:'',data:'',tag:''},[],'text',{iv:'AAAA',data:'AAAA',tag:'AAAA'}])await post(relay,junk,MATCH,1);
 await a.send({real:1});
 const sealed=JSON.parse(bodies.at(-1));
 const flip=text=>{const b=Buffer.from(text,'base64');b[0]^=1;return b.toString('base64');};
 await post(relay,{...sealed,data:flip(sealed.data)},MATCH,1);
 await post(relay,{...sealed,tag:flip(sealed.tag)},MATCH,1);
 await post(relay,{...sealed,iv:flip(sealed.iv)},MATCH,1);
 assert.deepEqual(await b.receive(),[{real:1}]);
 assert.equal(b.dropped,9,'the stranger’s message, 5 kinds of junk and 3 tampered copies');
});
test('a relay can’t hand a player’s own message back to it as the opponent’s',async t=>{
 const relay=await open(t,{tap:(_seat,body)=>[body]});
 const key=randomBytes(32),[a]=sealedPair(relay.url,MATCH,key);
 await a.send({mine:1});
 // The relay copies it into the sender's own mailbox.
 const [raw]=relay.boxes.get(`${MATCH}/1`).items;
 await post(relay,raw,MATCH,0);
 assert.deepEqual(await a.receive(),[]);
 assert.equal(a.dropped,1);
});
test('the largest message a match sends still fits once sealed',async t=>{
 const relay=await open(t,{});
 const [a,b]=sealedPair(relay.url,MATCH,randomBytes(32));
 const shuffle={type:'shuffle',hand:1,wire:'A'.repeat(1_000_000),sig:'b'.repeat(128),accept:{seq:1,hash:'c'.repeat(64),sig:'d'.repeat(128)}};
 await a.send(shuffle);
 assert.deepEqual(await b.receive(),[shuffle]);
});
test('a bad key is refused up front',()=>{
 assert.throws(()=>new SealedTransport({},Buffer.alloc(16),0),/Invalid relay key/);
});
