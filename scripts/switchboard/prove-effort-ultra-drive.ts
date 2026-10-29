#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'effort-ultra-drive-'))
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work-effort')
for (const d of [daemonDir, work]) mkdirSync(d, { recursive: true })
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

const SEAT_MODEL = 'gpt-6-astra'
const SEAT_MODEL_LABEL = 'GPT-6 Astra'
const SEAT_EFFORT = 'high'
const LISTED = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const LIST_WORD = 'ultra'
const TOP = 'max'
const SEAT_TITLE = 'Effort Ultra'
const [COLS, ROWS] = (process.env.EFFORT_ULTRA_SIZE ?? '120x40').split('x').map(Number) as [number, number]
const TURN = 'hello effort ultra'

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const projections = await import('../../src/services/engine-connector/seatProjections.ts')

const fixture = await startCrossfamilyFixture({
  port: Number(process.env.EFFORT_ULTRA_PORT ?? '0'),
  gptId: SEAT_MODEL,
  gptReasoningLevels: LISTED,
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
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const run = await runArtifactArena({
  turns: [],
  sends: [
    `after:${SEAT_TITLE}:2500:\t`,
    `after:${SEAT_TITLE}:4000:\r`,
    `after:${SEAT_TITLE}:5200:\r`,
    `after:${SEAT_TITLE}:9000:/effort`,
    `after:${SEAT_TITLE}:10500:\r`,
    `after:${SEAT_TITLE}:14500:\x1b`,
    `after:${SEAT_TITLE}:16500:/effort ${LIST_WORD}`,
    `after:${SEAT_TITLE}:18000:\r`,
    `after:${SEAT_TITLE}:20500:/effort ${TOP}`,
    `after:${SEAT_TITLE}:22000:\r`,
    `after:${SEAT_TITLE}:25500:${TURN}`,
    `after:${SEAT_TITLE}:27000:\r`,
    `after:${SEAT_TITLE}:34500:/effort current`,
    `after:${SEAT_TITLE}:36000:\r`,
  ],
  seconds: 44,
  cols: COLS,
  rows: ROWS,
  keep: true,
  seedHome: async (configDir, cwd) => {
    seedFirstRun(configDir, [cwd, work])
    spawnDaemon(configDir)
    check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' } as never)).ok === true, 60_000))
    const a = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'effort-ultra',
      prompt: 'seat-task-gpt: work on the gpt engine',
      workspaceDir: cwd,
      title: SEAT_TITLE,
      modelKey: SEAT_MODEL,
      effort: SEAT_EFFORT,
    } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string; modelId?: string; effort?: string }
    check(`the seat is born on the OpenAI row (${SEAT_MODEL}) at ${SEAT_EFFORT}`, a.ok === true && a.modelId === SEAT_MODEL && a.effort === SEAT_EFFORT, JSON.stringify(a))
    seatId = a.sessionId ?? ''
    transcript = join(paths.getProjectDir(cwd), `${seatId}.jsonl`)
    check('the seat transcript is born', await untilAsync(() => existsSync(transcript) && statSync(transcript).size > 100, 30_000))
  },
  extraEnv: {
    ...fixture.env,
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CACHE_CLOCK: '0',
  },
})
try {
  const offsets: number[] = []
  for (let ms = 6000; ms <= 42000; ms += 500) offsets.push(S(ms))
  const grabs = grabScreens(run, COLS, ROWS, offsets)
  const frames = grabs.map(g => ({ atMs: g.atMs, text: g.rows.map(r => r.replace(/\s+$/, '')).join('\n') }))
  const distinct = frames.filter((f, i) => i === 0 || f.text !== frames[i - 1]!.text)
  const KEEP_DIR = process.env.EFFORT_ULTRA_CAPTURE_DIR
  if (KEEP_DIR) {
    mkdirSync(KEEP_DIR, { recursive: true })
    for (const f of distinct) writeFileSync(join(KEEP_DIR, `at${String(f.atMs).padStart(6, '0')}.txt`), f.text + '\n')
  }
  if (process.env.EFFORT_ULTRA_KEEP === '1') {
    for (const f of distinct) {
      console.log(`\n═══ frame @${f.atMs}`)
      for (const r of f.text.split('\n')) if (r.trim()) console.log(r)
    }
  }
  const rowsWith = (text: string, needle: string): string[] => text.split('\n').filter(r => r.includes(needle))
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const anyFrame = (needle: string): boolean => distinct.some(f => flat(f.text).includes(needle))

  const entered = frames.some(f => f.text.includes('gpt-live body') || f.text.includes('gpt-landed body') || f.text.includes('seat-task-gpt'))
  check('the seat was entered from the board (its own body on screen)', entered, `frames: ${frames.length}`)

  const popupFrames = distinct.filter(f => f.text.includes('effort low…max') && f.text.includes('↑↓ move') && f.text.includes('esc or click outside closes'))
  check('U1 the bare /effort opened its popup with the served ladder and exit hint', popupFrames.length > 0, 'distinct frames: ' + distinct.length)
  const tierRows = (frame: { text: string }): string[] => frame.text.split('\n').flatMap(row => { const match = /│\s*[❯ ]?\s*(low|medium|high|xhigh|max)\s{2,}/.exec(row); return match ? [match[1]!] : [] })
  check('U1 the popup reads the five ladder words in order', popupFrames.some(frame => JSON.stringify(tierRows(frame)) === JSON.stringify(LADDER)), JSON.stringify(popupFrames.map(tierRows)))
  check('U1 the list word above max paints nowhere in the popup', popupFrames.every(frame => !new RegExp('\\b' + LIST_WORD + '\\b').test(frame.text)))
  check('U1 the popup carries auto beside five tiers and ends at max', popupFrames.some(frame => /│\s*auto\s{2,}/.test(frame.text) && tierRows(frame).length === 5 && tierRows(frame).at(-1) === TOP), JSON.stringify(popupFrames.map(tierRows)))
  check('U1 esc closed the slider with the running word (the seat runs the admission word, high)', anyFrame(`Effort unchanged (${SEAT_EFFORT})`), distinct.map(f => flat(f.text)).filter(t => t.includes('Effort unchanged')).map(t => t.slice(t.indexOf('Effort unchanged'), t.indexOf('Effort unchanged') + 60)).join(' | ').slice(0, 200))

  check(`U2 "/effort ${LIST_WORD}" is refused as not an effort option (the ladder leads, the refused word follows)`, anyFrame(`|max|auto — "${LIST_WORD}`), distinct.map(f => flat(f.text)).filter(t => t.includes('not an effort option')).map(t => t.slice(t.indexOf('"'), t.indexOf('"') + 120)).join(' | ').slice(0, 400))
  check('U2 the refusal names the ladder up to max and no further', anyFrame(`Valid options: ${LADDER.join('|')}|auto`), distinct.map(f => flat(f.text)).filter(t => t.includes('Valid options')).map(t => t.slice(t.indexOf('Valid options'), t.indexOf('Valid options') + 80)).join(' | ').slice(0, 300))
  check(`U2 no frame ever says the seat was set to the list's word`, !anyFrame(`Effort set to ${LIST_WORD}`))

  const statusRows = (text: string): string[] => text.split('\n').filter(r => /(?:⇧|shift\+)← back/.test(r)).map(r => r.replace(/\s+/g, ' ').trim())
  const receiptText = (text: string): string => {
    const rows = text.split('\n')
    const at = rows.findIndex(r => r.includes(`Effort set to ${TOP}`))
    if (at < 0) return ''
    const start = rows[at]!.indexOf('Effort set to')
    const end = rows[at]!.indexOf('│', start)
    const span = (r: string | undefined): string => (r ?? '').slice(start, end < 0 ? undefined : end).trim()
    return `${span(rows[at])} ${span(rows[at + 1])}`.replace(/\s+/g, ' ').trim()
  }
  const receiptFrames = distinct.filter(f => f.text.includes(`Effort set to ${TOP}`))
  check(`U3 the /effort ${TOP} receipt is the seat's, whole, in the chat under the echoed command ("Effort set to ${TOP} for this session — its next request runs it. Saved as your default for future sessions.") — at 120 columns the status row would cut it, so no status row carries it`, receiptFrames.length > 0 && receiptFrames.some(f => receiptText(f.text).includes(`Effort set to ${TOP} for this session — its next request runs it. Saved as your default for future sessions.`)) && distinct.every(f => !statusRows(f.text).some(r => r.includes('Effort set to'))), receiptFrames.map(f => receiptText(f.text)).slice(0, 2).join(' | ').slice(0, 400))
  const seatHits = fixture.captured.filter(h => h.lane === 'openai-seat')
  const lastHit = seatHits[seatHits.length - 1]
  const lastEffort = (lastHit?.body as { reasoning?: { effort?: string } } | undefined)?.reasoning?.effort
  check(`U3 the turn's request rode the Responses wire with reasoning.effort ${TOP}`, seatHits.length >= 2 && lastEffort === TOP, `hits=${seatHits.length} last=${String(lastEffort)}`)
  check(`U3 no request ever carried the list's word (${LIST_WORD}) on the wire`, seatHits.every(h => (h.body as { reasoning?: { effort?: string } } | undefined)?.reasoning?.effort !== LIST_WORD), seatHits.map(h => String((h.body as { reasoning?: { effort?: string } } | undefined)?.reasoning?.effort)).join(','))
  const turnAnswered = anyFrame('gpt-done body') || anyFrame('gpt-landed body')
  check('U3 the turn landed (the seat answered)', turnAnswered)
  const rows = existsSync(transcript) ? readFileSync(transcript, 'utf8').split('\n').filter(l => l.trim() !== '') : []
  check('U3 no downgrade receipt anywhere — the word was served as asked', !rows.some(l => l.includes('is not served on')) && !rows.some(l => l.includes('the wire refused it')) && !anyFrame('is not served on'))
  const facts = projections.readSessionFacts(seatId)
  check(`U3 the record carries the one word twice — effort ${TOP} (asked), effortSent ${TOP} (sent)`, facts !== null && facts.effort === TOP && facts.effortSent === TOP, JSON.stringify({ effort: facts?.effort, effortSent: facts?.effortSent }))

  const lateRows = distinct.filter(f => f.atMs >= S(30000)).flatMap(f => statusRows(f.text))
  const CHIP = new RegExp(`(?:^|· )${SEAT_MODEL_LABEL} · ${TOP}(?: ·| )`)
  check(`U4 after the turn the status row paints ${TOP} beside the model in every state (${SEAT_MODEL_LABEL} · ${TOP})`, lateRows.length > 0 && lateRows.every(r => CHIP.test(r)), lateRows.slice(-2).join(' | ').slice(0, 300))
  check(`U4 "/effort current" names the word ("Effort is ${TOP}")`, anyFrame(`Effort is ${TOP} —`), distinct.map(f => flat(f.text)).filter(t => t.includes('Effort is')).map(t => t.slice(t.indexOf('Effort is'), t.indexOf('Effort is') + 120)).join(' | ').slice(0, 400))
  check('U4 the readout never says the seat runs another word', !anyFrame(`(it runs`) && !anyFrame('runs its provider default'), rowsWith(distinct.map(f => f.text).join('\n'), 'it runs').join(' | ').slice(0, 200))
} finally {
  if (process.env.EFFORT_ULTRA_KEEP === '1') console.log(`[keep] arena home ${run.paths.home} cwd ${run.paths.cwd}`)
  else run.cleanup()
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon?.kill('SIGTERM')
  await fixture.close()
  if (process.env.EFFORT_ULTRA_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-effort-ultra-drive: ALL LAWS HOLD' : `\nprove-effort-ultra-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
