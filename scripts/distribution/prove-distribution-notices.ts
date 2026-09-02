#!/usr/bin/env bun
// ============================================================================
//  scripts/distribution/prove-distribution-notices.ts — third-party notice
//  coverage.
//
//  THIRD_PARTY_NOTICES.md must stay generated-truth: its runtime-package
//  set must equal package.json's dependencies EXACTLY (no drift in either
//  direction), each listed VERSION must match the installed metadata (the
//  generator's source; bun.lock enforces it via --frozen-lockfile in CI),
//  every vendored payload family must be named, and the source attributions
//  (the Ink derivation) must be present. The release packager
//  refuses to assemble without this file and copies it verbatim into every
//  archive.
//
//  Run: ~/.bun/bin/bun run scripts/distribution/prove-distribution-notices.ts
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('signature notices — third-party inventory coverage')

const noticesPath = join(ROOT, 'THIRD_PARTY_NOTICES.md')
check('THIRD_PARTY_NOTICES.md exists', existsSync(noticesPath))
const notices = readFileSync(noticesPath, 'utf8')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}
const deps = new Set(Object.keys(pkg.dependencies ?? {}))

// Parse the generated package rows: "- **name** version — homepage"
const listed = new Map<string, string>()
const section = notices.split('## Vendored tool payloads')[0]
for (const m of section.matchAll(/^- \*\*(.+?)\*\* (\S+)/gm)) listed.set(m[1], m[2])

const missing = [...deps].filter(d => !listed.has(d))
const extra = [...listed.keys()].filter(d => !deps.has(d))
check(`every runtime dependency listed (${deps.size})`, missing.length === 0, missing.join(', '))
check('no stale packages listed', extra.length === 0, extra.join(', '))

// Version drift: each listed version must match the INSTALLED metadata (the
// same source the generator reads; bun.lock holds it via --frozen-lockfile).
const versionDrift: string[] = []
for (const [name, version] of listed) {
  const p = join(ROOT, 'node_modules', name, 'package.json')
  if (!existsSync(p)) continue
  const installed = (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version
  if (installed && installed !== version) versionDrift.push(`${name}: listed ${version}, installed ${installed}`)
}
check('no version drift vs installed metadata', versionDrift.length === 0, versionDrift.slice(0, 5).join('; '))

// Every vendored payload family the archive carries (the packager refuses an
// archive whose notices omit one — js-debug was the gap it caught).
for (const vendor of ['ripgrep', 'debugpy', 'pyright', 'js-debug', 'TypeScript compiler', 'tree-sitter', 'tree-sitter-wasms', 'Node.js runtime', 'voice capture pack']) {
  check(`vendor payload named: ${vendor}`, notices.includes(vendor))
}
{
  // Every cherry-picked grammar's source package + licence must be named —
  // the pack's Unlicense never covers the grammars themselves.
  const glPath = join(ROOT, 'vendor', 'grammars.lock.json')
  if (existsSync(glPath)) {
    const gl = JSON.parse(readFileSync(glPath, 'utf8')) as {
      grammars?: Array<{ wasm: string; upstream?: { package?: string } }>
    }
    for (const g of gl.grammars ?? []) {
      const pkg = g.upstream?.package ?? ''
      check(`grammar upstream named: ${pkg || g.wasm}`, pkg !== '' && notices.includes(pkg))
    }
  }
}
check('Ink attribution recorded', /Ink.*project.*MIT|vadimdemedes\/ink/s.test(notices))
check('bundled-skills section present', notices.includes('src/skills/bundled'))

// The generator must exist and name its output (reproducibility).
const gen = join(ROOT, 'scripts/distribution/generate-third-party-notices.ts')
check('generator present + names output', existsSync(gen) && readFileSync(gen, 'utf8').includes('THIRD_PARTY_NOTICES.md'))

// The release packager must consume the canonical file, not an inline list.
const packager = readFileSync(join(ROOT, 'scripts/release/package.mjs'), 'utf8')
check('release packager copies the canonical notices', packager.includes('THIRD_PARTY_NOTICES.md'))
check('release packager writes the dry-run record', packager.includes('.dryrun.json'))

if (failures > 0) {
  console.log(`\nsignature notices: RED (${failures})`)
  process.exit(1)
}
console.log('\nsignature notices: green')
