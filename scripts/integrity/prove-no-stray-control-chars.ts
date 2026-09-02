#!/usr/bin/env bun
// ============================================================================
//  scripts/integrity/prove-no-stray-control-chars.ts
//  GATE: no STRAY control-char bytes in source. The edit layer can silently
//  encode an intended space (or other char) as a NUL/SOH byte — turning a
//  source file "binary" (breaks grep/git), and can crash a lazy
//  `-p` dist path with a SyntaxError (inter-`${}` spaces have shipped
//  as NUL in template-built keys). Neither the typecheck floor nor the runtime smoke
//  suites catch a NUL-in-a-string-literal — it is valid-enough JS — so this
//  static byte scan is the dedicated tripwire.
//
//  A FEW files use control chars DELIBERATELY as collision-proof separators /
//  sentinels (a byte that cannot appear in the real data). Those are allow-
//  listed BY BYTE COUNT (ratchet style, like the typecheck baseline): any NEW
//  control char — a new offending file, or a higher count in an allowlisted
//  one — fails RED until the allowlist is deliberately updated.
//
//  Run:  ~/.bun/bin/bun run scripts/integrity/prove-no-stray-control-chars.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCAN_DIRS = ['src', 'scripts']
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/
// 0x09 tab, 0x0a LF, 0x0d CR are legitimate; everything else < 0x20 is a stray.
const isStray = (b: number): boolean =>
  b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d

/**
 * Files that use control bytes ON PURPOSE as separators/sentinels, with the
 * exact expected stray-byte count. Update DELIBERATELY (with a reason) if a
 * legitimate sentinel is added/removed — never to silence an accidental NUL.
 */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  // leaseGlob.ts was delisted: its NUL sentinels are now SPELLED
  // '\x00…' (identical runtime value, text-searchable source) — raw bytes had
  // made the file binary to rg/grep/diff, which is this gate's whole point.
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
      // The allowlisted file lost its sentinels — flag so the allowlist is pruned.
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
