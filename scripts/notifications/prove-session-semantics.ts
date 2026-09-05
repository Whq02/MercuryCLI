#!/usr/bin/env bun
// gate-class: heavy
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'session-semantics-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const ws = join(SCRATCH, 'ws-sem')
const crewDir = join(SCRATCH, 'crew')
for (const d of [home, daemonDir, work, ws, crewDir]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
seedFirstRun(home, [work, ws])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { enableConfigs: __enableConfigs } = await import('../../src/utils/config.ts')
__enableConfigs()
const __wm = await import('../../src/services/concourse/workerModels.ts')
const RIG_MODEL = __wm.defaultWorkerModelId(await __wm.composeWorkerModelRegistry(), 'session')
const api = await startFixtureApi([
  { kind: 'text', text: 'pong — the first worker turn' },
  { kind: 'text', text: 'STEER-OK' },
  { kind: 'hang', deltas: ['working on something long…'] },
  { kind: 'text', text: 'AFTER-INTERRUPT-OK' },
  { kind: 'text', text: 'AFTER-RESUME-OK' },
])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — semantics journey exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 90_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return true
    if (Date.now() > deadline) return false
    await wait(250)
  }
}

console.log('session semantics — dispatch, redirect, interrupt, pause valve, answer, no shadows')

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const env = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  ANTHROPIC_API_KEY: 'fixture-key',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_CACHE_CLOCK: '0',
}
const daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
  cwd: work,
  env,
  stdio: ['ignore', logFd, logFd],
})

try {
  const up = await untilAsync(async () => {
    try {
      return ((await daemonControlRpc({ op: 'concourseList' } as never, { timeoutMs: 2000 })) as { ok?: boolean }).ok === true
    } catch {
      return false
    }
  }, 60_000)
  check('the daemon is up', up)

  const dispatch = (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId: 'sem-1',
      prompt: 'say pong',
      workspaceDir: ws,
      isolation: 'read-only',
      model: RIG_MODEL,
      title: 'Semantics worker',
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; sessionId?: string; state?: string; error?: string }
  check('dispatch admits + delivers (state working)', dispatch.ok === true && dispatch.state === 'working', dispatch.error ?? dispatch.state ?? '')
  const sessionId = String(dispatch.sessionId ?? '')

  const { workerTranscriptPath, openWorkerTranscript } = await import('../../src/services/concourse/workerTranscript.ts')
  const recOf = async (): Promise<{ workspaceId?: string; pid?: number; paused?: boolean } | undefined> => {
    const list = (await daemonControlRpc({ op: 'concourseList' } as never, { timeoutMs: 5000 })) as {
      workers?: Array<{ sessionId: string; workspaceId?: string; pid?: number; pausedAt?: number }>
    }
    const r = list.workers?.find(w => w.sessionId === sessionId)
    return r ? { workspaceId: r.workspaceId, pid: r.pid, paused: r.pausedAt !== undefined } : undefined
  }
  await untilAsync(async () => (await recOf()) !== undefined, 30_000)
  const rec0 = await recOf()
  const tpath = workerTranscriptPath({ sessionId, workspaceId: rec0?.workspaceId ?? ws })
  const inTranscript = (needle: string) => (): boolean => {
    try {
      return openWorkerTranscript(tpath).records.some(r => JSON.stringify(r).includes(needle))
    } catch {
      return false
    }
  }
  check('turn 1 landed in the worker transcript', await untilAsync(inTranscript('pong — the first worker turn')), tpath)
  const pidBefore = (await recOf())?.pid
  check('the worker has a live pid', typeof pidBefore === 'number', String(pidBefore))

  const redirect = (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId: 'sem-2',
      prompt: 'steer now',
      workspaceDir: ws,
      isolation: 'read-only',
      model: RIG_MODEL,
      targetSessionId: sessionId,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; state?: string; error?: string }
  check('redirect delivers into the live session (state working)', redirect.ok === true && redirect.state === 'working', redirect.error ?? '')
  check('the steer turn landed', await untilAsync(inTranscript('STEER-OK')))

  const hung = (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId: 'sem-3',
      prompt: 'begin the long task',
      workspaceDir: ws,
      isolation: 'read-only',
      model: RIG_MODEL,
      targetSessionId: sessionId,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; error?: string }
  check('the hung-turn delivery is accepted', hung.ok === true, hung.error ?? '')
  await api.messageRequestStarted(3)
  const interrupt = (await daemonControlRpc(
    { op: 'sessionControl', action: 'interrupt', sessionId, by: 'operator' } as never,
    { timeoutMs: 10_000 },
  )) as { ok?: boolean; outcome?: string; detail?: string }
  check('interrupt receipt: applied through the worker control channel', interrupt.outcome === 'applied', interrupt.detail ?? '')
  const afterInterrupt = (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId: 'sem-4',
      prompt: 'confirm you are back',
      workspaceDir: ws,
      isolation: 'read-only',
      model: RIG_MODEL,
      targetSessionId: sessionId,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; error?: string }
  check('post-interrupt delivery is accepted', afterInterrupt.ok === true, afterInterrupt.error ?? '')
  check('the post-interrupt turn completed (the abort consequence)', await untilAsync(inTranscript('AFTER-INTERRUPT-OK'), 120_000))

  const pause = (await daemonControlRpc(
    { op: 'sessionControl', action: 'pause', sessionId, by: 'operator' } as never,
    { timeoutMs: 10_000 },
  )) as { outcome?: string; detail?: string }
  check('pause receipt: applied', pause.outcome === 'applied', pause.detail ?? '')
  check('the record shows paused', await untilAsync(async () => (await recOf())?.paused === true, 15_000))
  const heldTry = (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId: 'sem-5',
      prompt: 'deliver after resume',
      workspaceDir: ws,
      isolation: 'read-only',
      model: RIG_MODEL,
      targetSessionId: sessionId,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; error?: string; state?: string }
  check(
    'a redirect while paused is HELD with the typed reason (never failed)',
    heldTry.ok === false && (heldTry as { heldReason?: string }).heldReason === 'session-paused' && heldTry.state === 'queued',
    `ok=${heldTry.ok} state=${heldTry.state} err=${heldTry.error ?? ''}`,
  )
  const { readConcourseDispatches } = await import('../../src/daemon/concourseDispatch.ts')
  const heldRow = readConcourseDispatches(daemonDir)['sem-5']
  check('the ledger row carries heldReason session-paused', heldRow?.heldReason === 'session-paused', JSON.stringify(heldRow ?? {}))
  const resume = (await daemonControlRpc(
    { op: 'sessionControl', action: 'resume', sessionId, by: 'operator' } as never,
    { timeoutMs: 10_000 },
  )) as { outcome?: string; detail?: string }
  check('resume receipt: applied', resume.outcome === 'applied', resume.detail ?? '')
  const replay = (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId: 'sem-5',
      prompt: 'deliver after resume',
      workspaceDir: ws,
      isolation: 'read-only',
      model: RIG_MODEL,
      targetSessionId: sessionId,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; state?: string; error?: string }
  check('the SAME-id replay after resume delivers (state working)', replay.ok === true && replay.state === 'working', replay.error ?? '')
  check('the held turn completed after resume', await untilAsync(inTranscript('AFTER-RESUME-OK'), 120_000))
  const replayAgain = (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId: 'sem-5',
      prompt: 'deliver after resume',
      workspaceDir: ws,
      isolation: 'read-only',
      model: RIG_MODEL,
      targetSessionId: sessionId,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; replay?: string }
  check('a second replay of the same id returns the SAME receipt (no re-delivery)', replayAgain.replay === 'replayed', JSON.stringify(replayAgain))

  const obligations = await import('../../src/services/crew/obligations.ts')
  const raised = await obligations.upsertObligation({
    ref: 'sem-permission-1',
    sessionId,
    question: 'Approve the demo permission?',
    owner: 'Mercury',
    dir: crewDir,
  } as never)
  const openBefore = await obligations.openObligations({ dir: crewDir })
  check('the obligation is a durable open needs-you row', openBefore.some(o => o.obligationId === raised.obligationId))
  const settled = await obligations.resolveObligation(raised.obligationId, {
    kind: 'answered',
    by: 'operator',
    dir: crewDir,
  } as never)
  check('resolveObligation settles it answered', settled.settled === true && settled.status === 'answered', JSON.stringify(settled))
  const openAfter = await obligations.openObligations({ dir: crewDir })
  check('no open row remains after the answer', !openAfter.some(o => o.obligationId === raised.obligationId))

  const modelCalls = api.messageRequests().length
  check('the provider saw EXACTLY the five scripted worker turns', modelCalls === 5, `${modelCalls} calls`)
  const pidAfter = (await recOf())?.pid
  check('the worker pid never changed across every semantic', pidAfter === pidBefore, `${pidBefore} → ${pidAfter}`)
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 8000 })
  } catch {
  }
  daemon.kill('SIGTERM')
  await wait(500)
  try {
    daemon.kill('SIGKILL')
  } catch {
  }
  await api.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`  [evidence] scratch kept: ${SCRATCH}`)
}

{
  console.log('\n' + '─'.repeat(76) + '\nSR-094 — the typed control vocabulary census (cancel = vacuous by design)')
  const { readFileSync } = await import('node:fs')
  const proto = readFileSync(join(process.cwd(), 'src/daemon/protocol.ts'), 'utf8')
  const controlBlock = proto.slice(proto.indexOf("op: 'sessionControl'"))
  const actionBlock = controlBlock.slice(controlBlock.indexOf('action:'), controlBlock.indexOf('sessionId'))
  const union = [...new Set([...actionBlock.matchAll(/'([a-z-]+)'/g)].map(m => m[1]))].join(' | ')
  check(
    "the session-control union is EXACTLY the switchboard vocabulary (pause·resume·interrupt·attach·detach·grant/revoke-workflows·answer-permission·stop) + the seat doors (set-model·set-permission-mode·session-facts·set-title·focus·blur·park·park-all·set-effort·contract·set-kit·set-schedule·set-spawn-switch)",
    union ===
      'pause | resume | interrupt | attach | detach | grant-workflows | revoke-workflows | answer-permission | stop | set-model | set-permission-mode | session-facts | set-title | focus | blur | park | park-all | set-effort | contract | set-kit | set-schedule | set-spawn-switch | stop-agent | resume-agent | withdraw-send',
    union,
  )
  check(
    "no typed 'cancel' verb exists anywhere in the daemon protocol — the CANCEL semantic is owned by 'interrupt' (turn abort) and the composers' esc (local cancel); a session-level cancel verb is VACUOUS by design",
    !/['"]cancel['"]/.test(proto),
    'protocol carries no cancel spelling',
  )
}

if (failures > 0) {
  console.log(`\n❌ prove-session-semantics — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✅ prove-session-semantics — all checks pass')
