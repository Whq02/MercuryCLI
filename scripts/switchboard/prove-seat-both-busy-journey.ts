#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

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
const seatDeltas = Array.from({ length: 48 }, (_, i) => `seat-${String(i + 1).padStart(2, '0')} body. `)
const api = await startFixtureApi([
  { kind: 'paced_tool_use', whenModel: 'opus', preDeltas: ['b-stage-01 body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 16; echo one', description: 'pause one' } }] },
  { kind: 'paced', whenModel: 'opus', deltas: seatDeltas, gapMs: 600, settleDelayMs: 2500 },
  { kind: 'paced_tool_use', whenModel: 'opus', preDeltas: ['b-stage-02 body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 16; echo two', description: 'pause two' } }] },
  { kind: 'paced', whenModel: 'opus', deltas: ['b-stage-03 body. ', 'b-stage-04 body. '], gapMs: 400, settleDelayMs: 1500 },
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
const sup = await import('../../src/daemon/concourseSupervisor.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
let boardSid = ''
let boardLog = ''
try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const N = 'Busy probe'
  const run = await runArtifactArena({
    turns: [],
    sends: [
      `after:${N}:1500:seat body please`,
      `after:${N}:2600:\r`,
      'after:seat-01 body:1000:\t',
      'after:seat-01 body:1600:\r',
      'after:seat-01 body:2200:\r',
      'after:seat-01 body:5200:\x1b[1;2D',
      'after:seat-01 body:6200:\x1b[B',
      'after:seat-01 body:6800:\r',
      'after:seat-01 body:7400:\r',
      'after:seat-01 body:10400:\x1b[1;2D',
      'after:seat-01 body:11400:\x1b[A',
      'after:seat-01 body:12000:\r',
      'after:seat-01 body:12600:\r',
      'after:seat-01 body:15600:\x1b[1;2D',
      'after:seat-01 body:16600:\x1b[B',
      'after:seat-01 body:17200:\r',
      'after:seat-01 body:17800:\r',
      'after:seat-01 body:20800:\x1b[1;2D',
      'after:seat-01 body:21800:\x1b[A',
      'after:seat-01 body:22400:\r',
      'after:seat-01 body:23000:\r',
    ],
    seconds: 42,
    cols: COLS,
    rows: ROWS,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work])
      const { execFileSync } = await import('node:child_process')
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
      execFileSync('git', ['-c', 'user.email=drive@fixture', '-c', 'user.name=drive', 'commit', '-q', '--allow-empty', '-m', 'ground'], { cwd })
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const b = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'seat-busy-b',
        prompt: 'stream the b chain',
        workspaceDir: cwd,
        title: N,
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
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
    const kind = (g: { rows: string[] }): 'board' | 'boot' | 'hopped' | 'other' => {
      const s = text(g)
      if (s.includes('SESSION CONCOURSE')) return 'board'
      if (stageMax(s) >= 0 || s.includes('stream the b chain')) return 'hopped'
      if (seatMax(s) >= 0) return 'boot'
      return 'other'
    }
    const lane = grabs.map(g => ({ atMs: g.atMs, kind: kind(g), seat: seatMax(text(g)), stage: stageMax(text(g)) }))
    const laneStr = lane.map(l => `${l.atMs / 1000}s:${l.kind}${l.kind === 'boot' ? `#${l.seat}` : l.kind === 'hopped' ? `@${l.stage}` : ''}`).join(' ')
    if (process.env.SWITCH_KEEP === '1') {
      for (const g of grabs) {
        console.log(`\n═══ frame @${g.atMs} [${kind(g)}]`)
        for (const r of g.rows) if (r.trim()) console.log(r.slice(0, COLS - 2))
      }
    }
    const stretches: Array<{ kind: 'boot' | 'hopped'; first: number; last: number; seat: number; stage: number }> = []
    let boardSince = -1
    for (const l of lane) {
      if (l.kind === 'board') {
        boardSince = l.atMs
        continue
      }
      if (l.kind !== 'boot' && l.kind !== 'hopped') continue
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
    const bootVisits = kinds.filter(k => k === 'boot').length
    const hoppedVisits = kinds.filter(k => k === 'hopped').length
    check(`L1 every enter takes — entered views of both kinds, board between them [${COLS}x${ROWS}]`, bootVisits >= 2 && hoppedVisits >= 2, laneStr)
    check('L1 …five enters in the drive land five entered stretches', stretches.length >= 5, `stretches=${kinds.join(',')}`)
    const bootStretches = stretches.filter(s => s.kind === 'boot')
    check('L2 the session started at boot keeps working while another session is focused (a later visit shows later tokens)', bootStretches.length >= 2 && bootStretches[bootStretches.length - 1]!.seat > bootStretches[0]!.seat, `seat tokens per visit: ${bootStretches.map(s => s.seat).join(',')}`)
    const hoppedStretches = stretches.filter(s => s.kind === 'hopped')
    check('L3 the board session keeps working while off screen (a later visit shows later stages)', hoppedStretches.length >= 2 && hoppedStretches[hoppedStretches.length - 1]!.stage > hoppedStretches[0]!.stage, `stages per visit: ${hoppedStretches.map(s => s.stage).join(',')}`)
    const lastSeatToken = Math.max(...lane.map(l => l.seat))
    const firstHopAt = hoppedStretches[0]?.first ?? -1
    const bootBeforeFirstHop = Math.max(-1, ...lane.filter(l => l.atMs < firstHopAt).map(l => l.seat))
    check('both were mid-turn during the hops (the boot session had more to say when the first hop landed; it said it later)', firstHopAt > 0 && bootBeforeFirstHop >= 0 && bootBeforeFirstHop < seatDeltas.length && lastSeatToken > bootBeforeFirstHop, `boot-session token at first hop: ${bootBeforeFirstHop}, last seen: ${lastSeatToken}`)
    const said = (needle: string): number[] => grabs.filter(g => text(g).includes(needle)).map(g => g.atMs)
    for (const needle of ['did not commit', 'may be mid-turn', 'esc there', 'settling —', 'finishing this thought', 'restoring the session', 'a run is in flight']) {
      check(`L4 no frame says "${needle}"`, said(needle).length === 0, said(needle).join(','))
    }
    const seatHome = paths.getProjectDir(run.paths.cwd)
    const seatFiles = existsSync(seatHome) ? readdirSync(seatHome).filter(f => f.endsWith('.jsonl')).map(f => join(seatHome, f)) : []
    const seatFile = seatFiles.find(f => /seat-\d\d body/.test(readFileSync(f, 'utf8')))
    const seatText = seatFile !== undefined ? readFileSync(seatFile, 'utf8') : ''
    check('L5 the session started at boot wrote its own transcript', seatFile !== undefined, `${seatHome}: ${seatFiles.length} file(s)`)
    check('L5 the seat\'s file carries its LAST token (every record produced while another session was focused was logged)', seatText.includes(`seat-${String(seatDeltas.length).padStart(2, '0')} body`), `last token present: ${seatText.includes('seat-48 body')}`)
    check("L5 the boot session's file carries none of the board session's words", !seatText.includes('b-stage-'))
    const boardText = existsSync(boardLog) ? readFileSync(boardLog, 'utf8') : ''
    check("L5 the board session's file carries none of the boot session's words", boardText.length > 0 && !/seat-\d\d body/.test(boardText) && !boardText.includes('seat body please'))
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
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nprove-seat-both-busy-journey (${COLS}x${ROWS}): ALL LAWS HOLD` : `\nprove-seat-both-busy-journey (${COLS}x${ROWS}): ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
