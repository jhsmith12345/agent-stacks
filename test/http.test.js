import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { Protocol } from '../src/protocol.js';
import { AgentClient } from '../src/client.js';
import { generateWallet, signCommand } from '../src/crypto.js';

test('HTTP clients complete a signed match; malformed and oversized requests are rejected', async () => {
  const server = createApp(new Protocol()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const clients = [new AgentClient(url, generateWallet()), new AgentClient(url, generateWallet())];
    for (const c of clients) await c.send({ type: 'faucet' });
    let { match } = await clients[0].send({ type: 'create', maxHands: 1 });
    ({ match } = await clients[1].matchCommand('join', match.id));
    const publicResponse = await fetch(`${url}/v1/matches/${match.id}`);
    assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
    assert.equal((await publicResponse.json()).match.hand.yourCards, undefined);
    const view = (await clients[0].view(match.id)).match;
    assert.equal(view.hand.yourCards.length, 2);
    const done = await clients[0].act(view, 'fold');
    assert.equal(done.match.status, 'complete');
    assert.equal((await clients[1].walletInfo()).balance, 10_010);
    for (const [body, expected] of [['{', 400], ['a'.repeat(17_000), 413]]) {
      const r = await fetch(`${url}/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(r.status, expected);
    }
    const a = clients[0];
    const forged = signCommand(a.wallet, { type: 'view', matchId: match.id }, 999);
    forged.command.matchId = 'changed';
    const r = await fetch(`${url}/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(forged) });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'BAD_SIGNATURE');
    const noType = await fetch(`${url}/v1/commands`, { method: 'POST', body: '{}' });
    assert.equal(noType.status, 415);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
});

test('malformed requests are the caller\'s error and leave the server running',async()=>{
 const errors=[],log=console.error;console.error=(...args)=>errors.push(args);
 const server=createApp(new Protocol());server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}`;
 try{
  for(const path of ['/v1/matches/%E0%A4%A','/v1/wallets/%ZZ']){
   const r=await fetch(url+path);assert.equal(r.status,400);assert.equal((await r.json()).error.code,'BAD_PATH');
  }
  const w=generateWallet(),deep='['.repeat(8000)+']'.repeat(8000);
  const body=`{"domain":"agent-stacks/local/v1","player":"${w.player}","nonce":1,"issuedAt":${Date.now()},"command":${deep},"signature":"x"}`;
  const r=await fetch(`${url}/v1/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body});
  assert.equal(r.status,400);assert.equal((await r.json()).error.code,'BAD_SIGNATURE');
  assert.equal((await fetch(`${url}/health`)).status,200);
  assert.equal(errors.length,0,'caller mistakes should not reach the server error log');
 }finally{console.error=log;server.close();server.closeAllConnections();await once(server,'close');}
});
test('a signed command is valid on one server only, and that identity survives a restart',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {fileStore}=await import('../src/store.js');
 const a=new Protocol(),b=new Protocol(),w=generateWallet();
 assert.notEqual(a.state.serverId,b.state.serverId);
 const envelope=signCommand(w,{type:'faucet',serverId:a.state.serverId},1);
 assert.equal(a.execute(envelope).wallet.balance,10_000);
 assert.throws(()=>b.execute(envelope),e=>e.code==='WRONG_SERVER');
 assert.throws(()=>a.execute(signCommand(w,{type:'view',matchId:'x'},2)),e=>e.code==='WRONG_SERVER','an unbound command is refused');
 const directory=mkdtempSync(join(tmpdir(),'stacks-server-id-'));
 try{
  const first=fileStore(directory),p=new Protocol(first.initial,{persist:first.persist}),id=p.state.serverId,u=generateWallet();
  p.execute(signCommand(u,{type:'faucet',serverId:id},1));
  assert.equal(new Protocol(fileStore(directory).initial).state.serverId,id);
 }finally{rmSync(directory,{recursive:true,force:true});}
 const old={schema:1,wallets:{},matches:{}};assert.ok(new Protocol(old).state.serverId,'state files from before this field still load');
});
