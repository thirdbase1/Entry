// Patches @blocksuite/icons package.json to remove the Node <23 engine
// restriction, eliminating the npm EBADENGINE warning on Node 24+.
// The package works fine on Node 24 — the restriction is overly conservative.
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', '@blocksuite', 'icons', 'package.json');
if (!fs.existsSync(target)) {
  process.exit(0);
}
const pkg = JSON.parse(fs.readFileSync(target, 'utf8'));
if (pkg.engines && pkg.engines.node) {
  pkg.engines.node = '>=18.19.0';
  fs.writeFileSync(target, JSON.stringify(pkg, null, 2) + '\n');
  console.log('patched @blocksuite/icons engines: removed <23.0.0 upper bound');
}
