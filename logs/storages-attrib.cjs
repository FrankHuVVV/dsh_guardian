const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const homedir = 'C:/Users/28256/.dsh';
const root = path.join(homedir, 'storages');
const VOLATILE = ['session_projcache/sessions'];
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function sha256Buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function walk(dir, rel, out) {
  const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=> a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const e of ents) {
    const r = rel ? rel + '/' + e.name : e.name;
    const full = path.join(dir, e.name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) { out.push({ rel:r, kind:'link', target: fs.readlinkSync(full) }); continue; }
    if (st.isDirectory()) { out.push({ rel:r, kind:'dir' }); walk(full, r, out); continue; }
    out.push({ rel:r, kind:'file', size: st.size, sha256: sha256File(full), mtime: st.mtime.toISOString() });
  }
}
const nodes = [];
walk(root, '', nodes);
const line = n => `${n.rel}\t${n.kind}\t${n.size ?? 0}\t${n.sha256 || n.target || ''}`;
const fullHash = sha256Buf(Buffer.from(nodes.map(line).join('\n')));
const isVol = n => VOLATILE.some(p => n.rel === p || n.rel.startsWith(p + '/'));
const stable = nodes.filter(n => !isVol(n));
const stableHash = sha256Buf(Buffer.from(stable.map(line).join('\n')));
console.log('files', nodes.filter(n=>n.kind==='file').length, 'stableFiles', stable.filter(n=>n.kind==='file').length);
console.log('full listing', fullHash);
console.log('stable listing', stableHash);
console.log('LKG stable    203413ba1fc01e4d986c6b155319a607dfa7f0379750661496e7850159a3f04f');
console.log('stable files by mtime:');
stable.filter(n=>n.kind==='file').sort((a,b)=> b.mtime.localeCompare(a.mtime)).forEach(n => console.log(n.mtime, n.size, n.rel));
