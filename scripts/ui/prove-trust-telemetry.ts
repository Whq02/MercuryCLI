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
//   5. The /effort Implementer slider seeds from the Implementer's actual
//      seat spec, never the foreground Scribe's state.
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

// ── 5. Implementer slider seeds from the Implementer ────────────────────────
{
  const { implementerSeatView, resetImplementerSeatViewForTest } = await import(
    '../../src/utils/scribe/reconfigureImplementer.ts'
  )
  resetImplementerSeatViewForTest()
  const savedModel = process.env.MERCURY_IMPLEMENTER_MODEL
  const savedEffort = process.env.MERCURY_IMPLEMENTER_EFFORT
  delete process.env.MERCURY_IMPLEMENTER_MODEL
  delete process.env.MERCURY_IMPLEMENTER_EFFORT
 // HERMETIC HOME (the operator-state law): the resolver's precedence
  // is env pin > persisted slot > ratified default — a standalone run on the
  // calibration machine read the OPERATOR's live seat-slots.json (@xhigh) and
  // failed the ratified-default check. seatSlotsPath() resolves per call and
  // the store cache is path-keyed, so an env re-point isolates cleanly.
  const savedCfgDir = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'trust-telemetry-home-'))
  const seat = implementerSeatView()
  check(
    'default view = the pinned Implementer seat (opus[1m] @max)',
    /opus/.test(seat.model) && seat.effort === 'max',
    `${seat.model}@${seat.effort}`,
  )
  process.env.MERCURY_IMPLEMENTER_EFFORT = 'xhigh'
  const pinned = implementerSeatView()
  check('env-pinned effort reflected', pinned.effort === 'xhigh', pinned.effort)
  if (savedModel === undefined) delete process.env.MERCURY_IMPLEMENTER_MODEL
  else process.env.MERCURY_IMPLEMENTER_MODEL = savedModel
  if (savedEffort === undefined) delete process.env.MERCURY_IMPLEMENTER_EFFORT
  else process.env.MERCURY_IMPLEMENTER_EFFORT = savedEffort
  if (savedCfgDir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = savedCfgDir

  const effortCmd = src('src', 'commands', 'effort', 'effort.tsx')
  check(
    'the Implementer wrapper passes the seat model + effort into the slider',
    effortCmd.includes('modelOverride={seatView.model}') &&
      effortCmd.includes('initialEffortOverride={initialEffort}'),
  )
  const slider = src('src', 'commands', 'effort', 'EffortSlider.tsx')
  check(
    'the slider honors the overrides (model geometry + opening position)',
    slider.includes('modelOverride ?? sessionModel') &&
      slider.includes('initialEffortOverride ?? sessionEffortValue'),
  )
  const reconf = src('src', 'utils', 'scribe', 'reconfigureImplementer.ts')
  check(
    'a daemon-ACKED reconfigure updates the seat view',
    reconf.includes('lastAckedImplementerPatch = {') &&
      /if \(isImplementer\) \{[\s\S]{0,300}lastAckedImplementerPatch/.test(reconf),
  )
}

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} TRUST-TELEMETRY CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TRUST-TELEMETRY PROOFS PASS')
