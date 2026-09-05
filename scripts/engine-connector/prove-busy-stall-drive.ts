#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.BUSY_STALL_DRIVE !== '1') {
  console.log('prove-busy-stall-drive: SKIPPED (driven — set BUSY_STALL_DRIVE=1 inside a granted PTY window)')
  process.exit(0)
}

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

const api = await startFixtureApi([
  { kind: 'hang', deltas: ['holding this turn open…'] },
  { kind: 'hang', deltas: ['still holding…'] },
])

const daemonDir = join(mkdirSyncTemp('busy-stall-daemon'), 'daemon')
mkdirSync(daemonDir, { recursive: true })
function mkdirSyncTemp(tag: string): string {
  const d = join(tmpdir(), `${tag}-${process.pid}`)
  mkdirSync(d, { recursive: true })
  return d
}
process.env.MERCURY_DAEMON_DIR = daemonDir
const logFd = openSync(join(daemonDir, 'drive-daemon.log'), 'a')

let daemon: ReturnType<typeof spawn> | null = null
let work = ''
let sessionId = ''
const workerPids = (): Array<{ runnerId: string; pid?: number }> => {
  try {
    const raw = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as {
      workers: Record<string, { pid?: number; runnerId: string }>
    }
    return Object.values(raw.workers)
  } catch {
    return []
  }
}
const factsBusy = (): boolean => {
  try {
    const facts = JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sessionId}.json`), 'utf8')) as { busy?: boolean }
    return facts.busy === true
  } catch {
    return false
  }
}
const reap = (): void => {
  for (const w of workerPids()) {
    if (w.pid !== undefined) {
      try {
        process.kill(w.pid, 'SIGKILL')
      } catch {
      }
    }
  }
  try {
    if (daemon?.pid !== undefined) process.kill(daemon.pid, 'SIGKILL')
  } catch {
  }
}
const watchdog = setTimeout(() => {
  console.error('\n[watchdog] prover deadline 220s — failing loud (the hang law)')
  reap()
  process.exit(124)
}, 220_000)
watchdog.unref()

const KILL_AT_ARENA_MS = 15_000
let teePathForKill = ''
const killLeg = (async () => {
  const staged = await untilAsync(() => workerPids().some(w => w.pid !== undefined) && factsBusy(), 90_000)
  if (!staged) {
    console.error('  [bail] the worker never staged busy — nothing to kill')
    return
  }
  const booted = await untilAsync(() => teePathForKill !== '' && existsSync(teePathForKill), 90_000)
  if (!booted) {
    console.error('  [bail] the arena never booted — nothing to drive')
    return
  }
  const arenaBootAt = Date.now()
  await new Promise(r => setTimeout(r, KILL_AT_ARENA_MS))
  reap()
  console.log(`  [info] tree SIGKILLed at arena+${Date.now() - arenaBootAt}ms (facts frozen busy)`)
})()

const runPromise = runArtifactArena({
  turns: [],
  sends: ['8500:\t', '10000:\r', '11500:\r'],
  seconds: 92,
  cols: 120,
  rows: 40,
  keep: true,
  seedHome: async (configDir, cwd) => {
    work = cwd
    execSync('git init -q && git -c user.email=busy@proof.invalid -c user.name=busy commit -q --allow-empty -m seed', {
      cwd: work,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    seedFirstRun(configDir, [work])
    process.env.MERCURY_CONFIG_DIR = configDir
    daemon = spawn('node', [DIST, 'daemon', 'run', work], {
      cwd: work,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: configDir,
        MERCURY_DAEMON_DIR: daemonDir,
        ANTHROPIC_API_KEY: 'fixture-key-000',
        ANTHROPIC_BASE_URL: api.url,
        MERCURY_CACHE_CLOCK: '0',
        MERCURY_PARTY: '0',
      },
      stdio: ['ignore', logFd, logFd],
    })
    const served = await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000)
    check('the daemon serves', served)
    const dispatched = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'busy-stall-hold',
      prompt: 'hold this turn open',
      workspaceDir: work,
      title: 'Hold the turn',
      modelKey: 'claude-opus-5',
      effort: 'xhigh',
    } as never)) as { ok?: boolean; sessionId?: string }
    check('the holding session dispatched', dispatched.ok === true, JSON.stringify(dispatched))
    sessionId = dispatched.sessionId ?? ''
    check('its facts say BUSY (the hanging turn is real)', await untilAsync(() => factsBusy(), 45_000))
  },
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_CACHE_CLOCK: '0',
    DEBUG: '1',
  },
})
const proverStartedAt = Date.now()
const teeWatcher = (async () => {
  const { readdirSync: rd, statSync: st } = await import('node:fs')
  const os = await import('node:os')
  const base = os.tmpdir()
  await untilAsync(() => {
    try {
      for (const name of rd(base)) {
        if (!name.startsWith('flux-arena-home-')) continue
        const candidate = join(base, name, 'tee.jsonl')
        if (existsSync(candidate) && st(candidate).mtimeMs > proverStartedAt) {
          teePathForKill = candidate
          return true
        }
      }
    } catch {
    }
    return false
  }, 120_000)
})()
const run = await runPromise
await teeWatcher
await killLeg

const KEEP_DIR = process.env.BUSY_STALL_CAPTURE_DIR ?? join(tmpdir(), `busy-stall-captures-${process.pid}`)
mkdirSync(KEEP_DIR, { recursive: true })
{
  const grabs = grabScreens(run, 120, 40, [13_000, 24_000, 88_000])
  for (const g of grabs) {
    writeFileSync(join(KEEP_DIR, `at${String(g.atMs).padStart(6, '0')}.txt`), g.rows.map((r: string) => r.replace(/\s+$/, '')).join('\n') + '\n')
  }
  const text = (g: { rows: string[] } | undefined): string => (g ? g.rows.join('\n') : '')
  const attached = grabs.find(g => g.atMs === 13_000)
  const frozen = grabs.find(g => g.atMs === 24_000)
  const settled = grabs.find(g => g.atMs === 88_000)
  check('pre-kill: the chat ATTACHED (the held prompt inside the FOCUSED CHAT pane)', text(attached).includes('hold this turn open') && text(attached).includes('FOCUSED CHAT'), 'see the kept capture')
  check('post-kill: the frame still stands (the freeze is painted, not a crash)', text(frozen).length > 0)
  check('post-deadline: the frame stands and differs from the frozen-busy paint', text(settled).length > 0 && text(settled) !== text(frozen))

  let settleSeen = false
  let looked = 0
  const walkForSettle = (dir: string, depth: number): void => {
    if (depth > 6 || settleSeen) return
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walkForSettle(p, depth + 1)
        else if (st.size > 0 && st.size < 32 * 1024 * 1024 && (name.endsWith('.txt') || name.endsWith('.log'))) {
          looked++
          const body = readFileSync(p, 'utf8')
          if (body.includes('busy turn stalled') && body.includes('settling idle')) settleSeen = true
        }
      } catch {
      }
      if (settleSeen) return
    }
  }
  walkForSettle(run.paths.home, 0)
  check('GROUND TRUTH: the 45s deadline road fired — the settle line in the debug log', settleSeen, `walked ${looked} log file(s) under ${run.paths.home}`)
  console.log(`  captures kept: ${KEEP_DIR}`)
}

await api.close()
run.cleanup()
console.log(failures === 0 ? '\nprove-busy-stall-drive: ALL LAWS HOLD' : `\nprove-busy-stall-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
