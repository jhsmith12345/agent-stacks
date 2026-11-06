// Plays a match between two brand-new cloud VMs in different regions, on public devnet, through a relay elsewhere.
// Each installs Node and this project from nothing, as a new player would, and they share only the invite code.
// It works without logging in to them: each VM is given its code at creation, reports over its serial port,
// and gets the invite code through its metadata. They're deleted at the end, whatever happens.
// Usage: node scripts/channel-cloud-rehearsal.js FUNDER_KEYPAIR GCLOUD_PROJECT RELAY_URL [--cut]
// With --cut, the second VM loses the relay partway through a hand, so both have to finish it on chain.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {ChainClient,DEVNET,PublicKey,SystemProgram,loadWallet} from '../src/solana/client.js';
import {DEPLOYMENTS} from '../src/channel/deployments.js';
import {DEVNET_GENESIS} from '../src/solana/client.js';
import {coverage,referee} from '../src/channel/referee.js';
const [funderFile,project,relay]=process.argv.slice(2),cut=process.argv.includes('--cut');
if(!funderFile||!project||!relay)throw Error('Usage: node scripts/channel-cloud-rehearsal.js FUNDER_KEYPAIR GCLOUD_PROJECT RELAY_URL [--cut]');
const {program}=DEPLOYMENTS[DEVNET_GENESIS];
const funder=await loadWallet(resolve(funderFile));
const direct=new ChainClient(DEVNET,program,funder);await direct.checkNetwork();
const log=(...parts)=>process.stderr.write(`[${new Date().toISOString().slice(11,19)}] ${parts.join(' ')}\n`);
const BIG_BLIND=20_000,HANDS=cut?3:6,FUNDS=[34_500_000,12_000_000];
const stamp=Date.now().toString(36);
const VMS=[{role:'host',name:`stacks-play-a-${stamp}`,zone:'us-west1-b',bot:'node examples/solver-bot.js --seed 11 --style aggressive --noise 0.05 --show sometimes'},{role:'guest',name:`stacks-play-b-${stamp}`,zone:'europe-west1-b',bot:'node examples/solver-bot.js --seed 22 --style loose --sizes 0.5,1'}];
function gcloud(args,{timeout=300_000}={}){
 return new Promise((done,fail)=>{
  const child=spawn('gcloud',['--quiet','--project',project,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');fail(Error(`Timed out: gcloud ${args.slice(0,3).join(' ')}`));},timeout);
  child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
  child.on('exit',code=>{clearTimeout(timer);code===0?done(out):fail(Error(`gcloud ${args.slice(0,3).join(' ')} exited ${code}: ${err.slice(-400)}`));});
 });
}
const startup=`#!/bin/bash
export HOME=/root PATH=/opt/node/bin:$PATH
meta(){ curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
say(){ echo "STACKS $*" > /dev/ttyS0; }
fail(){ say "FAILED $1"; [ -f /opt/stacks/err ] && say "LOG $(tail -c 3000 /opt/stacks/err | base64 -w0)"; exit 1; }
systemctl disable --now ssh ssh.socket 2>/dev/null
ROLE=$(meta role); RELAY=$(meta relay); FUNDER=$(meta funder); PROGRAM=$(meta program); CUT=$(meta cut); BOT=$(meta bot); HANDS=$(meta hands); CLOCK=$(meta clock); STALL=$(meta stall)
started=$(date +%s)
mkdir -p /opt/node /opt/stacks; cd /tmp
base=https://nodejs.org/dist/latest-v22.x
curl -fsS $base/SHASUMS256.txt -o sums || fail sums
name=$(grep 'linux-x64.tar.gz$' sums | awk '{print $2}')
curl -fsSO "$base/$name" || fail download
grep " $name\\$" sums | sha256sum -c - >/dev/null || fail checksum
tar xzf "$name" -C /opt/node --strip-components=1 || fail unpack
meta bundle | base64 -d | tar xz -C /opt/stacks || fail bundle
cd /opt/stacks
npm ci --omit=dev --no-audit --no-fund >/tmp/npm.log 2>&1 || fail npm
say "INSTALLED $(node -v) in $(( $(date +%s)-started ))s"
address=$(node scripts/stacks.js wallet | tail -1 | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).address') || fail wallet
say "WALLET $address"
export AGENT_STACKS_STALL_SECONDS=$STALL
if [ "$ROLE" = host ]; then
 node scripts/stacks.js host --relay "$RELAY" --buy-in 0.001 --big-blind 0.00002 --hands "$HANDS" --clock "$CLOCK" --think 10 --decide "$BOT" > out 2> err &
 pid=$!
 for i in $(seq 180); do code=$(grep -m1 '^stacks1\\.' out); [ -n "$code" ] && break; sleep 2; done
 [ -n "$code" ] || fail "no code"
 say "CODE $code"
 wait $pid || fail host
else
 for i in $(seq 300); do code=$(meta invite-code 2>/dev/null) && [ -n "$code" ] && break; sleep 3; done
 [ -n "$code" ] || fail "no code arrived"
 if [ "$CUT" = yes ]; then
  ( relay_ip=$(echo "$RELAY" | sed -E 's#.*//([^:/]+).*#\\1#')
    until ls .agent-stacks/play/*/state/*.state.json >/dev/null 2>&1; do sleep 2; done
    sleep 50; ip route add blackhole "$relay_ip/32" && say "CUT the relay is unreachable from here" ) &
 fi
 node scripts/stacks.js join "$code" --yes --decide "$BOT" > out 2> err || fail guest
fi
say "RESULT $(tail -1 out | base64 -w0)"
say "LOG $(tail -c 3000 err | base64 -w0)"
node scripts/channel.js sweep .agent-stacks/play/wallet-keypair.json "$FUNDER" "$PROGRAM" --rpc https://api.devnet.solana.com > sweep 2>&1 || say "SWEEPFAILED $(tail -c 300 sweep | base64 -w0)"
say "SWEPT"
`;
const files=mkdtempSync(join(tmpdir(),'stacks-cloud-'));
const list=spawnSync('git',['ls-files','-co','--exclude-standard','--','src','scripts','examples','package.json','package-lock.json'],{encoding:'utf8'}).stdout.trim().split('\n');
const tar=spawnSync('tar',['-czf','-','--no-xattrs',...list],{maxBuffer:1<<26});
if(tar.status!==0)throw Error('Could not bundle the code');
writeFileSync(join(files,'bundle'),tar.stdout.toString('base64'));
writeFileSync(join(files,'startup-script'),startup);
const created=[],summary={cut,regions:VMS.map(v=>v.zone)};
const started=Date.now();
const funderBefore=await direct.connection.getBalance(funder.publicKey,'confirmed');
async function create(vm){
 const entries={role:vm.role,relay,funder:funder.publicKey.toBase58(),program,cut:cut?'yes':'no',bot:vm.bot,hands:String(HANDS),clock:cut?'120':'600',stall:cut?'40':'120'};
 for(const [key,value] of Object.entries(entries))writeFileSync(join(files,`${vm.role}-${key}`),value);
 const from=[`bundle=${join(files,'bundle')}`,`startup-script=${join(files,'startup-script')}`,...Object.keys(entries).map(key=>`${key}=${join(files,`${vm.role}-${key}`)}`)].join(',');
 created.push(vm);
 await gcloud(['compute','instances','create',vm.name,'--zone',vm.zone,'--machine-type=e2-medium','--image-family=debian-13','--image-project=debian-cloud','--boot-disk-size=20GB','--no-service-account','--no-scopes',`--metadata-from-file=${from}`]);
 log(`created ${vm.name} in ${vm.zone}`);
}
async function reports(vm){
 const out=await gcloud(['compute','instances','get-serial-port-output',vm.name,'--zone',vm.zone,'--port','1'],{timeout:60_000}).catch(()=>'');
 const found={};
 for(const line of out.split(/\r?\n/)){const m=/^STACKS (\w+) ?(.*)$/.exec(line);if(m)found[m[1]]=m[2];}
 return found;
}
const fromBase64=text=>Buffer.from(text,'base64').toString();
const seen=[{},{}];
try{
 await Promise.all(VMS.map(create));
 let funded=[false,false],codeSent=false;
 const deadline=Date.now()+2_400_000;
 for(;;){
  if(Date.now()>deadline)throw Error('Timed out waiting for the match');
  for(const [i,vm] of VMS.entries()){
   const found=await reports(vm);
   for(const key of Object.keys(found))if(!(key in seen[i])){seen[i][key]=found[key];if(!['LOG','RESULT','CODE'].includes(key))log(`${vm.role}: ${key} ${found[key].slice(0,100)}`);}
   if('FAILED' in found)throw Error(`${vm.role} failed at ${found.FAILED}: ${found.LOG?fromBase64(found.LOG).slice(-800):''}`);
   if(found.WALLET&&!funded[i]){
    funded[i]=true;
    await direct.send([SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:new PublicKey(found.WALLET),lamports:BigInt(FUNDS[i])})]);
    log(`${vm.role}: funded`);
   }
  }
  if(seen[0].CODE&&!codeSent){
   codeSent=true;
   writeFileSync(join(files,'invite-code'),seen[0].CODE);
   await gcloud(['compute','instances','add-metadata',VMS[1].name,'--zone',VMS[1].zone,`--metadata-from-file=invite-code=${join(files,'invite-code')}`]);
   log('the code crossed to the other region');
  }
  // These reports have no text, only their arrival.
  if('SWEPT' in seen[0]&&'SWEPT' in seen[1])break;
  await pause(10_000);
 }
 const [a,b]=seen.map(s=>JSON.parse(fromBase64(s.RESULT)));
 summary.seconds=Math.round((Date.now()-started)/1000);
 summary.installed=seen.map(s=>s.INSTALLED);
 summary.payouts=[a.payouts,b.payouts];
 if(a.payouts[0]!==b.payouts[0]||a.payouts[0]+a.payouts[1]!==2_000_000)throw Error(`Bad payouts: ${a.payouts} and ${b.payouts}`);
 const count=(await direct.connection.getSignaturesForAddress(new PublicKey(a.match),{limit:200},'confirmed')).filter(s=>!s.err).length;
 summary.transactions=count;summary.match=a.match;
 const pairs=a.results.flatMap(r=>{const o=b.results.find(x=>x.hand===r.hand);return o?[[r,o]]:[];});
 const clean=cut?pairs.slice(0,-1):pairs;
 const faults=referee(1_000_000,BIG_BLIND,clean);
 if(faults.length)throw Error(`The referee disagrees: ${faults.join('; ')}`);
 const seenPlay={};coverage(seenPlay,clean,BIG_BLIND);
 summary.hands=a.results.length;summary.play=seenPlay;
 summary.onChain=[a.onChainTransactions,b.onChainTransactions];
 if(cut){
  if(!seen[1].CUT)throw Error('The relay was never cut');
  if(!b.onChainTransactions)throw Error('The cut-off player made no moves on chain');
 }else if(count>4)throw Error(`Nothing went wrong, but it went to the chain: ${count} transactions`);
 summary.logs=seen.map(s=>fromBase64(s.LOG??'').split('\n').filter(l=>/safe default|isn’t allowed|didn’t answer|exited/.test(l)).slice(0,5));
 summary.ok=true;
}catch(error){
 summary.ok=false;summary.error=error.message;
 // The VMs are about to go, and these are all that's left of what happened on them.
 summary.reports=seen.map(s=>({result:fromBase64(s.RESULT??'').slice(-2000),log:fromBase64(s.LOG??'')}));
}finally{
 for(const vm of created)await gcloud(['compute','instances','delete',vm.name,'--zone',vm.zone],{timeout:300_000}).then(()=>log(`deleted ${vm.name}`),error=>{summary.notDeleted=[...(summary.notDeleted??[]),vm.name];log(`COULD NOT DELETE ${vm.name}: ${error.message}`);});
 rmSync(files,{recursive:true,force:true});
}
const funderAfter=await direct.connection.getBalance(funder.publicKey,'confirmed');
summary.testSolSpent=(Number(funderBefore)-Number(funderAfter))/1e9;
console.log(JSON.stringify(summary,null,1));
process.exit(summary.ok?0:1);
