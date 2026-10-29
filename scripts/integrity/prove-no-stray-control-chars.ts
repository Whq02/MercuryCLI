#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCAN_DIRS = ['src', 'scripts']
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const isStray = (b: number): boolean =>
  b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d

const ALLOWLIST: Record<string, { count: number; reason: string }> = {
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (EXT.test(name)) out.push(full)
  }
}

const files: string[] = []
for (const d of SCAN_DIRS) walk(join(ROOT, d), files)

let fail = 0
const offenders: string[] = []
let scanned = 0

for (const full of files) {
  scanned++
  const buf = readFileSync(full)
  const rel = relative(ROOT, full)
  const offsets: number[] = []
  for (let i = 0; i < buf.length; i++) if (isStray(buf[i]!)) offsets.push(i)
  const count = offsets.length
  const allowed = ALLOWLIST[rel]

  if (count === 0) {
    if (allowed) {
      offenders.push(`${rel}: allowlisted for ${allowed.count} but found 0 — remove the stale allowlist entry`)
      fail++
    }
    continue
  }
  if (!allowed) {
    const bytes = offsets.slice(0, 6).map(o => `@${o}=0x${buf[o]!.toString(16).padStart(2, '0')}`).join(' ')
    offenders.push(`${rel}: ${count} STRAY control byte(s) — ${bytes}${count > 6 ? ' …' : ''}  (NOT allowlisted)`)
    fail++
  } else if (count !== allowed.count) {
    offenders.push(`${rel}: ${count} control byte(s) but allowlist expects ${allowed.count} — ${allowed.reason}`)
    fail++
  }
}

console.log('============================================================')
console.log(` no-stray-control-chars gate — scanned ${scanned} source file(s)`)
console.log('============================================================')
console.log(`  allowlisted intentional-sentinel files: ${Object.keys(ALLOWLIST).length}`)
if (offenders.length) {
  console.log('\n  OFFENDERS:')
  for (const o of offenders) console.log(`   ✗ ${o}`)
  console.log('\n  Fix: replace the stray byte (likely a space encoded as NUL by the edit')
  console.log('  layer) at the byte level — `perl -i -pe \'s/\\x00/ /g\' <file>` — then re-scan.')
  console.log('  If the control char is a DELIBERATE sentinel, add it to ALLOWLIST with a reason.')
}
console.log('\n' + '═'.repeat(60))
if (fail === 0) console.log('✅ NO STRAY CONTROL CHARS — source is clean')
else console.log(`❌ ${fail} file(s) with stray/mismatched control bytes`)
console.log('═'.repeat(60))
process.exit(fail === 0 ? 0 : 1)
