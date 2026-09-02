#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from '../ui/renderScenarios.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
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
  envExtra: Record<string, string> = {},
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
      ...envExtra,
    },
  })
  if (res.status !== 0) {
    check(`${tag}: PTY journey completed`, false, (res.stderr ?? '').slice(-300))
    const printed = (res.stdout ?? '').split('\n').filter(line => line.trimEnd() !== '')
    if (printed.length > 0) {
      console.log(`      ┌ ${tag}: the screen vshot ended on`)
      for (const line of printed) console.log(`      │ ${line.trimEnd()}`)
      console.log('      └')
    }
    return null
  }
  check(`${tag}: PTY journey completed`, true)
  return JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
}

const mark = (p: Payload, label: string): Mark | undefined =>
  p.marks?.find(m => m.label === label)

const dumpBottom = (label: string, grid: Array<Array<{ c: string }>>, count = 12): void => {
  const lines = rowsOf(grid)
  console.log(`      ┌ ${label}`)
  lines.slice(-count).forEach((line, offset) => {
    const row = line.trimEnd()
    if (row !== '') console.log(`      │ ${String(lines.length - count + offset).padStart(2, ' ')} ${row}`)
  })
  console.log('      └')
}

const NOTICE = 'twice to close Mercury'
const INTERRUPTED_ROW = '⨯ Interrupted'

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

type BusyWorld = { cfg: ScenarioCfg; env: Record<string, string>; home: string }
const busyWorld = (): BusyWorld => {
  const base = scenario('resume-2turn', 80, 44) as unknown as ScenarioCfg
  const argv = base['argv'] as string[]
  const home = mkdtempSync(join(tmpdir(), 'exit-copy-busy-'))
  seedFirstRun(home, [String(base['cwd'])])
  return {
    cfg: { ...base, argv: argv.slice(0, 2) },
    env: {
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor'),
    },
    home,
  }
}
const closeBusyWorld = (world: BusyWorld): void => {
  if (failures > 0) {
    const found = (spawnSync('find', [world.home, '-name', '*.jsonl'], { encoding: 'utf8' }).stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
    console.log(`      ┌ busy home kept at ${world.home} — transcripts: ${found.length}`)
    for (const file of found.slice(-2)) {
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
      console.log(`      │ ${file} (${lines.length} lines)`)
      for (const line of lines.slice(-6)) console.log(`      │   ${line.slice(0, 240)}`)
    }
    console.log('      └')
    return
  }
  try {
    rmSync(world.home, { recursive: true, force: true })
  } catch {
  }
}
const ENTER_FRESH_CHAT: Send[] = [
  { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
]

section('C · busy: one press interrupts AND arms; a second press closes')
{
  const world = busyWorld()
  const p = drive(
    'busy',
    world.cfg,
    [
      ...ENTER_FRESH_CHAT,
      { atTick: 130, awaitText: '⇧← back', minTick: 5, awaitSettleTicks: 3, requireAwait: true, data: '!' },
      { atTick: 150, awaitText: 'for shell mode', minTick: 0, awaitSettleTicks: 1, requireAwait: true, data: 'sleep 30' },
      { afterPrevTicks: 2, data: '\r' },
      { atTick: 210, awaitText: 'esc interrupt', minTick: 0, data: CTRL_C, mark: 'busy' },
      { atTick: 240, awaitText: NOTICE, minTick: 0, data: CTRL_C, mark: 'armed' },
    ],
    260,
    undefined,
    world.env,
  )
  if (p) {
    const busy = mark(p, 'busy')
    const hintUp = busy !== undefined && textOf(busy.grid).includes('esc interrupt')
    check("the running footer named esc as the interrupt (the truthful hint)", hintUp)
    if (!hintUp && busy !== undefined) dumpBottom('the frame at the first press — the hint absent', busy.grid, 60)
    check(
      "…and never the old 'ctrl+c interrupt' spelling",
      busy !== undefined && !textOf(busy.grid).includes('ctrl+c interrupt'),
    )
    const armed = mark(p, 'armed')
    check('the busy first press showed the same notice', armed !== undefined && textOf(armed.grid).includes(NOTICE))
    check('the second press closed Mercury', p.endReason === 'eof', `endReason=${p.endReason}`)
  }
  closeBusyWorld(world)
  cleanupScenario('resume-2turn')
}

section('C2 · busy: ESC alone interrupts the running turn (the hint keeps its promise)')
{
  const world = busyWorld()
  const p = drive(
    'busy-esc',
    world.cfg,
    [
      ...ENTER_FRESH_CHAT,
      { atTick: 130, awaitText: '⇧← back', minTick: 5, awaitSettleTicks: 3, requireAwait: true, data: '!' },
      { atTick: 150, awaitText: 'for shell mode', minTick: 0, awaitSettleTicks: 1, requireAwait: true, data: 'sleep 30' },
      { afterPrevTicks: 2, data: '\r' },
      { atTick: 210, awaitText: 'esc interrupt', minTick: 0, data: ESC, mark: 'busy' },
    ],
    250,
    INTERRUPTED_ROW,
    world.env,
  )
  if (p) {
    const busy = mark(p, 'busy')
    const hintUp = busy !== undefined && textOf(busy.grid).includes('esc interrupt')
    check('the busy hint was up when ESC landed', hintUp)
    if (!hintUp && busy !== undefined) dumpBottom('the frame at the ESC — the hint absent', busy.grid, 60)
    const settled = textOf(p.grid).includes(INTERRUPTED_ROW)
    check('ESC interrupted the turn (the interrupt row settled under the command)', settled)
    if (!settled) dumpBottom('the final frame — no interrupt marker', p.grid, 16)
    check('…and Mercury stayed open (no exit)', p.endReason !== 'eof', `endReason=${p.endReason}`)
  }
  closeBusyWorld(world)
  cleanupScenario('resume-2turn')
}

section('D · the copy receipt on both trigger paths (the standing scenarios)')
{
  const SGR = (button: number, up = false): string => `\x1b[<${button};{X};{Y}${up ? 'm' : 'M'}`
  const DRAG: Send[] = [
    { atTick: 60, minTick: 8, awaitText: '❯', data: '' },
    { targetText: 'first task', targetDx: 1, afterPrevTicks: 2, data: SGR(0) },
    { targetText: 'second task', targetDx: 3, afterPrevTicks: 1, data: SGR(32) },
    { targetText: 'second task', targetDx: 3, afterPrevTicks: 1, data: SGR(0, true) },
  ]
  const sel = scenario('copy-receipt-select', 80, 44) as unknown as ScenarioCfg
  const pSel = drive('receipt-select', sel, DRAG, sel.total, 'Copied to clipboard')
  if (pSel) {
    check('drag-release raised "Copied to clipboard"', textOf(pSel.grid).includes('Copied to clipboard'))
  }
  cleanupScenario('copy-receipt-select')

  const ctl = scenario('copy-receipt-ctrlc', 80, 44) as unknown as ScenarioCfg
  const pCtl = drive('receipt-ctrlc', ctl, [...DRAG, { afterPrevTicks: 4, data: CTRL_C }], ctl.total, 'Copied to clipboard')
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
