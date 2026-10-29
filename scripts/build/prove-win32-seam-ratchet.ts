#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const BASELINE = join(import.meta.dir, 'win32-seam-baseline.json')

const TELLS: Array<[string, RegExp]> = [
  ['split-slash', /\.split\((?:'\/'|"\/")\)/g],
  ['kill-signal', /process\.kill\([^)]+,\s*['"]SIG/g],
]

const SEAM_PINS: Array<{ file: string; carries: string; never: RegExp; law: string }> = [
  { file: 'src/services/structure/query.ts', carries: 'posixRelative(root, full)', never: /path\.relative\(/, law: 'the Structure files filter compares POSIX-relative paths (F37W-7B-25: a win32 walk handed src\\util.ts to a src/util.ts glob and parsed 0 files)' },
  { file: 'src/services/structure/polyglotQuery.ts', carries: 'posixRelative(root, full)', never: /path\.relative\(/, law: 'the polyglot walk (Structure patterns, AstSearch globs, .gitignore anchors) compares POSIX-relative paths' },
  { file: 'src/services/structure/scanPaths.ts', carries: "platform === 'win32' ? rel.split('\\\\').join('/') : rel", never: /path\.sep/, law: 'the seam flips separators by the platform it is told, never by the host\'s path.sep, so a proof shapes win32 paths on any host' },
]

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (e === 'node_modules' || e === '__snapshots__') continue
      walk(p, out)
    } else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && e !== 'content.generated.ts') {
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

for (const pin of SEAM_PINS) {
  let text: string | null
  try {
    text = readFileSync(join(ROOT, pin.file), 'utf8')
  } catch {
    text = null
  }
  const ok = text !== null && text.includes(pin.carries) && !pin.never.test(text)
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] seam pinned: ${pin.file} carries ${JSON.stringify(pin.carries)} and never ${pin.never.source} — ${pin.law}`)
}

console.log(failures === 0 ? '\nALL WIN32-SEAM CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
