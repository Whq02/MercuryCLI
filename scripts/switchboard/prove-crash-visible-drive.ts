#!/usr/bin/env bun
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'crash-visible-'))
const daemonDir = join(SCRATCH, 'daemon')
let work = join(SCRATCH, 'work-alpha')
let workB = join(SCRATCH, 'work-beta')
for (const d of [daemonDir, work, workB]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
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
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const countingTurn = (n: number) => ({
  kind: 'paced_tool_use' as const,
  preDeltas: [`counting ${String(n).padStart(3, '0')} `, 'still going '],
  gapMs: 400,
  tools: [{ name: 'Bash', input: { command: `sleep 3; echo tick-${n}`, description: 'one counted beat' } }],
  whenModel: 'opus',
})
const api = await startFixtureApi([
  ...Array.from({ length: 24 }, (_, i) => countingTurn(i + 1)),
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemon = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn('node', [DIST, 'daemon', 'run', work], {
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

const PROVER_DEADLINE_MS = 240_000
const reapDaemon = (): void => {
  try {
    if (daemon?.pid !== undefined) process.kill(daemon.pid, 'SIGKILL')
  } catch {
  }
}
const watchdog = setTimeout(() => {
  console.error(`\n[watchdog] prover deadline ${PROVER_DEADLINE_MS / 1000}s — failing loud (the hang law)`)
  reapDaemon()
  process.exit(124)
}, PROVER_DEADLINE_MS)
watchdog.unref()
const bail = (why: string): never => {
  console.error(`  [bail] ${why} — failing loud without the wait ladder`)
  reapDaemon()
  process.exit(1)
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

console.log('leg A — live-daemon crash paints NEEDS YOU + reason (no vanish, no ready-to-review lie)')
let alphaId = ''
let betaId = ''
const killLeg = (async () => {
  await untilAsync(() => workerPids().filter(w => w.pid !== undefined).length >= 2, 60_000)
  await new Promise(r => setTimeout(r, 9_000))
  for (const w of workerPids()) {
    if (w.pid !== undefined) {
      try {
        process.kill(w.pid, 'SIGKILL')
        console.log(`  [info] SIGKILLed ${w.runnerId} pid ${w.pid}`)
      } catch {
      }
    }
  }
})()
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const run = await runArtifactArena({
  turns: [],
  sends: [],
  seconds: 38,
  cols: 120,
  rows: 40,
  keep: true,
  seedHome: async (configDir, _cwd) => {
    work = _cwd
    workB = _cwd
    execSync('git init -q && git -c user.email=crashvis@proof.invalid -c user.name=crashvis commit -q --allow-empty -m seed', {
      cwd: work,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    seedFirstRun(configDir, [_cwd, work, workB])
    spawnDaemon(configDir)
    const served = await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000)
    check('the daemon serves', served)
    if (!served) bail('the daemon never served')
    const a = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'crashvis-alpha',
      prompt: 'count slowly with sleeps',
      workspaceDir: work,
      title: 'Alpha count',
      modelKey: 'claude-opus-5',
      effort: 'xhigh',
    } as never)) as { ok?: boolean; sessionId?: string }
    check('alpha dispatched', a.ok === true, JSON.stringify(a))
    if (a.ok !== true) bail('alpha refused — the crash pair never staged')
    alphaId = a.sessionId ?? ''
    const alphaTranscript = join(paths.getProjectDir(work), `${alphaId}.jsonl`)
    check('alpha transcript born', await untilAsync(() => existsSync(alphaTranscript) && statSync(alphaTranscript).size > 100, 30_000))
    const b = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'crashvis-beta',
      prompt: 'count slowly with sleeps too',
      workspaceDir: workB,
      title: 'Beta count',
      modelKey: 'claude-opus-5',
      effort: 'xhigh',
    } as never)) as { ok?: boolean; sessionId?: string }
    check('beta dispatched (defaulted → the worktree fork)', b.ok === true, JSON.stringify(b))
    if (b.ok !== true) bail('beta refused — the crash pair never staged')
    betaId = b.sessionId ?? ''
  },
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_CACHE_CLOCK: '0',
  },
})
await killLeg
{
  const grabs = grabScreens(run, 120, 40, [8000, 20000, 26000, 32000, 36000].map(m => S(m)))
  const KEEP_DIR = process.env.MERCURY_CRASHVIS_CAPTURE_DIR
  if (KEEP_DIR) {
    mkdirSync(KEEP_DIR, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    for (const g of grabs) {
      writeFileSync(join(KEEP_DIR, `legA-at${String(g.atMs).padStart(6, '0')}.txt`), g.rows.map((r: string) => r.replace(/\s+$/, '')).join('\n'))
    }
  }
  const text = (g: { rows: string[] }): string => g.rows.join('\n')
  const late = grabs.filter(g => g.atMs >= 20000 && text(g).includes('SESSIONS'))
  check('the board painted after the kill', late.length >= 2, `frames: ${late.map(g => g.atMs).join(',')}`)
  const bothRows = (g: { rows: string[] }): boolean => text(g).includes('Alpha count') && text(g).includes('Beta count')
  check('NO VANISH — both rows stand in every post-kill frame (poison: the silent removal)', late.every(bothRows), late.map(g => `${g.atMs}:${bothRows(g)}`).join(' '))
  const needsYou = late.filter(g => /NEEDS YOU/.test(text(g)) && /crashed mid-run/.test(text(g)))
  check('the pair paints NEEDS YOU with the crash reason line', needsYou.length >= 1, `frames: ${needsYou.map(g => g.atMs).join(',') || 'none'}`)
  const reviewLie = late.filter(g => {
    const alphaRow = g.rows.find(r => r.includes('Alpha count')) ?? ''
    const betaRow = g.rows.find(r => r.includes('Beta count')) ?? ''
    return /READY TO REVIEW/.test(text(g)) && /●/.test(alphaRow) && /●/.test(betaRow) && !/NEEDS YOU/.test(text(g))
  })
  check('…never the READY TO REVIEW masquerade (poison: the pre-fix settled-stamp lie)', reviewLie.length === 0, reviewLie.map(g => String(g.atMs)).join(','))
}

console.log('leg B — reboot reconcile keeps the rows as NEEDS YOU; only release removes')
for (const w of workerPids()) {
  if (w.pid !== undefined) {
    try {
      process.kill(w.pid, 'SIGKILL')
    } catch {
    }
  }
}
if (daemon?.pid !== undefined) {
  try {
    process.kill(daemon.pid, 'SIGKILL')
  } catch {
  }
}
await new Promise(r => setTimeout(r, 800))
const home2 = join(SCRATCH, 'home2')
mkdirSync(home2, { recursive: true })
seedFirstRun(home2, [work, workB])
spawnDaemon(home2)
check('daemon2 serves (the reboot)', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
const sup = await import('../../src/daemon/concourseSupervisor.ts')
check(
  'the boot reconcile keeps the CRASH fact on both records (endedAt UNSET — rows kept)',
  await untilAsync(() => {
    const recs = Object.values(sup.readSessionWorkers(daemonDir)).filter(r => r.sessionId === alphaId || r.sessionId === betaId)
    return recs.length === 2 && recs.every(r => r.crash !== undefined && r.endedAt === undefined)
  }, 30_000),
  JSON.stringify(Object.values(sup.readSessionWorkers(daemonDir)).map(r => ({ w: r.runnerId, crash: r.crash?.reason, endedAt: r.endedAt }))),
)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const snapshot = await import('../../src/services/concourse/concourseSnapshot.ts')
const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
const snap = await snapshot.buildConcourseSnapshot({ recordsDir: daemonDir, project: projectIdentity(work) })
const boardRows = snap.groups.flatMap((g: { rows: Array<{ sessionId: string; state: string; nowLabel: string | null }> }) => g.rows)
const crashedRows = boardRows.filter(r => r.sessionId === alphaId || r.sessionId === betaId)
check('the reboot board carries BOTH sessions', crashedRows.length === 2, JSON.stringify(boardRows.map(r => r.sessionId)))
check(
  'both paint NEEDS YOU with a crash reason line',
  crashedRows.every(r => r.state === 'needs-you' && /crashed/.test(r.nowLabel ?? '')),
  JSON.stringify(crashedRows.map(r => ({ state: r.state, now: r.nowLabel }))),
)
const victimWorker = Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === alphaId)
check('release (the operator\'s x x) settles the row', victimWorker !== undefined && sup.settleConcourseWorker(victimWorker.runnerId, daemonDir) === true)
const snap2 = await snapshot.buildConcourseSnapshot({ recordsDir: daemonDir, project: projectIdentity(work) })
const after = snap2.groups.flatMap((g: { rows: Array<{ sessionId: string; state: string }> }) => g.rows)
const alphaAfter = after.filter(r => r.sessionId === alphaId)
const betaAfter = after.filter(r => r.sessionId === betaId)
check(
  '…and only then does alpha\'s crash claim clear (row may park, never NEEDS YOU) — beta stays crashed',
  alphaAfter.every(r => r.state !== 'needs-you') && betaAfter.length >= 1 && betaAfter.every(r => r.state === 'needs-you'),
  JSON.stringify(after.map(r => ({ id: r.sessionId.slice(0, 8), state: r.state }))),
)

try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
} catch {
}
daemon?.kill('SIGTERM')
await api.close()
reapDaemon()
run.cleanup()
const { rmSync } = await import('node:fs')
rmSync(SCRATCH, { recursive: true, force: true })

console.log(failures === 0 ? '\nprove-crash-visible-drive: ALL LAWS HOLD' : `\nprove-crash-visible-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
