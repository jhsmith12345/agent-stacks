// The accepted terms, kept durably with the agent's state. A file received just before a power cut may not
// have reached the disk, and an agent mid-match must still know what it agreed to.
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readPrivate,writePrivate} from '../private-files.js';
import {channelAddress,channelTerms} from './chain.js';
const parse=text=>{try{return JSON.parse(text);}catch{return null;}};
const readable=file=>{try{return readFileSync(file,'utf8');}catch{return null;}};
export async function acceptedManifest(file,directory){
 const saved=resolve(directory,'manifest.json'),offered=parse(readable(resolve(file))??'');
 if(existsSync(saved)){
  const manifest=JSON.parse(readPrivate(saved,'utf8'));
  // Pointing an agent at another match while it holds this one's state would mix them up.
  if(offered&&offered.match!==manifest.match)throw Error('This state directory belongs to a different match');
  return manifest;
 }
 if(!offered)throw Error(`Could not read the manifest at ${file}`);
 if(channelTerms(offered)!==offered.terms)throw Error('The manifest’s terms hash does not match its terms');
 const [address]=await channelAddress(offered.program,offered.players[0],Buffer.from(offered.nonce,'hex'));
 if(address.toBase58()!==offered.match)throw Error('The manifest’s match address does not match its creator and nonce');
 writePrivate(saved,JSON.stringify(offered));
 return offered;
}
