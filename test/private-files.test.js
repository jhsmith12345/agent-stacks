import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, symlinkSync, linkSync, chmodSync, statSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPrivate, writePrivate, appendPrivate, transferOnce} from '../src/private-files.js';
import {ensureWallet, loadWallet} from '../src/solana/client.js';

test('private storage fails closed on symlinks, hard links, unsafe modes and overwrite races', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stacks-private-'));
  try {
    const file = join(dir, 'key');
    writePrivate(file, 'original', {exclusive:true});
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writePrivate(file, 'replacement', {exclusive:true}), {code:'EEXIST'});
    assert.equal(readPrivate(file, 'utf8'), 'original');
    const symlink = join(dir, 'symlink'); symlinkSync(file, symlink);
    assert.throws(() => readPrivate(symlink));
    assert.throws(() => writePrivate(symlink, 'overwrite'));
    assert.throws(() => appendPrivate(symlink, 'append'));
    const hardlink = join(dir, 'hardlink'); linkSync(file, hardlink);
    assert.throws(() => readPrivate(hardlink), /hard links/);
    rmSync(hardlink); chmodSync(file, 0o644);
    assert.throws(() => readPrivate(file), /owner-only/);
    chmodSync(file, 0o600);
    writePrivate(file, 'updated'); appendPrivate(file, '\nrecord');
    assert.equal(readFileSync(file, 'utf8'), 'updated\nrecord');
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('concurrent wallet creation converges on one durable identity and rejects lossy byte coercions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stacks-wallet-'));
  try {
    const file = join(dir, 'wallet');
    const wallets = await Promise.all(Array.from({length:8}, () => ensureWallet(file)));
    assert.equal(new Set(wallets.map(w => w.publicKey.toBase58())).size, 1);
    const bytes = JSON.parse(readPrivate(file, 'utf8')); bytes[0] += 256;
    writePrivate(file, JSON.stringify(bytes));
    await assert.rejects(loadWallet(file), /secret encoding/);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('a transfer interrupted after sending cannot pay twice on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stacks-transfer-'));
  try {
    let sends = 0;
    const marker = join(dir, 'uncertain.json');
    await assert.rejects(transferOnce(marker, {lamports:'100'}, async () => { sends++; throw Error('Lost acknowledgement after payment'); }), /Lost acknowledgement/);
    await assert.rejects(transferOnce(marker, {lamports:'100'}, async () => { sends++; return 'second-payment'; }), /pending or uncertain/);
    assert.equal(sends, 1);
    const complete = join(dir, 'complete.json');
    await transferOnce(complete, {}, async () => { sends++; return 'original-signature'; });
    assert.equal((await transferOnce(complete, {}, async () => { sends++; })).signature, 'original-signature');
    assert.equal(sends, 2);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
