#!/usr/bin/env bun
// ============================================================================
//  scripts/search/lib/bundle-for-node.ts — bundle a search prover for the
//  NODE verdict (the prover-green-under-bun ≠ node law: the shipped product
//  runs under node/undici while lane checks run under bun, so the fetch-
//  exercising provers run ONCE under node, bundle-and-run).
//
//  The bundle uses the PRODUCT's own resolution laws (build.ts's plugin,
//  mirrored): the source mixes relative imports with root-style `src/…`
//  specifiers, and a bundler that treats them as different modules DUPLICATES
//  stateful singletons (live-found here: the settings cache split-brained —
//  a prover-side resetSettingsCache stopped reaching the engine's copy, and
//  §2/§9 read a stale main model). jsonc-parser's UMD main passes `require`
//  into its factory, so the bare import pins to the package's clean ESM
//  build, exactly as dist does.
//
//  Usage: bun scripts/search/lib/bundle-for-node.ts <entry.ts> <outfile.mjs>
// ============================================================================
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
      /* not this one */
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
  // THE STATE.TS DUPLICATION INCIDENT:
  // the doors-prover bundle carried TWO instances of
  // src/bootstrap/state.ts, so a prover-side settings/override write did not
  // reach the copy the engine read. Re-measured (bun
  // 1.3.11): state.ts inlines exactly ONCE both WITH and WITHOUT splitting —
  // the duplication does not reproduce in either direction today, so neither
  // splitting story is load-bearing anymore. Splitting stays as the shape the
  // verdicts were cut on; the belt that actually protects the provers is the
  // ANTHROPIC_MODEL env-pin seed (process-global, immune to module identity —
  // see seedHome in prove-websearch-doors.ts). If a future bun re-splits a
  // stateful singleton, count `function resetStateForTests` per chunk.
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
