#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { ALL_MODEL_CONFIGS, newestGenerationKey } from '../../src/utils/model/configs.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const DEFAULT_OPUS = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'bb-journey-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const COLS = Number(process.env.SWITCH_COLS ?? '120')
const ROWS = Number(process.env.SWITCH_ROWS ?? '40')

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

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const B_SAID = 'stream the b chain'
const SEAT_SAID = 'seat body please'
const seatDeltas = Array.from({ length: 48 }, (_, i) => `seat-${String(i + 1).padStart(2, '0')} body. `)
const api = await startFixtureApi([
  { kind: 'paced_tool_use', whenModel: 'opus', whenBody: B_SAID, preDeltas: ['b-stage-01 body. '], gapMs: S(300), tools: [{ name: 'Bash', input: { command: `sleep ${Math.round(S(16_000) / 1000)}; echo one`, description: 'pause one' } }] },
  { kind: 'paced', whenModel: 'opus', whenBody: SEAT_SAID, deltas: seatDeltas, gapMs: S(600), settleDelayMs: S(2500) },
  { kind: 'paced_tool_use', whenModel: 'opus', whenBody: B_SAID, preDeltas: ['b-stage-02 body. '], gapMs: S(300), tools: [{ name: 'Bash', input: { command: `sleep ${Math.round(S(16_000) / 1000)}; echo two`, description: 'pause two' } }] },
  { kind: 'paced', whenModel: 'opus', whenBody: B_SAID, deltas: ['b-stage-03 body. ', 'b-stage-04 body. '], gapMs: S(400), settleDelayMs: S(1500) },
  { kind: 'text', whenModel: 'opus', text: 'Spare.' },
  { kind: 'text', whenModel: 'opus', text: 'Spare.' },
  { kind: 'text', whenModel: 'opus', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemonWithHome = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', logFd, logFd],
  })
}

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const untilAsync = async (pred: () => Promise<boolean>, ms: number): Promise<boolean> => {
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
const sup = await import('../../src/daemon/concourseWorkers.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
let boardSid = ''
let boardLog = ''
try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const N = 'Busy probe'
  const BOARD = 'SESSIONS'
  const PICKER = 'where new sessions launch'
  const CARD = 'Start with a contract?'
  const COMPOSER = 'Type a prompt'
  const ARMED = 'again enters'
  const OTHER = `${basename(work)} ⌄`
  const DOOR = '1 running in'
  const DOOR_ROW = `▸ ⇄ ${DOOR}`
  const BOARD_ROW = `▸ ◐ ${N}`
  const SEAT_ROW = `▸ ◐ ${SEAT_SAID}`
  const SHIFT_LEFT = '\x1b[1;2D'
  const UP = '\x1b[A'
  const DOWN = '\x1b[B'
  const CTRL_G = '\x07'
  const ESC = '\x1b'
  type Step = { awaitText: string | string[]; awaitAbsent?: string | string[]; arrivedText?: string; afterPrevMs?: number; settleMs?: number; text: string }
  const step = (awaitText: string | string[], text: string, extra: Omit<Partial<Step>, 'awaitText' | 'text'> = {}): Step => ({ awaitText, settleMs: 200, text, ...extra })
  const toBoardSession: Step[] = [
    step([BOARD, OTHER, DOOR], DOWN, { awaitAbsent: ARMED, arrivedText: DOOR_ROW }),
    step([OTHER, DOOR_ROW], '\r', { awaitAbsent: ARMED }),
    step([BOARD, N], UP, { awaitAbsent: [OTHER, ARMED], arrivedText: BOARD_ROW }),
    step(BOARD_ROW, '\r', { awaitAbsent: [OTHER, ARMED] }),
    step(ARMED, '\r'),
  ]
  const toSeatSession: Step[] = [
    step([BOARD, N, DOOR], DOWN, { awaitAbsent: [OTHER, ARMED], arrivedText: DOOR_ROW }),
    step(DOOR_ROW, '\r', { awaitAbsent: [OTHER, ARMED] }),
    step([BOARD, OTHER, SEAT_SAID], DOWN, { awaitAbsent: ARMED, arrivedText: SEAT_ROW }),
    step([OTHER, SEAT_ROW], '\r', { awaitAbsent: ARMED }),
    step(ARMED, '\r'),
  ]
  const leaveBoardSession = step('b-stage-', SHIFT_LEFT, { awaitAbsent: BOARD, afterPrevMs: 3000 })
  const leaveSeatSession = step('seat-', SHIFT_LEFT, { awaitAbsent: BOARD, afterPrevMs: 3000 })
  const WALK: Step[] = [
    step([BOARD, N], CTRL_G, { awaitAbsent: [OTHER, PICKER] }),
    step(PICKER, DOWN),
    step(PICKER, '\r', { afterPrevMs: 300 }),
    step([BOARD, OTHER], 'n', { awaitAbsent: PICKER }),
    step(CARD, ESC),
    step(COMPOSER, SEAT_SAID, { awaitAbsent: [BOARD, CARD] }),
    step(SEAT_SAID, '\r', { awaitAbsent: BOARD }),
    step('seat-03 body', SHIFT_LEFT, { awaitAbsent: BOARD }),
    ...toBoardSession,
    leaveBoardSession,
    ...toSeatSession,
    leaveSeatSession,
    ...toBoardSession,
    leaveBoardSession,
    ...toSeatSession,
    leaveSeatSession,
    ...toBoardSession,
  ]
  const run = await runArtifactArena({
    turns: [],
    sends: WALK,
    seconds: 42,
    cols: COLS,
    rows: ROWS,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work])
      const configFile = join(configDir, '.config.json')
      const config = JSON.parse(readFileSync(configFile, 'utf8')) as { projects: Record<string, unknown> }
      config.projects[work] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
      writeFileSync(configFile, JSON.stringify(config))
      const { execFileSync } = await import('node:child_process')
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
      execFileSync('git', ['-c', 'user.email=drive@fixture', '-c', 'user.name=drive', 'commit', '-q', '--allow-empty', '-m', 'ground'], { cwd })
      spawnDaemonWithHome(configDir)
      const oldChat = '00000000-dddd-4000-8000-000000000001'
      const oldRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
        isSidechain: false,
        entrypoint: 'cli',
        cwd: work,
        sessionId: oldChat,
        version: '1.0.0-beta.1',
        gitBranch: 'main',
        parentUuid: null,
        uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
        timestamp: new Date().toISOString(),
        ...extra,
      })
      const oldFile = join(paths.getProjectDir(work), `${oldChat}.jsonl`)
      mkdirSync(paths.getProjectDir(work), { recursive: true })
      writeFileSync(
        oldFile,
        encodeSeedTranscript(
          [
            oldRow({ type: 'user', message: { role: 'user', content: 'an old chat in the other project' } }),
            oldRow({ type: 'assistant', message: { id: 'msg_old', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
          ] as never,
          oldChat,
        ),
      )
      const hourAgo = new Date(Date.now() - 60 * 60_000)
      utimesSync(oldFile, hourAgo, hourAgo)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const b = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'seat-busy-b',
        prompt: B_SAID,
        workspaceDir: cwd,
        title: N,
        modelKey: DEFAULT_OPUS,
        effort: 'xhigh',
      } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string }
      check('the board session dispatched', b.ok === true && b.sessionId !== undefined, JSON.stringify(b))
      boardSid = b.sessionId ?? ''
      boardLog = join(paths.getProjectDir(cwd), `${boardSid}.jsonl`)
      check(
        'the board session is mid-thought (its first stage on disk, its tool unresolved)',
        await untilAsync(async () => existsSync(boardLog) && readFileSync(boardLog, 'utf8').includes('b-stage-01 body'), 30_000),
      )
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  try {
    const offsets = Array.from({ length: 37 }, (_, i) => S(3000 + i * 1000))
    const grabs = grabScreens(run, COLS, ROWS, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    const seatMax = (s: string): number => Math.max(-1, ...[...s.matchAll(/seat-(\d\d) body/g)].map(m => Number(m[1])))
    const stageMax = (s: string): number => Math.max(-1, ...[...s.matchAll(/b-stage-(\d\d) body/g)].map(m => Number(m[1])))
    const kind = (g: { rows: string[] }): 'board' | 'seat' | 'hopped' | 'other' => {
      const s = text(g)
      if (s.includes('SESSIONS')) return 'board'
      if (stageMax(s) >= 0 || s.includes(B_SAID)) return 'hopped'
      if (seatMax(s) >= 0) return 'seat'
      return 'other'
    }
    const lane = grabs.map(g => ({ atMs: g.atMs, kind: kind(g), seat: seatMax(text(g)), stage: stageMax(text(g)) }))
    const laneStr = lane.map(l => `${l.atMs / 1000}s:${l.kind}${l.kind === 'seat' ? `#${l.seat}` : l.kind === 'hopped' ? `@${l.stage}` : ''}`).join(' ')
    if (process.env.SWITCH_KEEP === '1') {
      for (const sent of run.sendLog) {
        console.log(`\n═══ step ${sent.step ?? '-'} sent at ${sent.atMs}ms on ${JSON.stringify(sent.awaitText ?? '')}`)
        for (const r of sent.screen ?? []) if (r.trim()) console.log(r.slice(0, COLS - 2))
      }
      for (const g of grabs) {
        console.log(`\n═══ frame @${g.atMs} [${kind(g)}]`)
        for (const r of g.rows) if (r.trim()) console.log(r.slice(0, COLS - 2))
      }
    }
    const walked = run.sendLog.filter(sent => sent.step !== undefined).length
    check(`every key of the journey found its screen (${WALK.length} sends, each on the words it waits for)`, run.outcome.complete && walked === WALK.length, run.outcome.report?.unfired.join(' · ') || run.outcome.reason || `${walked} of ${WALK.length} sent`)
    const stretches: Array<{ kind: 'seat' | 'hopped'; first: number; last: number; seat: number; stage: number }> = []
    let boardSince = -1
    for (const l of lane) {
      if (l.kind === 'board') {
        boardSince = l.atMs
        continue
      }
      if (l.kind !== 'seat' && l.kind !== 'hopped') continue
      const top = stretches[stretches.length - 1]
      if (top !== undefined && top.kind === l.kind && boardSince < top.last) {
        top.last = l.atMs
        top.seat = Math.max(top.seat, l.seat)
        top.stage = Math.max(top.stage, l.stage)
      } else {
        stretches.push({ kind: l.kind, first: l.atMs, last: l.atMs, seat: l.seat, stage: l.stage })
      }
    }
    const kinds = stretches.map(s => s.kind)
    const seatVisits = kinds.filter(k => k === 'seat').length
    const hoppedVisits = kinds.filter(k => k === 'hopped').length
    check(`L1 every enter takes — entered views of both kinds, board between them [${COLS}x${ROWS}]`, seatVisits >= 2 && hoppedVisits >= 2, laneStr)
    check('L1 …five enters in the drive land five entered stretches', stretches.length >= 5, `stretches=${kinds.join(',')}`)
    const seatStretches = stretches.filter(s => s.kind === 'seat')
    check('L2 the session started with n in the other project keeps working while another session is focused (a later visit shows later tokens)', seatStretches.length >= 2 && seatStretches[seatStretches.length - 1]!.seat > seatStretches[0]!.seat, `seat tokens per visit: ${seatStretches.map(s => s.seat).join(',')}`)
    const hoppedStretches = stretches.filter(s => s.kind === 'hopped')
    check('L3 the board session keeps working while off screen (a later visit shows later stages)', hoppedStretches.length >= 2 && hoppedStretches[hoppedStretches.length - 1]!.stage > hoppedStretches[0]!.stage, `stages per visit: ${hoppedStretches.map(s => s.stage).join(',')}`)
    const lastSeatToken = Math.max(...lane.map(l => l.seat))
    const firstHopAt = hoppedStretches[0]?.first ?? -1
    const seatBeforeFirstHop = Math.max(-1, ...lane.filter(l => l.atMs < firstHopAt).map(l => l.seat))
    const seatAtFirstHop = seatBeforeFirstHop >= 0 ? seatBeforeFirstHop : (seatStretches[0]?.seat ?? -1)
    check('both were mid-turn during the hops (the session started with n had more to say when the first hop landed; it said it later)', firstHopAt > 0 && seatAtFirstHop >= 0 && seatAtFirstHop < seatDeltas.length && lastSeatToken > seatAtFirstHop, `its token at first hop: ${seatAtFirstHop}, last seen: ${lastSeatToken}`)
    const said = (needle: string): number[] => grabs.filter(g => text(g).includes(needle)).map(g => g.atMs)
    for (const needle of ['did not commit', 'may be mid-turn', 'esc there', 'settling —', 'finishing this thought', 'restoring the session', 'a run is in flight']) {
      check(`L4 no frame says "${needle}"`, said(needle).length === 0, said(needle).join(','))
    }
    const seatHome = paths.getProjectDir(work)
    const seatFiles = existsSync(seatHome) ? readdirSync(seatHome).filter(f => f.endsWith('.jsonl') && !f.endsWith('.receipts.jsonl')).map(f => join(seatHome, f)) : []
    const seatFile = seatFiles.find(f => /seat-\d\d body/.test(readFileSync(f, 'utf8')))
    const seatText = seatFile !== undefined ? readFileSync(seatFile, 'utf8') : ''
    check("L5 the session started with n wrote its own transcript where the other project's records lie", seatFile !== undefined, `${seatHome}: ${seatFiles.length} file(s)`)
    check('L5 the seat\'s file carries its LAST token (every record produced while another session was focused was logged)', seatText.includes(`seat-${String(seatDeltas.length).padStart(2, '0')} body`), `last token present: ${seatText.includes('seat-48 body')}`)
    check("L5 the n-started session's file carries none of the board session's words", !seatText.includes('b-stage-'))
    const boardText = existsSync(boardLog) ? readFileSync(boardLog, 'utf8') : ''
    check("L5 the board session's file carries none of the n-started session's words", boardText.length > 0 && !/seat-\d\d body/.test(boardText) && !boardText.includes(SEAT_SAID))
    check("L5 the board session's file carries no foreign session id", !boardText.split('\n').some(l => l.includes('"sessionId"') && !l.includes(boardSid)))
    const rec = Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === boardSid)
    check('L6 the record was never attached or valve-closed (nothing yielded)', rec !== undefined && rec.attachedAt === undefined && rec.attachRequestedAt === undefined, `attachedAt=${rec?.attachedAt} attachRequestedAt=${rec?.attachRequestedAt} pausedAt=${rec?.pausedAt}`)
    if (process.env.SWITCH_KEEP === '1') console.log(`[keep] arena home=${run.paths.home} cwd=${run.paths.cwd}`)
  } finally {
    if (process.env.SWITCH_KEEP !== '1') run.cleanup()
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon?.kill('SIGTERM')
  await api.close()
  if (process.env.SWITCH_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else removeScratch(SCRATCH)
}

console.log(failures === 0 ? `\nprove-seat-both-busy-journey (${COLS}x${ROWS}): ALL LAWS HOLD` : `\nprove-seat-both-busy-journey (${COLS}x${ROWS}): ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
