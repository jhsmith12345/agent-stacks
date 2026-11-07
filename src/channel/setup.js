// What it takes to start a match: an offer, a create and a join. Wallets sign only this part.
import {createPublicKey,randomBytes,sign,verify} from 'node:crypto';
import {PublicKey,SystemProgram,u32,u64} from '../solana/client.js';
import {sessionFromSeed} from './keys.js';
import {BUFFER_SPACE,CHANNEL_SPACE,channelAddress,channelTerms} from './chain.js';
const OFFER=Buffer.from('agent-stacks/channel/offer/v1:');
const SPKI=Buffer.from('302a300506032b6570032100','hex');
const sessionOf=wallet=>sessionFromSeed(Buffer.from(wallet.secretKey).subarray(0,32));
export const sessionHex=sessionWallet=>Buffer.from(sessionOf(sessionWallet).publicKey).toString('hex');
export function makeOffer(wallet,sessionWallet){
 const session=sessionOf(sessionWallet);
 return {wallet:wallet.publicKey.toBase58(),session:Buffer.from(session.publicKey).toString('hex'),signature:sign(null,Buffer.concat([OFFER,session.publicKey]),sessionOf(wallet).key).toString('hex')};
}
// Binds the opponent's session key to its wallet, so nobody else can slip in a key of their own.
export function checkOffer(offer){
 const key=createPublicKey({key:Buffer.concat([SPKI,Buffer.from(new PublicKey(offer.wallet).toBytes())]),format:'der',type:'spki'});
 if(!/^[0-9a-f]{64}$/.test(offer.session)||!/^[0-9a-f]{128}$/.test(offer.signature)||!verify(null,Buffer.concat([OFFER,Buffer.from(offer.session,'hex')]),key,Buffer.from(offer.signature,'hex')))throw Error('The opponent’s offer is not signed by its wallet');
}
// A session key that can't afford to post a state can't defend its player in a dispute. It has to pay the
// buffer's rent and some fees, and keep the rent minimum itself.
export async function reserveNeeded(client){
 return Number(await client.connection.getMinimumBalanceForRentExemption(BUFFER_SPACE))+Number(await client.connection.getMinimumBalanceForRentExemption(0))+300_000;
}
// What a wallet has to hold to start a match. All of it comes back at the end apart from the result of the
// match, small fees and, for the creator, the rent of the tombstone the contract leaves at the match's address.
export async function fundsNeeded(client,{buyIn,reserve,creating}){
 const keep=Number(await client.connection.getMinimumBalanceForRentExemption(0));
 return buyIn+reserve+keep+100_000+(creating?Number(await client.connection.getMinimumBalanceForRentExemption(CHANNEL_SPACE)):0);
}
// One wallet can host several matches at once, and another of them can spend what was here between the check and the
// transaction. That only means waiting for more, so false says to go round again. Anything else is a real failure.
export async function tryToSpend(client,wallet,needed,send){
 try{await send();return true;}
 catch(error){
  if(Number(await client.connection.getBalance(wallet.publicKey,'confirmed'))>=needed)throw error;
  return false;
 }
}
export async function buildManifest({client,wallet,sessionWallet,offer,program,buyIn,bigBlind,hands,seconds}){
 const genesis=await client.checkNetwork(),nonce=randomBytes(32),[match]=await channelAddress(program,wallet.publicKey,nonce);
 const manifest={protocol:'agent-stacks/channel/v1',genesis,program,players:[wallet.publicKey.toBase58(),offer.wallet],sessions:[sessionHex(sessionWallet),offer.session],match:match.toBase58(),nonce:nonce.toString('hex'),buyIn,bigBlind,maxHands:hands,turnSeconds:seconds};
 manifest.terms=channelTerms(manifest);
 return manifest;
}
// Save the manifest before sending this: it holds the nonce, without which the deposit couldn't be found again.
export function sendCreate({client,wallet,sessionWallet,manifest,reserve}){
 const accounts=[{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:new PublicKey(manifest.players[1]),isSigner:false,isWritable:false},{pubkey:new PublicKey(manifest.match),isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}];
 return client.send([client.instruction(30,[Buffer.from(manifest.nonce,'hex'),u64(manifest.buyIn),u32(manifest.turnSeconds),Buffer.from(new PublicKey(manifest.genesis).toBytes()),u64(manifest.bigBlind),u32(manifest.maxHands),Buffer.from(manifest.sessions[0],'hex'),Buffer.from(manifest.sessions[1],'hex')],accounts),SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:sessionWallet.publicKey,lamports:BigInt(reserve)})]);
}
// Joining commits to these exact terms. If the account holds anything else, the contract refuses.
export function sendJoin({client,wallet,sessionWallet,manifest,reserve}){
 return client.send([client.instruction(31,[Buffer.from(manifest.terms,'hex')],[{pubkey:new PublicKey(manifest.match),isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}]),SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:sessionWallet.publicKey,lamports:BigInt(reserve)})]);
}
export function sendRetire({client,wallet,manifest}){
 return client.send([client.instruction(44,[],[{pubkey:new PublicKey(manifest.match),isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true}])]);
}
// A payout too small for an empty wallet to receive is held for its owner, who can send it anywhere.
export function sendClaim({client,wallet,manifest,seat,destination=wallet.publicKey}){
 return client.send([client.instruction(43,[Buffer.from([seat])],[{pubkey:new PublicKey(manifest.match),isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:new PublicKey(destination),isSigner:false,isWritable:true}])]);
}
// What's left in a session key goes back to its owner.
export async function sendSweep({client,session,destination}){
 const balance=Number(await client.connection.getBalance(session.publicKey,'confirmed'));
 if(balance<=5000)return {swept:0};
 return {swept:balance-5000,signature:await client.send([SystemProgram.transfer({fromPubkey:session.publicKey,toPubkey:new PublicKey(destination),lamports:BigInt(balance-5000)})])};
}
