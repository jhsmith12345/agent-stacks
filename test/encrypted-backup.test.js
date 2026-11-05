import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,scryptSync,createCipheriv} from 'node:crypto';
import {encryptBackup,decryptBackup} from '../src/encrypted-backup.js';
test('private backups authenticate ciphertext/header, reject wrong passwords and randomize encryption',()=>{
 const pass=Buffer.from('a long test-only passphrase'),plain=Buffer.from('synthetic hand key and checkpoint fixture');
 const encrypted=encryptBackup(plain,pass);assert.deepEqual(decryptBackup(encrypted,pass),plain);
 assert.notDeepEqual(encryptBackup(plain,pass),encrypted);
 assert.throws(()=>decryptBackup(encrypted,Buffer.from('another long test-only passphrase')));
 for(const index of [0,8,24,36,52,encrypted.length-1]){const copy=Buffer.from(encrypted);copy[index]^=1;assert.throws(()=>decryptBackup(copy,pass));}
 assert.throws(()=>encryptBackup(plain,Buffer.from('short')));
 assert.throws(()=>decryptBackup(encrypted.subarray(0,51),pass));
});

test('new backups use the higher KDF cost, and backups at the older cost still open',()=>{
 const pass=Buffer.from('a long test-only passphrase'),plain=Buffer.from('synthetic fixture');
 assert.equal(encryptBackup(plain,pass).subarray(0,8).toString(),'ASTKBKP2');
 const magic=Buffer.from('ASTKBKP1'),salt=randomBytes(16),iv=randomBytes(12),header=Buffer.concat([magic,salt,iv]);
 const cipher=createCipheriv('aes-256-gcm',scryptSync(pass,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),iv);cipher.setAAD(header);
 const body=Buffer.concat([cipher.update(plain),cipher.final()]),older=Buffer.concat([header,cipher.getAuthTag(),body]);
 assert.deepEqual(decryptBackup(older,pass),plain);
 for(const version of ['ASTKBKP3','__proto_','toString']){const copy=Buffer.from(older);copy.write(version,0,'latin1');assert.throws(()=>decryptBackup(copy,pass),/Invalid encrypted backup/);}
 const relabeled=Buffer.from(older);relabeled.write('ASTKBKP2',0,'latin1');assert.throws(()=>decryptBackup(relabeled,pass),'the version is authenticated');
});
