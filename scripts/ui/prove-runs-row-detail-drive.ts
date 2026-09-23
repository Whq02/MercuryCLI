#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DIST, argAfter, makeTally } from '../daemon/dupline-world.ts'
import { vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startScriptedFixture, type ScriptedFixture } from '../lib/scriptedTurn.ts'
import wrapText from '../../src/ink/wrap-text.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const tally = makeTally('prove-runs-row-detail-drive')
const FRAMES = argAfter('--frames')
const KEEP = process.argv.includes('--keep')
const sizes = (argAfter('--sizes') ?? '80x21,80x14,82x17,120x40').split(',').map(s => {
  const [cols, rows] = s.split('x').map(Number)
  return { cols: cols ?? 80, rows: rows ?? 21 }
})
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const ASK = 'runs-row: start the background run'
const LANDED = 'runs-row: the background run is started'
const PACE = Math.max(1, Math.round(vshotBudgetScale()))
const COMMAND = `for i in 1 2 3 4 5 6 7 8; do echo "runs-row line $i of the background run"; sleep ${PACE}; done; echo "runs-row tail line"; sleep 240`
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'

type Cell = string | { c?: string } | null
type Grid = Cell[][]
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c ?? ' '))).join('').trimEnd()).join('\n')

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rr-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'rr-dir-')))
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] }, skipSovereignConsentPrompt: true }, null, 2))
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_SKIP_PERMISSIONS: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    OPENAI_API_KEY: '',
    BROWSER: '/usr/bin/true',
    SHELL: existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL ?? '/bin/sh'),
  }
}

type Capture = { marks: Record<string, string>; sends: number; receipts: number; stderr: string; endReason: string }
async function capture(cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'runs-row-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(200_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`the capture wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  marks.final = gridText(payload.grid)
  rmSync(dir, { recursive: true, force: true })
  return { marks, sends: (cfg.sends as unknown[]).length, receipts: payload.sendReceipts?.length ?? 0, stderr: stderr.join(''), endReason: payload.endReason ?? '' }
}

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
]

function scriptedFixture(): Promise<ScriptedFixture> {
  return startScriptedFixture(req => {
    if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: COMMAND, run_in_background: true, description: 'the background run' } }]
    return [{ type: 'text', text: LANDED }]
  })
}

function dump(label: string, frame: string | undefined, cols: number): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, cols)}`)
}

const rowsOf = (frame: string): string[] => frame.split('\n')
const inner = (row: string): string => row.replace(/^[\s│]+|[\s│]+$/g, '')
const cardRows = (frame: string): string[] => {
  const rows = rowsOf(frame)
  const at = rows.findIndex(r => r.includes('Mercury — shell'))
  return at < 0 ? [] : rows.slice(at)
}
const joined = (frame: string): string => cardRows(frame).map(inner).join('')
const flat = (frame: string): string => cardRows(frame).join('\n').replace(/\s+/g, ' ')

for (const { cols, rows } of sizes) {
  const rail = cols >= 100 && rows >= 26
  const label = `${cols}x${rows}`
  const { home, cwd } = seedWorld()
  const fixture = await scriptedFixture()
  let cap: Capture | null = null
  try {
    const open: Array<Record<string, unknown>> = rail
      ? [
          { data: '\x1b[I', atTick: 999, awaitText: '· shell', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'runs' },
          { data: CLICK, afterPrevTicks: 3, targetText: '· shell', targetDx: -4 },
          { data: CLICK, afterPrevTicks: 5, targetText: '· shell', targetDx: -4, mark: 'selected' },
        ]
      : [
          { data: '/tasks', atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
          { data: '\r', afterPrevTicks: 4 },
        ]
    cap = await capture(
      {
        cols,
        rows,
        total: 300,
        cwd,
        argv: ['node', DIST, '--dangerously-bypass-permissions'],
        sends: [
          ...bootSends(ASK),
          { data: '', atTick: 999, awaitText: LANDED, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'landed' },
          ...open,
          { data: '', atTick: 999, awaitText: 'Mercury — shell', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'card' },
          { data: '', afterPrevTicks: 25, mark: 'card-later' },
          { data: '\x1b', afterPrevTicks: 2 },
        ],
        stableTicks: 4,
      },
      driveEnv(home, fixture.base),
    )
  } finally {
    await fixture.close()
  }
  const card = cap.marks.card
  const later = cap.marks['card-later']
  dump(`${label} · landed`, cap.marks.landed, cols)
  if (rail) dump(`${label} · the runs row selected`, cap.marks.selected, cols)
  dump(`${label} · the card`, card, cols)
  dump(`${label} · the card later`, later, cols)
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [name, frame] of Object.entries(cap.marks)) writeFileSync(join(FRAMES, `${name}-${label}.txt`), frame ?? '')
  }
  const launched = fixture.requests.some(r => r.results.some(x => /Running in the background \(ID: b[0-9a-z]+\)/.test(x.text)))
  tally.section(`${label}: a background shell's row, opened from ${rail ? 'the cockpit RUNS lane by click' : 'the tasks board'}`)
  tally.check(`${label} A1 every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason} ${cap.stderr.slice(-200)}`)
  tally.check(`${label} A2 the turn ended with the command running in the background`, (cap.marks.landed ?? '').includes(LANDED) && launched)
  if (rail) tally.check(`${label} A3 the RUNS row carries the command and the shell verb`, /for i in.*· shell \d+[sm]/.test((cap.marks.runs ?? '').replace(/\s+/g, ' ')), (cap.marks.runs ?? '').replace(/\s+/g, ' ').slice(0, 300))
  tally.check(`${label} A4 the shell card opened (Mercury — shell)`, card !== undefined && card.includes('Mercury — shell'))
  tally.check(`${label} F1 the card carries the whole command, wrapped`, card !== undefined && joined(card).replace(/\s+/g, '').includes(COMMAND.replace(/\s+/g, '')), card === undefined ? '' : flat(card).slice(0, 400))
  tally.check(`${label} F2 the card names the working directory on its own cwd line`, card !== undefined && cardRows(card).some(r => /^\s*│?\s*cwd\s+\S/.test(r) && r.includes(basename(cwd))), card === undefined ? '' : flat(card).slice(0, 400))
  tally.check(`${label} F3 the card shows the elapsed time, running`, card !== undefined && /running · \d+[smh]/.test(flat(card)), card === undefined ? '' : flat(card).slice(0, 400))
  tally.check(`${label} F4 the card shows the last lines of output`, card !== undefined && /runs-row line \d of the background run/.test(flat(card)), card === undefined ? '' : flat(card).slice(0, 400))
  tally.check(`${label} F5 the card follows the run: a later frame shows a later line or a later elapsed`, later !== undefined && card !== undefined && (later !== card) && /runs-row line \d|runs-row tail line/.test(flat(later)) && /running · \d+[smh]/.test(flat(later)))
  if (tally.failed() === 0 && !KEEP) {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  } else console.log(`world kept: ${home} ${cwd}`)
}

const ASK2 = 'runs-row: start the failing run'
const LANDED2 = 'runs-row: the failing run is over'
const DESCRIPTION2 = 'the failing run'
const LONG_COMMAND = `for i in $(seq 1 30); do echo "long-run line $i of thirty"; done; : "the rest of this command is padding so that its text wraps across many rows of the card: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu"; exit 3`
const HOLD_SECONDS = 14 * PACE

function settledFixture(): Promise<ScriptedFixture> {
  return startScriptedFixture(req => {
    if (req.ask.trim() !== ASK2) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: LONG_COMMAND, run_in_background: true, description: DESCRIPTION2 } }]
    if (req.step === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: `sleep ${HOLD_SECONDS}`, description: 'hold the turn' } }]
    return [{ type: 'text', text: LANDED2 }]
  })
}

for (const { cols, rows } of sizes) {
  const label = `${cols}x${rows}`
  const { home, cwd } = seedWorld()
  const fixture = await settledFixture()
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols,
        rows,
        total: 300,
        cwd,
        argv: ['node', DIST, '--dangerously-bypass-permissions'],
        sends: [
          ...bootSends(ASK2),
          { data: '', afterPrevTicks: 20 * PACE, mark: 'settled-chat' },
          { data: '/tasks', afterPrevTicks: 2 },
          { data: '\r', afterPrevTicks: 4 },
          { data: '', afterPrevTicks: 8, mark: 'settled-board' },
          { data: '', atTick: 999, awaitText: 'Mercury — shell', requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'settled-card' },
          { data: '\x1b', afterPrevTicks: 2 },
          { data: '', atTick: 999, awaitText: LANDED2, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'settled-landed' },
        ],
        stableTicks: 4,
      },
      driveEnv(home, fixture.base),
    )
  } finally {
    await fixture.close()
  }
  const card = cap.marks['settled-card']
  dump(`${label} · the chat while the turn holds`, cap.marks['settled-chat'], cols)
  dump(`${label} · after /tasks`, cap.marks['settled-board'], cols)
  dump(`${label} · the settled card (the run ended with exit 3 while the turn still runs)`, card, cols)
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [name, frame] of Object.entries(cap.marks)) writeFileSync(join(FRAMES, `${name}-${label}.txt`), frame ?? '')
  }
  const rowsOfCard = card === undefined ? [] : cardRows(card)
  const commandRowsOnCard = rowsOfCard.filter((r, i) => i > 0 && !/^\s*│?\s*(cwd|Output|◐|failed|done|killed|running)/.test(r) && (i === 1 || /^\s*│?\s{8}/.test(r))).slice(0, 12)
  const countLine = card === undefined ? undefined : /(\d+) of (\d+) lines? shown/.exec(flat(card))
  tally.section(`${label}: a settled shell's card — the exit code, the description, the count line and the one-line floor`)
  tally.check(`${label} S1 every send became due`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason} ${cap.stderr.slice(-200)}`)
  tally.check(`${label} S2 the shell card opened for the settled row while the turn still ran`, card !== undefined && card.includes('Mercury — shell'))
  tally.check(`${label} S3 the header carries the command's description as its subtitle`, card !== undefined && flat(card).includes(`Mercury — shell · ${DESCRIPTION2}`), card === undefined ? '' : flat(card).slice(0, 200))
  tally.check(`${label} S4 the state line names the exit code: failed (exit 3) · <elapsed>`, card !== undefined && /failed \(exit 3\) · \d+[smh]/.test(flat(card)), card === undefined ? '' : flat(card).slice(0, 400))
  tally.check(`${label} S5 the count line reads how many lines show of how many the run wrote (N of 30)`, countLine !== undefined && countLine !== null && Number(countLine[2]) === 30 && Number(countLine[1]) >= 1 && Number(countLine[1]) <= 30, countLine === undefined || countLine === null ? (card === undefined ? '' : flat(card).slice(-300)) : countLine[0])
  tally.check(`${label} S6 at least one output line shows whatever the command's length (the floor counts content lines)`, card !== undefined && /long-run line \d+ of thirty/.test(flat(card)), card === undefined ? '' : flat(card).slice(-400))
  const whole = card !== undefined && joined(card).replace(/\s+/g, '').includes(LONG_COMMAND.replace(/\s+/g, ''))
  const clipped = commandRowsOnCard.some(r => r.trimEnd().endsWith('…'))
  const commandRowsNeeded = wrapText(LONG_COMMAND, cols - 4 - 8, 'wrap').split('\n').length
  const rowsForCommand = rows - 9 - 1 - 1
  const expectWhole = commandRowsNeeded <= rowsForCommand
  tally.check(expectWhole ? `${label} S7 the window has rows for the whole command (${commandRowsNeeded} of ${rowsForCommand}) and the card shows it whole` : `${label} S7 the command needs ${commandRowsNeeded} rows and the window affords ${rowsForCommand}: the card clips it with … and keeps the output line`, expectWhole ? whole : clipped && !whole, `whole=${whole} clipped=${clipped} rows=${JSON.stringify(commandRowsOnCard.slice(0, 3))}`)
  tally.check(`${label} S8 the turn ended after the card closed`, (cap.marks['settled-landed'] ?? '').includes(LANDED2))
  if (tally.failed() === 0 && !KEEP) {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  } else console.log(`world kept: ${home} ${cwd}`)
}
tally.finish()
