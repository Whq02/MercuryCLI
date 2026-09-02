#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-halt-roster.ts — /halt truth (workflow-hardening
//  defect 5): the reap NAMES what it reaped, never re-counts a worker, and
//  the operator's hard stop is not silently undone by an auto-heal.
//
//  The burn (the operator's evening): "/halt: daemon halted (reaped 5
//  workers)" → an immediate second /halt reaped 4 MORE → a third found
//  none — with no visible subagents running. Two truths land here:
//    §1/§2 the REAL daemon (dist, scratch world) hosting a long-lived seat
//        and a live one-shot answers `shutdown` with the reaped workers BY
//        NAME AND PURPOSE, and a repeat shutdown can never re-reap them
//        ('retiring' rows are excluded from the reapable roster);
//    §3 summarizeHalt spells the names on the /halt line (bounded), with
//        honest fallbacks for count-only daemons and nothing-to-reap;
//    §4 the stand-down latch: /halt marks it, the SILENT heal path (the
//        switchboard ensure) consults it, and only the EXPLICIT engage
//        gesture (the crew engage) clears it — the fix for
//        halt-then-respawn.
//
//  Fixture API only — no paid calls.
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-halt-roster.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'halt-roster-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
// Slack-provisioned text turns: seat boots and the one-shot's run can sip
// freely; the one-shot's own turn HANGS so it stays live at the halt.
const api = await startFixtureApi([
  { kind: 'hang', deltas: ['working…'] },
  { kind: 'text', text: 'slack 1' },
  { kind: 'text', text: 'slack 2' },
  { kind: 'text', text: 'slack 3' },
  { kind: 'text', text: 'slack 4' },
])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — halt-roster exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 120_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return true
    if (Date.now() > deadline) return false
    await wait(200)
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const referencesScratch = (): string => {
  try {
    return execFileSync('pgrep', ['-f', daemonDir], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

console.log('halt roster — named reaps · no re-counts · the stand-down latch')

section('§1 the real daemon: a long-lived seat + a live one-shot on the roster')
const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_CACHE_CLOCK: '0',
    // The crew-engage stamp: this daemon hosts crew teammates — the named
    // long-lived worker the reap must spell out is spawned below.
    MERCURY_DAEMON_CREW: '1',
  },
  stdio: ['ignore', logFd, logFd],
})
const daemonExit = new Promise<void>(r => daemon.once('exit', () => r()))

check(
  'the supervisor answers ping',
  await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000),
)
type ListReply = { ok: boolean; jobs?: Array<{ short: string; outcome?: string; state?: string }> }
const liveShorts = async (): Promise<string[]> => {
  const r = (await daemonControlRpc({ op: 'list', proto: 0 } as never)) as ListReply
  return (r.jobs ?? []).filter(j => !j.outcome).map(j => j.short)
}
const spawned = (await daemonControlRpc({ op: 'crewSpawn', name: 'scout', model: 'sonnet' } as never)) as {
  ok: boolean
  pid?: number
  error?: string
}
check('a crew teammate spawn is accepted', spawned.ok === true, JSON.stringify(spawned))
check(
  'the crew seat comes up on the roster',
  await untilAsync(async () => (await liveShorts()).includes('scout'), 90_000),
  JSON.stringify(await liveShorts()),
)
const dispatched = (await daemonControlRpc({
  op: 'dispatch',
  proto: 0,
  d: { prompt: 'halt-roster one-shot: hang on the fixture', cwd: work },
} as never)) as { ok: boolean; short?: string; pid?: number }
check('a one-shot dispatch is accepted', dispatched.ok === true && !!dispatched.short, JSON.stringify(dispatched))
check(
  'the one-shot is LIVE at halt time',
  await untilAsync(async () => (await liveShorts()).includes(dispatched.short!), 60_000),
)

section('§2 shutdown names the reaped; a second shutdown re-reaps nothing')
type ShutdownReply = {
  ok: boolean
  op?: string
  reaped?: number
  workers?: Array<{ short: string; kind: string; purpose: string; pid?: number }>
}
const bye = (await daemonControlRpc({ op: 'shutdown', reapWorkers: true })) as ShutdownReply
check('shutdown acknowledged', bye.ok === true, JSON.stringify(bye))
const workers = bye.workers ?? []
check('the reply CARRIES the reaped workers', Array.isArray(bye.workers), JSON.stringify(bye))
check('reaped count equals the named list', bye.reaped === workers.length, `reaped=${bye.reaped} named=${workers.length}`)
const seatRow = workers.find(w => w.short === 'scout')
check('the crew seat is named with its purpose', !!seatRow && seatRow.kind === 'long-lived' && /crew seat/.test(seatRow.purpose), JSON.stringify(workers))
const oneShotRow = workers.find(w => w.short === dispatched.short)
check(
  "the one-shot is named with the run's prompt clip",
  !!oneShotRow && oneShotRow.kind === 'one-shot' && /halt-roster one-shot/.test(oneShotRow.purpose),
  JSON.stringify(workers),
)

// The immediate second halt: EITHER the daemon already left (socket dead —
// zero to reap) OR it answers with an EMPTY reap (retiring rows excluded).
// Both are the truth the operator was owed; "4 MORE" is impossible.
const bye2 = (await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 2000 }).catch(() => ({ ok: false }))) as ShutdownReply
if (bye2.ok && bye2.op === 'shutdown') {
  check('second shutdown re-reaps NOTHING', bye2.reaped === 0 && (bye2.workers ?? []).length === 0, JSON.stringify(bye2))
} else {
  check('second shutdown finds no daemon (already down) — zero to reap', true)
}

await Promise.race([daemonExit, wait(30_000)])
check('the daemon process exited', daemon.pid !== undefined && !alive(daemon.pid))
check(
  'nothing anywhere still references the scratch daemon dir',
  await untilAsync(() => referencesScratch() === '', 30_000),
  referencesScratch(),
)

section('§3 summarizeHalt spells the names (pure)')
{
  const { summarizeHalt } = await import('../../src/utils/haltDecide.ts')
  const named = summarizeHalt({
    tasksStopped: [],
    tasksFailed: [],
    daemon: {
      ok: true,
      reaped: 2,
      workers: [
        { short: 'scout', kind: 'long-lived', purpose: 'crew seat' },
        { short: 'a1b2c3', kind: 'one-shot', purpose: 'dispatch run: audit the tree' },
      ],
    },
  })
  check(
    'names + purposes on the /halt line',
    named.includes('reaped 2: scout — crew seat, a1b2c3 — dispatch run: audit the tree'),
    named,
  )
  const many = summarizeHalt({
    tasksStopped: [],
    tasksFailed: [],
    daemon: {
      ok: true,
      reaped: 8,
      workers: Array.from({ length: 8 }, (_, i) => ({
        short: `w${i}`,
        kind: 'one-shot' as const,
        purpose: `run ${i}`,
      })),
    },
  })
  check('the name list is bounded (+N more)', many.includes('+2 more'), many)
  const bare = summarizeHalt({ tasksStopped: [], tasksFailed: [], daemon: { ok: true, reaped: 3 } })
  check('count-only daemons still report the count', bare.includes('reaped 3 workers'), bare)
  const none = summarizeHalt({ tasksStopped: [], tasksFailed: [], daemon: { ok: true, reaped: 0, workers: [] } })
  check('nothing-to-reap says so', none.includes('no live workers to reap'), none)
}

section('§4 the stand-down latch: /halt sticks until an explicit engage')
{
  const { markDaemonHaltStanddown, clearDaemonHaltStanddown, daemonHaltStanddownActive } = await import(
    '../../src/utils/daemonStanddown.ts'
  )
  clearDaemonHaltStanddown()
  check('clear at rest', daemonHaltStanddownActive() === false)
  markDaemonHaltStanddown()
  check('marked after a halt', daemonHaltStanddownActive() === true)
  clearDaemonHaltStanddown()
  check('an explicit engage lifts it', daemonHaltStanddownActive() === false)

  const root = process.cwd()
  const read = (p: string): string => readFileSync(join(root, p), 'utf8')
  check('/halt marks the latch (haltAll)', /markDaemonHaltStanddown\(\)/.test(read('src/utils/haltAll.ts')))
  check(
    'the switchboard silent heal consults it',
    /daemonHaltStanddownActive\(\)/.test(read('src/services/switchboard/ensureDaemon.ts')),
  )
  check('the crew engage clears it', /clearDaemonHaltStanddown\(\)/.test(read('src/utils/crew/crewClient.ts')))
}

await api.close()
rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log('✅ HALT ROSTER: green')
  process.exit(0)
} else {
  console.log(`❌ HALT ROSTER: ${failures} check(s) failed`)
  process.exit(1)
}
