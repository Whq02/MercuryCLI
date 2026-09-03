#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'enter-live-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME
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

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'paced_tool_use', preDeltas: ['stage-01 live-body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 6; echo one', description: 'pause one' } }] },
  { kind: 'paced_tool_use', preDeltas: ['stage-02 live-body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 6; echo two', description: 'pause two' } }] },
  { kind: 'paced', deltas: ['stage-03 live-body. ', 'stage-04 live-body. '], gapMs: 400, settleDelayMs: 1500 },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
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
let sessionId = ''
let transcript = ''
try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const hostTranscriptRows = (dir: string): { rows: number; digest: string } => {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      let rows = 0
      const parts: string[] = []
      for (const f of files) {
        const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)
        rows += lines.length
        const types = lines.map(l => {
          try {
            const d = JSON.parse(l) as Record<string, unknown>
            const sid = typeof d.sessionId === 'string' ? `@${d.sessionId.slice(0, 8)}` : ''
            const kind =
              typeof d.type === 'string' ? d.type : typeof d.kind === 'string' ? `k:${d.kind}` : Object.keys(d).slice(0, 4).join('+')
            return `${kind}${sid}`
          } catch {
            return '!'
          }
        })
        parts.push(`${f}: ${types.join(',')}`)
      }
      return { rows, digest: parts.join(' | ') }
    } catch {
      return { rows: 0, digest: '' }
    }
  }
  const run = await runArtifactArena({
    turns: [],
    sends: [
      'after:Enter live probe:1200:\t',
      'after:Enter live probe:1900:\r',
      'after:Enter live probe:2600:\r',
    ],
    seconds: 26,
    cols: 140,
    rows: 40,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work])
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const dispatched = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'enter-live-1',
        prompt: 'stream a long body',
        workspaceDir: cwd,
        title: 'Enter live probe',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string; state?: string }
      check('the session dispatched (working)', dispatched.ok === true && dispatched.sessionId !== undefined, JSON.stringify(dispatched))
      sessionId = dispatched.sessionId ?? ''
      transcript = join(paths.getProjectDir(cwd), `${sessionId}.jsonl`)
      check('the worker transcript was born at the law home', await untilAsync(async () => existsSync(transcript) && statSync(transcript).size > 200, 30_000), transcript)
      check(
        'the runner is mid-thought (the first stage landed; the tool call is unresolved)',
        await untilAsync(async () => readFileSync(transcript, 'utf8').includes('stage-01 live-body'), 30_000),
      )
      const recBefore = Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === sessionId)
      check('the record is WORKING before the enter (no pausedAt)', recBefore !== undefined && recBefore.pausedAt === undefined && recBefore.attachedAt === undefined)
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  try {
    const offsets = [3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000].map(m => S(m))
    const grabs = grabScreens(run, 140, 40, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    if (process.env.ENTER_LIVE_KEEP === '1') {
      for (const g of grabs) {
        console.log(`\n═══ frame @${g.atMs}`)
        for (const r of g.rows) if (r.trim()) console.log(r.slice(0, 138))
      }
    }
    const entered = grabs.filter(g => !text(g).includes('SESSION CONCOURSE') && /stage-\d\d live-body/.test(text(g)))
    check('§1 the entered view paints the live transcript', entered.length > 0, `entered frames: ${entered.map(g => g.atMs).join(',') || 'none'}`)
    const tokenMax = (g: { rows: string[] }): number =>
      Math.max(-1, ...[...text(g).matchAll(/stage-(\d\d) live-body/g)].map(m => Number(m[1])))
    const maxes = entered.map(tokenMax)
    check('§1 …and keeps painting as the thought grows (later frames carry later stages)', maxes.length >= 2 && maxes[maxes.length - 1]! > maxes[0]!, `stage highs: ${maxes.join(',')}`)
    const lifted = entered.filter(g => /\b\d+s\b/.test(text(g)) && /esc|interrupt|thinking|✻|✶|responding/i.test(text(g)))
    check('§2 THE ONE THINKING LIFT is up while the followed runner works', lifted.length > 0, `lifted frames: ${lifted.map(g => g.atMs).join(',') || 'none'}`)
    const recDuring = Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === sessionId)
    const { concourseRecordState } = await import('../../src/services/concourse/concourseSnapshot.ts')
    const stateDuring = recDuring ? concourseRecordState(recDuring, { needsYou: false, alive: true }) : 'missing'
    check("§3 the record never reads PAUSED while the operator watches (enter valve ≠ pause)", stateDuring !== 'paused', `state=${stateDuring} attachRequestedAt=${recDuring?.attachRequestedAt} pausedAt=${recDuring?.pausedAt}`)
    const hostHome = paths.getProjectDir(run.paths.cwd)
    const foreignFiles = ((): string[] => {
      try {
        return readdirSync(hostHome).filter(f => f.endsWith('.jsonl') && f !== `${sessionId}.jsonl`)
      } catch {
        return []
      }
    })()
    check('§4 the host terminal wrote ZERO transcript rows of its own during the follow (a follow is a READ)', foreignFiles.length === 0, `${hostHome}: ${foreignFiles.join(',')}`)
    const followedText = readFileSync(transcript, 'utf8')
    check("§4 the followed transcript carries no synthetic continuation rows", !followedText.includes('Continue from where you left off') && !followedText.includes('No response requested'))
    check("§4 the followed transcript carries no foreign session id", !followedText.split('\n').some(l => l.includes('"sessionId"') && !l.includes(sessionId)))
  } finally {
    run.cleanup()
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon?.kill('SIGTERM')
  await api.close()
  if (process.env.ENTER_LIVE_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-enter-live-journey: ALL LAWS HOLD' : `\nprove-enter-live-journey: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
