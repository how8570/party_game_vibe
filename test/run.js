// Runs every *.test.js in this folder one after another (each spawns its own server) and exits non-zero if any failed.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const only = process.argv[2];
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && (!only || f.includes(only))).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n===== ${f} =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed');
process.exit(failed ? 1 : 0);
