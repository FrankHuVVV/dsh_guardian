const fs = require('fs');
const meta = JSON.parse(fs.readFileSync('backups/last-known-good/meta.json','utf8'));
const keys = Object.keys(meta.entries).filter(k => k.includes('storages'));
console.log('storages entry count:', keys.length);
for (const k of keys.slice(0, 20)) {
  const e = meta.entries[k];
  console.log(k, JSON.stringify({kind:e.kind, files:e.files, bytes:e.bytes, listing:e.listingSha256 && e.listingSha256.slice(0,12), sha:e.sha256 && e.sha256.slice(0,12), size:e.size}));
}
console.log('total entries:', Object.keys(meta.entries).length);
