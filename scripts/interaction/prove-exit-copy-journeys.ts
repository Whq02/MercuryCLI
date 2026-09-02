#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const CTRL_C = String.fromCharCode(3)
const ESC = String.fromCharCode(27)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (name: string): void => {
  console.log(`\n== ${name} ==`)
}

type Send = Record<string, unknown>
type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
type Payload = {
  grid: Array<Array<{ c: string }>>
  endReason: string
  marks?: Mark[]
}
const rowsOf = (grid: Array<Array<{ c: string }>>): string[] =>
  grid.map(r => r.map(c => c.c).join(''))
const textOf = (grid: Array<Array<{ c: string }>>): string => rowsOf(grid).join('\n')

type ScenarioCfg = { sends: Send[]; total: number } & Record<string, unknown>

function drive(
  tag: string,
  base: ScenarioCfg,
  sends: Send[],
  total: number,
  readyText?: string,
): Payload | null {
  const cfg = { ...base, sends, total } as Record<string, unknown>
  if (readyText !== undefined) cfg['readyText'] = readyText
  else delete cfg['readyText']
  delete cfg['stableTicks']
  const gridPath = `/tmp/exitcopy-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/exitcopy-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_FULLSCREEN: '1',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) {
    check(`${tag}: PTY journey completed`, false, (res.stderr ?? '').slice(-300))
    return null
  }
  check(`${tag}: PTY journey completed`, true)
  return JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
}

const mark = (p: Payload, label: string): Mark | undefined =>
  p.marks?.find(m => m.label === label)

const NOTICE = 'twice to close Mercury'

section('A · idle: ctrl+c arms, a second press INSIDE 3 s closes Mercury')
{
  const p = drive(
    'arm-close',
    scenario('resume-2turn', 80, 44) as unknown as ScenarioCfg,
    [
      { atTick: 60, minTick: 8, awaitText: '❯', data: CTRL_C },
      { atTick: 100, awaitText: NOTICE, minTick: 0, data: CTRL_C, mark: 'armed' },
    ],
    110,
  )
  if (p) {
    const armed = mark(p, 'armed')
    check('the notice was up between the presses (armed mark)', armed !== undefined && textOf(armed.grid).includes(NOTICE))
    check(
      'the second press CLOSED Mercury (child EOF)',
      p.endReason === 'eof',
      `endReason=${p.endReason}`,
    )
  }
  cleanupScenario('resume-2turn')
}

section('B · idle: the window EXPIRES at 3 s — a late second press re-arms, never closes')
{
  const p = drive(
    'arm-expire',
    scenario('resume-2turn', 80, 44) as unknown as ScenarioCfg,
    [
      { atTick: 60, minTick: 8, awaitText: '❯', data: CTRL_C },
      { afterPrevTicks: 17, data: CTRL_C, mark: 'preSecond' },
    ],
    110,
    NOTICE,
  )
  if (p) {
    const pre = mark(p, 'preSecond')
    check(
      'the notice had EXPIRED before the late press (3 s window, not 800 ms — an 800 ms window would also pass here, but leg A + this pair pin the boundary from both sides)',
      pre !== undefined && !textOf(pre.grid).includes(NOTICE),
    )
    check('the late press did NOT close Mercury', p.endReason !== 'eof', `endReason=${p.endReason}`)
    check('…and no farewell painted', !textOf(p.grid).includes('Session saved.'))
  }
  cleanupScenario('resume-2turn')
}

section('C · busy: one press interrupts AND arms; a second press closes')
{
  const p = drive(
    'busy',
    scenario('resume-2turn', 80, 44) as unknown as ScenarioCfg,
    [
      { atTick: 60, minTick: 8, awaitText: '❯', data: '!' },
      { atTick: 80, awaitText: 'for shell mode', minTick: 0, data: 'sleep 30' },
      { afterPrevTicks: 2, data: '\r' },
      { atTick: 100, awaitText: 'esc interrupt', minTick: 0, data: CTRL_C, mark: 'busy' },
      { atTick: 120, awaitText: NOTICE, minTick: 0, data: CTRL_C, mark: 'armed' },
    ],
    140,
  )
  if (p) {
    const busy = mark(p, 'busy')
    check(
      "the running footer named esc as the interrupt (the truthful hint)",
      busy !== undefined && textOf(busy.grid).includes('esc interrupt'),
    )
    check(
      "…and never the old 'ctrl+c interrupt' spelling",
      busy !== undefined && !textOf(busy.grid).includes('ctrl+c interrupt'),
    )
    const armed = mark(p, 'armed')
    check('the busy first press showed the same notice', armed !== undefined && textOf(armed.grid).includes(NOTICE))
    check('the second press closed Mercury', p.endReason === 'eof', `endReason=${p.endReason}`)
  }
  cleanupScenario('resume-2turn')
}

section('C2 · busy: ESC alone interrupts the running turn (the hint keeps its promise)')
{
  const p = drive(
    'busy-esc',
    scenario('resume-2turn', 80, 44) as unknown as ScenarioCfg,
    [
      { atTick: 60, minTick: 8, awaitText: '❯', data: '!' },
      { atTick: 80, awaitText: 'for shell mode', minTick: 0, data: 'sleep 30' },
      { afterPrevTicks: 2, data: '\r' },
      { atTick: 100, awaitText: 'esc interrupt', minTick: 0, data: ESC, mark: 'busy' },
    ],
    130,
    'interrupted by user',
  )
  if (p) {
    const busy = mark(p, 'busy')
    check(
      'the busy hint was up when ESC landed',
      busy !== undefined && textOf(busy.grid).includes('esc interrupt'),
    )
    check('ESC interrupted the turn (the interrupt marker settled)', textOf(p.grid).includes('interrupted by user'))
    check('…and Mercury stayed open (no exit)', p.endReason !== 'eof', `endReason=${p.endReason}`)
  }
  cleanupScenario('resume-2turn')
}

section('D · the copy receipt on both trigger paths (the standing scenarios)')
{
  const sel = scenario('copy-receipt-select', 80, 44) as unknown as ScenarioCfg
  const pSel = drive('receipt-select', sel, sel.sends, sel.total, 'Copied to clipboard')
  if (pSel) {
    check('drag-release raised "Copied to clipboard"', textOf(pSel.grid).includes('Copied to clipboard'))
  }
  cleanupScenario('copy-receipt-select')

  const ctl = scenario('copy-receipt-ctrlc', 80, 44) as unknown as ScenarioCfg
  const pCtl = drive('receipt-ctrlc', ctl, ctl.sends, ctl.total, 'Copied to clipboard')
  if (pCtl) {
    const text = textOf(pCtl.grid)
    check('ctrl+c with a selection raised "Copied to clipboard"', text.includes('Copied to clipboard'))
    check('…and the press was CONSUMED by the copy (no exit notice)', !text.includes(NOTICE))
  }
  cleanupScenario('copy-receipt-ctrlc')
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-exit-copy-journeys: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ exit-copy-journeys — arm/expire/close · busy interrupt→close · busy esc-interrupt · both receipt paths (E2E)')
