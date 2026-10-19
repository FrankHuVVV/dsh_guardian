#!/usr/bin/env node
// Step-3 acceptance helper: deterministically mutate the three files that
// acceptance item 2 restores (profile package.json, pnpm-lock.yaml, link target README).
import fs from 'node:fs';
import path from 'node:path';

const profileDir = 'C:\\Users\\28256\\.dsh\\profiles\\desktop';
const packagePath = path.join(profileDir, 'package.json');
const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
const readmePath = 'D:\\Github\\novel_assistance\\README.md';
const marker = 'guardian acceptance probe';

const mode = process.argv[2] ?? 'mutate';

if (mode === 'mutate') {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.dependencies['guardian-probe'] = '1.0.0';
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  if (!fs.readFileSync(lockPath, 'utf8').includes(marker)) fs.appendFileSync(lockPath, `# ${marker}\n`, 'utf8');
  if (!fs.readFileSync(readmePath, 'utf8').includes(marker)) fs.appendFileSync(readmePath, `${marker}\n`, 'utf8');
  console.log('mutated: package.json, pnpm-lock.yaml, README.md');
} else {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  console.log(JSON.stringify({
    probeDependency: Boolean(pkg.dependencies?.['guardian-probe']),
    lockHasMarker: fs.readFileSync(lockPath, 'utf8').includes(marker),
    readmeHasMarker: fs.readFileSync(readmePath, 'utf8').includes(marker)
  }, null, 2));
}
