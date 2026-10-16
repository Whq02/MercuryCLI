#!/usr/bin/env bun
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
const popup = await import('../../src/commands/effort/EffortPopup.js')
const cmd = await import('../../src/commands/effort/effort.js')

type EffortValue = import('../../src/utils/effort.js').EffortValue

function sliderOpens(model: string, stored: EffortValue | undefined): string {
  const rows = popup.effortPopupRows(model)
  const row = popup.effortPopupOpeningRow(model, stored)
  return String(rows[row]?.value)
}

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
  const model = 'claude-opus-5'
  const chip = effort.getDisplayedEffortLabel(model, undefined)
  t('the chip says the model default (high)', chip === 'high', chip)
  const opened = sliderOpens(model, undefined)
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
        const opened = sliderOpens(model, stored)
        cases += 1
        const agree = opened === chipLevel && chipLabel === chipLevel
        if (agree) agreements += 1
        else if (firstMiss === '') firstMiss = `${model} stored=${String(stored)} env=${String(env)}: slider ${opened}, chip ${chipLevel}/${chipLabel}`
      }
    }
  }
  delete process.env.MERCURY_EFFORT_LEVEL
  t(`chip and slider agree on all ${cases} ladder cases`, agreements === cases, firstMiss)
  process.env.MERCURY_EFFORT_LEVEL = 'high'
  const chipPinned = effort.getDisplayedEffortLabel('claude-opus-5', 'xhigh')
  const openedPinned = sliderOpens('claude-opus-5', 'xhigh')
  t('an env pin below the stored value rules BOTH gauges', chipPinned === 'high' && openedPinned === 'high', `chip ${chipPinned}, slider ${openedPinned}`)
  delete process.env.MERCURY_EFFORT_LEVEL
  const chipStepped = effort.getDisplayedEffortLabel('claude-opus-4-6', 'xhigh')
  const openedStepped = sliderOpens('claude-opus-4-6', 'xhigh')
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

console.log('— §4 override targets keep their own truths —')
{
  const geo = { levels: popup.effortPopupRows('claude-opus-5') }
  const maxSlot = popup.effortPopupOpeningRow('claude-opus-5', 'max')
  t('a session at max opens on the max row, the last row of the popup', geo.levels[maxSlot]?.value === 'max' && maxSlot === geo.levels.length - 1, String(geo.levels[maxSlot]?.value))
  const ovSlot = popup.effortPopupOpeningRow('claude-opus-5', 'low', 'xhigh')
  t('an override target opens on the override', geo.levels[ovSlot]?.value === 'xhigh', String(geo.levels[ovSlot]?.value))
  process.env.MERCURY_EFFORT_LEVEL = 'low'
  const ovPinned = popup.effortPopupOpeningRow('claude-opus-5', undefined, 'max')
  t('…and a foreign env pin cannot move an override target', geo.levels[ovPinned]?.value === 'max', String(geo.levels[ovPinned]?.value))
  delete process.env.MERCURY_EFFORT_LEVEL
}

console.log('— §5 a hosted session: the seat\'s served word rules BOTH gauges, the app state only when no seat speaks —')
{
  const chip = await import('../../src/components/mercury-ui/EffortChip.js')
  const hostedOpens = (model: string, seat: string | null, sent: string | null | undefined, stored: EffortValue | undefined): string => {
    const rows = popup.effortPopupRows(model)
    return String(rows[popup.effortPopupOpeningRow(model, stored, undefined, seat, sent)]?.value)
  }
  const model = 'claude-opus-5'
  const chipMax = chip.focusedEffortLabelOf(model, 'max', 'max', 'high')
  const openedMax = hostedOpens(model, 'max', 'max', 'high')
  t('served max over app state high: the chip says max', chipMax === 'max', chipMax)
  t('…and the slider OPENS on max, never on the app state\'s high', openedMax === 'max', `slider ${openedMax} vs chip ${chipMax}`)
  const chipAsked = chip.focusedEffortLabelOf(model, 'max', undefined, 'high')
  const openedAsked = hostedOpens(model, 'max', undefined, 'high')
  t('served max still unresolved on the wire: the chip says max (asked) and the slider opens on max', chipAsked === 'max (asked)' && openedAsked === 'max', `chip ${chipAsked}, slider ${openedAsked}`)
  const chipLow = chip.focusedEffortLabelOf(model, 'high', 'high', 'max')
  const openedLow = hostedOpens(model, 'high', 'high', 'max')
  t('served high over app state max: both gauges say high', chipLow === 'high' && openedLow === 'high', `chip ${chipLow}, slider ${openedLow}`)
  const chipStepped = chip.focusedEffortLabelOf('claude-opus-4-6', 'xhigh', undefined, 'low')
  const openedStepped = hostedOpens('claude-opus-4-6', 'xhigh', undefined, 'low')
  t('a served tier above the seat model\'s ladder opens on the step-down the seat applies', openedStepped === 'high' && openedStepped === effort.resolveStampedEffortTruth('claude-opus-4-6', 'xhigh').label, `chip ${chipStepped}, slider ${openedStepped}`)
  const STORED: Array<EffortValue | undefined> = [undefined, 'low', 'medium', 'high', 'xhigh', 'max']
  let cases = 0
  let agreements = 0
  let firstMiss = ''
  for (const seat of ['low', 'medium', 'high', 'xhigh', 'max']) {
    for (const stored of STORED) {
      for (const sent of [seat, undefined]) {
        const label = chip.focusedEffortLabelOf(model, seat, sent, stored)
        const opened = hostedOpens(model, seat, sent, stored)
        cases += 1
        if (label.replace(' (asked)', '') === opened) agreements += 1
        else if (firstMiss === '') firstMiss = `seat=${seat} sent=${String(sent)} stored=${String(stored)}: chip ${label}, slider ${opened}`
      }
    }
  }
  t(`chip and slider agree on all ${cases} hosted cases, whatever the app state says`, agreements === cases, firstMiss)
  const chipNoSeat = chip.focusedEffortLabelOf(model, null, undefined, 'xhigh')
  const openedNoSeat = hostedOpens(model, null, undefined, 'xhigh')
  t('no seat facts: both gauges fall to the app state (xhigh)', chipNoSeat === 'xhigh' && openedNoSeat === 'xhigh', `chip ${chipNoSeat}, slider ${openedNoSeat}`)
  const geo = { levels: popup.effortPopupRows(model) }
  const ovSlot = popup.effortPopupOpeningRow(model, 'low', 'xhigh', 'max', 'max')
  t('an override target still opens on the override, the seat\'s word never leaking in', geo.levels[ovSlot]?.value === 'xhigh', String(geo.levels[ovSlot]?.value))
}

console.log(failures ? '\n❌ EFFORT-GAUGE-AGREEMENT RED' : '\n✅ EFFORT-GAUGE-AGREEMENT GREEN')
process.exit(failures)
