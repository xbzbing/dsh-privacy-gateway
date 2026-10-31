#!/usr/bin/env node
/**
 * Builds the client half: `src/client/index.ts` bundled into one file,
 * `lib/client.js`, wrapped in the `window.__ModuleLoader__.load({ id,
 * factory })` closure the Web shell loads. react and the @deepseek-ai/*
 * packages stay external: the loader's `require` provides them.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

await esbuild.build({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  minify: true,
  sourcemap: false,
  logOverride: { 'commonjs-variable-in-esm': 'silent' },
  outfile: resolve(root, 'lib/client.js'),
  logLevel: 'info',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports;\n} });' },
})
