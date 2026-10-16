const esbuild = require('esbuild');
const fs = require('node:fs');
fs.mkdirSync('dist', { recursive: true });
esbuild.buildSync({ entryPoints: ['src/app.js'], bundle: true, format: 'esm', outfile: 'dist/app.js', target: 'chrome140' });
for (const file of ['index.html', 'style.css']) fs.copyFileSync('src/' + file, 'dist/' + file);
