#!/usr/bin/env bun
// ============================================================================
//  scripts/build/prove-win32-seam-ratchet.ts
//  RATCHET (the WINDOWS standing audit, mechanized): Mercury RUNS ON WINDOWS
//  but is authored + tested POSIX-first, so unbranched POSIX idioms keep
//  landing (the bug ledger's self-replenishing WINDOWS class). A semantic
//  win32 lint is FP-heavy; what ratchets cleanly is the COUNT of the two
//  highest-signal tells, frozen per-file (the typecheck-floor pattern):
//
//    split-slash   `.split('/')`  — path splitting that breaks on win32
//                   backslash paths (unless the value is known-normalized).
//    kill-signal   `process.kill(pid, 'SIG…')` — POSIX signal semantics that
//                   degrade to TerminateProcess-ish behavior on win32.
//
//  GREEN while every file's tell-count ≤ the committed baseline (new code must
//  branch on process.platform or use a normalized helper); RED the moment any
//  file gains a tell or a NEW file introduces one. A DECREASE prints the
//  relock hint. Regenerate: bun run … --relock  (updates baseline.json).
//
//  Run: ~/.bun/bin/bun run scripts/build/prove-win32-seam-ratchet.ts
// ============================================================================
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const BASELINE = join(import.meta.dir, 'win32-seam-baseline.json')

const TELLS: Array<[string, RegExp]> = [
  ['split-slash', /\.split\((?:'\/'|"\/")\)/g],
  ['kill-signal', /process\.kill\([^)]+,\s*['"]SIG/g],
]

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (e === 'node_modules' || e === '__snapshots__') continue
      walk(p, out)
    } else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
      out.push(p)
    }
  }
}

function measure(): Record<string, number> {
  const counts: Record<string, number> = {}
  const files: string[] = []
  walk(SRC, files)
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/')
    const text = readFileSync(abs, 'utf8')
    for (const [tell, re] of TELLS) {
      const n = (text.match(re) ?? []).length
      if (n > 0) counts[`${rel} :: ${tell}`] = n
    }
  }
  return counts
}

const current = measure()

if (process.argv.includes('--relock')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 1) + '\n')
  console.log(`relocked ${Object.keys(sorted).length} entries → ${BASELINE}`)
  process.exit(0)
}

let baseline: Record<string, number>
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>
} catch {
  console.log('  [FAIL] baseline missing — generate it: bun run prove-win32-seam-ratchet.ts --relock')
  process.exit(1)
}

console.log('============================================================')
console.log(' win32-seam ratchet — POSIX tells frozen per-file')
console.log('============================================================')

let failures = 0
const grew: string[] = []
let shrank = 0
for (const [key, n] of Object.entries(current)) {
  const base = baseline[key] ?? 0
  if (n > base) grew.push(`${key}  ${base} → ${n}`)
  else if (n < base) shrank++
}
for (const key of Object.keys(baseline)) {
  if (!(key in current) && baseline[key]! > 0) shrank++
}

if (grew.length > 0) {
  failures++
  console.log(`  [FAIL] POSIX tells INCREASED (branch on process.platform or use a normalized helper):`)
  for (const g of grew) console.log(`      - ${g}`)
} else {
  console.log(`  [PASS] no file gained a POSIX tell (${Object.keys(current).length} tracked)`)
}
if (shrank > 0) {
  console.log(`  [INFO] ${shrank} entr${shrank === 1 ? 'y' : 'ies'} improved — relock to ratchet down:`)
  console.log('         ~/.bun/bin/bun run scripts/build/prove-win32-seam-ratchet.ts --relock')
}

console.log(failures === 0 ? '\nALL WIN32-SEAM CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
