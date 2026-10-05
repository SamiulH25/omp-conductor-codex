import { build } from 'esbuild'
await build({ entryPoints: ['src/server.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/server.mjs', banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, legalComments: 'eof' })
await build({ entryPoints: ['src/conductor.ts', 'src/runtime.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outdir: 'dist/test', outExtension: { '.js': '.mjs' } })
await build({ entryPoints: ['src/companion.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/companion.mjs' })
await build({ entryPoints: ['src/panel.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outdir: 'dist/test', outExtension: { '.js': '.mjs' } })
