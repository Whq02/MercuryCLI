#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'effort-normalizer-'))
delete process.env.MERCURY_EFFORT_LEVEL

let failures = 0
const t = (name: string, ok: boolean, detail = '', fixHint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && fixHint ? ` — change: ${fixHint}` : ''}`)
  if (!ok) failures = 1
}

const effort = await import('../../src/models/effort/effort.js')

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
  t(`'${spoken}' resolves to ${tier}`, got === tier, `got ${String(got)}`, 'the spelling table in normalizeEffortLevelString in src/models/effort/effort.ts')
}

console.log('— §2 junk refuses; nothing substitutes (a provider list word above max included) —')
const REFUSES = ['supermax', 'mega', 'no effort', 'low high', 'effort', '', '  ', 'maximal', 'highest', 'hyper', 'ultra', 'ULTRA', 'ultra effort']
for (const junk of REFUSES) {
  t(`'${junk}' stays undefined`, effort.normalizeEffortLevelString(junk) === undefined, '', 'normalizeEffortLevelString in src/models/effort/effort.ts must return undefined for this word')
}

console.log('— §3 the parser + the env pin ride the same normalizer —')
t("parseEffortValue('x high') → xhigh", effort.parseEffortValue('x high') === 'xhigh', '', 'parseEffortValue in src/models/effort/effort.ts must route strings through normalizeEffortLevelString')
t("parseEffortValue('max effort') → max", effort.parseEffortValue('max effort') === 'max', '', 'parseEffortValue in src/models/effort/effort.ts must route strings through normalizeEffortLevelString')
t('parseEffortValue(3) keeps the numeric arm', effort.parseEffortValue(3) === 3)
t("parseEffortValue('7') keeps the lenient integer arm", effort.parseEffortValue('7') === 7)
process.env.MERCURY_EFFORT_LEVEL = 'x high'
t("MERCURY_EFFORT_LEVEL='x high' pins xhigh", effort.getEffortEnvOverride() === 'xhigh', '', 'getEffortEnvOverride in src/models/effort/effort.ts must read MERCURY_EFFORT_LEVEL through the same normalizer')
process.env.MERCURY_EFFORT_LEVEL = 'unset'
t("…and 'unset' still means null (defer)", effort.getEffortEnvOverride() === null, '', 'getEffortEnvOverride in src/models/effort/effort.ts must return null for the value unset')
delete process.env.MERCURY_EFFORT_LEVEL

console.log('— §4 the ladder truth: five words, max at the top, each model-gated —')
t('the ladder has five words', effort.EFFORT_LEVELS.length === 5, '', 'EFFORT_LEVELS in src/models/effort/effort.ts')
t('the ladder ends max', effort.EFFORT_LEVELS[effort.EFFORT_LEVELS.length - 1] === 'max')
t('xhigh sits directly below max', effort.EFFORT_LEVELS[effort.EFFORT_LEVELS.length - 2] === 'xhigh')
t('a provider list word above max is not on the ladder', !(effort.EFFORT_LEVELS as readonly string[]).includes('ultra') && !effort.isEffortLevel('ultra'))
const seats = await import('../../src/models/facts/seatSlots.js')
t('the seat vocabulary IS the ladder tuple (one owner, no mirror)', seats.SEAT_EFFORTS === effort.EFFORT_LEVELS, '', 'SEAT_EFFORTS in src/models/facts/seatSlots.ts must be the EFFORT_LEVELS tuple itself, not a copy')
t('claude-opus-5 serves the whole ladder (max included)', effort.modelSupportsMaxEffort('claude-opus-5') && effort.modelSupportsXHighEffort('claude-opus-5'))
t('claude-fable-5 serves the whole ladder', effort.modelSupportsMaxEffort('claude-fable-5') && effort.modelSupportsXHighEffort('claude-fable-5'))
t("claude-opus-4-6 serves max but NOT xhigh (the step-down specimen)", effort.modelSupportsMaxEffort('claude-opus-4-6') && !effort.modelSupportsXHighEffort('claude-opus-4-6'))
t("getMaxSupportedEffortLevel('claude-opus-5') = max", effort.getMaxSupportedEffortLevel('claude-opus-5') === 'max')
const opusStops = effort.selectableEffortLevelsForLadder('claude-opus-5') as readonly string[]
t('the top served stop on opus-5 is max, and the ladder-domain stops never carry a word above it', opusStops.indexOf('max') === opusStops.length - 1 && !opusStops.includes('ultra'), JSON.stringify(opusStops), 'selectableEffortLevelsForLadder in src/models/effort/effort.ts')

console.log('— §5 the stamped-truth projection is env-free —')
process.env.MERCURY_EFFORT_LEVEL = 'low'
const stamped = effort.resolveStampedEffortTruth('claude-opus-5', 'max')
t('stamped max stays max under a foreign env pin', stamped.label === 'max', stamped.label, 'resolveStampedEffortTruth in src/models/effort/effort.ts must not read MERCURY_EFFORT_LEVEL')
const live = effort.resolveEffortTruth('claude-opus-5', 'max')
t('…while the live resolution follows the env (the pin outranks)', live.label === 'low', live.label, 'resolveEffortTruth in src/models/effort/effort.ts must let the env pin outrank')
delete process.env.MERCURY_EFFORT_LEVEL
const steppedTruth = effort.resolveStampedEffortTruth('claude-opus-4-6', 'xhigh')
t('stamped xhigh on a no-xhigh model speaks high', steppedTruth.label === 'high', steppedTruth.label, 'resolveStampedEffortTruth in src/models/effort/effort.ts must step xhigh down to high when the model lacks xhigh')
t('…and records what it stepped from', steppedTruth.adjustedFrom === 'xhigh', String(steppedTruth.adjustedFrom), 'resolveStampedEffortTruth in src/models/effort/effort.ts must set adjustedFrom')

console.log(failures ? '\n❌ EFFORT-NORMALIZER RED' : '\n✅ EFFORT-NORMALIZER GREEN')
process.exit(failures)
