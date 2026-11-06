import test from 'node:test';
import assert from 'node:assert/strict';
import {ChainClient,Keypair,DEVNET,DEVNET_GENESIS,termsHash,decodeMatch,LAYOUT,u64} from '../src/solana/client.js';
const accept=async()=>({value:{err:null}});
test('network guard rejects other clusters, including a mainnet RPC behind a devnet-looking URL',async()=>{
 const w=await Keypair.generate();const c=new ChainClient(DEVNET,w.publicKey,w);
 c.connection={getGenesisHash:async()=> 'mainnet-genesis'};await assert.rejects(c.checkNetwork(),/non-devnet/);
 c.connection={getGenesisHash:async()=>DEVNET_GENESIS};await c.checkNetwork();
 const local=new ChainClient('http://127.0.0.1:18899',w.publicKey,w);local.connection={getGenesisHash:async()=> 'local'};await assert.rejects(local.checkNetwork(),/explicit local/);
 local.allowLocal=true;await local.checkNetwork();
});
test('remote plaintext RPC is rejected and asynchronous journal failure prevents sending',async()=>{
 const w=await Keypair.generate();const unsafe=new ChainClient('http://untrusted.example',w.publicKey,w);
 unsafe.connection={getGenesisHash:async()=>DEVNET_GENESIS};await assert.rejects(unsafe.checkNetwork(),/HTTPS/);
 let sent=false;const c=new ChainClient(DEVNET,w.publicKey,w,{onTransaction:async()=>{await Promise.resolve();throw Error('Durable storage failed');}});c.networkChecked=true;
 c.connection={getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async()=>{sent=true;}};
 await assert.rejects(c.send([c.instruction(0,[],[])]),/Durable storage failed/);assert.equal(sent,false);
});
test('transaction signing journals the original signature before submitting and preserves observed match version',async()=>{
 const w=await Keypair.generate(),events=[];const c=new ChainClient(DEVNET,w.publicKey,w,{onTransaction:(s,d)=>events.push({s,...d})});c.networkChecked=true;
 let observed;
 c.connection={getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async bytes=>{assert.ok(bytes.length<=1232);assert.equal(events[0].status,'prepared');return events[0].s;},getSignatureStatuses:async()=>({value:[{confirmationStatus:'confirmed',err:null}]})};
 const send=c.send.bind(c);c.send=async (ix,...args)=>{observed=Buffer.from(ix[0].data).readBigUInt64LE(1);return send(ix,...args);};c.match=()=>{throw Error('Must not replace observed version with a newer state');};
 const signature=await c.command(w.publicKey.toBase58(),15,[Buffer.from([1]),u64(0)],[],null,7);
 assert.equal(observed,7n);assert.equal(events[0].s,signature);assert.equal(events[1].status,'confirmed');assert.equal(events[0].lastValidBlockHeight,'100');
});
test('ambiguous submission errors retain the signed transaction signature for recovery',async()=>{
 const w=await Keypair.generate();let prepared;const c=new ChainClient(DEVNET,w.publicKey,w,{onTransaction:(s,d)=>{prepared={signature:s,...d};}});c.networkChecked=true;
 c.connection={getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async()=>{const error=Error('Connection dropped');error.signature='';throw error;}};
 await assert.rejects(c.send([c.instruction(0,[],[])]),e=>e.signature===prepared.signature&&e.message==='Connection dropped');assert.ok(prepared.transactionBase64);
});
test('terms bind cluster, program, participants, stakes, blinds, clock and hand limit',()=>{
 const config={program:'p',players:['a','b'],buyIn:1000,bigBlind:20,turnSeconds:86400};const original=termsHash(config);
 for(const delta of [{genesis:'another-cluster'},{program:'q'},{players:['b','a']},{buyIn:2000},{bigBlind:40},{turnSeconds:30},{maxHands:2}])assert.notEqual(termsHash({...config,...delta}),original);
 assert.throws(()=>decodeMatch(Buffer.alloc(LAYOUT.size)),/layout/);assert.throws(()=>decodeMatch(Buffer.alloc(10)),/layout/);
});
test('accepted manifests must match the actual RPC genesis, program and match address',async()=>{
 const {PublicKey}=await import('../src/solana/client.js');
 const [a,b,p,other]=await Promise.all(Array.from({length:4},()=>Keypair.generate()));
 const nonce=Buffer.alloc(32,7),[id,bump]=await PublicKey.findProgramAddress([Buffer.from('escrow'),a.publicKey.toBytes(),nonce],p.publicKey);
 const config={genesis:DEVNET_GENESIS,program:p.publicKey.toBase58(),match:id.toBase58(),players:[a.publicKey.toBase58(),b.publicKey.toBase58()],buyIn:1000,bigBlind:20,turnSeconds:30,maxHands:2};config.terms=termsHash(config);
 const data=Buffer.alloc(LAYOUT.size);data.write('ASTKESC5');u64(1).copy(data,9);data.set(a.publicKey.toBytes(),17);data.set(b.publicKey.toBytes(),49);u64(1000).copy(data,81);u64(30).copy(data,89);nonce.copy(data,217);data[249]=bump;u64(20).copy(data,LAYOUT.blind);data.writeUInt32LE(1,LAYOUT.hand);data.writeUInt32LE(2,LAYOUT.maxHands);Buffer.from(config.terms,'hex').copy(data,105);
 const c=new ChainClient(DEVNET,p.publicKey,a);c.connection={getGenesisHash:async()=>DEVNET_GENESIS,getAccountInfo:async()=>({owner:p.publicKey,data})};
 assert.equal((await c.match(config.match,config)).maxHands,2);
 for(const change of [{genesis:'another-genesis'},{program:other.publicKey.toBase58()},{match:other.publicKey.toBase58()}]){
  const wrong={...config,...change};wrong.terms=termsHash(wrong);Buffer.from(wrong.terms,'hex').copy(data,105);
  await assert.rejects(c.match(config.match,wrong),/accepted configuration/);
 }
 data.write('ASTKESC4');assert.throws(()=>decodeMatch(data),/Unsupported/);
 assert.throws(()=>decodeMatch(Buffer.from('ASTKEND5')),/retired/);
});
test('timeout scheduling reads the chain Clock and rejects malformed clock accounts',async()=>{
 const {PublicKey}=await import('../src/solana/client.js');const w=await Keypair.generate();
 const c=new ChainClient(DEVNET,w.publicKey,w);c.networkChecked=true;
 const data=Buffer.alloc(40);data.writeBigInt64LE(123456n,32);
 let owner=new PublicKey('Sysvar1111111111111111111111111111111111111');
 c.connection={getAccountInfo:async key=>{assert.equal(key.toBase58(),'SysvarC1ock11111111111111111111111111111111');return {owner,data};}};
 assert.equal(await c.chainTime(),123456);owner=w.publicKey;await assert.rejects(c.chainTime(),/Clock account/);
});

test('proof contexts bind each hand and full upload chunks fit a Solana packet',async()=>{
 const {keyContext,shuffleContext,shareContext,u32,PublicKey}=await import('../src/solana/client.js');
 for(const fn of [h=>keyContext('p','m',0,'terms',h),h=>shuffleContext('p','m',0,'terms',h),h=>shareContext('p','m',5,1,0,'terms',h)])assert.notEqual(fn(1),fn(2));
 const wallet=await Keypair.generate(),proof=await Keypair.generate(),program=await Keypair.generate();let size;
 const client=new ChainClient(DEVNET,program.publicKey,wallet);client.networkChecked=true;
 client.connection={getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async bytes=>{size=bytes.length;return 'ok';},getSignatureStatuses:async()=>({value:[{confirmationStatus:'confirmed',err:null}]})};
 await client.send([client.instruction(9,[u32(0),Buffer.alloc(1000)],[{pubkey:proof.publicKey,isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true}])]);
 assert.ok(size<=1232);assert.ok(size>1100);
});

const hash='11111111111111111111111111111111';
const statusList=states=>{let i=0;return async()=>({value:[{confirmationStatus:states[Math.min(i++,states.length-1)],err:null}]});};
test('a transaction rejected in simulation is never recorded or released',async()=>{
 const w=await Keypair.generate(),events=[];let sent=0;
 const c=new ChainClient(DEVNET,w.publicKey,w,{onTransaction:(s,d)=>events.push(d)});c.networkChecked=true;
 c.connection={getLatestBlockhash:async()=>({blockhash:hash,lastValidBlockHeight:100n}),sendRawTransaction:async()=>{sent++;},simulateTransaction:async(_,options)=>{
  assert.equal(options.sigVerify,true);assert.equal(options.replaceRecentBlockhash,false);
  return {value:{err:{InstructionError:[0,'InvalidInstructionData']}}};
 }};
 await assert.rejects(c.send([c.instruction(12,[],[])]),e=>e.notSent===true&&/not sent/.test(e.message)&&e.signature===undefined);
 c.connection.simulateTransaction=async()=>{throw Error('trusted node unavailable');};
 await assert.rejects(c.send([c.instruction(12,[],[])]),/trusted node unavailable/);
 assert.equal(sent,0);assert.deepEqual(events,[]);
});
test('the relay receives bytes only after the trusted node simulated them and they were recorded',async()=>{
 const w=await Keypair.generate(),order=[];
 const c=new ChainClient(DEVNET,w.publicKey,w,{onTransaction:(_,d)=>order.push(d.status)});c.networkChecked=true;
 c.connection={getLatestBlockhash:async()=>({blockhash:hash,lastValidBlockHeight:100n}),simulateTransaction:async()=>{order.push('simulated');return {value:{err:null}};},getSignatureStatuses:statusList(['confirmed'])};
 c.submissionConnection={sendRawTransaction:async(_,options)=>{assert.equal(options.skipPreflight,true);order.push('relayed');}};
 await c.send([c.instruction(9,[],[])]);
 assert.deepEqual(order,['simulated','prepared','relayed','confirmed']);
});
test('only explicit bulk steps clear at confirmed; every other send on a finalized client waits for finality',async()=>{
 const w=await Keypair.generate();const c=new ChainClient(DEVNET,w.publicKey,w,{commitment:'finalized'});c.networkChecked=true;
 let polls=0;const statuses=statusList(['confirmed','confirmed','finalized']);
 const connection=()=>({getLatestBlockhash:async()=>({blockhash:hash,lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async()=>'ok'});
 c.connection={...connection(),getSignatureStatuses:async()=>{polls++;return statuses();}};
 await c.send([c.instruction(15,[],[])]);assert.equal(polls,3,'a normal send must wait for finalized');
 polls=0;c.connection={...connection(),getSignatureStatuses:async()=>{polls++;return {value:[{confirmationStatus:'confirmed',err:null}]};}};
 await c.send([c.instruction(9,[],[])],[],null,{confirmation:'confirmed'});assert.equal(polls,1,'a bulk step clears at confirmed');
});

test('failures from the RPC layer are tagged and bounded; the client\'s own checks are not tagged',async()=>{
 const {createServer}=await import('node:http');const {once}=await import('node:events');
 const w=await Keypair.generate();
 const refused=new ChainClient('http://127.0.0.1:9',w.publicKey,w,{allowLocal:true});
 await assert.rejects(refused.connection.getGenesisHash(),e=>e.rpcFailure===true);
 const hanging=createServer(()=>{});hanging.listen(0,'127.0.0.1');await once(hanging,'listening');
 try{
  const slow=new ChainClient(`http://127.0.0.1:${hanging.address().port}`,w.publicKey,w,{allowLocal:true,rpcTimeoutMs:50});
  const started=Date.now();await assert.rejects(slow.connection.getGenesisHash(),e=>e.rpcFailure===true);assert.ok(Date.now()-started<5000,'a node that never answers cannot stall the agent');
 }finally{hanging.close();hanging.closeAllConnections();}
 const {PublicKey}=await import('../src/solana/client.js');const c=new ChainClient(DEVNET,w.publicKey,w);
 await assert.rejects(c.validateMatch(w.publicKey.toBase58(),null),e=>e.notYetVisible===true&&e.rpcFailure===undefined&&/not visible/.test(e.message));
 await assert.rejects(c.validateMatch(w.publicKey.toBase58(),{owner:new PublicKey('11111111111111111111111111111111'),data:Buffer.alloc(0)}),e=>e.notYetVisible===undefined&&e.rpcFailure===undefined&&/not owned/.test(e.message));
});
test('a transaction that never left is marked not sent and returns its authorization, for rejections and for a dead node',async()=>{
 const w=await Keypair.generate();let released=0,prepared=0;
 const c=new ChainClient(DEVNET,w.publicKey,w,{releaseAuthorization:()=>{released++;},onTransaction:(_,d)=>{if(d.status==='prepared')prepared++;}});c.networkChecked=true;
 const base={getLatestBlockhash:async()=>({blockhash:hash,lastValidBlockHeight:100n})};
 c.connection={...base,simulateTransaction:async()=>({value:{err:'AccountNotFound'}})};
 await assert.rejects(c.send([c.instruction(9,[],[])]),e=>e.notSent===true);assert.equal(released,1);
 c.connection={...base,simulateTransaction:async()=>{throw Error('node down');}};
 await assert.rejects(c.send([c.instruction(9,[],[])]),e=>e.notSent===true&&e.message==='node down');assert.equal(released,2);
 c.connection={...base,simulateTransaction:accept,sendRawTransaction:async()=>{throw Error('relay down');}};
 await assert.rejects(c.send([c.instruction(9,[],[])]),e=>e.notSent===undefined&&!!e.signature);assert.equal(released,2,'released bytes keep their reservation');assert.equal(prepared,1);
});
test('a priced transaction carries an explicit limit, and a full upload chunk would not fit beside the fee instructions',async()=>{
 const {u32}=await import('../src/solana/client.js');const {Transaction}=await import('@solana/web3.js');
 const wallet=await Keypair.generate(),proof=await Keypair.generate(),program=await Keypair.generate();let size,sent;
 const client=new ChainClient(DEVNET,program.publicKey,wallet,{computeUnitPrice:async()=>7});client.networkChecked=true;
 client.connection={getLatestBlockhash:async()=>({blockhash:hash,lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async bytes=>{size=bytes.length;sent=bytes;return 'ok';},getSignatureStatuses:statusList(['confirmed'])};
 const metas=[{pubkey:proof.publicKey,isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true}];
 await assert.rejects(client.send([client.instruction(9,[u32(0),Buffer.alloc(1000)],metas)]),/1261 exceeds limit of 1232/);
 await client.send([client.instruction(9,[u32(0),Buffer.alloc(960)],metas)]);assert.ok(size<=1232);
 const compute=(await Transaction.from(sent)).instructions.filter(ix=>ix.programId.toBase58()==='ComputeBudget111111111111111111111111111111').map(ix=>Buffer.from(ix.data)[0]).sort();
 assert.deepEqual(compute,[2,3]);
});

test('failed status polls and resends do not abandon a healthy send, but other errors still stop it',async()=>{
 const w=await Keypair.generate(),events=[];const c=new ChainClient(DEVNET,w.publicKey,w,{commitment:'finalized',onTransaction:(_,d)=>events.push(d.status)});c.networkChecked=true;
 const down=()=>Object.assign(Error('HTTP 503'),{rpcFailure:true});let polls=0;
 c.connection={getLatestBlockhash:async()=>({blockhash:hash,lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async()=>'ok',getSignatureStatuses:async()=>{if(++polls<4)throw down();return {value:[{confirmationStatus:'finalized',err:null}]};}};
 await c.send([c.instruction(15,[],[])]);assert.equal(polls,4);assert.deepEqual(events,['prepared','confirmed']);
 c.connection.getSignatureStatuses=async()=>{throw Error('a client bug');};
 await assert.rejects(c.send([c.instruction(15,[],[])]),/a client bug/);
});

test('board positions reject an impossible street instead of treating it as the river',async()=>{
 const {positions}=await import('../src/solana/client.js');
 assert.deepEqual(positions({phase:9,game:{street:1}}),[4,5,6]);assert.deepEqual(positions({phase:10,game:{street:2}}),[7]);assert.deepEqual(positions({phase:9,game:{street:3}}),[8]);
 for(const street of [0,4,255])assert.throws(()=>positions({phase:9,game:{street}}),/Invalid board street/);
});
test('creator tools send the right instruction, and refuse the wrong state or caller',async()=>{
 const {PublicKey}=await import('../src/solana/client.js');const {Transaction}=await import('@solana/web3.js');
 const w=await Keypair.generate(),other=await Keypair.generate(),match=await Keypair.generate(),id=match.publicKey.toBase58();let sent;
 const c=new ChainClient(DEVNET,w.publicKey,w,{commitment:'confirmed'});c.networkChecked=true;
 c.connection={getLatestBlockhash:async()=>({blockhash:hash,lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async bytes=>{sent=bytes;return 'ok';},getSignatureStatuses:statusList(['confirmed'])};
 let state;c.match=async()=>state;const base={version:9,players:[w.publicKey.toBase58(),other.publicKey.toBase58()],pendingPayouts:0};
 const lastInstruction=async()=>{const ix=(await Transaction.from(sent)).instructions.at(-1),d=Buffer.from(ix.data);return {tag:d[0],version:d.readBigUInt64LE(1),length:d.length,keys:ix.keys.map(k=>k.pubkey.toBase58())};};
 state={...base,phase:0};await c.cancelInvitation(id);
 assert.deepEqual(await lastInstruction(),{tag:6,version:9n,length:9,keys:[id,w.publicKey.toBase58()]});
 state={...base,phase:6};await c.closeMatch(id);
 assert.deepEqual(await lastInstruction(),{tag:7,version:9n,length:9,keys:[id,w.publicKey.toBase58()]});
 sent=null;
 state={...base,phase:1};await assert.rejects(c.cancelInvitation(id),/nobody has joined/);await assert.rejects(c.closeMatch(id),/completed match/);
 state={...base,phase:6,pendingPayouts:2};await assert.rejects(c.closeMatch(id),/claims are still outstanding/);
 state={...base,phase:0,players:[other.publicKey.toBase58(),w.publicKey.toBase58()]};await assert.rejects(c.cancelInvitation(id),/Only the match creator/);
 assert.equal(sent,null,'none of the refused calls sent anything');
});
test('an unusable co-signature is refused before anything is recorded, and returns the reservation',async()=>{
 const {Transaction,TransactionInstruction}=await import('@solana/web3.js');
 const w=await Keypair.generate(),peer=await Keypair.generate(),events=[];let released=0,sent=0;
 const c=new ChainClient(DEVNET,w.publicKey,w,{releaseAuthorization:()=>{released++;},onTransaction:(_,d)=>events.push(d.status)});c.networkChecked=true;
 c.connection={simulateTransaction:accept,sendRawTransaction:async()=>{sent++;}};
 const tx=new Transaction({feePayer:w.publicKey,blockhash:hash,lastValidBlockHeight:100n}).add(new TransactionInstruction({programId:w.publicKey,data:Buffer.from([18]),keys:[{pubkey:peer.publicKey,isSigner:true,isWritable:false}]}));
 await tx.sign(w);tx.addSignature(peer.publicKey,Buffer.alloc(64,1));
 await assert.rejects(c.submit(tx),e=>e.signature===undefined);
 assert.equal(released,1);assert.equal(sent,0);assert.deepEqual(events,[]);
});
test('a transaction that fails on chain is reported as itself, though its error holds BigInts',async()=>{
 const w=await Keypair.generate(),events=[];const c=new ChainClient(DEVNET,w.publicKey,w,{onTransaction:(s,d)=>{JSON.stringify(d);events.push(d);}});c.networkChecked=true;
 c.connection={getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async()=>'ok',getSignatureStatuses:async()=>({value:[{confirmationStatus:'confirmed',err:{InstructionError:[1n,{Custom:7n}]}}]})};
 await assert.rejects(c.send([c.instruction(0,[],[])]),/failed: \{"InstructionError":\["1",\{"Custom":"7"\}\]\}/);
 assert.deepEqual(events.at(-1),{status:'failed',error:{InstructionError:['1',{Custom:'7'}]}},'and the journal can hold it');
});
test('waiting for a confirmation is limited by time, however long each poll takes',async()=>{
 const w=await Keypair.generate();
 const c=new ChainClient('http://127.0.0.1:18899',w.publicKey,w,{allowLocal:true,confirmMs:300});c.networkChecked=true;
 let polls=0;
 // What a rate-limited RPC looks like: every poll takes a while, inside the RPC library's own retries, and then fails.
 const refused=async()=>{polls++;await new Promise(done=>setTimeout(done,100));throw Object.assign(Error('429'),{rpcFailure:true});};
 c.connection={getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async()=>'ok',getSignatureStatuses:refused};
 const started=Date.now();
 await assert.rejects(c.send([c.instruction(0,[],[])]),e=>/Confirmation uncertain/.test(e.message)&&!!e.signature,'and it says what it sent, so the caller can check');
 assert.ok(Date.now()-started<800,`gave up on time, after ${Date.now()-started} ms`);
 assert.ok(polls>=2&&polls<=3,`${polls} polls`);
});
test('only an RPC on this machine is polled quickly, whatever the local flag says',async()=>{
 const w=await Keypair.generate();
 const count=async(url)=>{
  const c=new ChainClient(url,w.publicKey,w,{allowLocal:true,confirmMs:2200});c.networkChecked=true;
  let polls=0;
  c.connection={getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async()=>'ok',getSignatureStatuses:async()=>{polls++;return {value:[null]};}};
  await assert.rejects(c.send([c.instruction(0,[],[])]),/Confirmation uncertain/);
  return polls;
 };
 const [remote,local]=await Promise.all([count(DEVNET),count('http://127.0.0.1:18899')]);
 assert.ok(remote<=3,`public devnet polled ${remote} times in 2.2 seconds`);
 assert.ok(local>=20,`a local validator polled ${local} times`);
});
test('a send that goes unconfirmed is sent again every few seconds, however fast it polls',async()=>{
 const w=await Keypair.generate();
 const c=new ChainClient('http://127.0.0.1:18899',w.publicKey,w,{allowLocal:true,confirmMs:3600});c.networkChecked=true;
 let sends=0;
 c.connection={getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}),simulateTransaction:accept,sendRawTransaction:async()=>{sends++;return 'ok';},getSignatureStatuses:async()=>({value:[null]})};
 await assert.rejects(c.send([c.instruction(0,[],[])]),/Confirmation uncertain/);
 assert.equal(sends,2,'the first send, and one more after three seconds');
});
