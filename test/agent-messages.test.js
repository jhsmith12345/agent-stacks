import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ask} from '../src/solana/agent-messages.js';
test('late cooperative approvals cannot resolve subsequent agent commands',async()=>{
 const child=new EventEmitter(),sent=[];child.send=m=>sent.push(m);
 await assert.rejects(ask(child,{kind:'approve'},5),/timed out/);
 let settled=false;const next=ask(child,{kind:'step'}).then(x=>{settled=true;return x;});
 child.emit('message',{requestId:sent[0].requestId,kind:'signed'});await Promise.resolve();assert.equal(settled,false);
 child.emit('message',{requestId:sent[1].requestId,kind:'result',phase:4});assert.equal((await next).phase,4);
 assert.equal(child.listenerCount('message'),0);assert.equal(child.listenerCount('exit'),0);
});
test('IPC errors and synchronous send failures reject and remove listeners',async()=>{
 const child=new EventEmitter();child.send=()=>{throw Error('Channel closed');};
 await assert.rejects(ask(child,{kind:'step'}),/Channel closed/);assert.equal(child.listenerCount('message'),0);
 child.send=m=>queueMicrotask(()=>child.emit('message',{requestId:m.requestId,kind:'error',message:'Rejected',signature:'original'}));
 await assert.rejects(ask(child,{kind:'step'}),e=>e.message==='Rejected'&&e.signature==='original');assert.equal(child.listenerCount('message'),0);
});
