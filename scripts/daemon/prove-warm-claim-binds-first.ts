#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mock } from 'bun:test'
import type { RunnerChildSpec } from '../../src/daemon/headlessRun.ts'
import type { InputRow } from '../../src/rows/vocabulary.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'warm-claim-binds-')))
const home = join(scratch, 'home')
const daemonHome = join(scratch, 'daemon')
const ws = join(scratch, 'ws')
const wsBare = join(scratch, 'ws-bare')
for (const dir of [home, daemonHome, ws, wsBare]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonHome
process.env.MERCURY_TMPDIR = join(scratch, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CACHE_CLOCK = '0'
process.env.MERCURY_PARTY = '0'
process.env.MERCURY_TERMINAL_TITLE = '0'
process.env.TERM = 'dumb'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
for (const name of ['MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_SESSION_HOME', 'MERCURY_SESSION_FACTS_HOLD_MS', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_WARM_RUNNER', 'MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES', 'MERCURY_DAEMON_NO_SELF_WARM', 'MERCURY_CONCOURSE_WORKER']) {
  delete process.env[name]
}

const HOOK_SECONDS = 12
const REPLY = 'THE WORD AFTER THE LOAD.'
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-warm-claim-binds-first exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const stop = Date.now() + ms
  for (;;) {
    if (pred()) return true
    if (Date.now() > stop) return false
    await sleep(50)
  }
}

const daemonLog: string[] = []
const realConsoleError = console.error
console.error = ((...args: unknown[]): void => {
  daemonLog.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
}) as typeof console.error

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [ws, wsBare])
writeFileSync(join(home, 'settings.json'), `${JSON.stringify({ events: { hooks: { 'session.start': [{ name: 'slow-start', run: `sleep ${HOOK_SECONDS}` }] } } })}\n`)
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'text', text: REPLY },
  { kind: 'text', text: 'Spare.' },
])
process.env.ANTHROPIC_BASE_URL = api.url
const { sourceLauncher } = await import('../lib/seatLauncher.ts')
const launcher = sourceLauncher(scratch)

const real = await import('../../src/daemon/headlessRun.ts')
type Spawned = { short: string; respawn: boolean; pid: number | undefined }
const spawns: Spawned[] = []
mock.module('../../src/daemon/headlessRun.ts', () => ({
  ...real,
  spawnRunnerChild: (spec: RunnerChildSpec, opts?: { respawn?: boolean }) => {
    const invocation = real.buildRunnerInvocation(spec, opts)
    const child = spawn(process.execPath, [launcher, ...invocation.argv.slice(1)], {
      cwd: spec.cwd ?? ws,
      env: { ...invocation.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    spawns.push({ short: spec.agentName, respawn: opts?.respawn === true, pid: child.pid })
    return { child, argv: invocation.argv, env: invocation.env, capabilities: invocation.capabilities }
  },
}))

const { TaskRoster } = await import('../../src/daemon/roster.ts')
const sup = await import('../../src/daemon/concourseWorkers.ts')
const warm = await import('../../src/daemon/warmRunner.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { runnerStateFactOf } = await import('../../src/services/engine-connector/seatProjections.ts')
const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))

const readyEdges: Array<{ short: string; atMs: number }> = []
const roster = new TaskRoster({
  dir: daemonHome,
  breaker: {} as never,
  maxInflight: 3,
  onChildReady: short => {
    readyEdges.push({ short, atMs: Date.now() })
    seat.publishSeatFacts(short, daemonHome, roster)
    seat.requestSessionFacts(short, roster, { immediate: true }, daemonHome)
  },
})
const warmDeps = { roster: () => roster, dir: daemonHome }
const now = Date.now()
const FLOOR_MS = warm.claimAnswerDeadlineMs(now - warm.WARM_BOOT_ALLOWANCE_MS - 1, now)
const admitDoor = sup.makeConcourseAdmitHandler({
  roster: () => roster,
  dir: daemonHome,
  claimWarm: args => warm.claimWarmRunner({ ...args, answerDeadlineMs: FLOOR_MS }, warmDeps),
  ensureWarm: () => {},
  onSpawned: runnerId => seat.onSeatSpawned(runnerId, roster, daemonHome),
})
const admit: typeof admitDoor = req => admitDoor({ by: 'operator', ...req })

const registryDefault = await validateWorkerModelChoice(undefined, 'session')
if (!registryDefault.ok) throw new Error(`the registry default is unavailable in this home: ${registryDefault.reason}`)
const MODEL = registryDefault.entry.modelId

const rosterEntry = (short: string) => roster.list().find(e => e.short === short)
const factsOf = (sid: string): Record<string, unknown> | null => {
  const path = join(daemonHome, 'session-facts', `${sid}.json`)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
const retiredLines = (): string[] => daemonLog.filter(line => line.includes('warm runner retired'))

async function settle(short: string): Promise<void> {
  roster.expectExit(short, true)
  roster.kill(short)
  await until(() => roster.has(short).alive === false, 10_000)
}

console.log('============================================================')
console.log(' warm claim binds first — the claim is the binding; the session loads after the answer')
console.log(` the daemon's floor for a long-warmed runner: ${FLOOR_MS / 1000}s; the resumed session carries a ${HOOK_SECONDS}s session.start hook`)
console.log(' red on the base: the claim answer waits for the whole resume (transcript, read ledger, hooks, boot recovery), the floor retires the live warm runner and the session spawns cold')
console.log('============================================================')

section(`§1 a parked session reactivates on the warm runner: the claim answers inside the floor while its resume takes ${HOOK_SECONDS}s`)
const parkedSid = randomUUID()
{
  check('the floor the daemon gives a runner older than the boot allowance is 10s', FLOOR_MS === 10_000, String(FLOOR_MS))
  const wsId = sup.canonicalWorkspaceId(ws)
  const parkedShort = 'concourse-w900'
  const parked = {
    schema: 1,
    runnerId: parkedShort,
    sessionId: parkedSid,
    workspaceId: wsId,
    isolation: 'exclusive',
    modelKey: MODEL,
    effort: 'high',
    spawnedAt: Date.now() - 3_600_000,
    lastLiveAt: Date.now() - 3_600_000,
    pid: 2_147_000_000,
    parkedAt: Date.now() - 600_000,
    parkedBy: 'operator:test',
    title: 'the parked chat',
  }
  const transcript = sup.concourseTranscriptPath(parked as never)
  mkdirSync(dirname(transcript), { recursive: true })
  const rows: Record<string, unknown>[] = []
  let parent: string | null = null
  let n = 0
  const row = (extra: Record<string, unknown>): Record<string, unknown> => {
    const uuid = `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`
    const out = { isSidechain: false, entrypoint: 'cli', cwd: wsId, sessionId: parkedSid, version: '1.0.0', gitBranch: 'main', parentUuid: parent, uuid, timestamp: new Date(1_750_000_000_000 + n * 1000).toISOString(), ...extra }
    parent = uuid
    return out
  }
  for (let t = 0; t < 40; t++) {
    rows.push(row({ type: 'user', message: { role: 'user', content: `turn ${t}: carry on` } }))
    rows.push(row({ type: 'assistant', message: { id: `msg_${t}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: `carried ${t}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } } }))
  }
  writeFileSync(transcript, encodeSeedTranscript(rows, parkedSid))
  sup.updateConcourseWorkers(workers => {
    workers[parkedShort] = parked as never
  }, daemonHome)

  const warmed = await warm.ensureWarmRunner({ workspaceDir: ws }, warmDeps)
  const short = warmed.short ?? ''
  check('the pool warms a real runner for the workspace', warmed.state === 'warmed' && short !== '' && spawns.length === 1, j(warmed))
  check('the warm runner answers initialize (ready) before the claim', await until(() => rosterEntry(short)?.ready === true, 90_000), j(rosterEntry(short)))
  await sleep(500)

  const claimAt = Date.now()
  const admitted = await admit({ workspaceDir: ws, resumeSessionId: parkedSid, permissionMode: 'default' })
  const ackMs = Date.now() - claimAt
  check('the reactivation claims the warm runner (no cold respawn)', admitted.ok && admitted.runnerId === short && spawns.length === 1, j({ admitted, spawns }))
  check(`the claim is answered inside the daemon's ${FLOOR_MS / 1000}s floor — ${ackMs}ms, while the resume still has a ${HOOK_SECONDS}s hook ahead`, admitted.ok && ackMs < FLOOR_MS, `${ackMs}ms`)
  check('no warm runner was retired', retiredLines().length === 0, retiredLines().join(' | '))
  check('the pool is empty after the claim', warm.warmRunnerCount() === 0)

  const entry = rosterEntry(short)
  check("the claimed seat reads 'starting' while its session loads (the cold spawn's status road, the same fact)", entry !== undefined && entry.ready === false && runnerStateFactOf(entry, Date.now())?.state === 'starting', j(entry))
  const sinceMs = runnerStateFactOf(entry, Date.now())?.sinceMs ?? 0
  check('the starting clock runs from the claim, not from the warm boot', sinceMs >= claimAt - 50 && sinceMs <= Date.now(), `since=${sinceMs} claim=${claimAt}`)
  check('the published facts say the runner is starting and the queue is not ready', await until(() => factsOf(parkedSid)?.queueReady === false && (factsOf(parkedSid)?.runner as { state?: string } | undefined)?.state === 'starting', 5_000), j(factsOf(parkedSid)))

  let deliveredAt: number | null = null
  const promptRow: InputRow = { type: 'prompt', content: 'say the word', id: randomUUID() } as InputRow
  const delivery = roster.reply(short, promptRow).then(ok => {
    deliveredAt = Date.now()
    return ok
  })
  await sleep(FLOOR_MS / 2)
  check(`words sent during the load are not failed by the queue deadline — the delivery still waits at ${Math.round((Date.now() - claimAt) / 1000)}s`, deliveredAt === null)

  check('the seat turns ready once the session is loaded', await until(() => rosterEntry(short)?.ready === true, 60_000), j(rosterEntry(short)))
  const readyMs = Date.now() - claimAt
  check(`readiness came after the hook ran (${readyMs}ms ≥ ${HOOK_SECONDS}s)`, readyMs >= HOOK_SECONDS * 1000, `${readyMs}ms`)
  check('the ready edge reached onChildReady for the claimed seat', readyEdges.some(edge => edge.short === short), j(readyEdges))
  const delivered = await delivery
  check('the held words are delivered once the session is loaded', delivered === true && deliveredAt !== null && deliveredAt >= claimAt + HOOK_SECONDS * 1000, j({ delivered, deliveredAt, claimAt }))
  check('the delivered turn settles under the parked session (the fixture reply lands in its transcript)', await until(() => existsSync(transcript) && readFileSync(transcript, 'utf8').includes(REPLY), 60_000))
  check("the facts after readiness carry the runner's truth: queue ready, no starting fact, the loaded context", await until(() => {
    const facts = factsOf(parkedSid)
    const context = (facts?.usage as { context?: { usedTokens?: number | null } } | undefined)?.context
    return facts !== null && facts.queueReady === true && facts.runner === undefined && typeof context?.usedTokens === 'number' && context.usedTokens > 0
  }, 30_000), j(factsOf(parkedSid)))
  const log = daemonLog.join('\n')
  check('the daemon log names the ack and never a claim deadline', /warm claim acked in \d+ms/.test(log) && !log.includes('no claim answer in'), log.split('\n').filter(l => l.includes('claim')).join(' | '))
  await settle(short)
}

section('§2 a resume claim for a session with no transcript is still refused at once (the cold road parks it as transcript-lost)')
{
  const warmed = await warm.ensureWarmRunner({ workspaceDir: wsBare }, warmDeps)
  const short = warmed.short ?? ''
  check('the pool warms a runner for the bare workspace', warmed.state === 'warmed' && short !== '', j(warmed))
  check('it answers initialize', await until(() => rosterEntry(short)?.ready === true, 90_000), j(rosterEntry(short)))
  const { deriveSessionKitForWorkspace } = await import('../../src/daemon/sessionKit.ts')
  const wsId = sup.canonicalWorkspaceId(wsBare)
  const refusedAt = Date.now()
  const outcome = await warm.claimWarmRunner(
    { workspaceId: wsId, sessionId: randomUUID(), modelKey: MODEL, effort: 'high', permissionMode: 'default', kit: deriveSessionKitForWorkspace(wsId), resume: true, answerDeadlineMs: FLOOR_MS },
    warmDeps,
  )
  check('the claim is refused with the no-conversation reason, before any load', outcome.claimed === false && outcome.reason.includes('no conversation found') && Date.now() - refusedAt < FLOOR_MS, j(outcome))
  await until(() => roster.has(short).alive === false, 10_000)
}

section('§3 source pins: the readiness road')
{
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const print = read('src/cli/run.ts')
  const claimBody = print.slice(print.indexOf("'session/claim': async params => {"), print.indexOf("'session/set_effort': (params, ref) => {"))
  check('the claim answers after binding; the load runs behind the answer', claimBody.indexOf('claimSettling = settling') !== -1 && claimBody.indexOf('await loadConversationForResume(sid,') !== -1 && claimBody.indexOf('claimSettling = settling') < claimBody.indexOf('return { session_id: sid }') && claimBody.indexOf('return { session_id: sid }') > claimBody.indexOf('await loadConversationForResume(sid,'))
  check('the claim checks the transcript stands before it binds a resume', claimBody.includes('no conversation found for session') && claimBody.indexOf('no conversation found for session') < claimBody.indexOf('const settling ='))
  check('session verbs queue behind the load (the session scope is held until the claim settles)', claimBody.includes("peer?.holdScope('session')"))
  check('session/facts answers only once the claimed session is loaded', /'session\/facts': async \(\) => \{\s*\n\s*if \(claimSettling !== null\) await claimSettling/.test(print))
  const rosterSrc = read('src/daemon/roster.ts')
  check('the roster marks the claimed seat not ready and waits for the load through the connection', rosterSrc.includes('ll.ready = false') && rosterSrc.includes('connection.sessionLoaded()') && rosterSrc.includes('ll.claimedAt = Date.now()'))
  const door = read('src/daemon/runnerConnection.ts')
  check("the connection's load wait has no deadline and gates deliveries, the way initialize does", door.includes("'session/facts', {}, { deadlineMs: null }") && door.includes('if (!(await this.loaded)) return false'))
  const dmain = read('src/daemon/main.ts')
  check('a ready edge asks the runner for its facts (the first request may have run out while it loaded)', /onChildReady: short => \{[\s\S]{0,200}requestSessionFacts\(short, roster, \{ immediate: true \}\)/.test(dmain))
}

clearTimeout(watchdog)
console.error = realConsoleError
await api.close()
if (failures !== 0) {
  console.log('\n[forensics] the daemon lines:')
  for (const line of daemonLog.slice(-20)) console.log(`  ${line}`)
  console.log(`[forensics] world kept: ${scratch}`)
} else {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    console.log(`  scratch kept: ${scratch}`)
  }
}
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-warm-claim-binds-first: ALL LAWS HOLD' : `prove-warm-claim-binds-first: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
