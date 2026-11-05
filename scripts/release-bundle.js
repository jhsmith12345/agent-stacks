// Copy only public source roots. Never traverse .agent-stacks, wallets, caches,
// journals, node_modules, toolchains or validator ledgers into a review package.
import {mkdirSync,readdirSync,lstatSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('.'),output=resolve(process.argv[2]??`.agent-stacks/review/guard-v1-${Date.now()}`);
if(!output.startsWith(resolve(root,'.agent-stacks/review')+'/'))throw Error('Review output must be a new directory beneath .agent-stacks/review');
mkdirSync(dirname(output),{recursive:true,mode:0o700});mkdirSync(output,{mode:0o700});
const manifest=[];
function copy(path){
 const stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('Review package refuses symlinks');
 if(stat.isDirectory()){for(const name of readdirSync(path).sort()){if(name==='target')continue;copy(join(path,name));}return;}
 if(!stat.isFile())throw Error('Unexpected source file type');
 const name=relative(root,path);if(/keypair|\.key\.json|\.private\.json|\.ndjson$/.test(name))throw Error('Private file name in public source roots');
 const bytes=readFileSync(path),destination=resolve(output,name);mkdirSync(dirname(destination),{recursive:true});copyFileSync(path,destination);
 manifest.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
for(const path of ['README.md','package.json','package-lock.json','Cargo.toml','Cargo.lock','rust-toolchain.toml','solana-tools.sha256','.gitignore','.github','src','programs','scripts','examples','test','docs'])copy(resolve(root,path));
const artifact=readFileSync('target/deploy/agent_stacks_escrow.so');mkdirSync(resolve(output,'artifacts'));writeFileSync(resolve(output,'artifacts/agent_stacks_escrow.so'),artifact);
manifest.push({path:'artifacts/agent_stacks_escrow.so',bytes:artifact.length,sha256:createHash('sha256').update(artifact).digest('hex')});
mkdirSync(resolve(output,'evidence'));
for(const name of ['guard-v1-match.json','guard-v1-cost.json','guard-v1-reproducibility.json','guard-v1-validation.json']){
 const source=resolve('.agent-stacks/reports',name);if(!existsSync(source))throw Error(`Missing required public validation evidence: ${name}`);
 const bytes=readFileSync(source);JSON.parse(bytes.toString('utf8'));
 writeFileSync(resolve(output,'evidence',name),bytes);manifest.push({path:`evidence/${name}`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const report={schema:'agent-stacks/review-package/v1',createdAt:new Date().toISOString(),files:manifest,releaseAllowed:false,blockers:['Independent cryptographic review','Independent Solana custody/client review','Separate-host public devnet fault tests','Reviewed production immutability and operational release'],trustModel:'Explicit operator-controlled validating node; untrusted-RPC authentication is not implemented'};
writeFileSync(resolve(output,'manifest.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({output,publicFiles:manifest.length,manifestSha256:createHash('sha256').update(readFileSync(resolve(output,'manifest.json'))).digest('hex'),releaseAllowed:false},null,2));
