#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'effort-seat-drive-'))
const daemonDir = join(SCRATCH, 'daemon')
const tabulaDir = join(SCRATCH, 'tabula')
const work = join(SCRATCH, 'work-effort')
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

const SEAT_MODEL = 'gpt-5.5'
const SEAT_MODEL_LABEL = 'GPT-5.5'
const LADDER = ['low', 'medium', 'high', 'xhigh'] as const
const SERVED = 'xhigh'
const ASKED = 'max'
const SEAT_EFFORT = ASKED
const SEAT_TITLE = 'Effort Seat'
const TURN = 'hello effort seat'

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const projections = await import('../../src/services/engine-connector/seatProjections.ts')

const fixture = await startCrossfamilyFixture({
  port: Number(process.env.EFFORT_SEAT_PORT ?? '0'),
  gptReasoningLevels: LADDER,
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

let seatId = ''
let transcript = ''
let bornSent = 'unread'
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const run = await runArtifactArena({
  turns: [],
  sends: [
    `after:${SEAT_TITLE}:2500:\t`,
    `after:${SEAT_TITLE}:4000:\r`,
    `after:${SEAT_TITLE}:5200:\r`,
    `after:${SEAT_TITLE}:9000:/effort ${SERVED}`,
    `after:${SEAT_TITLE}:10500:\r`,
    `after:${SEAT_TITLE}:14500:/effort ${ASKED}`,
    `after:${SEAT_TITLE}:16000:\r`,
    `after:${SEAT_TITLE}:20000:${TURN}`,
    `after:${SEAT_TITLE}:21500:\r`,
    `after:${SEAT_TITLE}:29000:/effort current`,
    `after:${SEAT_TITLE}:30500:\r`,
  ],
  seconds: 38,
  cols: 120,
  rows: 40,
  keep: true,
  seedHome: async (configDir, cwd) => {
    seedFirstRun(configDir, [cwd, work])
    spawnDaemon(configDir)
    check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' } as never)).ok === true, 60_000))
    const a = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'effort-seat',
      prompt: 'seat-task-gpt: work on the gpt engine',
      workspaceDir: cwd,
      title: SEAT_TITLE,
      modelKey: SEAT_MODEL,
      effort: SEAT_EFFORT,
    } as never)) as { ok?: boolean; sessionId?: string; modelId?: string; effort?: string }
    check(`the seat is born on the OpenAI row (${SEAT_MODEL}) at ${SEAT_EFFORT}`, a.ok === true && a.modelId === SEAT_MODEL && a.effort === SEAT_EFFORT, JSON.stringify(a))
    seatId = a.sessionId ?? ''
    transcript = join(paths.getProjectDir(cwd), `${seatId}.jsonl`)
    check('the seat transcript is born', await untilAsync(() => existsSync(transcript) && statSync(transcript).size > 100, 30_000))
    await untilAsync(() => (projections.readSessionFacts(seatId)?.atMs ?? 0) > 0 && existsSync(transcript), 20_000)
    await new Promise(r => setTimeout(r, 2500))
    const born = projections.readSessionFacts(seatId)
    bornSent = born === null ? 'no-facts' : !('effortSent' in born) || born.effortSent === undefined ? 'absent' : born.effortSent === null ? 'null' : String(born.effortSent)
    console.log(`  the seat's facts at birth: effort=${String(born?.effort)} effortSent=${bornSent}`)
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
  for (let ms = 6000; ms <= 36000; ms += 500) offsets.push(S(ms))
  const grabs = grabScreens(run, 120, 40, offsets)
  const frames = grabs.map(g => ({ atMs: g.atMs, text: g.rows.map(r => r.replace(/\s+$/, '')).join('\n') }))
  const distinct = frames.filter((f, i) => i === 0 || f.text !== frames[i - 1]!.text)
  const KEEP_DIR = process.env.EFFORT_SEAT_CAPTURE_DIR
  if (KEEP_DIR) {
    mkdirSync(KEEP_DIR, { recursive: true })
    for (const f of distinct) writeFileSync(join(KEEP_DIR, `at${String(f.atMs).padStart(6, '0')}.txt`), f.text + '\n')
  }
  if (process.env.EFFORT_SEAT_KEEP === '1') {
    for (const f of distinct) {
      console.log(`\n═══ frame @${f.atMs}`)
      for (const r of f.text.split('\n')) if (r.trim()) console.log(r)
    }
  }
  const rowsWith = (text: string, needle: string): string[] => text.split('\n').filter(r => r.includes(needle))
  const allRows = (needle: string): string[] => distinct.flatMap(f => rowsWith(f.text, needle))
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const anyFrame = (needle: string): boolean => distinct.some(f => flat(f.text).includes(needle))

  const entered = frames.some(f => f.text.includes('gpt-live body') || f.text.includes('gpt-landed body') || f.text.includes('seat-task-gpt'))
  check('the seat was entered from the board (its own body on screen)', entered, `frames: ${frames.length}`)

  check(`W0 at birth the runner's sent word is the served word (${SERVED}) or unresolved (absent) — never null, never the asked word`, bornSent === SERVED || bornSent === 'absent', `effortSent at birth: ${bornSent}`)
  const windowStrip = frames.filter(f => f.atMs >= 6000 && f.atMs <= 8500).flatMap(f => rowsWith(f.text, `${SEAT_MODEL_LABEL} ·`).filter(r => r.includes('▚▛▀▜▞')))
  check(`W1 in the window the strip's chip paints the runner's word (${SERVED}) or "${ASKED} (asked)" — never the asked word bare, never "default"`, windowStrip.length > 0 && windowStrip.every(r => new RegExp(`\\b${SERVED}\\b`).test(r) || r.includes(`${ASKED} (asked)`)) && !windowStrip.some(r => /\bdefault\b/.test(r) || /◉ max(?! \(asked\))/.test(r)), windowStrip.slice(0, 3).join(' | ').slice(0, 300))

  check(`E1 the /effort ${SERVED} receipt is the seat's ("Effort set to ${SERVED} for this session — its next request runs it")`, anyFrame(`Effort set to ${SERVED} for this session`), distinct.map(f => flat(f.text)).filter(t => t.includes('Effort')).map(t => t.slice(0, 200)).join(' | ').slice(0, 600))
  check(`E1 the screen never claims the old road's sentence ("Effort set to ${SERVED} — saved as your default")`, !anyFrame(`Effort set to ${SERVED} — saved`))

  check(`E2 the /effort ${ASKED} receipt is the seat's (applied)`, anyFrame(`Effort set to ${ASKED} for this session`))
  const seatHits = fixture.captured.filter(h => h.lane === 'openai-seat')
  const lastHit = seatHits[seatHits.length - 1]
  const lastEffort = (lastHit?.body as { reasoning?: { effort?: string } } | undefined)?.reasoning?.effort
  check(`E2 the turn's request rode the Responses wire with reasoning.effort ${SERVED} (the nearest served word for ${ASKED})`, seatHits.length >= 2 && lastEffort === SERVED, `hits=${seatHits.length} last=${String(lastEffort)}`)
  const turnAnswered = anyFrame('gpt-done body') || anyFrame('gpt-landed body')
  check('E2 the turn landed (the seat answered)', turnAnswered)
  const receiptLine = `effort ${ASKED} is not served on ${SEAT_MODEL_LABEL} today — sent ${SERVED}`
  const rows = existsSync(transcript) ? readFileSync(transcript, 'utf8').split('\n').filter(l => l.trim() !== '') : []
  check('E2 the transcript carries the typed receipt row (a notice row in the seat\'s own record)', rows.some(l => l.includes('"kind":"notice"') && l.includes(receiptLine)), rows.filter(l => l.includes('"kind":"notice"')).map(l => l.slice(0, 200)).join(' | ').slice(0, 500))
  check('E2 the receipt row painted on screen', anyFrame(receiptLine) || anyFrame(`is not served on ${SEAT_MODEL_LABEL} today`), distinct.map(f => flat(f.text)).filter(t => t.includes('not served')).map(t => t.slice(0, 200)).join(' | ').slice(0, 400))
  check("E2 no note is folded into the reply text (the old road's sentence is gone)", !rows.some(l => l.includes('live effort catalogue')) && !anyFrame('live effort catalogue'))
  const facts = projections.readSessionFacts(seatId)
  check(`E2 the record keeps BOTH words — effort ${ASKED} (asked), effortSent ${SERVED} (sent)`, facts !== null && facts.effort === ASKED && facts.effortSent === SERVED, JSON.stringify({ effort: facts?.effort, effortSent: facts?.effortSent }))
  const stripRows = allRows(`${SEAT_MODEL_LABEL} ·`).filter(r => r.includes('▚▛▀▜▞'))
  const lateStrip = distinct.filter(f => f.atMs >= 24000).flatMap(f => rowsWith(f.text, `${SEAT_MODEL_LABEL} ·`).filter(r => r.includes('▚▛▀▜▞')))
  check(`E2 after the turn the strip's chip paints the SENT word (${SERVED}), never the asked one`, lateStrip.length > 0 && lateStrip.every(r => new RegExp(`\\b${SERVED}\\b`).test(r) && !/\bmax\b/.test(r)), lateStrip.slice(-2).join(' | ').slice(0, 300))
  check(`E1 the chip took ${SERVED} once the seat verb applied it`, stripRows.some(r => new RegExp(`\\b${SERVED}\\b`).test(r)), stripRows.slice(0, 3).join(' | ').slice(0, 300))

  check(`E3 "/effort current" says the seat's word and the sent word ("Effort is ${ASKED} (it runs ${SERVED} on ${SEAT_MODEL})")`, anyFrame(`Effort is ${ASKED} (it runs ${SERVED} on ${SEAT_MODEL})`), distinct.map(f => flat(f.text)).filter(t => t.includes('Effort is')).map(t => t.slice(t.indexOf('Effort is'), t.indexOf('Effort is') + 160)).join(' | ').slice(0, 500))
} finally {
  if (process.env.EFFORT_SEAT_KEEP === '1') console.log(`[keep] arena home ${run.paths.home} cwd ${run.paths.cwd}`)
  else run.cleanup()
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon?.kill('SIGTERM')
  await fixture.close()
  if (process.env.EFFORT_SEAT_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-effort-seat-drive: ALL LAWS HOLD' : `\nprove-effort-seat-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
