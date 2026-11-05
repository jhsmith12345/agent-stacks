import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
// The format version selects the KDF cost, so backups written at the older cost still open.
const COST={ASTKBKP1:32768,ASTKBKP2:131072};
const MAGIC=Buffer.from('ASTKBKP2');
const LIMIT=64*1024*1024;
const derive=(pass,salt,N)=>scryptSync(pass,salt,32,{N,r:8,p:1,maxmem:256*1024*1024});
function password(pass){if(!Buffer.isBuffer(pass)||pass.length<16||pass.length>1024)throw Error('Use a passphrase of 16–1024 UTF-8 bytes');}
export function encryptBackup(plain,pass){
 password(pass);if(!Buffer.isBuffer(plain)||plain.length>LIMIT)throw Error('Backup exceeds 64 MiB limit');
 const salt=randomBytes(16),iv=randomBytes(12),header=Buffer.concat([MAGIC,salt,iv]),key=derive(pass,salt,COST.ASTKBKP2);
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(header);const body=Buffer.concat([cipher.update(plain),cipher.final()]);return Buffer.concat([header,cipher.getAuthTag(),body]);}finally{key.fill(0);}
}
export function decryptBackup(encrypted,pass){
 password(pass);if(!Buffer.isBuffer(encrypted)||encrypted.length<52||encrypted.length>LIMIT+52)throw Error('Invalid encrypted backup');
 const version=encrypted.subarray(0,8).toString('latin1');if(!Object.hasOwn(COST,version))throw Error('Invalid encrypted backup');
 const key=derive(pass,encrypted.subarray(8,24),COST[version]);
 try{const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(24,36));decipher.setAAD(encrypted.subarray(0,36));decipher.setAuthTag(encrypted.subarray(36,52));return Buffer.concat([decipher.update(encrypted.subarray(52)),decipher.final()]);}finally{key.fill(0);}
}
