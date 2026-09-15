#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, argAfter, makeTally } from '../daemon/dupline-world.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startScriptedFixture, type ScriptedFixture } from '../lib/scriptedTurn.ts'

const VSHOT = join(import.meta.dir, '..', 'ui', 'vshot.py')
const tally = makeTally('prove-sub-agent-shell-board-drive')
const FRAMES = argAfter('--frames')
const KEEP = process.argv.includes('--keep')
const sizes = (argAfter('--sizes') ?? '80x21').split(',').map(s => {
  const [cols, rows] = s.split('x').map(Number)
  return { cols: cols ?? 80, rows: rows ?? 21 }
})
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const ASK = 'board-probe: launch the agent'
const AGENT_PROMPT = 'board agent work'
const AGENT_DESCRIPTION = 'background agent'
const SUB_COMMAND = 'sleep 60; echo sub-shell-row'
const LANDED = 'board-probe: the agent is launched'

type Cell = string | { c?: string } | null
type Grid = Cell[][]
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c ?? ' '))).join('').trimEnd()).join('\n')

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'shell-board-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'shell-board-cwd-')))
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'Agent'] }, skipSovereignConsentPrompt: true }, null, 2))
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
    MERCURY_DECK_COMPANION: '0',
    OPENAI_API_KEY: '',
    BROWSER: '/usr/bin/true',
    SHELL: existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL ?? '/bin/sh'),
  }
}

type Capture = { marks: Record<string, string>; sends: number; receipts: number; stderr: string }
async function capture(cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'shell-board-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(180_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`the capture wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }> }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  marks.final = gridText(payload.grid)
  rmSync(dir, { recursive: true, force: true })
  return { marks, sends: (cfg.sends as unknown[]).length, receipts: payload.sendReceipts?.length ?? 0, stderr: stderr.join('') }
}

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
]

function scriptedFixture(): Promise<ScriptedFixture> {
  return startScriptedFixture(req => {
    if (req.opening.trim() === AGENT_PROMPT) {
      switch (req.step) {
        case 0:
          return [{ type: 'tool_use', name: 'Bash', input: { command: SUB_COMMAND, run_in_background: true, description: 'the sub-agent’s background run' } }]
        case 1:
          return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 50', description: 'stay alive for the board' } }]
        default:
          return [{ type: 'text', text: 'agent done' }]
      }
    }
    if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: AGENT_DESCRIPTION, prompt: AGENT_PROMPT, run_in_background: true } }]
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

for (const { cols, rows } of sizes) {
  const { home, cwd } = seedWorld()
  const fixture = await scriptedFixture()
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols,
        rows,
        total: 260,
        cwd,
        argv: ['node', DIST, '--dangerously-bypass-permissions'],
        sends: [
          ...bootSends(ASK),
          { data: '', atTick: 999, awaitText: LANDED, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'landed' },
          { data: '/tasks', afterPrevTicks: 6 },
          { data: '\r', afterPrevTicks: 4 },
          { data: '', atTick: 999, awaitText: 'Mercury \u2014 ', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'board' },
        ],
        stableTicks: 4,
      },
      driveEnv(home, fixture.base),
    )
  } finally {
    await fixture.close()
  }
  const label = `${cols}x${rows}`
  const board = cap.marks.board ?? cap.marks.final
  dump(`${label} · the board`, board, cols)
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true })
    writeFileSync(join(FRAMES, `board-${label}.txt`), board ?? '')
    writeFileSync(join(FRAMES, `landed-${label}.txt`), cap.marks.landed ?? '')
  }
  const subLaunched = fixture.requests.some(r => r.results.some(x => /Running in the background \(ID: b[0-9a-z]+\)/.test(x.text)))
  tally.section(`${label}: a background agent’s background command on the tasks board`)
  tally.check(`${label} A1 every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} ${cap.stderr.slice(-200)}`)
  tally.check(`${label} A2 the lead answered and its turn ended`, (cap.marks.landed ?? '').includes(LANDED))
  tally.check(`${label} A3 the background agent launched its command in the background`, subLaunched)
  tally.check(`${label} A4 the /tasks view opened on the agent\u2019s work`, board !== undefined && /Mercury \u2014 (tasks|agent)/.test(board) && board.includes(AGENT_DESCRIPTION), board?.slice(0, 200))
  tally.check(`${label} A5 the board lists the agent\u2019s background command as a shell row`, board !== undefined && /Shells \(1\)/.test(board) && board.includes('sub-shell-row'), board === undefined ? '' : `rows: ${board.split('\n').filter(l => /Shells|sub-shell|Mercury \u2014/.test(l)).join(' | ').slice(0, 300)}`)
  if (tally.failed() === 0 && !KEEP) {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  } else console.log(`world kept: ${home} ${cwd}`)
}
tally.finish()
