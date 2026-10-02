#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, argAfter, makeTally } from '../daemon/dupline-world.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const tally = makeTally('prove-crew-runs-board-drive')
const FRAMES = argAfter('--frames')
const KEEP = process.argv.includes('--keep')
const sizes = (argAfter('--sizes') ?? '80x24').split(',').map(s => {
  const [cols, rows] = s.split('x').map(Number)
  return { cols: cols ?? 80, rows: rows ?? 24 }
})
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const CREW = 'crewproof'
const ALPHA_TASK = 'alpha: wire the claim guard'
const BETA_TASK = 'beta: prove the stop'

type Cell = string | { c?: string } | null
type Grid = Cell[][]
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c ?? ' '))).join('').trimEnd()).join('\n')

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crew-runs-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'crew-runs-dir-')))
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { sovereignConsentSeen: true } }, null, 2))
  const now = Date.now()
  mkdirSync(join(home, 'crew', 'livecomms'), { recursive: true })
  writeFileSync(
    join(home, 'crew', 'livecomms', `${CREW}.json`),
    JSON.stringify({
      schema: 1,
      crew: CREW,
      seq: 2,
      messages: [],
      tasks: {
        '1': { id: '1', subject: ALPHA_TASK, status: 'in_progress', owner: 'alpha', blockedBy: [], createdBy: 'alpha', createdAt: now, updatedAt: now },
        '2': { id: '2', subject: BETA_TASK, status: 'pending', owner: 'beta', blockedBy: ['1'], createdBy: 'beta', createdAt: now, updatedAt: now },
      },
      busy: {},
    }, null, 2),
  )
  return { home, cwd }
}

function driveEnv(home: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
    MERCURY_TASK_LIST_ID: CREW,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
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
  const dir = mkdtempSync(join(tmpdir(), 'crew-runs-cfg-'))
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

function dump(label: string, frame: string | undefined, cols: number): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, cols)}`)
}

for (const { cols, rows } of sizes) {
  const label = `${cols}x${rows}`
  tally.section(`the runs board lists a crewmate's live comms task — ${label}`)
  const { home, cwd } = seedWorld()
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols,
        rows,
        total: 260,
        cwd,
        argv: ['node', DIST],
        sends: [
          { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 },
          { data: '/tasks', atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
          { data: '\r', atTick: 999, awaitText: '/tasks', requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
          { data: '', atTick: 999, awaitText: ALPHA_TASK, requireAwait: true, minTick: 2, awaitSettleTicks: 8, mark: 'board' },
          { data: '\x1b', atTick: 999, awaitText: 'esc close', requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
        ],
        readyText: 'ype a prompt',
        readySettleTicks: 3,
        stableTicks: 6,
      },
      driveEnv(home),
    )
  } catch (error) {
    tally.check(`${label}: the capture ran`, false, String(error))
    continue
  }
  const board = cap.marks.board ?? cap.marks.final
  dump(`${label} board`, board, cols)
  if (FRAMES !== undefined) {
    mkdirSync(FRAMES, { recursive: true })
    writeFileSync(join(FRAMES, `runs-board-${label}.txt`), (board ?? '') + '\n')
  }
  const flat = (board ?? '').replace(/\s+/g, ' ')
  tally.check(`${label}: the board lists alpha's task written through the live comms store`, flat.includes(ALPHA_TASK), cap.endReason)
  tally.check(`${label}: the board lists beta's task beside it`, flat.includes(BETA_TASK))
  tally.check(`${label}: the rows sit under the board's own Mission header with its own glyphs (◐ in progress · ○ pending)`, /Mission \(2\)/.test(flat) && flat.includes(`◐ ${ALPHA_TASK}`) && flat.includes(`○ ${BETA_TASK}`), flat.slice(0, 400))
  tally.check(`${label}: the board's header counts them as mission rows (no new column, no new key)`, /Mercury — runs · 0 active · 2 mission/.test(flat) && /esc close/.test(flat), flat.slice(0, 400))
  if (!KEEP) {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

tally.finish()
