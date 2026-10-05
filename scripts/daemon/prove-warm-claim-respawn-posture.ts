#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'
import type { RunnerChildSpec } from '../../src/daemon/headlessRun.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'warm-claim-posture-')))
const home = join(scratch, 'home')
const daemonHome = join(scratch, 'daemon')
mkdirSync(home, { recursive: true })
mkdirSync(daemonHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const name of ['MERCURY_HOME', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_WARM_RUNNER', 'MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES', 'MERCURY_DAEMON_NO_SELF_WARM']) {
  delete process.env[name]
}
writeFileSync(
  join(home, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)

const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-warm-claim-respawn-posture exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

const daemonLog: string[] = []
const realConsoleError = console.error
console.error = ((...args: unknown[]): void => {
  daemonLog.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
}) as typeof console.error

const real = await import('../../src/daemon/headlessRun.ts')
const { createPeer } = await import('../../src/runner/wire/peer.ts')

type Fake = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
type Spawn = { short: string; respawn: boolean; argv: string[]; spec: RunnerChildSpec }
const spawns: Spawn[] = []
const claims: Array<{ short: string; params: Record<string, unknown> }> = []
const latest = new Map<string, Fake>()

function scriptedRunner(short: string, child: Fake): void {
  const runner = createPeer({ input: child.stdin, output: child.stdout, side: 'runner', log: () => {} })
  runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '0.0.0-prover', pid: process.pid }, session_id: null }))
  runner.onRequest('session/claim', params => {
    const claim = params as Record<string, unknown>
    claims.push({ short, params: claim })
    return { session_id: String(claim.session_id) }
  })
  child.once('close', () => runner.close('the fixture runner exited'))
}

mock.module('../../src/daemon/headlessRun.ts', () => ({
  ...real,
  spawnRunnerChild: (spec: RunnerChildSpec, opts?: { respawn?: boolean }) => {
    const invocation = real.buildRunnerInvocation(spec, opts)
    const child: Fake = Object.assign(new EventEmitter(), {
      pid: process.pid,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        setTimeout(() => {
          child.emit('exit', 0, null)
          child.emit('close', 0, null)
        }, 5)
        return true
      },
    })
    spawns.push({ short: spec.agentName, respawn: opts?.respawn === true, argv: invocation.argv.slice(1), spec: JSON.parse(JSON.stringify(spec)) as RunnerChildSpec })
    latest.set(spec.agentName, child)
    scriptedRunner(spec.agentName, child)
    return { child, argv: invocation.argv, env: invocation.env, capabilities: invocation.capabilities }
  },
}))

const { TaskRoster } = await import('../../src/daemon/roster.ts')
const sup = await import('../../src/daemon/concourseWorkers.ts')
const warm = await import('../../src/daemon/warmRunner.ts')
const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))

const roster = new TaskRoster({ dir: daemonHome, breaker: {} as never, maxInflight: 3 })
const warmDeps = { roster: () => roster, dir: daemonHome }
const admit = sup.makeConcourseAdmitHandler({
  roster: () => roster,
  dir: daemonHome,
  claimWarm: args => warm.claimWarmRunner({ ...args, answerDeadlineMs: 5_000 }, warmDeps),
  ensureWarm: () => {},
})

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
async function until<T>(read: () => T | undefined, ms = 20_000): Promise<T | undefined> {
  const stop = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() > stop) return value
    await sleep(15)
  }
}

const spawnsOf = (short: string): Spawn[] => spawns.filter(s => s.short === short)
const workspace = (tag: string): string => realpathSync(mkdtempSync(join(scratch, `ws-${tag}-`)))
const recordOf = (short: string) => sup.readSessionWorkers(daemonHome)[short]
const postureOf = (short: string) => ({ permissionMode: recordOf(short)?.permissionMode, bypassConsent: recordOf(short)?.bypassConsent })

function crash(short: string): void {
  const child = latest.get(short)
  child?.emit('exit', 1, null)
  child?.emit('close', 1, null)
}

async function settle(short: string): Promise<void> {
  roster.expectExit(short, true)
  const child = latest.get(short)
  child?.emit('exit', 0, null)
  child?.emit('close', 0, null)
  await sleep(10)
}

const registryDefault = await validateWorkerModelChoice(undefined, 'session')
if (!registryDefault.ok) throw new Error(`the registry default is unavailable in this home: ${registryDefault.reason}`)
const MODEL = registryDefault.entry.modelId

type Claimed = { name: string; warmConsent: boolean; claim: 'sovereign' | 'default' | 'implement' | 'flow'; words: string[] }
const bootWordsOf = (consent: boolean): string[] => (consent ? ['--mode', 'flow', '--allow-sovereign'] : ['--mode', 'flow'])
const respawnArgvOf = (respawn: Spawn, words: string[], tail: string[]): string[] => ['runner', ...words, '--model', respawn.spec.model, '--brief-add', respawn.spec.appendSystemPrompt, ...tail]

async function claimedSeat(c: Claimed): Promise<void> {
  const ws = workspace('claimed')
  const warmed = await warm.ensureWarmRunner({ workspaceDir: ws, ...(c.warmConsent ? { bypassConsent: true as const } : {}) }, warmDeps)
  const short = warmed.short ?? ''
  check(`${c.name}: the pool warms a runner`, warmed.state === 'warmed' && short !== '', j(warmed))
  const boot = spawnsOf(short)[0]
  check(
    `${c.name}: the warm boot argv is the pool's own (${bootWordsOf(c.warmConsent).join(' ')}, no identity)`,
    boot !== undefined && !boot.respawn && j(boot.argv) === j(['runner', ...bootWordsOf(c.warmConsent), '--model', boot.spec.model, '--brief-add', boot.spec.appendSystemPrompt]),
    j(boot?.argv),
  )
  const admitted = await admit({ workspaceDir: ws, permissionMode: c.claim, ...(c.warmConsent ? { bypassConsent: true as const } : {}) })
  const sessionId = admitted.ok ? admitted.sessionId : ''
  check(`${c.name}: the admission claims the warm runner`, admitted.ok && admitted.runnerId === short, j(admitted))
  const claim = claims.find(x => x.short === short)?.params
  check(
    `${c.name}: the claim frame carries the session, the model and the posture`,
    claim !== undefined && claim.session_id === sessionId && claim.model === MODEL && claim.mode === c.claim,
    j(claim),
  )
  check(
    `${c.name}: the record holds the claim's posture`,
    postureOf(short).permissionMode === c.claim && (postureOf(short).bypassConsent === true) === c.warmConsent,
    j(postureOf(short)),
  )
  crash(short)
  const respawn = await until(() => spawnsOf(short).find(s => s.respawn))
  check(
    `${c.name}: a crash respawns the claimed seat under the claim's posture (${c.words.join(' ') || 'no posture word'}) and resumes the session`,
    respawn !== undefined && j(respawn.argv) === j(respawnArgvOf(respawn, c.words, ['--resume', sessionId])),
    j(respawn?.argv),
  )
  const posture = respawn === undefined ? undefined : sup.spawnPostureOf(respawn.spec)
  check(
    `${c.name}: the respawn spec and the record name one posture`,
    posture !== undefined && posture.permissionMode === postureOf(short).permissionMode && (posture.bypassConsent === true) === (postureOf(short).bypassConsent === true),
    j({ spec: posture, record: postureOf(short) }),
  )
  await settle(short)
}

console.log('============================================================')
console.log(' warm claim respawn posture — a claimed seat comes back under the posture it was claimed with')
console.log(` platform: ${process.platform} — the same laws hold on every platform`)
console.log(" red on the base: §1 a claimed seat's respawn wears the pool's boot posture, and its spec and record name two postures (8 checks); §2 the same on the reactivation claim (2); §3 the same on a reconfigure respawn (1) — 11 of 45")
console.log('============================================================')

section('§1 the first-birth claim: the pool boots under flow, the claim names another posture')
const CASES: Claimed[] = [
  { name: 'sovereign over a consented flow boot', warmConsent: true, claim: 'sovereign', words: ['--sovereign'] },
  { name: 'default over an unconsented flow boot', warmConsent: false, claim: 'default', words: [] },
  { name: 'default over a consented flow boot', warmConsent: true, claim: 'default', words: ['--allow-sovereign'] },
  { name: 'implement over an unconsented flow boot', warmConsent: false, claim: 'implement', words: ['--mode', 'implement'] },
]
for (const c of CASES) await claimedSeat(c)

section('§2 the reactivation claim: a parked session takes a warm runner under a posture')
{
  const ws = workspace('reactivate')
  const wsId = sup.canonicalWorkspaceId(ws)
  const parkedSid = '00000000-eeee-4000-8000-0000000000a1'
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
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: `${parkedSid}-u1`, sessionId: parkedSid, message: { role: 'user', content: 'seeded turn' } })}\n`)
  sup.updateConcourseWorkers(workers => {
    workers[parkedShort] = parked as never
  }, daemonHome)
  const warmed = await warm.ensureWarmRunner({ workspaceDir: ws, bypassConsent: true }, warmDeps)
  const short = warmed.short ?? ''
  check('reactivate: the pool warms a runner', warmed.state === 'warmed' && short !== '' && short !== parkedShort, j(warmed))
  const admitted = await admit({ workspaceDir: ws, resumeSessionId: parkedSid, permissionMode: 'sovereign', bypassConsent: true })
  check('reactivate: the resume is admitted on the claimed runner', admitted.ok && admitted.runnerId === short && admitted.sessionId === parkedSid, j(admitted))
  const claim = claims.find(x => x.short === short)?.params
  check('reactivate: the claim frame carries the parked session, resume and the posture', claim !== undefined && claim.session_id === parkedSid && claim.resume === true && claim.mode === 'sovereign', j(claim))
  check("reactivate: the record holds the claim's posture", postureOf(short).permissionMode === 'sovereign' && postureOf(short).bypassConsent === true, j(postureOf(short)))
  crash(short)
  const respawn = await until(() => spawnsOf(short).find(s => s.respawn))
  check(
    "reactivate: a crash respawns the seat under the claim's posture (--sovereign) and resumes the parked session",
    respawn !== undefined && j(respawn.argv) === j(respawnArgvOf(respawn, ['--sovereign'], ['--resume', parkedSid])),
    j(respawn?.argv),
  )
  const posture = respawn === undefined ? undefined : sup.spawnPostureOf(respawn.spec)
  check(
    'reactivate: the respawn spec and the record name one posture',
    posture !== undefined && posture.permissionMode === postureOf(short).permissionMode && (posture.bypassConsent === true) === (postureOf(short).bypassConsent === true),
    j({ spec: posture, record: postureOf(short) }),
  )
  await settle(short)
}

section('§3 a model or effort change respawns the claimed seat: the same spec, the same posture')
{
  const ws = workspace('reconfigure')
  const warmed = await warm.ensureWarmRunner({ workspaceDir: ws, bypassConsent: true }, warmDeps)
  const short = warmed.short ?? ''
  const admitted = await admit({ workspaceDir: ws, permissionMode: 'sovereign', bypassConsent: true })
  const sessionId = admitted.ok ? admitted.sessionId : ''
  check('reconfigure: the admission claims the warm runner', warmed.state === 'warmed' && admitted.ok && admitted.runnerId === short, j({ warmed, admitted }))
  const changed = roster.reconfigureLongLived(short, { effort: 'low' })
  check('reconfigure: an effort change on the idle claimed seat respawns it at once', changed.ok && changed.respawned, j(changed))
  const respawn = await until(() => spawnsOf(short).find(s => s.respawn))
  check(
    "reconfigure: the respawned seat keeps the claim's posture (--sovereign) and resumes the session",
    respawn !== undefined && j(respawn.argv) === j(respawnArgvOf(respawn, ['--sovereign'], ['--resume', sessionId])),
    j(respawn?.argv),
  )
  await settle(short)
}

section("§4 controls: a claim that names the pool's own posture, an unclaimed warm seat and cold seats keep their argv")
{
  const name = 'flow over an unconsented flow boot'
  const ws = workspace('same')
  const warmed = await warm.ensureWarmRunner({ workspaceDir: ws }, warmDeps)
  const short = warmed.short ?? ''
  const admitted = await admit({ workspaceDir: ws, permissionMode: 'flow' })
  const sessionId = admitted.ok ? admitted.sessionId : ''
  check(`${name}: the admission claims the warm runner`, warmed.state === 'warmed' && admitted.ok && admitted.runnerId === short, j({ warmed, admitted }))
  crash(short)
  const respawn = await until(() => spawnsOf(short).find(s => s.respawn))
  check(
    `${name}: the respawn keeps the boot posture words (--mode flow) and resumes the session`,
    respawn !== undefined && j(respawn.argv) === j(respawnArgvOf(respawn, ['--mode', 'flow'], ['--resume', sessionId])),
    j(respawn?.argv),
  )
  await settle(short)
}
{
  const ws = workspace('unclaimed')
  const warmed = await warm.ensureWarmRunner({ workspaceDir: ws, bypassConsent: true }, warmDeps)
  const short = warmed.short ?? ''
  const boot = spawnsOf(short)[0]
  crash(short)
  const respawn = await until(() => spawnsOf(short).find(s => s.respawn))
  check(
    'an unclaimed warm seat respawns with its boot argv, byte for byte (still identityless)',
    boot !== undefined && respawn !== undefined && j(respawn.argv) === j(boot.argv) && j(respawn.argv) === j(['runner', '--mode', 'flow', '--allow-sovereign', '--model', boot.spec.model, '--brief-add', boot.spec.appendSystemPrompt]),
    j({ boot: boot?.argv, respawn: respawn?.argv }),
  )
  check('an unclaimed warm seat has no claim and no record', claims.every(x => x.short !== short) && recordOf(short) === undefined)
  await settle(short)
}
for (const c of [
  { name: 'sovereign' as const, consent: true, words: ['--sovereign'] },
  { name: 'default' as const, consent: false, words: [] },
]) {
  const label = `a cold ${c.name} seat`
  const ws = workspace('cold')
  const admitted = await admit({ workspaceDir: ws, permissionMode: c.name, ...(c.consent ? { bypassConsent: true as const } : {}) })
  const short = admitted.ok ? admitted.runnerId : ''
  const sessionId = admitted.ok ? admitted.sessionId : ''
  const boot = spawnsOf(short)[0]
  check(
    `${label}: boots with its posture and pins its identity (${c.words.join(' ') || 'no posture word'} --session-id)`,
    admitted.ok && boot !== undefined && !boot.respawn && claims.every(x => x.short !== short) && j(boot.argv) === j(['runner', ...c.words, '--model', boot.spec.model, '--brief-add', boot.spec.appendSystemPrompt, '--session-id', sessionId]),
    j(boot?.argv),
  )
  crash(short)
  const respawn = await until(() => spawnsOf(short).find(s => s.respawn))
  check(
    `${label}: a crash respawns it under the same posture and resumes the session`,
    respawn !== undefined && j(respawn.argv) === j(respawnArgvOf(respawn, c.words, ['--resume', sessionId])),
    j(respawn?.argv),
  )
  await settle(short)
}

clearTimeout(watchdog)
console.error = realConsoleError
if (failures !== 0) {
  console.log('\n[forensics] the last daemon lines:')
  for (const line of daemonLog.slice(-12)) console.log(`  ${line}`)
  console.log(`[forensics] world kept: ${scratch}`)
} else {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    console.log(`  scratch kept: ${scratch}`)
  }
}
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-warm-claim-respawn-posture: ALL LAWS HOLD' : `prove-warm-claim-respawn-posture: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
