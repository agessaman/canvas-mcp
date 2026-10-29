#!/usr/bin/env node
// Packs the .mcpb from a production-only install.
//
// `mcpb pack` ships node_modules exactly as it finds it, and .mcpbignore's
// patterns do not reach inside it, so a normal dev install puts the whole
// TypeScript compiler in the bundle — 19 MB of the 32 MB that went out before
// anyone noticed. Pruning first cuts it to 18 MB, all of which is code the
// server actually loads.
//
// The pruning is the dangerous part: it empties node_modules of everything
// dev, and a pack that throws halfway would leave the checkout unable to build
// or test. So the restore runs from a finally, and from the signal handlers
// too — Ctrl-C during a two-minute pack is the likely way this gets
// interrupted, and it must not leave a broken tree behind.
//
// Usage: npm run pack-release
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = require('../package.json');

// The packer is itself a devDependency, so by the time it is needed it has
// just been pruned. npx keeps its own cache outside node_modules; pinning to
// the version in package.json stops a release being packed by whatever the
// registry happens to be serving.
const packer = `@anthropic-ai/mcpb@${pkg.devDependencies['@anthropic-ai/mcpb'].replace(/^[\^~]/, '')}`;

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

let pruned = false;
function restore() {
  if (!pruned) return;
  pruned = false;
  console.log('\n— restoring dev dependencies —');
  run(npm, ['install']);
}
// execFileSync on a signal would otherwise leave the tree pruned.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

try {
  // Compile before pruning: tsc is a devDependency too.
  console.log('— building dist/ —');
  run(npm, ['run', 'build']);

  console.log('\n— pruning dev dependencies —');
  run(npm, ['prune', '--omit=dev']);
  pruned = true;

  console.log(`\n— packing with ${packer} —`);
  run(npx, ['-y', packer, 'pack']);
} finally {
  restore();
}

const bundle = path.join(root, `${pkg.name.replace(/^@[^/]+\//, '')}.mcpb`);
if (!fs.existsSync(bundle)) {
  console.error(`\npacking reported success but ${path.basename(bundle)} is not there`);
  process.exit(1);
}

// A bundle nobody ran is a bundle nobody knows about. This is the check that
// catches a runtime dependency the prune took with it.
console.log('\n— verifying the packed bundle —');
run(process.execPath, [path.join(root, 'scripts', 'verify-bundle.mjs'), bundle]);

const mb = (fs.statSync(bundle).size / 1048576).toFixed(1);
console.log(`\n${path.basename(bundle)} — ${mb} MB, production dependencies only`);
