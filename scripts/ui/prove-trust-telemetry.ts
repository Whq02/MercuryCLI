#!/usr/bin/env bun
// ============================================================================
//  prove-trust-telemetry — trust telemetry + environment/account identity
//  (5.6 Sol audit slice 7, revalidated at HEAD).
//
//   2. ctx forecast turn-sampling is proven by prove-ctx-forecast (extended).
//      (Section 1 retired with the output-styles feature.)
//      (Section 3 retired with the usage-limit relay — account-slot
//      simplification ruling: no switching machinery to key.)
//   4. Effort capability copy derives from the catalog predicates — Sonnet 5
//      appears wherever supported; /effort help uses the same generator.
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const src = (...p: string[]): string =>
  readFileSync(join(import.meta.dir, '../../', ...p), 'utf8')

console.log('============================================================')
console.log(' trust telemetry + account identity — proof')
console.log('============================================================')

// ── 4. effort copy from catalog predicates ──────────────────────────────────
{
  const { getEffortLevelDescription, modelSupportsXHighEffort, modelSupportsMaxEffort } =
    await import('../../src/utils/effort.ts')
  const xhigh = getEffortLevelDescription('xhigh')
  const max = getEffortLevelDescription('max')
  check('Sonnet 5 appears in the xhigh copy (catalog: supportsXHigh)', xhigh.includes('Sonnet 5'), xhigh)
  check('the max copy covers the Sonnet tier honestly', /Sonnet 4\.6\+|Sonnet 5/.test(max), max)
  check('Fable appears in both', xhigh.includes('Fable') && max.includes('Fable'))
  // Copy ↔ predicate agreement — the whole point of generating it.
  check(
    'copy agrees with the predicates for Sonnet 5',
    modelSupportsXHighEffort('claude-sonnet-5') === xhigh.includes('Sonnet 5') &&
      modelSupportsMaxEffort('claude-sonnet-5') === true,
  )
  const effortCmd = src('src', 'commands', 'effort', 'effort.tsx')
  check(
    '/effort help derives its level lines from the generator',
    /getEffortLevelDescription\(level\)/.test(effortCmd),
  )
  check(
    'no stale hardcoded family list remains in the help',
    !effortCmd.includes('Opus 4.5+, Sonnet 4.6, Fable'),
  )
}

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} TRUST-TELEMETRY CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TRUST-TELEMETRY PROOFS PASS')
