const esbuild = require('esbuild');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
esbuild.buildSync({ entryPoints: ['tests/core.test.js'], bundle: true, platform: 'node', format: 'cjs', outfile: 'tests/core.test.cjs' });
execFileSync(process.execPath, ['--test', 'tests/core.test.cjs'], { stdio: 'inherit' });
