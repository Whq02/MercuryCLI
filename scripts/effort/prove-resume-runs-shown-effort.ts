#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'resume-runs-shown-effort-')))
const home = join(scratch, 'home')
const daemon = join(scratch, 'daemon')
const work = join(scratch, 'work')
const otherWork = join(scratch, 'other-work')
for (const dir of [home, daemon, work, otherWork]) mkdirSync(dir, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemon
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'sk-ant-effort-resume-proof'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_MODEL
delete process.env.MERCURY_DAEMON_PERMISSION_MODE
delete process.env.MERCURY_SKIP_PERMISSIONS

seedFirstRun(home, [work, otherWork])
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ engine: { model: 'claude-opus-5-5', effort: 'max' } }),
)

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail: string, fixWhere: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail} — ${fixWhere}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

const hooks: {
  admit: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
} = {
  admit: async () => ({ ok: false, error: 'unarmed' }),
}

const realEnsure = await import('../../src/daemon/switchboard/ensureDaemon.js')
mock.module('../../src/daemon/switchboard/ensureDaemon.js', () => ({
  ...realEnsure,
  ensureOwnedDaemon: async () => true,
}))

const realControl = await import('../../src/daemon/control/controlSocket.js')
mock.module('../../src/daemon/control/controlSocket.js', () => ({
  ...realControl,
  daemonControlRpc: async (request: Record<string, unknown>) => {
    if (request.op === 'sessionAdmit') return hooks.admit(request)
    if (request.op === 'ping') return { ok: true }
    return { ok: true, outcome: 'applied' }
  },
}))

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.js')
const { buildRunnerInvocation } = await import('../../src/daemon/runner-link/headlessRun.js')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.js')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.js')
const facts = await import('../../src/daemon/switchboard/bootBirthFacts.js')
const { bornSession } = await import('../../src/daemon/switchboard/bornSession.js')
const { focusResumedSession } = await import('../../src/daemon/switchboard/hopIntoSession.js')
const { releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')
const { focusedEffortLabelOf } = await import('../../src/screen/widgets/EffortChip.js')
const { restingStatusWords } = await import('../../src/screen/chat/SwitchboardTagBar.js')
const { renderModelChip } = await import('../../src/models/catalogue/engineModel.js')

const BOOT_MODEL = 'claude-sonnet-5-5'
const SAVED_MODEL = 'claude-opus-5-5'
const BOOT_EFFORT = 'high'
const SAVED_EFFORT = 'max'

type RunnerChildSpec = import('../../src/daemon/runner-link/headlessRun.js').RunnerChildSpec
type AdmittedCapture = {
  wire: Record<string, unknown>
  reply: import('../../src/daemon/concourse-workers/concourseWorkers.js').ConcourseAdmitResult
  spec: RunnerChildSpec | undefined
}

let lastCapture: AdmittedCapture | null = null

const admitHandler = workers.makeConcourseAdmitHandler({
  dir: daemon,
  roster: () => ({
    has: () => ({ present: false }),
    list: () => [],
    registerLongLived: (_id, spec) => {
      if (lastCapture !== null) lastCapture.spec = spec
      return { ok: true }
    },
  }),
})

hooks.admit = async request => {
  const capture: AdmittedCapture = {
    wire: request,
    reply: { ok: false, code: 'invalid-request', error: 'pending' },
    spec: undefined,
  }
  lastCapture = capture
  const req: import('../../src/daemon/concourse-workers/concourseWorkers.js').ConcourseAdmitRequest = {
    workspaceDir: String(request.workspaceDir ?? ''),
    ...(typeof request.birthKey === 'string' ? { birthKey: request.birthKey } : {}),
    ...(typeof request.isolation === 'string' ? { isolation: request.isolation as 'shared' } : {}),
    ...(typeof request.model === 'string' && request.model ? { modelKey: request.model } : {}),
    ...(typeof request.effort === 'string' && request.effort ? { effort: request.effort } : {}),
    ...(typeof request.title === 'string' && request.title ? { title: request.title } : {}),
    ...(typeof request.resumeSessionId === 'string' && request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
    ...(typeof request.permissionMode === 'string' && request.permissionMode ? { permissionMode: request.permissionMode as 'default' } : {}),
    ...(Array.isArray(request.runnerArgv) && request.runnerArgv.length > 0 ? { runnerArgv: request.runnerArgv as string[] } : {}),
    ...(request.bypassConsent === true ? { bypassConsent: true } : {}),
    ...(request.bornBlank === true ? { bornBlank: true } : {}),
    ...(typeof request.resumeSessionId === 'string' && request.resumeSessionId && request.bornBlank !== true ? { resumedAtRest: true as const } : {}),
    ...(typeof request.by === 'string' && request.by ? { by: request.by } : {}),
    ...(request.restartReason === 'update' ? { restartReason: 'update' as const } : {}),
  }
  const reply = await admitHandler(req)
  capture.reply = reply
  if (!reply.ok) return { ok: false, error: reply.error, refusal: reply.code }
  return {
    ok: true,
    workerId: reply.runnerId,
    runnerId: reply.runnerId,
    sessionId: reply.sessionId,
    workspaceId: reply.workspaceId,
    ...(reply.modelId !== undefined ? { modelId: reply.modelId } : {}),
    ...(reply.effort !== undefined ? { effort: reply.effort } : {}),
    ...(reply.liveHop === true ? { liveHop: true } : {}),
  }
}

function seedTranscript(workspaceDir: string, sessionId: string, model: string, effort: string): string {
  const project = getProjectDir(workers.canonicalWorkspaceId(workspaceDir))
  mkdirSync(project, { recursive: true })
  const path = join(project, `${sessionId}.jsonl`)
  const u1 = randomUUID()
  const a1 = randomUUID()
  const rows = [
    {
      type: 'user',
      cwd: workspaceDir,
      sessionId,
      uuid: u1,
      parentUuid: null,
      timestamp: new Date().toISOString(),
      isSidechain: false,
      entrypoint: 'cli',
      version: '1.0.0',
      message: { role: 'user', content: 'Seed turn.' },
    },
    {
      type: 'assistant',
      cwd: workspaceDir,
      sessionId,
      uuid: a1,
      parentUuid: u1,
      timestamp: new Date().toISOString(),
      isSidechain: false,
      entrypoint: 'cli',
      version: '1.0.0',
      effort: { asked: effort, applied: effort, wire: `output_config.effort=${effort}` },
      message: {
        id: randomUUID(),
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'Seed reply.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]
  writeFileSync(
    path,
    rows.map(row => (encodeTranscriptLine as (p: string, r: Record<string, unknown>) => { line: string })(path, row).line).join(''),
  )
  return path
}

function assertRunnerMatchesBoot(road: string, capture: AdmittedCapture | null, expectResumeId?: string): void {
  const fixInvocation = 'pass --effort <spec.effort> in buildRunnerInvocation (src/daemon/runner-link/headlessRun.ts) alongside --model'
  const fixResumeCarry = 'carry bootBirthFacts().effort, model and runnerArgv in focusResumedSession (src/daemon/switchboard/hopIntoSession.ts) and reactivateConcourseSession (src/daemon/concourse-workers/admit.ts, src/daemon/concourse-workers/reactivate.ts)'
  check(`${road}: admission succeeded and registered a runner spec`, capture !== null && capture.reply.ok && capture.spec !== undefined, JSON.stringify(capture?.reply), fixResumeCarry)
  if (!capture || !capture.reply.ok || !capture.spec) return
  const inv = buildRunnerInvocation(capture.spec)
  const respawnInv = buildRunnerInvocation(capture.spec, { respawn: true })
  const rec = workers.readSessionWorkers(daemon)[capture.reply.runnerId]
  const shown = restingStatusWords(renderModelChip(capture.spec.model), focusedEffortLabelOf(capture.spec.model, rec?.effort ?? null, undefined, undefined, undefined, false))
  check(`${road}: sessionAdmit carried boot effort '${BOOT_EFFORT}'`, capture.wire.effort === BOOT_EFFORT, `wire.effort=${JSON.stringify(capture.wire.effort)}`, fixResumeCarry)
  check(`${road}: sessionAdmit carried boot model '${BOOT_MODEL}'`, capture.wire.model === BOOT_MODEL, `wire.model=${JSON.stringify(capture.wire.model)}`, fixResumeCarry)
  check(`${road}: runner argv carries --effort ${BOOT_EFFORT} beside --model ${BOOT_MODEL}`, flagValue(inv.argv, '--effort') === BOOT_EFFORT && flagValue(inv.argv, '--model') === BOOT_MODEL, `argv=${JSON.stringify(inv.argv)}`, fixInvocation)
  check(`${road}: respawn argv also carries --effort ${BOOT_EFFORT}`, flagValue(respawnInv.argv, '--effort') === BOOT_EFFORT, `respawn argv=${JSON.stringify(respawnInv.argv)}`, fixInvocation)
  check(`${road}: runner env stamps MERCURY_EFFORT_LEVEL=${BOOT_EFFORT}`, inv.env.MERCURY_EFFORT_LEVEL === BOOT_EFFORT, `MERCURY_EFFORT_LEVEL=${JSON.stringify(inv.env.MERCURY_EFFORT_LEVEL)}`, fixInvocation)
  check(`${road}: runner argv carries boot thinking flag --reasoning-mode disabled`, flagValue(inv.argv, '--reasoning-mode') === 'disabled', `argv=${JSON.stringify(inv.argv)}`, fixResumeCarry)
  if (expectResumeId !== undefined) {
    check(`${road}: runner argv resumes ${expectResumeId}`, flagValue(inv.argv, '--resume') === expectResumeId, `argv=${JSON.stringify(inv.argv)}`, fixResumeCarry)
  }
  check(`${road}: status row effort matches runner --effort (${BOOT_EFFORT})`, shown.endsWith(` · ${BOOT_EFFORT}`) && rec?.effort === BOOT_EFFORT, `shown=${JSON.stringify(shown)} rec.effort=${JSON.stringify(rec?.effort)}`, fixResumeCarry)
}

try {
  facts._resetBootBirthFactsForTesting()
  facts.setBootBirthFacts({
    model: BOOT_MODEL,
    effort: BOOT_EFFORT,
    permissionMode: 'default',
    bypassConsent: true,
    runnerArgv: ['--reasoning-mode', 'disabled'],
  })

  section('§1 New Session carries boot --effort, --model and --reasoning-mode into runner argv')
  {
    lastCapture = null
    const born = await bornSession({ workspaceDir: work, firstPaintMs: 10 })
    check('New Session opened', born.ok, JSON.stringify(born), 'check bornSession in src/daemon/switchboard/bornSession.ts')
    assertRunnerMatchesBoot('New Session', lastCapture)
    releaseFocusedSessionConnector()
  }

  section('§2 Continue Last Session (in this folder) runs boot --effort, --model and --reasoning-mode')
  {
    const sid = randomUUID()
    const transcript = seedTranscript(work, sid, SAVED_MODEL, SAVED_EFFORT)
    lastCapture = null
    const outcome = await focusResumedSession(sid, transcript, { permissionMode: 'default', firstPaintMs: 10 })
    await outcome.admitted
    assertRunnerMatchesBoot('Continue Last Session (cwd)', lastCapture, sid)
    releaseFocusedSessionConnector()
  }

  section('§3 Continue Last Session (in another folder) runs boot --effort, --model and --reasoning-mode')
  {
    const sid = randomUUID()
    const transcript = seedTranscript(otherWork, sid, SAVED_MODEL, SAVED_EFFORT)
    lastCapture = null
    const outcome = await focusResumedSession(sid, transcript, { title: 'other-work', firstPaintMs: 10 })
    await outcome.admitted
    assertRunnerMatchesBoot('Continue Last Session (other folder)', lastCapture, sid)
    releaseFocusedSessionConnector()
  }

  section('§4 Resume from Session Manager (parked standing record) overrides saved max with boot high')
  {
    const sid = randomUUID()
    const transcript = seedTranscript(work, sid, SAVED_MODEL, SAVED_EFFORT)
    workers.updateConcourseWorkers(records => {
      records['concourse-w91'] = {
        schema: 1,
        runnerId: 'concourse-w91',
        sessionId: sid,
        workspaceId: workers.canonicalWorkspaceId(work),
        isolation: 'shared',
        modelKey: SAVED_MODEL,
        effort: SAVED_EFFORT,
        spawnedAt: Date.now() - 10_000,
        lastLiveAt: Date.now() - 5_000,
        parkedAt: Date.now() - 2_000,
        parkedBy: 'operator:fixture',
      }
    }, daemon)
    lastCapture = null
    const outcome = await focusResumedSession(sid, transcript, { title: 'Session Manager row', permissionMode: 'default', firstPaintMs: 10 })
    await outcome.admitted
    assertRunnerMatchesBoot('Session Manager (reactivate)', lastCapture, sid)
    releaseFocusedSessionConnector()
  }

  section('§5 Resume from /sessions runs boot --effort, --model and --reasoning-mode')
  {
    const sid = randomUUID()
    const transcript = seedTranscript(work, sid, SAVED_MODEL, SAVED_EFFORT)
    lastCapture = null
    const outcome = await focusResumedSession(sid, transcript, { title: 'from-slash-sessions', permissionMode: 'default', firstPaintMs: 10 })
    await outcome.admitted
    assertRunnerMatchesBoot('/sessions', lastCapture, sid)
    releaseFocusedSessionConnector()
  }

  section('§6 Control: /restart (restartReason=update) keeps the session own standing model and effort')
  {
    const sid = randomUUID()
    const transcript = seedTranscript(work, sid, 'claude-haiku-5-5', 'low')
    workers.updateConcourseWorkers(records => {
      records['concourse-w92'] = {
        schema: 1,
        runnerId: 'concourse-w92',
        sessionId: sid,
        workspaceId: workers.canonicalWorkspaceId(work),
        isolation: 'shared',
        modelKey: 'claude-haiku-5-5',
        effort: 'low',
        spawnedAt: Date.now() - 10_000,
        lastLiveAt: Date.now() - 5_000,
        parkedAt: Date.now() - 2_000,
        parkedBy: 'operator:restart',
      }
    }, daemon)
    lastCapture = null
    const outcome = await focusResumedSession(sid, transcript, { restartReason: 'update', firstPaintMs: 10 })
    await outcome.admitted
    const restartCapture = lastCapture as AdmittedCapture | null
    const inv = restartCapture?.spec ? buildRunnerInvocation(restartCapture.spec) : null
    check('/restart keeps standing effort low (does not overwrite with stale boot high)', inv !== null && flagValue(inv.argv, '--effort') === 'low', `argv=${JSON.stringify(inv?.argv)}`, 'do not carry boot model/effort over restartReason === "update" in focusResumedSession (src/daemon/switchboard/hopIntoSession.ts)')
    check('/restart keeps standing model claude-haiku-5-5', inv !== null && flagValue(inv.argv, '--model') === 'claude-haiku-5-5', `argv=${JSON.stringify(inv?.argv)}`, 'do not carry boot model/effort over restartReason === "update" in focusResumedSession (src/daemon/switchboard/hopIntoSession.ts)')
    releaseFocusedSessionConnector()
  }
} finally {
  facts._resetBootBirthFactsForTesting()
  releaseFocusedSessionConnector()
  removeScratch(scratch)
}

console.log(`\nprove-resume-runs-shown-effort: ${checks - failures}/${checks} PASS`)
process.exit(failures === 0 ? 0 : 1)
