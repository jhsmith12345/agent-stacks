// The contract deployments this software trusts, by network. An invite can't choose the contract: a bad one
// could simply keep the deposits. Before putting any money in, a player checks the deployed bytes against
// the hash here. A retained upgrade authority is only acceptable on a test network.
const DEVNET='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEPLOYMENTS={
 [DEVNET]:{network:'devnet',program:'DrUx4PvwUpW1mHPqhDM7Stabtx6JSyXycvtaZftGP1g4',programBytes:180752,programSha256:'d73412687fab0376eb8bd74bb935a3b2b7388d8a979ee67bf2c3767dc03c8179',allowUpgradeable:true},
};
export const isTestNetwork=genesis=>DEPLOYMENTS[genesis]?.network==='devnet';
const SHAPE=/^[0-9a-f]{64}$/;
// `custom` is what the player's own settings name, for a network of their own.
export function trustedDeployment(genesis,custom=null){
 const deployment=custom??DEPLOYMENTS[genesis];
 if(!deployment)throw Error(`This software has no trusted contract for network ${genesis}`);
 if(typeof deployment.program!=='string'||!Number.isSafeInteger(deployment.programBytes)||deployment.programBytes<=0||!SHAPE.test(deployment.programSha256??''))throw Error('Invalid deployment');
 return deployment;
}
