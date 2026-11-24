#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSubprocess(
  body: string,
  opts?: { allowNonZero?: boolean },
): { status: number | null; stdout: string; stderr: string; out: Record<string, unknown> } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn01-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n__OUT__' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (!opts?.allowNonZero && res.status !== 0) {
      throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1200)}`)
    }
    const marker = res.stdout.lastIndexOf('__OUT__')
    const out = marker >= 0 ? (JSON.parse(res.stdout.slice(marker + 7).trim()) as Record<string, unknown>) : {}
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, out }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nsessionsVerb.ts — unreadable projects dir or project store rejects instead of saying absent')
if (!POSIX_MODES) skip('sessionsVerb unreadable dirs', 'chmod 0000 needs non-root POSIX')
else {
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const paths = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/paths.ts'))})
    const verb = await import(${JSON.stringify(join(SRC, 'commands/verbs/sessionsVerb.ts'))})
    const sid = '11111111-1111-4111-8111-111111111111'
    const absentSid = '99999999-9999-4999-8999-999999999999'
    const projectsDir = paths.getProjectsDir()
    const store = paths.getProjectDir(PROJECT)
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, sid + '.jsonl'), '{"type":"user"}\\n')
    const runDelete = async id => {
      const errLines = []
      try {
        const rc = await verb.sessionsDeleteCli(id, { yes: true }, {
          out: () => {},
          err: line => errLines.push(line),
          interactive: false,
          ask: async () => false,
        })
        return { threw: null, rc, errLines }
      } catch (e) {
        return { threw: { code: e?.code ?? null, message: String(e?.message ?? e) }, rc: null, errLines }
      }
    }
    out.absentControl = await runDelete(absentSid)
    fs.chmodSync(projectsDir, 0o000)
    try {
      out.unreadableProjects = await runDelete(sid)
    } finally {
      fs.chmodSync(projectsDir, 0o700)
    }
    fs.chmodSync(store, 0o000)
    try {
      out.unreadableStore = await runDelete(sid)
    } finally {
      fs.chmodSync(store, 0o700)
    }
  `)
  const absent = r.out.absentControl as { threw: unknown; rc: number | null; errLines: string[] }
  const proj = r.out.unreadableProjects as { threw: { code: string | null } | null; rc: number | null; errLines: string[] }
  const store = r.out.unreadableStore as { threw: { code: string | null } | null; rc: number | null; errLines: string[] }
  check('sessionsVerb: absent session on readable store still returns rc 1', absent.threw === null && absent.rc === 1, JSON.stringify(absent))
  check('sessionsVerb: unreadable projects dir rejects with EACCES instead of saying absent', proj.threw?.code === 'EACCES' && proj.errLines.length === 0, JSON.stringify(proj))
  check('sessionsVerb: unreadable project store rejects with EACCES instead of saying absent', store.threw?.code === 'EACCES' && store.errLines.length === 0, JSON.stringify(store))
}

console.log('\nrestartCarry.ts — unreadable transcript rejects; unstatable agent folder is tried and next agent is still carried')
if (!POSIX_MODES) skip('restartCarry unreadable paths', 'chmod 0200/0000 needs non-root POSIX')
else {
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const paths = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/paths.ts'))})
    const relaunchedIds = []
    mock.module(path.join(SRC, 'tools/crewmate/resumeCrewmate.js'), () => ({
      resumeCrewmateBackground: async ({ agentId }) => {
        relaunchedIds.push(agentId)
        if (agentId === 'a12345678') throw new Error('cannot open worktree')
      },
    }))
    const carry = await import(${JSON.stringify(join(SRC, 'daemon/runner/restartCarry.ts'))})
    const absentPath = path.join(HOME, 'missing-transcript.jsonl')
    const basePorts = (transcriptPath, messages = []) => ({
      reason: 'crash',
      messages,
      getAppState: () => ({ tasks: {} }),
      setAppState: () => {},
      canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
      relaunchContext: async () => ({}),
      transcriptPath,
    })
    out.absentTranscript = await carry.carryRunnerAcrossRestart(basePorts(absentPath))
    const unreadableTranscript = path.join(HOME, 'unreadable-transcript.jsonl')
    fs.writeFileSync(unreadableTranscript, '{"type":"queue-operation"}\\n', { mode: 0o600 })
    fs.chmodSync(unreadableTranscript, 0o200)
    try {
      const res = await carry.carryRunnerAcrossRestart(basePorts(unreadableTranscript))
      out.unreadableTranscript = { threw: null, res }
    } catch (e) {
      out.unreadableTranscript = { threw: { code: e?.code ?? null, message: String(e?.message ?? e) }, res: null }
    } finally {
      fs.chmodSync(unreadableTranscript, 0o600)
    }
    const { CREWMATE_TOOL_NAME } = await import(${JSON.stringify(join(SRC, 'tools/kit/names/agent.ts'))})
    const { BACKGROUND_LAUNCH_LINE } = await import(${JSON.stringify(join(SRC, 'engine/tasks/local-agent/launchReceipts.ts'))})
    const agent1 = 'a12345678'
    const agent2 = 'b87654321'
    const twoAgents = [
      {
        type: 'assistant',
        uuid: 'u-launch',
        timestamp: '2026-11-20T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: CREWMATE_TOOL_NAME, input: { description: 'worker1', prompt: 'go1' } },
            { type: 'tool_use', id: 'toolu_2', name: CREWMATE_TOOL_NAME, input: { description: 'worker2', prompt: 'go2' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u-receipt',
        timestamp: '2026-11-20T00:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: BACKGROUND_LAUNCH_LINE + '\\nagentId: ' + agent1 },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: BACKGROUND_LAUNCH_LINE + '\\nagentId: ' + agent2 },
          ],
        },
      },
    ]
    const parentDir = path.join(HOME, 'locked-parent')
    const childDir = path.join(parentDir, 'worktree')
    const okDir = path.join(HOME, 'ok-worktree')
    fs.mkdirSync(childDir, { recursive: true })
    fs.mkdirSync(okDir, { recursive: true })
    await paths.writeCrewmateMetadata(agent1, { agentType: 'general', worktreePath: childDir })
    await paths.writeCrewmateMetadata(agent2, { agentType: 'general', worktreePath: okDir })
    fs.chmodSync(parentDir, 0o000)
    try {
      const res = await carry.carryRunnerAcrossRestart(basePorts(absentPath, twoAgents))
      out.unstatableFolder = { threw: null, res, relaunchedIds: [...relaunchedIds] }
    } catch (e) {
      out.unstatableFolder = { threw: { code: e?.code ?? null, message: String(e?.message ?? e) }, res: null, relaunchedIds: [...relaunchedIds] }
    } finally {
      fs.chmodSync(parentDir, 0o700)
    }
    relaunchedIds.length = 0
    await paths.writeCrewmateMetadata(agent1, { agentType: 'general', worktreePath: path.join(HOME, 'no-such-folder') })
    out.absentFolder = await carry.carryRunnerAcrossRestart(basePorts(absentPath, twoAgents.map(m => ({ ...m }))))
    out.absentFolderTried = [...relaunchedIds]
  `)
  const absentT = r.out.absentTranscript as { requeued: number; stopped: number }
  const unreadT = r.out.unreadableTranscript as { threw: { code: string | null } | null }
  const unstatF = r.out.unstatableFolder as { threw: unknown; res: { relaunched: number; stopped: number } | null; relaunchedIds: string[] }
  const absentF = r.out.absentFolder as { stopped: number; relaunched: number }
  const absentFTried = r.out.absentFolderTried as string[]
  check('restartCarry: absent transcript still answers zero requeued', absentT.requeued === 0 && absentT.stopped === 0, JSON.stringify(absentT))
  check('restartCarry: unreadable transcript rejects with EACCES', unreadT.threw?.code === 'EACCES', JSON.stringify(unreadT))
  check('restartCarry: unstatable agent folder is tried for relaunch and the next agent is still carried', unstatF.threw === null && unstatF.relaunchedIds.includes('a12345678') && unstatF.relaunchedIds.includes('b87654321') && unstatF.res?.relaunched === 1 && unstatF.res?.stopped === 1, JSON.stringify(unstatF))
  check('restartCarry: genuinely absent agent folder is skipped and counted stopped while sibling still relaunches', !absentFTried.includes('a12345678') && absentFTried.includes('b87654321') && absentF.stopped === 1 && absentF.relaunched === 1, JSON.stringify({ absentF, absentFTried }))
}

console.log('\nclaimSession.ts — loadConversationForResume error reports resume failure instead of no conversation found')
{
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const loading = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/loading.ts'))})
    const sid = '33333333-3333-4333-8333-333333333333'
    const file = loading.sessionFilePath(sid)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"type":"user"}\\n')
    const shutdownCodes = []
    const emitted = []
    mock.module(path.join(SRC, 'sessions/resume/conversationRecovery.js'), () => ({
      loadConversationForResume: async () => { throw new Error('disk read fault') },
    }))
    mock.module(path.join(SRC, 'platform/processes/gracefulShutdown.js'), () => ({
      gracefulShutdownSync: code => { shutdownCodes.push(code) },
    }))
    mock.module(path.join(SRC, 'daemon/runner/resume.js'), () => ({
      emitLoadError: message => { emitted.push(message) },
    }))
    const { claimSession } = await import(${JSON.stringify(join(SRC, 'daemon/runner/claimSession.ts'))})
    const live = { awaitingSessionClaim: true, claimSettling: null, runnerRestartReason: null }
    const ports = {
      armSessionRunnerWiring: async () => {},
      driver: { kick: () => {} },
      enqueueRow: () => {},
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
      heldNoticeWaits: () => false,
      hydrateResumedRun: async () => {},
      live,
      liveMcp: { refresh: async () => {} },
      liveScope: () => ({ session_id: sid }),
      messages: [],
      options: { outputFormat: 'text' },
      peer: null,
      persistBootModelRefusal: async () => {},
      releaseQueueUntilClaimed: null,
      setAppState: () => {},
      settleClearBirth: () => {},
      settleSessionBriefs: () => {},
      wire: false,
    }
    await claimSession({ session_id: sid, resume: true }, ports)
    await live.claimSettling
    out.emitted = emitted
    out.shutdownCodes = shutdownCodes
  `)
  const emitted = r.out.emitted as string[]
  const codes = r.out.shutdownCodes as number[]
  check('claimSession: resume load throw reports Failed to resume session with the error message', emitted.length === 1 && emitted[0] === 'Failed to resume session: disk read fault' && codes[0] === 1, JSON.stringify({ emitted, codes }))
}

console.log('\nhealthJson.ts — serialization failure emits cert-failed error and exits 1 instead of {} and exit 0')
{
  const r = runSubprocess(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    mock.module(path.join(SRC, 'platform/health/healthReport.js'), () => ({
      healthCertEnabled: () => true,
      runAndRecordHealthReport: async () => ({ verdict: 'sound', broken: 1n }),
    }))
    mock.module(path.join(SRC, 'platform/health/readiness.js'), () => ({
      collectReadiness: () => ({ records: [] }),
    }))
    const { runHealthJsonCli } = await import(${JSON.stringify(join(SRC, 'commands/verbs/healthJson.ts'))})
    await runHealthJsonCli()
  `, { allowNonZero: true })
  let parsed: { code?: string; error?: string } | null = null
  try { parsed = JSON.parse(r.stdout.trim()) as { code?: string; error?: string } } catch {}
  check('healthJson: serialization bug exits 1 with cert-failed JSON instead of {} with exit 0', r.status === 1 && parsed?.code === 'cert-failed' && typeof parsed.error === 'string' && parsed.error.length > 0, `status=${r.status} stdout=${r.stdout.slice(0, 200)}`)
}

console.log('\nhealthPresentation.ts — sync non-EPIPE stdout error exits 1 instead of exiting 0')
{
  const enospc = runSubprocess(`
    const path = await import('node:path')
    const { writeOutAndExit } = await import(${JSON.stringify(join(SRC, 'commands/verbs/healthPresentation.ts'))})
    process.stdout.write = () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) }
    await writeOutAndExit('ok\\n', 0)
  `, { allowNonZero: true })
  const epipe = runSubprocess(`
    const path = await import('node:path')
    const { writeOutAndExit } = await import(${JSON.stringify(join(SRC, 'commands/verbs/healthPresentation.ts'))})
    process.stdout.write = () => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) }
    await writeOutAndExit('ok\\n', 0)
  `, { allowNonZero: true })
  check('healthPresentation: sync ENOSPC exits 1 instead of 0', enospc.status === 1, `status=${enospc.status}`)
  check('healthPresentation: sync EPIPE still exits with requested code 0', epipe.status === 0, `status=${epipe.status}`)
}

console.log('\nmodels.ts — non-EPIPE stdout write failure rejects instead of being swallowed')
{
  const enospc = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    mock.module('node:fs', () => ({
      ...fs,
      writeSync: () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) },
    }))
    mock.module(path.join(SRC, 'integrations/resources/registry.js'), () => ({}))
    mock.module(path.join(SRC, 'integrations/resources/adapters/models.js'), () => ({
      liveModelsReference: async () => ({ models: [] }),
      liveModelsReferenceText: () => 'models',
    }))
    const { modelsCli } = await import(${JSON.stringify(join(SRC, 'commands/verbs/models.ts'))})
    try {
      await modelsCli({ json: true })
      out.threw = null
    } catch (e) {
      out.threw = { code: e?.code ?? null, message: String(e?.message ?? e) }
    }
  `)
  const epipe = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    mock.module('node:fs', () => ({
      ...fs,
      writeSync: () => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) },
    }))
    mock.module(path.join(SRC, 'integrations/resources/registry.js'), () => ({}))
    mock.module(path.join(SRC, 'integrations/resources/adapters/models.js'), () => ({
      liveModelsReference: async () => ({ models: [] }),
      liveModelsReferenceText: () => 'models',
    }))
    const { modelsCli } = await import(${JSON.stringify(join(SRC, 'commands/verbs/models.ts'))})
    try {
      await modelsCli({ json: true })
      out.threw = null
    } catch (e) {
      out.threw = { code: e?.code ?? null, message: String(e?.message ?? e) }
    }
  `)
  const t1 = enospc.out.threw as { code: string | null } | null
  const t2 = epipe.out.threw as { code: string | null } | null
  check('models: non-EPIPE writeSync failure rejects with ENOSPC instead of silently succeeding', t1?.code === 'ENOSPC', JSON.stringify(enospc.out))
  check('models: EPIPE writeSync failure is still passed over', t2 === null, JSON.stringify(epipe.out))
}

console.log('\nutil.tsx — healthHandler exits 1 instead of 0 when rendering throws')
{
  const r = runSubprocess(`
    const path = await import('node:path')
    const { healthHandler } = await import(${JSON.stringify(join(SRC, 'commands/verbs/setupTokenAndHealth.tsx'))})
    await healthHandler({
      render: () => { throw new Error('render failed') },
      unmount: () => {},
    })
  `, { allowNonZero: true })
  check('util: healthHandler exits 1 when root.render throws instead of 0', r.status === 1, `status=${r.status}`)
}

console.log('\nchatLauncher.tsx — rejecting boot recovery or resume fold releases its timer in finally and logs the error')
{
  const r = runSubprocess(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const timers = await import(${JSON.stringify(join(SRC, 'platform/async/timers.js'))})
    const realStart = timers.startTimeout
    const realStop = timers.stopTimeout
    let started = 0
    let stopped = 0
    const logged = []
    mock.module(path.join(SRC, 'platform/async/timers.js'), () => ({
      ...timers,
      startTimeout: (fn, ms) => { started++; return realStart(fn, ms) },
      stopTimeout: handle => { stopped++; return realStop(handle) },
    }))
    const logMod = await import(${JSON.stringify(join(SRC, 'platform/logs/errorLog.js'))})
    mock.module(path.join(SRC, 'platform/logs/errorLog.js'), () => ({
      ...logMod,
      logError: err => { logged.push(String(err instanceof Error ? err.message : err)) },
    }))
    mock.module(path.join(SRC, 'platform/substrate/recoveryOrchestrator.js'), () => ({
      runBootRecovery: async () => { throw new Error('recovery boom') },
    }))
    mock.module(path.join(SRC, 'engine/run/runCoordinator.js'), () => ({
      foldResumedRunForBoot: async () => { throw new Error('fold boom') },
    }))
    mock.module(path.join(SRC, 'screen/routes/surfaceRoute.js'), () => ({
      resolveInitialSurface: async () => ({ effective: 'chat' }),
      initializeSurfaceRoute: () => {},
      subscribeSurfaceRoute: () => () => {},
      currentSurfaceRoute: () => ({ kind: 'repl' }),
      surfaceRouteId: () => 'repl',
    }))
    mock.module(path.join(SRC, 'boot/App.js'), () => ({ App: () => null }))
    mock.module(path.join(SRC, 'screen/routes/SurfaceRouter.js'), () => ({ SurfaceRouter: () => null }))
    mock.module(path.join(SRC, 'screen/chat/Chat.js'), () => ({ Chat: () => null }))
    mock.module(path.join(SRC, 'integrations/mcp/dynamicMcpSeed.js'), () => ({ seedDynamicMcpConfig: () => {} }))
    const { launchChat } = await import(${JSON.stringify(join(SRC, 'boot/chatLauncher.tsx'))})
    let rendered = false
    await launchChat({}, { getFpsMetrics: () => undefined, initialState: {} }, {}, async () => { rendered = true })
    out.started = started
    out.stopped = stopped
    out.logged = logged
    out.rendered = rendered
  `)
  const logged = r.out.logged as string[]
  check('chatLauncher: rejecting recovery and fold release both timers in finally, log both errors, and still open chat', r.out.started === 2 && r.out.stopped === 2 && logged.includes('recovery boom') && logged.includes('fold boom') && r.out.rendered === true, JSON.stringify(r.out))
}

console.log('\nprintTurn.ts — failed elicitation registration does not mark server registered or drop async rejection')
{
  const r = runSubprocess(`
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const logged = []
    const logMod = await import(${JSON.stringify(join(SRC, 'platform/logs/errorLog.js'))})
    mock.module(path.join(SRC, 'platform/logs/errorLog.js'), () => ({
      ...logMod,
      logError: err => { logged.push(String(err instanceof Error ? err.message : err)) },
    }))
    const { registerPerTurnHandlers } = await import(${JSON.stringify(join(SRC, 'daemon/runner/runnerTurn.ts'))})
    const registered = new Set()
    let unhandled = 0
    process.on('unhandledRejection', () => { unhandled++ })
    const ports = {
      elicitationRegistered: registered,
      registerElicitationHandlersForClient: async () => { throw new Error('handler attach failed') },
    }
    registerPerTurnHandlers([{ type: 'connected', name: 'srv-a' }], ports)
    await new Promise(resolve => setTimeout(resolve, 30))
    out.registeredAfterFailure = registered.has('srv-a')
    out.logged = logged
    out.unhandled = unhandled
  `)
  const logged = r.out.logged as string[]
  check('printTurn: failed elicitation registration leaves server unregistered, logs error, and has zero unhandled rejections', r.out.registeredAfterFailure === false && logged.includes('handler attach failed') && r.out.unhandled === 0, JSON.stringify(r.out))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
