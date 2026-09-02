#!/usr/bin/env bun
import { statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(ROOT, 'src')

const entry = process.argv[2]
const outfile = process.argv[3]
if (!entry || !outfile) {
  console.error('usage: bun scripts/search/lib/bundle-for-node.ts <entry.ts> <outfile.mjs>')
  process.exit(2)
}

const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const probe = (base: string): string | null => {
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const candidates = [base, ...exts.map(e => stripped + e), ...exts.map(e => stripped + '/index' + e)]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
    }
  }
  return null
}

const plugin: import('bun').BunPlugin = {
  name: 'search-node-verdict-resolves',
  setup(build) {
    build.onResolve({ filter: /^src\// }, args => {
      const abs = resolve(SRC, args.path.slice('src/'.length))
      const found = probe(abs)
      return found ? { path: found } : undefined
    })
    build.onResolve({ filter: /\.node$/ }, args => ({ path: args.path, external: true }))
    build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
      path: resolve(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js'),
    }))
  },
}

const result = await Bun.build({
  entrypoints: [resolve(entry)],
  outdir: dirname(resolve(outfile)),
  naming: { entry: basename(outfile), chunk: basename(outfile).replace(/\.mjs$/, '') + '-[name]-[hash].mjs' },
  target: 'node',
  format: 'esm',
  splitting: true,
  sourcemap: 'none',
  plugins: [plugin],
  loader: { '.md': 'text', '.txt': 'text' },
})
if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}
console.log(`bundled ${entry} → ${outfile}`)
