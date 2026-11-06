// One code that gets two players into a match. The host makes it and sends it however they like, and the guest
// pastes it. It says what the match is and how to find the host, and it holds a secret the relay never sees,
// so a relay can't slip in another player or other terms. Anyone holding the code can take the seat, once.
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {PublicKey} from '../solana/client.js';
import {channelAddress,channelTerms} from './chain.js';
import {checkOffer} from './setup.js';
const PREFIX='stacks1.',MAX_CODE=2000,MAX_THINK=300;
const LIMITS={buyIn:2_000_000_000_000,bigBlind:100_000_000_000,hands:1_000_000,seconds:604_800};
const whole=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
const base58=text=>{try{new PublicKey(text);return true;}catch{return false;}};
function checkInvite(i){
 if(!i||typeof i!=='object')throw Error('This isn’t an invite');
 let url;try{url=new URL(i.relay);}catch{throw Error('The invite’s relay address isn’t valid');}
 if(!['http:','https:'].includes(url.protocol))throw Error('The invite’s relay address isn’t valid');
 if(!base58(i.program)||!base58(i.genesis)||!base58(i.host))throw Error('The invite’s addresses aren’t valid');
 if(!/^[0-9a-f]{64}$/.test(i.secret??''))throw Error('The invite’s secret isn’t valid');
 for(const [name,max] of Object.entries(LIMITS))if(!whole(i[name],max))throw Error(`The invite’s ${name} isn’t valid`);
 if(i.bigBlind%2!==0||i.bigBlind<2||i.bigBlind>Math.floor(i.buyIn/10))throw Error('The invite’s blinds don’t fit its buy-in');
 if(!whole(i.think,MAX_THINK)||i.think*2>i.seconds)throw Error('The invite’s thinking time doesn’t fit its clock');
 if(i.fund!==undefined&&i.fund!==true)throw Error('The invite’s funding isn’t valid');
 return i;
}
// Exact, because a stake shouldn't depend on floating point.
export function parseSol(text){
 if(!/^\d{1,10}(\.\d{1,9})?$/.test(String(text)))throw Error(`Not an amount of SOL: ${text}`);
 const [whole,fraction='']=String(text).split('.');
 return Number(whole)*1_000_000_000+Number(fraction.padEnd(9,'0'));
}
export const formatSol=lamports=>`${Math.floor(lamports/1e9)}.${String(lamports%1e9).padStart(9,'0').replace(/0+$/,'')}`.replace(/\.$/,'');
const inviteId=secret=>new PublicKey(createHash('sha256').update('agent-stacks/invite/id/v1:').update(Buffer.from(secret,'hex')).digest()).toBase58();
// `fund` tells the guest the host will send its wallet what it needs. It's only a promise: nothing depends on it but
// what the guest is told, and a guest who doesn't get the money simply can't join.
export function newInvite({relay,program,genesis,host,buyIn,bigBlind,hands,seconds,think,fund=false}){
 return withId(checkInvite({relay,program,genesis,host,buyIn,bigBlind,hands,seconds,think,...(fund?{fund:true}:{}),secret:randomBytes(32).toString('hex')}));
}
const withId=invite=>({...invite,id:inviteId(invite.secret)});
export function encodeInvite(invite){
 const {id,...fields}=invite;void id;
 return PREFIX+Buffer.from(JSON.stringify(fields)).toString('base64url');
}
export function decodeInvite(code){
 const text=String(code).trim();
 if(!text.startsWith(PREFIX)||text.length>MAX_CODE)throw Error('This isn’t an invite');
 let fields;try{fields=JSON.parse(Buffer.from(text.slice(PREFIX.length),'base64url').toString());}catch{throw Error('This isn’t an invite');}
 return withId(checkInvite(fields));
}
// Where the match's messages go, and the key that seals them. Both come from the secret, so nobody without the
// invite can find the mailbox, unlike one named after the match's public address, and the relay can't read it.
const derived=(invite,label)=>createHash('sha256').update(`agent-stacks/invite/${label}/v1:`).update(Buffer.from(invite.secret,'hex')).digest();
export const matchMailbox=invite=>new PublicKey(derived(invite,'mailbox')).toBase58();
export const matchKey=invite=>derived(invite,'relay-key');
const macKey=invite=>createHash('sha256').update('agent-stacks/invite/mac/v1:').update(Buffer.from(invite.secret,'hex')).digest();
const macOf=(invite,type,body)=>createHmac('sha256',macKey(invite)).update(type).update('\0').update(JSON.stringify(body)).digest();
export const seal=(invite,type,body)=>({type,body,mac:macOf(invite,type,body).toString('hex')});
// The body of a message only someone with this invite could have sent, or null.
export function unseal(invite,type,message){
 if(!message||typeof message!=='object'||message.type!==type||typeof message.mac!=='string'||!/^[0-9a-f]{64}$/.test(message.mac))return null;
 return timingSafeEqual(macOf(invite,type,message.body),Buffer.from(message.mac,'hex'))?message.body:null;
}
// Everything the guest was promised, checked against what the host says it created.
export async function checkManifest(manifest,invite,{wallet,session}){
 const m=manifest;
 if(m?.protocol!=='agent-stacks/channel/v1'||m.program!==invite.program||m.genesis!==invite.genesis)throw Error('The match is on a different contract or network from the invite');
 if(!Array.isArray(m.players)||m.players[0]!==invite.host||m.players[1]!==wallet)throw Error('The match has different players from the invite');
 if(!Array.isArray(m.sessions)||m.sessions[1]!==session||!/^[0-9a-f]{64}$/.test(m.sessions[0]??''))throw Error('The match names a different session key');
 if(m.buyIn!==invite.buyIn||m.bigBlind!==invite.bigBlind||m.maxHands!==invite.hands||m.turnSeconds!==invite.seconds)throw Error('The match has different terms from the invite');
 if(channelTerms(m)!==m.terms)throw Error('The match’s terms hash does not match its terms');
 const [address]=await channelAddress(m.program,m.players[0],Buffer.from(m.nonce,'hex'));
 if(address.toBase58()!==m.match)throw Error('The match’s address does not match its creator and nonce');
 return m;
}
// A silent or failing relay only means waiting. Nothing has been spent at this point.
async function poll(transport,find,{pollMs,log,every=null,until=Infinity}){
 let lastEvery=0;
 for(;;){
  const now=Date.now();
  if(now>until)throw Error('Timed out waiting for the other player');
  if(every&&now-lastEvery>=every.ms){lastEvery=now;try{await transport.send(every.message);}catch(error){log(`relay: ${error.message}`);}}
  try{for(const message of await transport.receive()){const found=find(message);if(found)return found;}}
  catch(error){log(`relay: ${error.message}`);}
  await pause(pollMs);
 }
}
export function waitForOffer({invite,transport,pollMs=1000,log=()=>{},timeoutMs=Infinity}){
 return poll(transport,message=>{
  const offer=unseal(invite,'offer',message);
  if(!offer)return null;
  try{checkOffer(offer);}catch(error){log(error.message);return null;}
  if(offer.wallet===invite.host){log('Ignoring an offer from the host’s own wallet');return null;}
  return offer;
 },{pollMs,log,until:Date.now()+timeoutMs});
}
export function waitForManifest({invite,offer,transport,pollMs=1000,resendMs=5000,log=()=>{},timeoutMs=Infinity}){
 return poll(transport,message=>unseal(invite,'manifest',message),{pollMs,log,until:Date.now()+timeoutMs,every:{ms:resendMs,message:seal(invite,'offer',offer)}});
}
