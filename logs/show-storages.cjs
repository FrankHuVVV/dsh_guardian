const fs = require('fs');
const meta = JSON.parse(fs.readFileSync('backups/last-known-good/meta.json','utf8'));
console.log(JSON.stringify(meta.entries['dshHome/storages'], null, 2));
