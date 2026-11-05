// Optional two-player authorization. Full proof verification occurs independently
// in BOTH agents. This is not a compact cryptographic shuffle proof.
import {createHash} from 'node:crypto';
import {Transaction} from '@solana/web3.js';
import {PublicKey,u64,shuffleContext} from './client.js';
import {decodeShuffle,verifyShuffle} from '../mental-poker/shuffle.js';
import {point} from '../mental-poker/group.js';
export const COMPACT_SPACE=3409;
export const deckBytes=deck=>Buffer.concat(deck.flatMap(c=>[Buffer.from(c.a,'hex'),Buffer.from(c.b,'hex')]));
export const deckHash=deck=>createHash('sha256').update(deckBytes(deck)).digest('hex');
export function compactTransaction(client,config,m,offer){
 if(offer.protocol!=='agent-stacks/joint-shuffle/v1'||offer.match!==config.match||offer.version!==m.version||offer.handNo!==m.handNo||![3,4].includes(m.phase)||!/^[0-9a-f]{64}$/.test(offer.outputHash))throw Error('Stale or invalid cooperative offer');
 if(typeof offer.lastValidBlockHeight!=='string'||!/^[1-9][0-9]{0,19}$/.test(offer.lastValidBlockHeight)||BigInt(offer.lastValidBlockHeight)>0xffffffffffffffffn||[offer.buffer,offer.blockhash].some(v=>typeof v!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)))throw Error('Stale or invalid cooperative offer framing');
 new PublicKey(offer.buffer);new PublicKey(offer.blockhash);
 const seat=m.phase-3;const actor=new PublicKey(config.players[seat]),peer=new PublicKey(config.players[1-seat]);
 // Construct the only instruction we authorize. Never sign a relay-supplied transaction.
 return new Transaction({feePayer:actor,blockhash:offer.blockhash,lastValidBlockHeight:BigInt(offer.lastValidBlockHeight)}).add(client.instruction(18,[u64(m.version),Buffer.from(offer.outputHash,'hex')],[{pubkey:new PublicKey(config.match),isSigner:false,isWritable:true},{pubkey:actor,isSigner:true,isWritable:false},{pubkey:peer,isSigner:true,isWritable:false},{pubkey:new PublicKey(offer.buffer),isSigner:false,isWritable:false}]));
}
export async function signVerifiedShuffle(client,config,wallet,offer,{allowCooperative=false}={}){
 if(!allowCooperative)throw Error('Cooperative shuffle acceptance is disabled');
 const m=await client.match(config.match,config);const seat=m.phase-3;
 if(![0,1].includes(seat)||wallet.publicKey.toBase58()!==config.players[1-seat])throw Error('Not the independent counterparty');
 const tx=compactTransaction(client,config,m,offer);
 const context=shuffleContext(config.program,config.match,seat,config.terms,m.handNo);
 const joint=point(m.keys[0],true).add(point(m.keys[1],true)).toHex();
 // Bound decoding prevents unbounded allocation before parsing a public proof.
 if(typeof offer.wire!=='string'||offer.wire.length>872000)throw Error('Invalid proof transport');
 const {input,proof}=decodeShuffle(Buffer.from(offer.wire,'base64'));
 if(!deckBytes(input).equals(deckBytes(m.deck))||!verifyShuffle(m.deck,joint,context,proof)||deckHash(proof.output)!==offer.outputHash)throw Error('Invalid cooperative shuffle proof');
 const account=await client.connection.getAccountInfo(new PublicKey(offer.buffer),'confirmed');
 if(!account||!account.owner.equals(client.program)||account.data.length!==COMPACT_SPACE)throw Error('Invalid deck buffer');
 const b=Buffer.from(account.data);
 if(b.subarray(0,8).toString()!=='ASTKDK01'||!b.subarray(8,40).equals(Buffer.from(new PublicKey(config.players[seat]).toBytes()))||!b.subarray(40,72).equals(Buffer.from(new PublicKey(config.match).toBytes()))||b.readUInt32LE(72)!==m.handNo||b[76]!==seat||b.readUInt32LE(77)!==3328||!b.subarray(81).equals(deckBytes(proof.output)))throw Error('Deck buffer differs from verified proof');
 await client.authorizeTransaction?.(tx);
 await tx.sign(wallet);
 return {signature:Buffer.from(tx.signatures.find(s=>s.publicKey.equals(wallet.publicKey)).signature).toString('base64')};
}
