// Small shared helpers for channel messages. The share encoding is the one the contract already verifies.
import {encodeDLEQ} from '../mental-poker/proofs.js';
import {G} from '../mental-poker/group.js';
export {encodeDLEQ,G};
export const toHex=b=>Buffer.from(b).toString('hex');
export function fromHex(value,bytes=null){
 if(typeof value!=='string'||value.length%2!==0||!/^[0-9a-f]*$/.test(value))throw Error('Invalid hex field');
 const out=Buffer.from(value,'hex');
 if(bytes!==null&&out.length!==bytes)throw Error(`Expected ${bytes} bytes`);
 return out;
}
