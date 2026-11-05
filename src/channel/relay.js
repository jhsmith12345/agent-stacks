// A mailbox for one match's messages. It holds nothing secret and has no power: agents verify everything,
// so the worst a relay can do is delay or drop messages, and then they go to the chain instead.
import {createServer} from 'node:http';
const MAX_BODY=1_200_000,MAX_MESSAGES=4_000;
const reject=(res,code)=>{res.writeHead(code);res.end();};
export function startRelay({port=0,host='127.0.0.1',tap=null}={}){
 const boxes=new Map();
 const box=(match,seat)=>{const key=`${match}/${seat}`;if(!boxes.has(key))boxes.set(key,[]);return boxes.get(key);};
 const server=createServer(async(req,res)=>{
  const path=/^\/([1-9A-HJ-NP-Za-km-z]{32,44})\/([01])(?:\?after=(\d+))?$/.exec(req.url);
  if(!path)return reject(res,404);
  const [,match,seat,after]=path,messages=box(match,Number(seat));
  if(req.method==='GET'){
   const from=Number(after??0);
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({next:messages.length,messages:messages.slice(from,from+50)}));
   return;
  }
  if(req.method!=='POST')return reject(res,405);
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)return reject(res,413);chunks.push(chunk);}
  if(messages.length>=MAX_MESSAGES)return reject(res,429);
  const body=Buffer.concat(chunks).toString();
  try{JSON.parse(body);}catch{return reject(res,400);}
  const delivered=tap?tap(Number(seat),body):[body];
  for(const item of delivered)messages.push(JSON.parse(item));
  reject(res,204);
 });
 // Agents can be busy proving for seconds between requests. Don't drop a connection they're about to reuse.
 server.keepAliveTimeout=120_000;
 return new Promise(resolve=>server.listen(port,host,()=>resolve({port:server.address().port,url:`http://${host}:${server.address().port}`,close:()=>{server.closeAllConnections();server.close();},boxes})));
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
  // A relay can repeat or rewind itself, which is harmless to agents but must not loop forever.
  if(Number.isSafeInteger(next)&&Array.isArray(messages)){this.next=Math.min(next,this.next+messages.length);return messages;}
  return [];
 }
}
