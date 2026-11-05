// The protected agent rejects relay-selected state. A compromised node that
// the operator explicitly trusts remains outside this backend's guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Transaction} from '@solana/web3.js';
import {ensureWallet,Keypair,PublicKey,termsHash,LAYOUT,u64,DEVNET_GENESIS,keyContext} from '../src/solana/client.js';
import {writePrivate} from '../src/private-files.js';
import {ask} from '../src/solana/agent-messages.js';
import {makeKey} from '../src/mental-poker/proofs.js';
import {point,scalar,mul,randomScalar} from '../src/mental-poker/group.js';
import {initialDeck,encodeCipher,reencrypt,revealCard} from '../src/mental-poker/deck.js';

for(const mode of ['no-policy','override','dishonest-relay','compromised-trusted-node'])test(`actual agent RPC boundary: ${mode}`, {timeout:15000}, async () => {
  const directory=mkdtempSync(join(tmpdir(),'stacks-rpc-attack-'));
  let child, captured;
  const walletFile=join(directory,'wallet.json');
  const wallet=await ensureWallet(walletFile), opponent=await Keypair.generate(), program=await Keypair.generate();
  const nonce=Buffer.alloc(32,9),[address,bump]=await PublicKey.findProgramAddress([Buffer.from('escrow'),wallet.publicKey.toBytes(),nonce],program.publicKey);
  const config={program:program.publicKey.toBase58(),match:address.toBase58(),players:[wallet.publicKey.toBase58(),opponent.publicKey.toBase58()],genesis:DEVNET_GENESIS,buyIn:1000000,bigBlind:20000,turnSeconds:86400,maxHands:1};config.terms=termsHash(config);
  const a=makeKey(keyContext(config.program,config.match,0,config.terms,1)),b=makeKey('attacker/known-key');
  const source=initialDeck()[0], joint=point(a.registration.publicKey).add(point(b.registration.publicKey));
  const hidden=encodeCipher(reencrypt({a:point(source.a),b:point(source.b)},joint,randomScalar()));
  const honestDeck=initialDeck().map(c=>encodeCipher(reencrypt({a:point(c.a),b:point(c.b)},joint,randomScalar())));honestDeck[0]=hidden;
  const state=Buffer.alloc(LAYOUT.size);state.write('ASTKESC5');state[8]=7;u64(7).copy(state,9);
  state.set(wallet.publicKey.toBytes(),17);state.set(opponent.publicKey.toBytes(),49);u64(config.buyIn).copy(state,81);u64(config.turnSeconds).copy(state,89);
  state.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)+86400),97);Buffer.from(config.terms,'hex').copy(state,105);
  Buffer.from(a.registration.publicKey+b.registration.publicKey,'hex').copy(state,137);nonce.copy(state,217);state[249]=bump;u64(config.bigBlind).copy(state,LAYOUT.blind);
  state.writeUInt32LE(1,LAYOUT.hand);state.writeUInt32LE(1,LAYOUT.maxHands);
  Buffer.concat(honestDeck.map(c=>Buffer.from(c.a+c.b,'hex'))).copy(state,LAYOUT.deck);
  const honestState=Buffer.from(state);
  // The malicious RPC substitutes A's hidden ciphertext into B's allowed slot.
  Buffer.from(hidden.a+hidden.b,'hex').copy(state,LAYOUT.deck+64);
  const artifact=Buffer.from('test program fixture');let relayReads=0;
  writePrivate(join(directory,'agent',`${config.match}.hand-1.private.json`),JSON.stringify(a),{exclusive:true});
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const request=JSON.parse(raw);let result,error;
    switch(request.method){
      case 'getGenesisHash':result=DEVNET_GENESIS;break;
      case 'getAccountInfo':{
        if(req.url==='/relay')relayReads++;
        let bytes=req.url==='/trusted'?honestState:state,owner=config.program,executable=false;
        if(request.params[0]===config.program){bytes=artifact;owner='BPFLoader2111111111111111111111111111111111';executable=true;}
        if(request.params[0]==='SysvarC1ock11111111111111111111111111111111'){bytes=Buffer.alloc(40);bytes.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32);owner='Sysvar1111111111111111111111111111111111111';}
        result={context:{slot:1},value:{owner,lamports:100000000,executable,rentEpoch:0,data:[bytes.toString('base64'),'base64'],space:bytes.length}};break;
      }
      case 'getFeeForMessage':result={context:{slot:1},value:5000};break;
      case 'getLatestBlockhash':result={context:{slot:1},value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100}};break;
      case 'simulateTransaction':result={context:{slot:1},value:{err:null,logs:[]}};break;
      case 'sendTransaction':captured=Buffer.from(request.params[0],'base64');error={code:-32002,message:'Transaction rejected: fabricated card state'};break;
      default:error={code:-32601,message:`Unsupported test RPC method ${request.method}`};
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,...(error?{error}:{result})}));
  });
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');const rpc=`http://127.0.0.1:${server.address().port}`;
    const trustedRpc=mode==='compromised-trusted-node'?rpc:`${rpc}/trusted`,policyFile=join(directory,'policy.json');
    writePrivate(policyFile,JSON.stringify({schema:'agent-stacks/trusted-node/v1',trust:'operator-controlled-validator',network:'test-only',rpc:trustedRpc,submitRpc:`${rpc}/relay`,genesis:config.genesis,program:config.program,programSha256:createHash('sha256').update(artifact).digest('hex'),programBytes:artifact.length,allowLocal:true,allowUpgradeable:false,allowTestControls:false,allowCooperative:false,maxBuyIn:1000000,maxHands:1,minTurnSeconds:3600,maxTransactions:100,maxFeePerTransaction:10000,maxTotalFees:1000000,maxAccountRent:5000000000,maxTotalOutflow:10000000000}));
    const env={...process.env,AGENT_STACKS_TRUST_POLICY:mode==='no-policy'?'':policyFile};
    child=fork(new URL('../examples/chain-agent.js',import.meta.url),[walletFile,join(directory,'agent')],{env,stdio:['ignore','ignore','ignore','ipc']});
    await once(child,'message',{signal:AbortSignal.timeout(5000)});
    if(['no-policy','override'].includes(mode)){
      await assert.rejects(ask(child,{kind:'initialize',config,rpc,allowLocal:true},5000),mode==='no-policy'?/TRUST_POLICY/:/cannot replace/);assert.equal(captured,undefined);return;
    }
    await ask(child,{kind:'initialize',config,rpc:trustedRpc,allowLocal:true},5000);
    await assert.rejects(ask(child,{kind:'step'},5000));
    assert.ok(captured,'RPC saw the transaction before rejecting it');
    const tx=await Transaction.from(captured);
    const data=Buffer.from(tx.instructions.find(ix=>ix.programId.toBase58()===config.program).data);
    assert.equal(data[0],14);assert.equal(data[9],1);
    const fields=12+data.readUInt16LE(10);
    const releasedBase=data.subarray(fields+32,fields+64).toString('hex');
    if(mode==='dishonest-relay'){
      assert.equal(relayReads,0,'relay must never supply game state');
      assert.equal(releasedBase,honestDeck[1].a);assert.notEqual(releasedBase,hidden.a);
      await assert.rejects(ask(child,{kind:'step'},5000),/uncertain/);return;
    }
    assert.equal(releasedBase,hidden.a);
    const leaked=data.subarray(fields+64,fields+96).toString('hex');
    const attackerShare=mul(point(hidden.a),scalar(b.secret,true)).toHex();
    assert.equal(revealCard(hidden,[{share:leaked},{share:attackerShare}]),'2c');
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
    server.close();server.closeAllConnections();
    rmSync(directory,{recursive:true,force:true});
  }
});
