#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-exit-copy-journeys.ts — LANE X (exit · interrupt ·
//  copy grammar): the PTY half. Real product, real PTY, no API.
//
//  Legs (every phase transition is OBSERVED, never tick-guessed — the
//  two-phase-paint law: sends gate on on-screen text, marks snapshot the grid
//  the moment before the next press fires):
//   A  idle arm → close INSIDE the 3 s window: ctrl+c arms (the notice
//      "press ctrl+c twice to close Mercury" is the await-gate for the second
//      press, so a missing notice REFUSES the journey), a second press
//      ~600 ms later closes Mercury (child EOF).
//   B  idle arm → EXPIRE at 3 s: the second press lands ~3.4 s later; the
//      mark taken just before it must show the notice GONE (the window
//      lapsed), and that late press re-arms (readyText) instead of closing.
//   C  busy: a local `!sleep 30` turn is running (its truthful resting hint
//      `esc interrupt` is the await-gate — also the footer-truth pin, and
//      the old `ctrl+c interrupt` spelling must be absent); ONE ctrl+c
//      interrupts AND arms (the notice is the next await-gate), a second
//      press inside the window closes Mercury.
//   D  the copy receipt on both trigger paths, via the standing scenarios:
//      copy-receipt-select (drag-release copy-on-select) and
//      copy-receipt-ctrlc (copy-on-select seeded OFF — the receipt can only
//      come from plain ctrl+c with a selection); the ctrl+c leg also proves
//      the press was CONSUMED by the copy (no exit notice on the grid).
// ============================================================================
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

/** Drive one journey; null = the capture itself failed (already reported). */
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
      // Gated on the NOTICE itself (atTick is only the hard deadline —
      // vshot's awaitText contract): fires the moment the notice paints,
      // well inside the 3 s window. If arming broke, the deadline-fired
      // press lands on an unarmed composer and the 'armed' mark assert
      // below reds loudly.
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
      // 17 ticks ≈ 3.4 s — outside the 3000 ms window. The mark snapshots
      // the grid the moment before this press fires.
      { afterPrevTicks: 17, data: CTRL_C, mark: 'preSecond' },
    ],
    110,
    NOTICE, // the late press must RE-ARM (readyText evaluates only after all sends)
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
      // '!' rides ALONE: a grouped '!sleep 30' chunk is one text atom, which
      // inserts literally instead of arming shell mode (the input-mode check
      // reads the RAW chunk). The bash-mode footer line is the arm receipt.
      // Every awaitText below fires ON the observed text; its atTick is only
      // the hard deadline (vshot's contract).
      { atTick: 60, minTick: 8, awaitText: '❯', data: '!' },
      { atTick: 80, awaitText: 'for shell mode', minTick: 0, data: 'sleep 30' },
      { afterPrevTicks: 2, data: '\r' },
      // Gated on the RUNNING turn's truthful resting hint — `esc interrupt`
      // (the kit grammar of chat:cancel). The mark is the footer-truth pin.
      { atTick: 100, awaitText: 'esc interrupt', minTick: 0, data: CTRL_C, mark: 'busy' },
      // The SAME press must have interrupted AND armed: the notice gates the
      // second press, which lands well inside the 3 s window.
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
  // The flow incident: the operator pressed Esc during a running
  // turn and NOTHING fired — the session transcript holds zero interruption
  // records. The grammar legs above pin the footer NAMING esc as the
  // interrupt; this leg makes esc DO it: a bare ESC during a busy turn must
  // settle the interrupt marker, and Mercury must stay open.
  const p = drive(
    'busy-esc',
    scenario('resume-2turn', 80, 44) as unknown as ScenarioCfg,
    [
      { atTick: 60, minTick: 8, awaitText: '❯', data: '!' },
      { atTick: 80, awaitText: 'for shell mode', minTick: 0, data: 'sleep 30' },
      { afterPrevTicks: 2, data: '\r' },
      // A bare ESC lands the moment the truthful busy hint paints.
      { atTick: 100, awaitText: 'esc interrupt', minTick: 0, data: ESC, mark: 'busy' },
    ],
    130,
    // The settled interrupt row spells '[Request interrupted by user]'
    // (rejectionText) — the old capital-I marker died with its surface.
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
  // Drag-release (copy-on-select, default ON).
  const sel = scenario('copy-receipt-select', 80, 44) as unknown as ScenarioCfg
  const pSel = drive('receipt-select', sel, sel.sends, sel.total, 'Copied to clipboard')
  if (pSel) {
    check('drag-release raised "Copied to clipboard"', textOf(pSel.grid).includes('Copied to clipboard'))
  }
  cleanupScenario('copy-receipt-select')

  // Plain ctrl+c with a selection (copy-on-select seeded OFF by the
  // scenario, so the receipt can ONLY be this path).
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
