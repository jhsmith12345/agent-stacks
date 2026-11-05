// Passphrase enters through fd 3, never argv/environment/logs. Input is an
// already prepared private archive; use while agents are stopped and unlocked.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readPrivate,writePrivate} from '../src/private-files.js';
import {encryptBackup,decryptBackup} from '../src/encrypted-backup.js';
const [mode,input,output]=process.argv.slice(2);
if(!['encrypt','decrypt'].includes(mode)||!input||!output)throw Error('Usage: node scripts/backup-private.js encrypt|decrypt INPUT OUTPUT 3< PASSPHRASE_FILE');
const pass=readFileSync(3),source=readPrivate(resolve(input));let result;
try{result=mode==='encrypt'?encryptBackup(source,pass):decryptBackup(source,pass);writePrivate(resolve(output),result,{exclusive:true});console.log(JSON.stringify({operation:mode,output:resolve(output),bytes:result.length}));}
finally{pass.fill(0);source.fill(0);result?.fill(0);}
