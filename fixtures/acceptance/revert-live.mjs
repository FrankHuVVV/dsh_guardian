#!/usr/bin/env node
// One-shot cleanup: undo the three acceptance mutations that were applied to the
// live profile before the sandbox rule was introduced. Restores exact bytes from
// the guardian content-addressed store (verified by sha256).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STORE = 'D:\\dsh_plugin\\dsh_guardian\\backups\\_store';
const targets = [
  {
    file: 'C:\\Users\\28256\\.dsh\\profiles\\desktop\\package.json',
    hash: 'b568afde471cba665c136f204699fd425d96fde8aa9ab6918dfea217dc3e8874'
  },
  {
    file: 'C:\\Users\\28256\\.dsh\\profiles\\desktop\\pnpm-lock.yaml',
    hash: 'd1d3eb1521235856350e93975cec95e1c1a024344bb3431f4db04ab7658b27bf'
  },
  {
    file: 'D:\\Github\\novel_assistance\\README.md',
    hash: '60f7fde328cfedc39b64bc3e234a8c43c9f4b9593fd6941256da67b2c520f2a7'
  }
];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

for (const target of targets) {
  const blob = path.join(STORE, target.hash.slice(0, 2), target.hash);
  if (!fs.existsSync(blob)) {
    console.error(`missing blob ${blob}`);
    process.exit(2);
  }
  const blobHash = sha256(blob);
  if (blobHash !== target.hash) {
    console.error(`blob corrupted ${blob} (${blobHash})`);
    process.exit(2);
  }
  const temp = `${target.file}.guardian-revert-${process.pid}`;
  fs.copyFileSync(blob, temp);
  try { fs.chmodSync(temp, 0o666); } catch { /* clear inherited read-only */ }
  fs.renameSync(temp, target.file);
  console.log(JSON.stringify({ file: target.file, sha256: sha256(target.file), expected: target.hash, ok: sha256(target.file) === target.hash }));
}
