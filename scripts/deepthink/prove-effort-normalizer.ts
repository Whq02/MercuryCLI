#!/usr/bin/env bun
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
  ['ultra', 'ultra'],
  ['ULTRA', 'ultra'],
  ['ultra effort', 'ultra'],
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
const REFUSES = ['supermax', 'mega', 'no effort', 'low high', 'effort', '', '  ', 'maximal', 'highest', 'hyper']
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

console.log('— §4 the ladder truth: six words, ultra above max, each model-gated —')
t('the ladder ends ultra', effort.EFFORT_LEVELS[effort.EFFORT_LEVELS.length - 1] === 'ultra')
t('max sits directly below ultra', effort.EFFORT_LEVELS[effort.EFFORT_LEVELS.length - 2] === 'max')
t('xhigh sits directly below max', effort.EFFORT_LEVELS[effort.EFFORT_LEVELS.length - 3] === 'xhigh')
const seats = await import('../../src/utils/model/seatSlots.js')
t('the seat vocabulary IS the ladder tuple (one owner, no mirror)', seats.SEAT_EFFORTS === effort.EFFORT_LEVELS)
t('claude-opus-5 serves the whole ladder (max included)', effort.modelSupportsMaxEffort('claude-opus-5') && effort.modelSupportsXHighEffort('claude-opus-5'))
t('claude-fable-5 serves the whole ladder', effort.modelSupportsMaxEffort('claude-fable-5') && effort.modelSupportsXHighEffort('claude-fable-5'))
t("claude-opus-4-6 serves max but NOT xhigh (the step-down specimen)", effort.modelSupportsMaxEffort('claude-opus-4-6') && !effort.modelSupportsXHighEffort('claude-opus-4-6'))
t("getMaxSupportedEffortLevel('claude-opus-5') = max", effort.getMaxSupportedEffortLevel('claude-opus-5') === 'max')
const cappedUltra = effort.resolveStampedEffortTruth('claude-opus-5', 'ultra')
t('the first-party ladder ends at max: opus-5 does not serve ultra, and ultra asked there runs max with the asked word on the record', !effort.modelOffersEffortLevel('claude-opus-5', 'ultra') && cappedUltra.label === 'max' && cappedUltra.adjustedFrom === 'ultra', JSON.stringify(cappedUltra))

console.log('— §5 the stamped-truth projection is env-free —')
process.env.MERCURY_EFFORT_LEVEL = 'low'
const stamped = effort.resolveStampedEffortTruth('claude-opus-5', 'max')
t('stamped max stays max under a foreign env pin', stamped.label === 'max', stamped.label)
const live = effort.resolveEffortTruth('claude-opus-5', 'max')
t('…while the live resolution follows the env (the pin outranks)', live.label === 'low', live.label)
delete process.env.MERCURY_EFFORT_LEVEL
const steppedTruth = effort.resolveStampedEffortTruth('claude-opus-4-6', 'xhigh')
t('stamped xhigh on a no-xhigh model speaks high', steppedTruth.label === 'high', steppedTruth.label)
t('…and records what it stepped from', steppedTruth.adjustedFrom === 'xhigh', String(steppedTruth.adjustedFrom))

console.log(failures ? '\n❌ EFFORT-NORMALIZER RED' : '\n✅ EFFORT-NORMALIZER GREEN')
process.exit(failures)
