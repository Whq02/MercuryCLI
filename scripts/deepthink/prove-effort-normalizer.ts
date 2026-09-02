#!/usr/bin/env bun
// ============================================================================
//  prove-effort-normalizer — THE ONE NORMALIZER for wordy effort intake.
//
//  The incident this closes: the operator asked the concourse coordinator
//  for launches at "MAX effort" and the sessions came up lower with no
//  explanation — the plain spelling never resolved to its ladder tier, and
//  the daemon's convention default stood in silently. The law (the
//  parseUserSpecifiedModel exact-spellings lesson, applied to effort
//  words): every wordy intake — /effort, the CLI flag, the env pin, the
//  daemon's dispatch and verb doors, the coordinator's launch tool —
//  resolves through normalizeEffortLevelString; a plain spelling IS its
//  ladder word, and what cannot normalize refuses TYPED naming the ladder.
//
//    §1 the plain-spelling table (spoken word → ladder tier)
//    §2 junk refuses (undefined) — nothing off-ladder ever substitutes
//    §3 the parser + the env pin ride the same normalizer
//    §4 the ladder truth: max EXISTS above xhigh, model-gated
//    §5 the stamped-truth projection is env-free (another session's tier)
//
//  Hermetic: MERCURY_CONFIG_DIR is a temp dir; effort env is scrubbed.
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'effort-normalizer-'))
delete process.env.MERCURY_EFFORT_LEVEL

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const effort = await import('../../src/utils/effort.js')

console.log('— §1 the plain-spelling table —')
const RESOLVES: Array<[string, string]> = [
  ['max', 'max'],
  ['MAX', 'max'],
  ['max effort', 'max'],
  ['MAX EFFORT', 'max'],
  ['effort max', 'max'],
  ['maximum', 'max'],
  ['maximum effort', 'max'],
  ['xhigh', 'xhigh'],
  ['x high', 'xhigh'],
  ['x-high', 'xhigh'],
  ['x_high', 'xhigh'],
  ['extra high', 'xhigh'],
  ['extra-high', 'xhigh'],
  ['high effort', 'high'],
  ['low effort', 'low'],
  ['med', 'medium'],
  ['  medium  ', 'medium'],
]
for (const [spoken, tier] of RESOLVES) {
  const got = effort.normalizeEffortLevelString(spoken)
  t(`'${spoken}' resolves to ${tier}`, got === tier, `got ${String(got)}`)
}

console.log('— §2 junk refuses; nothing substitutes —')
const REFUSES = ['ultra', 'supermax', 'mega', 'no effort', 'low high', 'effort', '', '  ', 'maximal', 'highest']
for (const junk of REFUSES) {
  t(`'${junk}' stays undefined`, effort.normalizeEffortLevelString(junk) === undefined)
}

console.log('— §3 the parser + the env pin ride the same normalizer —')
t("parseEffortValue('x high') → xhigh", effort.parseEffortValue('x high') === 'xhigh')
t("parseEffortValue('max effort') → max", effort.parseEffortValue('max effort') === 'max')
t('parseEffortValue(3) keeps the numeric arm', effort.parseEffortValue(3) === 3)
t("parseEffortValue('7') keeps the lenient integer arm", effort.parseEffortValue('7') === 7)
process.env.MERCURY_EFFORT_LEVEL = 'x high'
t("MERCURY_EFFORT_LEVEL='x high' pins xhigh", effort.getEffortEnvOverride() === 'xhigh')
process.env.MERCURY_EFFORT_LEVEL = 'unset'
t("…and 'unset' still means null (defer)", effort.getEffortEnvOverride() === null)
delete process.env.MERCURY_EFFORT_LEVEL

console.log('— §4 the ladder truth: max exists above xhigh, model-gated —')
t('the ladder ends max', effort.EFFORT_LEVELS[effort.EFFORT_LEVELS.length - 1] === 'max')
t('xhigh sits directly below max', effort.EFFORT_LEVELS[effort.EFFORT_LEVELS.length - 2] === 'xhigh')
t('claude-opus-5 serves the whole ladder (max included)', effort.modelSupportsMaxEffort('claude-opus-5') && effort.modelSupportsXHighEffort('claude-opus-5'))
t('claude-fable-5 serves the whole ladder', effort.modelSupportsMaxEffort('claude-fable-5') && effort.modelSupportsXHighEffort('claude-fable-5'))
t("claude-opus-4-6 serves max but NOT xhigh (the step-down specimen)", effort.modelSupportsMaxEffort('claude-opus-4-6') && !effort.modelSupportsXHighEffort('claude-opus-4-6'))
t("getMaxSupportedEffortLevel('claude-opus-5') = max", effort.getMaxSupportedEffortLevel('claude-opus-5') === 'max')

console.log('— §5 the stamped-truth projection is env-free —')
// A sentence about ANOTHER session must not inherit this process's pin:
// with a live env override the stamped projection still speaks the
// stamped tier, while the live resolution follows the env.
process.env.MERCURY_EFFORT_LEVEL = 'low'
const stamped = effort.resolveStampedEffortTruth('claude-opus-5', 'max')
t('stamped max stays max under a foreign env pin', stamped.label === 'max', stamped.label)
const live = effort.resolveEffortTruth('claude-opus-5', 'max')
t('…while the live resolution follows the env (the pin outranks)', live.label === 'low', live.label)
delete process.env.MERCURY_EFFORT_LEVEL
// The step-down stays honest in the projection: a tier the model's ladder
// skips speaks the tier it actually runs.
const steppedTruth = effort.resolveStampedEffortTruth('claude-opus-4-6', 'xhigh')
t('stamped xhigh on a no-xhigh model speaks high', steppedTruth.label === 'high', steppedTruth.label)
t('…and records what it stepped from', steppedTruth.adjustedFrom === 'xhigh', String(steppedTruth.adjustedFrom))

console.log(failures ? '\n❌ EFFORT-NORMALIZER RED' : '\n✅ EFFORT-NORMALIZER GREEN')
process.exit(failures)
