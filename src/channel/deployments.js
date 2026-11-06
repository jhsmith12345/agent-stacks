// The contract deployments this software trusts, by network. An invite can't choose the contract: a bad one
// could simply keep the deposits. Before putting any money in, a player checks the deployed bytes against
// the hash here. A retained upgrade authority is only acceptable on a test network.
const DEVNET='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEPLOYMENTS={
 [DEVNET]:{network:'devnet',program:'DrUx4PvwUpW1mHPqhDM7Stabtx6JSyXycvtaZftGP1g4',programBytes:180744,programSha256:'9ccfb8c5ab7684d4c23f489b26d4f30a399e55069a1520e6862ce399887f25b1',allowUpgradeable:true},
};
const SHAPE=/^[0-9a-f]{64}$/;
// `custom` is what the player's own settings name, for a network of their own.
export function trustedDeployment(genesis,custom=null){
 const deployment=custom??DEPLOYMENTS[genesis];
 if(!deployment)throw Error(`This software has no trusted contract for network ${genesis}`);
 if(typeof deployment.program!=='string'||!Number.isSafeInteger(deployment.programBytes)||deployment.programBytes<=0||!SHAPE.test(deployment.programSha256??''))throw Error('Invalid deployment');
 return deployment;
}
