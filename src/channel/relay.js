// A mailbox for one match's messages. It holds nothing secret and has no power: agents verify everything,
// so the worst a relay can do is delay or drop messages, and then they go to the chain instead.
// On the public internet anyone can reach it, so it also has to look after itself: memory is capped, a mailbox
// keeps only its newest messages, idle ones expire, each address is rate limited, and outgoing traffic has a
// daily budget, because whoever runs it pays for that.
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
const MAX_BODY=1_500_000,MAX_PER_READ=50,MINUTE=60_000,DAY=86_400_000;
export const RELAY_LIMITS={boxBytes:16_000_000,totalBytes:256_000_000,boxes:10_000,idleMs:3_600_000,readBytes:4_000_000,requestsPerMinute:3_000,writeBytesPerMinute:48_000_000,readBytesPerMinute:96_000_000,dailyEgressBytes:5_000_000_000,addresses:100_000,connections:256};
const reject=(res,code,headers={})=>{res.writeHead(code,headers);res.end();};
export function startRelay({port=0,host='127.0.0.1',tap=null,limits={},now=Date.now}={}){
 const cap={...RELAY_LIMITS,...limits};
 // A Map keeps its order, so moving a mailbox to the back on each use leaves the least recently used at the front.
 const boxes=new Map(),meters=new Map();
 let totalBytes=0,egress=0,egressSince=now(),meterSince=now();
 const drop=key=>{const box=boxes.get(key);if(box){totalBytes-=box.bytes;boxes.delete(key);}};
 const touch=(key,box)=>{boxes.delete(key);boxes.set(key,box);box.at=now();};
 function store(key,raw){
  const box=boxes.get(key)??{items:[],first:0,bytes:0,at:now()},size=Buffer.byteLength(raw);
  box.items.push(raw);box.bytes+=size;totalBytes+=size;
  // Agents read within moments and resend what matters, so it's the oldest that can go.
  while(box.bytes>cap.boxBytes&&box.items.length>1){const old=Buffer.byteLength(box.items.shift());box.first++;box.bytes-=old;totalBytes-=old;}
  touch(key,box);
  while((totalBytes>cap.totalBytes||boxes.size>cap.boxes)&&boxes.size>1)drop(boxes.keys().next().value);
 }
 function sweep(){
  for(const [key,box] of boxes){if(now()-box.at<cap.idleMs)break;drop(key);}
 }
 function meter(req){
  const time=now();
  if(time-meterSince>=MINUTE||meters.size>cap.addresses){meters.clear();meterSince=time;}
  const address=req.socket.remoteAddress??'';
  if(!meters.has(address))meters.set(address,{requests:0,written:0,read:0});
  return meters.get(address);
 }
 const busy=res=>reject(res,429,{'retry-after':'30'});
 const server=createServer(async(req,res)=>{
  if(req.url==='/health'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,boxes:boxes.size,bytes:totalBytes}));return;}
  const path=/^\/([1-9A-HJ-NP-Za-km-z]{32,44})\/([01])(?:\?after=(\d{1,16}))?$/.exec(req.url);
  if(!path)return reject(res,404);
  const use=meter(req);
  if(++use.requests>cap.requestsPerMinute)return busy(res);
  const [,match,seat,after]=path,key=`${match}/${seat}`;
  if(req.method==='GET'){
   if(now()-egressSince>=DAY){egress=0;egressSince=now();}
   if(egress>=cap.dailyEgressBytes)return reject(res,503,{'retry-after':'3600'});
   if(use.read>=cap.readBytesPerMinute)return busy(res);
   const box=boxes.get(key),from=Number(after??0),end=box?box.first+box.items.length:0;
   const start=box?Math.min(Math.max(from,box.first),end):0,messages=[];
   // Asking doesn't create a mailbox, so it can't be used to fill memory.
   if(box){
    touch(key,box);
    let bytes=0;
    for(let i=start;i<end&&messages.length<MAX_PER_READ;i++){
     const raw=box.items[i-box.first],size=Buffer.byteLength(raw);
     if(messages.length&&bytes+size>cap.readBytes)break;
     messages.push(raw);bytes+=size;
    }
   }
   const body=Buffer.from(`{"next":${start+messages.length},"messages":[${messages.join(',')}]}`);
   egress+=body.length;use.read+=body.length;
   res.writeHead(200,{'content-type':'application/json'});
   res.end(body);
   return;
  }
  if(req.method!=='POST')return reject(res,405);
  if(use.written>=cap.writeBytesPerMinute)return busy(res);
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)return reject(res,413,{connection:'close'});chunks.push(chunk);}
  use.written+=size;
  const body=Buffer.concat(chunks).toString();
  try{JSON.parse(body);}catch{return reject(res,400);}
  for(const item of tap?tap(Number(seat),body):[body])store(key,item);
  reject(res,204);
 });
 // Agents can be busy proving for seconds between requests. Don't drop a connection they're about to reuse.
 server.keepAliveTimeout=120_000;
 server.headersTimeout=20_000;server.requestTimeout=30_000;server.maxConnections=cap.connections;
 const sweeper=setInterval(sweep,MINUTE);sweeper.unref();
 return new Promise(resolve=>server.listen(port,host,()=>resolve({port:server.address().port,url:`http://${host}:${server.address().port}`,close:()=>{clearInterval(sweeper);server.closeAllConnections();server.close();},boxes,sweep})));
}
// The agent's side of the relay.
export class RelayTransport{
 constructor(url,match,seat,{timeoutMs=20_000}={}){this.url=url.replace(/\/$/,'');this.match=match;this.seat=seat;this.next=0;this.timeoutMs=timeoutMs;}
 async send(message){
  const response=await fetch(`${this.url}/${this.match}/${1-this.seat}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message),signal:AbortSignal.timeout(this.timeoutMs)});
  if(!response.ok)throw Error(`Relay refused a message: ${response.status}`);
 }
 async receive(){
  const response=await fetch(`${this.url}/${this.match}/${this.seat}?after=${this.next}`,{signal:AbortSignal.timeout(this.timeoutMs)});
  if(!response.ok)throw Error(`Relay read failed: ${response.status}`);
  const {next,messages}=await response.json();
  // A relay can repeat itself, skip messages or start again after a restart. Agents don't depend on any of it:
  // what's repeated is ignored, and what's skipped is resent or goes to the chain.
  if(Number.isSafeInteger(next)&&next>=0&&Array.isArray(messages)){this.next=messages.length?next:Math.min(next,this.next);return messages;}
  return [];
 }
}
// Seals a match's messages with a key both players hold and the relay doesn't, so the relay and the network see
// only sizes and timing, and junk from anyone else is dropped unread. The match's safety doesn't depend on it,
// since agents verify everything anyway. This is about privacy.
export class SealedTransport{
 constructor(inner,key,seat){if(key.length!==32)throw Error('Invalid relay key');Object.assign(this,{inner,key,seat,dropped:0});}
 // Bound to the sender's seat, so a relay can't hand a player's own message back to it as the opponent's.
 label(seat){return Buffer.from(`agent-stacks/relay/v1:${seat}`);}
 send(message){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(this.label(this.seat));
  const data=Buffer.concat([cipher.update(JSON.stringify(message)),cipher.final()]);
  return this.inner.send({iv:iv.toString('base64'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('base64')});
 }
 open(sealed){
  const decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(sealed.iv,'base64'),{authTagLength:16});
  decipher.setAAD(this.label(1-this.seat));decipher.setAuthTag(Buffer.from(sealed.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data,'base64')),decipher.final()]).toString());
 }
 async receive(){
  const out=[];
  for(const sealed of await this.inner.receive()){
   try{out.push(this.open(sealed));}catch{this.dropped++;}
  }
  return out;
 }
}
