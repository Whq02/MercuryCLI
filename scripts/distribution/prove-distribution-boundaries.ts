#!/usr/bin/env bun
// ============================================================================
//  scripts/distribution/prove-distribution-boundaries.ts —
//  the session/home boundary truths.
//
//  1. crashReportDir rides the ONE config-home resolver — behaviorally
//     (MERCURY_HOME + MERCURY_CONFIG_DIR precedence) and at source (no
//     inline `~/.claude` fallback survives in crashReport.ts).
//
//  Run: ~/.bun/bin/bun run scripts/distribution/prove-distribution-boundaries.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('signature boundaries — home authority')

// ── 1. crash forensics ride the ONE resolver ────────────────────────────────
{
  // scrub the canonical spellings the pooled gate exports (they outrank),
  // THEN set the scratch home this leg proves — order matters: the scrub
  // once sat below the set line and deleted the very value under test.
  delete process.env.MERCURY_CONFIG_DIR
  delete process.env.MERCURY_HOME
  process.env.MERCURY_HOME = '/tmp/sig-proof-home'
  const { crashReportDir } = await import('../../src/utils/crashReport.js')
  check(
    'MERCURY_HOME governs the crash dir',
    crashReportDir().startsWith('/tmp/sig-proof-home'),
    crashReportDir(),
  )
  process.env.MERCURY_CONFIG_DIR = '/tmp/sig-proof-explicit'
  check(
    'explicit MERCURY_CONFIG_DIR wins (compat contract)',
    crashReportDir().startsWith('/tmp/sig-proof-explicit'),
    crashReportDir(),
  )
  delete process.env.MERCURY_CONFIG_DIR
  delete process.env.MERCURY_HOME

  const src = readFileSync(join(ROOT, 'src/utils/crashReport.ts'), 'utf8')
  check(
    'no inline legacy-home derivation survives in crashReport.ts',
    !src.includes('.claude') && src.includes('getMercuryHome'),
  )
}

if (failures > 0) {
  console.log(`\nsignature boundaries: RED (${failures})`)
  process.exit(1)
}
console.log('\nsignature boundaries: green')
