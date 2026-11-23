#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

let failures = 0
const effortCopyHint = 'change getEffortLevelDescription or the modelSupportsXHighEffort and modelSupportsMaxEffort predicates in src/models/effort/effort.ts so the copy and the predicates agree'
const check = (label: string, cond: boolean, detail = ''): void => {
  const shown = cond ? detail : detail ? detail + '; ' + effortCopyHint : effortCopyHint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}

console.log('============================================================')
console.log(' trust telemetry + account identity — proof')
console.log('============================================================')

{
  const { getEffortLevelDescription, modelSupportsXHighEffort, modelSupportsMaxEffort } =
    await import('../../src/models/effort/effort.ts')
  const xhigh = getEffortLevelDescription('xhigh')
  const max = getEffortLevelDescription('max')
  check('Sonnet 5 appears in the xhigh copy (catalog: supportsXHigh)', xhigh.includes('Sonnet 5'), xhigh)
  check('the max copy covers the Sonnet tier honestly', /Sonnet 4\.6\+|Sonnet 5/.test(max), max)
  check('Fable appears in both', xhigh.includes('Fable') && max.includes('Fable'))
  check(
    'copy agrees with the predicates for Sonnet 5',
    modelSupportsXHighEffort('claude-sonnet-5') === xhigh.includes('Sonnet 5') &&
      modelSupportsMaxEffort('claude-sonnet-5') === true,
  )
}

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} TRUST-TELEMETRY CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TRUST-TELEMETRY PROOFS PASS')
