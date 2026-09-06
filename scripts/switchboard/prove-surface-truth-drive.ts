#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'surface-truth-drive-'))
const daemonDir = join(SCRATCH, 'daemon')
const tabulaDir = join(SCRATCH, 'tabula')
const work = join(SCRATCH, 'work-truth')
for (const d of [daemonDir, tabulaDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
delete process.env.MERCURY_MODEL
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_CONCOURSE = 'always'

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SCREEN_MODEL_SETTING = 'claude-fable-5[1m]'
const SCREEN_MODEL_LABEL = 'Fable 5 (1M context)'
const SEAT_MODEL = 'gpt-5.6-sol'
const SEAT_MODEL_LABEL = 'GPT-5.6 Sol'
const SEAT_MODEL_WIRE_NAME = 'GPT-5.6-Sol'
const SEAT_EFFORT = 'xhigh'
const SEAT_TITLE = 'Truth Seat'

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const fixture = await startCrossfamilyFixture({
  port: Number(process.env.SURFACE_TRUTH_PORT ?? '25161'),
  gptId: SEAT_MODEL,
  gptDisplayName: SEAT_MODEL_WIRE_NAME,
  gptReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
})

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemon = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn('node', [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      ...fixture.env,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_TABULA_DIR: tabulaDir,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TERMINAL_TITLE: '0',
    },
    stdio: ['ignore', logFd, logFd],
  })
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const BACKSPACES = '\x7f'.repeat(8)
let seatId = ''
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const run = await runArtifactArena({
  turns: [],
  sends: [
    `after:${SEAT_TITLE}:2500:\t`,
    `after:${SEAT_TITLE}:4000:\r`,
    `after:${SEAT_TITLE}:5200:\r`,
    `after:${SEAT_TITLE}:9000:/mo`,
    `after:${SEAT_TITLE}:12000:${BACKSPACES}`,
    `after:${SEAT_TITLE}:13000:/eff`,
    `after:${SEAT_TITLE}:16000:${BACKSPACES}`,
    `after:${SEAT_TITLE}:17000:/status`,
    `after:${SEAT_TITLE}:18200:\r`,
    ...Array.from({ length: 16 }, (_, i) => `after:${SEAT_TITLE}:${20000 + i * 250}:\x1b[B`),
    `after:${SEAT_TITLE}:25500:\x1b`,
    `after:${SEAT_TITLE}:27000:/model`,
    `after:${SEAT_TITLE}:28200:\r`,
    `after:${SEAT_TITLE}:32000:\x1b`,
  ],
  seconds: 46,
  cols: 120,
  rows: 40,
  keep: true,
  seedHome: async (configDir, cwd) => {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ model: SCREEN_MODEL_SETTING }))
    seedFirstRun(configDir, [cwd, work])
    spawnDaemon(configDir)
    check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' } as never)).ok === true, 60_000))
    const a = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'surface-truth-seat',
      prompt: 'seat-task-gpt: work on the gpt engine',
      workspaceDir: cwd,
      title: SEAT_TITLE,
      modelKey: SEAT_MODEL,
      effort: SEAT_EFFORT,
    } as never)) as { ok?: boolean; sessionId?: string; modelId?: string; effort?: string }
    check(`the seat is born on the OpenAI row (${SEAT_MODEL}) at ${SEAT_EFFORT}`, a.ok === true && a.modelId === SEAT_MODEL && a.effort === SEAT_EFFORT, JSON.stringify(a))
    seatId = a.sessionId ?? ''
    const transcript = join(paths.getProjectDir(cwd), `${seatId}.jsonl`)
    check('the seat transcript is born', await untilAsync(() => existsSync(transcript) && statSync(transcript).size > 100, 30_000))
  },
  extraEnv: {
    ...fixture.env,
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_TABULA_DIR: tabulaDir,
    MERCURY_CACHE_CLOCK: '0',
  },
})
try {
  const offsets: number[] = []
  for (let ms = 6000; ms <= 42000; ms += 500) offsets.push(S(ms))
  const grabs = grabScreens(run, 120, 40, offsets)
  const frames = grabs.map(g => ({ atMs: g.atMs, text: g.rows.map(r => r.replace(/\s+$/, '')).join('\n') }))
  const distinct = frames.filter((f, i) => i === 0 || f.text !== frames[i - 1]!.text)
  const KEEP_DIR = process.env.SURFACE_TRUTH_CAPTURE_DIR
  if (KEEP_DIR) {
    mkdirSync(KEEP_DIR, { recursive: true })
    for (const f of distinct) writeFileSync(join(KEEP_DIR, `at${String(f.atMs).padStart(6, '0')}.txt`), f.text + '\n')
  }
  if (process.env.SURFACE_TRUTH_KEEP === '1') {
    for (const f of distinct) {
      console.log(`\n═══ frame @${f.atMs}`)
      for (const r of f.text.split('\n')) if (r.trim()) console.log(r)
    }
  }
  const rowsWith = (text: string, needle: string): string[] => text.split('\n').filter(r => r.includes(needle))
  const allRows = (needle: string): string[] => distinct.flatMap(f => rowsWith(f.text, needle))

  const entered = frames.some(f => f.text.includes('gpt-live body') || f.text.includes('gpt-landed body') || f.text.includes('seat-task-gpt'))
  check('the seat was entered from the board (its own body on screen)', entered, `frames: ${frames.length}`)

  check(`the seat's runner honoured ${SEAT_EFFORT} (no live-catalogue downgrade note)`, !frames.some(f => f.text.includes(`is not in ${SEAT_MODEL}`) && f.text.includes("using 'high'")))

  const modelRows = allRows('/model').filter(r => /Choose the AI model|Set the model/.test(r))
  const modelRow = modelRows[modelRows.length - 1] ?? ''
  check('P1 the palette painted a /model row', modelRows.length > 0)
  check('P1 the /model description is the static label (no "(currently …)" clause)', modelRows.length > 0 && modelRows.every(r => r.includes('Choose the AI model') && !r.includes('currently')), modelRow)
  check(`P1 the /model value column names the SESSION's model (${SEAT_MODEL_LABEL})`, modelRows.length > 0 && modelRows.every(r => r.includes(SEAT_MODEL_LABEL)), modelRow)
  check(`P1 the /model row never names the screen's own setting (${SCREEN_MODEL_LABEL})`, modelRows.length > 0 && modelRows.every(r => !r.includes('Fable 5')), modelRow)

  const effortRows = allRows('/effort').filter(r => /reasoning effort/.test(r))
  const effortRow = effortRows[effortRows.length - 1] ?? ''
  check('P2 the palette painted an /effort row', effortRows.length > 0)
  check(`P2 the /effort value column is the SESSION's effort word (${SEAT_EFFORT})`, effortRows.length > 0 && effortRows.every(r => new RegExp(`\\b${SEAT_EFFORT}\\b`).test(r)), effortRow)
  const stripRows = allRows(`${SEAT_MODEL_LABEL} ·`).filter(r => r.includes('▚▛▀▜▞'))
  check(`P2 the strip's effort chip is the SESSION's word (${SEAT_MODEL_LABEL} · … ${SEAT_EFFORT})`, stripRows.length > 0 && stripRows.every(r => new RegExp(`\\b${SEAT_EFFORT}\\b`).test(r)), stripRows[0] ?? '')

  const statusFrames = distinct.filter(f => f.text.includes('Mercury — status'))
  check('P3 the status dashboard painted', statusFrames.length > 0)
  const sessionRows = statusFrames.flatMap(f => f.text.split('\n').filter(r => /│\s+Session\s{2,}/.test(r)))
  check(`P3 the dashboard's Session row names the focused seat (${SEAT_TITLE}), never the screen's own session`, sessionRows.length > 0 && sessionRows.every(r => r.includes(SEAT_TITLE) && !r.includes('unnamed')), sessionRows.join(' | ').slice(0, 300))
  const idRows = statusFrames.flatMap(f => f.text.split('\n').filter(r => r.includes('Session ID')))
  check(`P3 the dashboard's Session ID row is the seat's own id (${seatId.slice(0, 8)}…)`, idRows.length > 0 && idRows.every(r => r.includes(seatId.slice(0, 8))), idRows.join(' | ').slice(0, 300))
  const statusModelRows = statusFrames.flatMap(f => f.text.split('\n').filter(r => (r.includes(SEAT_MODEL_LABEL) || r.includes('Fable 5')) && !r.includes('▚▛▀▜▞')))
  check(`P3 /status names the session's model (${SEAT_MODEL_LABEL}), never the screen's`, statusModelRows.some(r => r.includes(SEAT_MODEL_LABEL)) && !statusModelRows.some(r => r.includes('Fable 5')), statusModelRows.join(' | ').slice(0, 300))

  const currentRows = allRows('● current')
  check('P4 the picker painted (a current dot)', currentRows.length > 0)
  check(`P4 the picker's current dot is the session's model (${SEAT_MODEL_LABEL})`, currentRows.length > 0 && currentRows.every(r => r.includes(SEAT_MODEL_LABEL)), currentRows.join(' | ').slice(0, 300))
  const keptRows = allRows('Kept model as')
  check(`P4 closing the picker keeps the SESSION's model ("Kept model as ${SEAT_MODEL_LABEL}"), never the screen's`, keptRows.length > 0 && keptRows.every(r => r.includes(`Kept model as ${SEAT_MODEL_LABEL}`)), keptRows.join(' | ').slice(0, 300))

  check(`P6 the picker's current row spells the page's name (${SEAT_MODEL_LABEL}), never the wire's (${SEAT_MODEL_WIRE_NAME})`, currentRows.length > 0 && currentRows.every(r => r.includes(SEAT_MODEL_LABEL) && !r.includes(SEAT_MODEL_WIRE_NAME)), currentRows.join(' | ').slice(0, 300))
  const wireRows = distinct.flatMap(f => rowsWith(f.text, SEAT_MODEL_WIRE_NAME))
  check(`P6 no surface spells the row the wire's way (${SEAT_MODEL_WIRE_NAME}) — one owner, one spelling`, wireRows.length === 0, wireRows.slice(0, 3).join(' | ').slice(0, 300))
  check(`P6 the strip spells the same row the same way (${SEAT_MODEL_LABEL} ·)`, stripRows.length > 0 && stripRows.every(r => r.includes(`${SEAT_MODEL_LABEL} ·`)), stripRows[0] ?? '')
} finally {
  if (process.env.SURFACE_TRUTH_KEEP === '1') console.log(`[keep] arena home ${run.paths.home} cwd ${run.paths.cwd}`)
  else run.cleanup()
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon?.kill('SIGTERM')
  await fixture.close()
  if (process.env.SURFACE_TRUTH_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-surface-truth-drive: ALL LAWS HOLD' : `\nprove-surface-truth-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
