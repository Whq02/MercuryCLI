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
//   C  busy: a `!sleep 30` shell line is running on the session's runner
//      (its truthful resting hint `esc interrupt` is the await-gate — also
//      the footer-truth pin, and the old `ctrl+c interrupt` spelling must
//      be absent); ONE ctrl+c interrupts AND arms (the notice is the next
//      await-gate), a second press inside the window closes Mercury. The
//      busy legs (C, C2) drive a FRESH session born on a home seeded with
//      a presence-only fixture key: a shell line needs no credential — the
//      runner executes it in its own process without a model call — but a
//      RUNNER is admitted only on a model whose family holds a credential,
//      so the keyless shared home admits none (a resumed session keeps the
//      model it ran on and is refused by name; a fresh birth is refused the
//      same way). NAMED DEFERRAL: a keyless operator therefore has no seat
//      for `!ls` today — an admission road that seats a runner without a
//      credential and refuses only the first MODEL send by name is a design
//      question for the operator, outside this proof, which pins the live
//      world.
//   D  the copy receipt on both trigger paths, via the standing scenarios:
//      copy-receipt-select (drag-release copy-on-select) and
//      copy-receipt-ctrlc (copy-on-select seeded OFF — the receipt can only
//      come from plain ctrl+c with a selection); the ctrl+c leg also proves
//      the press was CONSUMED by the copy (no exit notice on the grid).
// ============================================================================
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

/** Drive one journey; null = the capture itself failed (already reported). */
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
    // vshot prints the screen it ended on before a never-ready or
    // undelivered refusal: the bottom of that screen is the evidence.
    const printed = (res.stdout ?? '').split('\n').filter(line => line.trimEnd() !== '')
    if (printed.length > 0) {
      console.log(`      ┌ ${tag}: the screen vshot ended on`)
      for (const line of printed.slice(-16)) console.log(`      │ ${line.trimEnd()}`)
      console.log('      └')
    }
    return null
  }
  check(`${tag}: PTY journey completed`, true)
  return JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
}

const mark = (p: Payload, label: string): Mark | undefined =>
  p.marks?.find(m => m.label === label)

/** The bottom of a frame, row-numbered — the footer, the notices and the
 *  hints — for a red whose evidence is the state of that chrome. */
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
/** The interrupt row's painted spelling (the rejection grammar over the
 *  '[Request interrupted by user]' record the runner lands). */
const INTERRUPTED_ROW = '⨯ Interrupted'

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

// The busy legs need a session with a LIVE runner, and a runner is admitted
// only on a model whose family holds a credential. The shared proof home is
// keyless by law: the resumed fixture (resume-2turn) keeps the model it ran
// on and its re-admission is refused by name (never a silent substitute),
// and a fresh birth on that home is refused the same way (`model refused
// (no-credential:…)` on the face). The shell line itself needs no
// credential — the runner executes it in its own process without a model
// call — so the legs seed their OWN home with a presence-only fixture key
// (the seed and the capture carry the same key, the way the frame-trace and
// profile-card proofs do; no wire is ever reached) and drive a FRESH session
// born there: the Boot face's New Session admits a live runner, and the
// legs pin that a `!` line runs, shows the hint and interrupts.
const BUSY_KEY = 'sk-ant-fixture-exit-copy'
type BusyWorld = { cfg: ScenarioCfg; env: Record<string, string>; home: string }
const busyWorld = (): BusyWorld => {
  // The scenario call pins the display flags and the boot cwd in this
  // process's env (and strips any ambient key — captures are keyless by
  // default); the busy home is seeded after it, with its own key.
  const base = scenario('resume-2turn', 80, 44) as unknown as ScenarioCfg
  const argv = base['argv'] as string[]
  const home = mkdtempSync(join(tmpdir(), 'exit-copy-busy-'))
  process.env.ANTHROPIC_API_KEY = BUSY_KEY
  try {
    seedFirstRun(home, [String(base['cwd'])])
  } finally {
    delete process.env.ANTHROPIC_API_KEY
  }
  return { cfg: { ...base, argv: argv.slice(0, 2) }, env: { MERCURY_CONFIG_DIR: home, ANTHROPIC_API_KEY: BUSY_KEY }, home }
}
const closeBusyWorld = (world: BusyWorld): void => {
  try {
    rmSync(world.home, { recursive: true, force: true })
  } catch {
    /* temp-dir clutter only */
  }
}
// THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session
// enters the chat first; the composer's footer hint is the cockpit's own
// settled needle (no earlier surface paints it).
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
      // '!' rides ALONE: a grouped '!sleep 30' chunk is one text atom, which
      // inserts literally instead of arming shell mode (the input-mode check
      // reads the RAW chunk). The bash-mode footer line is the arm receipt.
      // Every awaitText below fires ON the observed text; its atTick is only
      // the hard deadline (vshot's contract).
      { atTick: 130, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: '!' },
      { atTick: 150, awaitText: 'for shell mode', minTick: 0, data: 'sleep 30' },
      { afterPrevTicks: 2, data: '\r' },
      // Gated on the RUNNING turn's truthful resting hint — `esc interrupt`
      // (the kit grammar of chat:cancel). The mark is the footer-truth pin.
      { atTick: 210, awaitText: 'esc interrupt', minTick: 0, data: CTRL_C, mark: 'busy' },
      // The SAME press must have interrupted AND armed: the notice gates the
      // second press, which lands well inside the 3 s window.
      { atTick: 240, awaitText: NOTICE, minTick: 0, data: CTRL_C, mark: 'armed' },
    ],
    260,
    undefined,
    world.env,
  )
  closeBusyWorld(world)
  if (p) {
    const busy = mark(p, 'busy')
    const hintUp = busy !== undefined && textOf(busy.grid).includes('esc interrupt')
    check("the running footer named esc as the interrupt (the truthful hint)", hintUp)
    if (!hintUp && busy !== undefined) dumpBottom('the frame at the first press — the hint absent', busy.grid)
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
  const world = busyWorld()
  const p = drive(
    'busy-esc',
    world.cfg,
    [
      ...ENTER_FRESH_CHAT,
      { atTick: 130, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: '!' },
      { atTick: 150, awaitText: 'for shell mode', minTick: 0, data: 'sleep 30' },
      { afterPrevTicks: 2, data: '\r' },
      // A bare ESC lands the moment the truthful busy hint paints.
      { atTick: 210, awaitText: 'esc interrupt', minTick: 0, data: ESC, mark: 'busy' },
    ],
    250,
    // The settled interrupt row as the cockpit PAINTS it: the runner lands
    // the '[Request interrupted by user]' record and the chat renders that
    // record through its rejection grammar — `⨯ Interrupted · What should
    // Mercury do instead?` under the echoed command (the frame's own
    // words); the raw record text never reaches the screen.
    INTERRUPTED_ROW,
    world.env,
  )
  closeBusyWorld(world)
  if (p) {
    const busy = mark(p, 'busy')
    const hintUp = busy !== undefined && textOf(busy.grid).includes('esc interrupt')
    check('the busy hint was up when ESC landed', hintUp)
    if (!hintUp && busy !== undefined) dumpBottom('the frame at the ESC — the hint absent', busy.grid)
    const settled = textOf(p.grid).includes(INTERRUPTED_ROW)
    check('ESC interrupted the turn (the interrupt row settled under the command)', settled)
    if (!settled) dumpBottom('the final frame — no interrupt marker', p.grid, 16)
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
