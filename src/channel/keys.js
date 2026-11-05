// Session keys sign game states with plain Ed25519, the same scheme the Solana runtime verifies in a dispute.
import {createPrivateKey,createPublicKey,randomBytes,sign,verify} from 'node:crypto';
const PKCS8=Buffer.from('302e020100300506032b657004220420','hex'),SPKI=Buffer.from('302a300506032b6570032100','hex');
export function sessionFromSeed(seed){
 if(!Buffer.isBuffer(seed)||seed.length!==32)throw Error('A session seed is 32 bytes');
 const key=createPrivateKey({key:Buffer.concat([PKCS8,seed]),format:'der',type:'pkcs8'});
 const publicKey=createPublicKey(key).export({type:'spki',format:'der'}).subarray(SPKI.length);
 return {seed,key,publicKey:Buffer.from(publicKey)};
}
export const newSession=()=>sessionFromSeed(randomBytes(32));
export const signMessage=(session,message)=>sign(null,message,session.key);
export function verifySignature(publicKey,message,signature){
 if(!Buffer.isBuffer(publicKey)||publicKey.length!==32||!Buffer.isBuffer(signature)||signature.length!==64)return false;
 try{return verify(null,message,createPublicKey({key:Buffer.concat([SPKI,publicKey]),format:'der',type:'spki'}),signature);}
 catch{return false;}
}
