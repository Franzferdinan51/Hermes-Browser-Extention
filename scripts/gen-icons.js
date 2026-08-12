#!/usr/bin/env node
// Resize the Imagine-authored master icon (icon256.png) into toolbar sizes.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const iconsDir = path.join(__dirname, '..', 'extension', 'icons');
const master = path.join(iconsDir, 'icon256.png');
if (!fs.existsSync(master)) {
  console.error('Missing extension/icons/icon256.png — generate the Hermes mark first.');
  process.exit(1);
}

for (const size of [16, 32, 48, 128]) {
  const dest = path.join(iconsDir, `icon${size}.png`);
  const result = spawnSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), master, '--out', dest], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
  console.log('wrote', path.basename(dest));
}
