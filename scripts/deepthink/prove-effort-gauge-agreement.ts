#!/usr/bin/env bun
// ============================================================================
//  prove-effort-gauge-agreement — every effort gauge speaks ONE tier.
//
//  The incident this closes: in one session the status line above the
//  composer said the effort is "high" while /effort presented "xhigh". Two
//  roads led there, one root: the slider's opening position rode the RAW
//  stored value plus a fixed preferred slot (xhigh), while the chip rode
//  the applied resolve (env pin, model default, step-down). The law: the
//  chip, the slider's opening stop and the /effort readout all derive from
//  resolveEffortTruth — one session state in, one spoken tier out.
//
//    §1 the operator's exact scene, pinned (no stored value ⇒ the model's
//       default, on every gauge — never a preferred-slot xhigh)
//    §2 chip ≡ slider over the WHOLE ladder × models × env pins
//    §3 the /effort readout speaks the same running tier
//    §4 supercode + override targets keep their own truths
//
//  Hermetic: MERCURY_CONFIG_DIR is a temp dir; effort env scrubbed and set
//  per case. cpu-pure — string composition only, no PTY, no paint.
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'effort-gauge-'))
delete process.env.MERCURY_EFFORT_LEVEL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const effort = await import('../../src/utils/effort.js')
const slider = await import('../../src/commands/effort/EffortSlider.js')
const cmd = await import('../../src/commands/effort/effort.js')

type EffortValue = import('../../src/utils/effort.js').EffortValue

/** The slider's spoken opening tier for a session state. */
function sliderOpens(model: string, supercode: boolean, stored: EffortValue | undefined): string {
  const geo = slider.getSliderGeometry(model)
  const slot = slider.resolveOpeningStop(model, supercode, stored)
  return String(geo.levels[slot]?.value)
}

/** The running tier the /effort readout speaks, parsed from its own three
 *  sentence shapes (the prover owns the shapes — a reworded readout re-trues
 *  here, which is the point of a pin). */
function effortReadoutRuns(stored: EffortValue | undefined, model: string): string {
  const message = cmd.showCurrentEffort(stored, model).message
  const automatic = /automatic — currently (\S+) on /.exec(message)
  if (automatic) return automatic[1]!
  const clause = /It runs (\S+) on /.exec(message)
  if (clause) return clause[1]!
  const head = /^Effort is (\S+) — /.exec(message)
  return head ? head[1]! : `<unparsed: ${message}>`
}

console.log('— §1 the operator scene: fresh session, no stored value —')
{
  // A coordinator-launched or fresh Opus 5 session: launch pin default is
  // high; the old slider opened on the preferred xhigh slot regardless.
  const model = 'claude-opus-5'
  const chip = effort.getDisplayedEffortLabel(model, undefined)
  t('the chip says the model default (high)', chip === 'high', chip)
  const opened = sliderOpens(model, false, undefined)
  t('the slider OPENS on the same tier', opened === chip, `slider ${opened} vs chip ${chip}`)
  t('…and never the preferred-slot xhigh', opened !== 'xhigh', opened)
  const readout = effortReadoutRuns(undefined, model)
  t('/effort speaks the same running tier', readout === chip, readout)
}

console.log('— §2 chip ≡ slider: the whole ladder × models × env pins —')
{
  const MODELS = ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-6']
  const STORED: Array<EffortValue | undefined> = [undefined, 'low', 'medium', 'high', 'xhigh', 'max']
  const ENVS: Array<string | undefined> = [undefined, 'high', 'max', 'x high']
  let cases = 0
  let agreements = 0
  let firstMiss = ''
  for (const model of MODELS) {
    for (const stored of STORED) {
      for (const env of ENVS) {
        if (env === undefined) delete process.env.MERCURY_EFFORT_LEVEL
        else process.env.MERCURY_EFFORT_LEVEL = env
        const chipLevel = effort.getDisplayedEffortLevel(model, stored)
        const chipLabel = effort.getDisplayedEffortLabel(model, stored)
        const opened = sliderOpens(model, false, stored)
        cases += 1
        const agree = opened === chipLevel && chipLabel === chipLevel
        if (agree) agreements += 1
        else if (firstMiss === '') firstMiss = `${model} stored=${String(stored)} env=${String(env)}: slider ${opened}, chip ${chipLevel}/${chipLabel}`
      }
    }
  }
  delete process.env.MERCURY_EFFORT_LEVEL
  t(`chip and slider agree on all ${cases} ladder cases`, agreements === cases, firstMiss)
  // The env-vs-stored disagreement scene, called out by name: the pin says
  // high, the stored value says xhigh — BOTH gauges must speak high.
  process.env.MERCURY_EFFORT_LEVEL = 'high'
  const chipPinned = effort.getDisplayedEffortLabel('claude-opus-5', 'xhigh')
  const openedPinned = sliderOpens('claude-opus-5', false, 'xhigh')
  t('an env pin below the stored value rules BOTH gauges', chipPinned === 'high' && openedPinned === 'high', `chip ${chipPinned}, slider ${openedPinned}`)
  delete process.env.MERCURY_EFFORT_LEVEL
  // The step-down scene: stored xhigh on a no-xhigh model — both speak high.
  const chipStepped = effort.getDisplayedEffortLabel('claude-opus-4-6', 'xhigh')
  const openedStepped = sliderOpens('claude-opus-4-6', false, 'xhigh')
  t('a stored tier above the model ladder steps down on BOTH gauges', chipStepped === 'high' && openedStepped === 'high', `chip ${chipStepped}, slider ${openedStepped}`)
}

console.log('— §3 the /effort readout speaks the running tier —')
{
  for (const [model, stored, want] of [
    ['claude-opus-5', 'max', 'max'],
    ['claude-opus-5', 'xhigh', 'xhigh'],
    ['claude-opus-4-6', 'xhigh', 'high'],
  ] as const) {
    const runs = effortReadoutRuns(stored, model)
    const chip = effort.getDisplayedEffortLabel(model, stored)
    t(`${model} stored=${stored}: readout runs ${want} = chip`, runs === want && chip === want, `readout ${runs}, chip ${chip}`)
  }
}

console.log('— §4 supercode + override targets keep their own truths —')
{
  const geo = slider.getSliderGeometry('claude-opus-5')
  const scSlot = slider.resolveOpeningStop('claude-opus-5', true, 'max')
  t('a supercode session opens on the supercode stop', geo.levels[scSlot]?.value === 'supercode', String(geo.levels[scSlot]?.value))
  const ovSlot = slider.resolveOpeningStop('claude-opus-5', true, 'low', 'xhigh')
  t('an override target opens on the override (supercode ignored)', geo.levels[ovSlot]?.value === 'xhigh', String(geo.levels[ovSlot]?.value))
  // The override is that agent's own tier — this process's env must not move it.
  process.env.MERCURY_EFFORT_LEVEL = 'low'
  const ovPinned = slider.resolveOpeningStop('claude-opus-5', false, undefined, 'max')
  t('…and a foreign env pin cannot move an override target', geo.levels[ovPinned]?.value === 'max', String(geo.levels[ovPinned]?.value))
  delete process.env.MERCURY_EFFORT_LEVEL
}

console.log(failures ? '\n❌ EFFORT-GAUGE-AGREEMENT RED' : '\n✅ EFFORT-GAUGE-AGREEMENT GREEN')
process.exit(failures)
