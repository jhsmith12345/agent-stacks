// Two clean source directories and target directories, same installed toolchain.
// This is a local reproducibility check, not independent build attestation.
import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve('.'),tool=resolve(process.env.CARGO_BUILD_SBF??'.tools/solana-release/bin/cargo-build-sbf');
const version=spawnSync(tool,['--version'],{encoding:'utf8'});
if(version.status!==0||!version.stdout.includes('cargo-build-sbf 4.5.0')||!version.stdout.includes('v1.57'))throw Error('Expected reviewed build tool: cargo-build-sbf 4.5.0 / platform-tools v1.57');
const outputs=[];
for(let i=0;i<2;i++){
 const directory=mkdtempSync(join(tmpdir(),'stacks-reproduce-'));
 try{
  for(const file of ['Cargo.toml','Cargo.lock','rust-toolchain.toml','programs','scripts/build-solana.js'])cpSync(resolve(root,file),resolve(directory,file),{recursive:true,filter:source=>!source.split('/').includes('target')});
  const result=spawnSync(process.execPath,[resolve(directory,'scripts/build-solana.js')],{cwd:directory,env:{...process.env,CARGO_BUILD_SBF:tool,CARGO_TARGET_DIR:resolve(directory,'target')},encoding:'utf8',maxBuffer:10*1024*1024});
  if(result.status!==0)throw Error(`Clean build ${i+1} failed:\n${result.stderr}`);
  const bytes=readFileSync(resolve(directory,'target/deploy/agent_stacks_escrow.so'));
  outputs.push({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  process.stdout.write(`Clean build ${i+1}: ${outputs.at(-1).sha256}\n`);
 }finally{rmSync(directory,{recursive:true,force:true});}
}
const current=readFileSync(resolve(root,'target/deploy/agent_stacks_escrow.so'));
const localSha256=createHash('sha256').update(current).digest('hex');
const report={schema:'agent-stacks/reproducibility/v1',toolchain:version.stdout.trim(),builds:outputs,localSha256,match:outputs.every(o=>o.sha256===localSha256),independent:false,at:new Date().toISOString()};
mkdirSync('.agent-stacks/reports',{recursive:true,mode:0o700});writeFileSync('.agent-stacks/reports/guard-v1-reproducibility.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(!report.match)process.exitCode=1;
