#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn10-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

try {
  console.log('1. src/screen/concourse-model/projectActivity.ts')
  {
    const { runningByProjectKey } = await import('../../src/screen/concourse-model/projectActivity.ts')
    const absentDir = join(SCRATCH, 'pa-absent')
    mkdirSync(absentDir, { recursive: true })
    const absentMap = await runningByProjectKey(absentDir)
    check('projectActivity.runningByProjectKey absent records file returns empty map', absentMap.size === 0)

    const corruptDir = join(SCRATCH, 'pa-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'concourse-workers.json'), '{not-json')
    const corruptErr = await rejects(() => runningByProjectKey(corruptDir))
    check('projectActivity.runningByProjectKey rejects on corrupt records file', corruptErr !== null, 'returned empty map instead of rejecting')

    if (POSIX_MODES) {
      const unreadableDir = join(SCRATCH, 'pa-unreadable')
      mkdirSync(unreadableDir, { recursive: true })
      const file = join(unreadableDir, 'concourse-workers.json')
      writeFileSync(file, JSON.stringify({ version: 1, workers: {} }))
      chmodSync(file, 0o200)
      const permErr = await rejects(() => runningByProjectKey(unreadableDir))
      chmodSync(file, 0o600)
      check('projectActivity.runningByProjectKey rejects on unreadable records file', permErr !== null, 'returned empty map instead of rejecting')
    }
  }

  console.log('2. src/screen/concourse-model/sessionTitleMint.ts')
  {
    const { transcriptHeadFacts } = await import('../../src/screen/concourse-model/sessionTitleMint.ts')
    const { workerTranscriptPath } = await import('../../src/screen/concourse-model/workerTranscript.ts')
    const workspaceId = join(SCRATCH, 'ws-title')
    mkdirSync(workspaceId, { recursive: true })
    const absent = transcriptHeadFacts({ sessionId: 'absent-session', workspaceId })
    check('sessionTitleMint.transcriptHeadFacts absent transcript returns zero turns', absent.assistantTurns === 0 && absent.description === '')

    if (POSIX_MODES) {
      const rec = { sessionId: 'unreadable-session', workspaceId }
      const file = workerTranscriptPath(rec)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '{}\n')
      chmodSync(file, 0o200)
      let threw: unknown = null
      try {
        transcriptHeadFacts(rec)
      } catch (error) {
        threw = error
      } finally {
        chmodSync(file, 0o600)
      }
      check('sessionTitleMint.transcriptHeadFacts throws on unreadable transcript', threw !== null, 'returned zero turns on EACCES')
    }
  }

  console.log('3. src/screen/concourse-model/workerModels.ts')
  {
    const { validateWorkerModelChoice } = await import('../../src/screen/concourse-model/workerModels.ts')
    const prevCompatUrl = process.env.MERCURY_COMPAT_BASE_URL
    process.env.MERCURY_COMPAT_BASE_URL = 'not-a-url'
    try {
      const verdict = await validateWorkerModelChoice('openai-compat', 'session', { modelOptions: () => [] })
      check(
        'workerModels.compatReaderFor refuses with compat error instead of false no-credential',
        !verdict.ok && verdict.reason === 'not-runnable:compat-error' && (verdict.detail ?? '').includes('compatProvider'),
        JSON.stringify(verdict),
      )
    } finally {
      if (prevCompatUrl === undefined) delete process.env.MERCURY_COMPAT_BASE_URL
      else process.env.MERCURY_COMPAT_BASE_URL = prevCompatUrl
    }
  }

  console.log('4. src/crew/crewmates/dispatch.ts')
  {
    const { spawnSync } = await import('node:child_process')
    const dir = join(SCRATCH, 'crew-dispatch')
    mkdirSync(dir, { recursive: true })
    const script = `
      import { mock } from 'bun:test'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      mock.module(${JSON.stringify(join(HERE, '../../src/crew/crewmates/conversations.ts'))}, () => ({
        appendConversationEvent: async () => { throw new Error('injected conversation store failure') },
        resolveEventByRef: async () => { throw new Error('injected conversation store failure') },
        upsertUnresolvedEvent: async () => { throw new Error('injected conversation store failure') },
      }))
      const { dispatchToAgent } = await import(${JSON.stringify(join(HERE, '../../src/crew/crewmates/dispatch.ts'))})
      const { openObligations } = await import(${JSON.stringify(join(HERE, '../../src/crew/crewmates/obligations.ts'))})
      const dir = ${JSON.stringify(dir)}
      const receipt = await dispatchToAgent({
        clientMessageId: 'dispatch-iso-1',
        sourceConversationId: 'cv-iso-1',
        requestedAddress: { agentId: 'cw-absent' },
        requestedDisposition: 'hold-next',
        instruction: 'check isolation',
        attachments: [],
      }, { dir })
      const open = await openObligations({ scope: 'switchboard', dir })
      process.stdout.write('\\n' + JSON.stringify({ state: receipt.state, recorded: open.some(o => o.ref === 'receipt:dispatch-iso-1') }))
    `
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    const out = res.status === 0 ? JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') : { error: res.stderr.slice(-400) }
    check(
      'dispatch.runDispatchTransaction records retry-or-withdraw obligation even when conversation store fails',
      out.state === 'not-delivered' && out.recorded === true,
      JSON.stringify(out),
    )
  }

  console.log('5. src/crew/crewmates/graph.ts')
  {
    const { spawnSync } = await import('node:child_process')
    const runGraphFault = (mockBlock: string): { rejected: boolean; message?: string; error?: string } => {
      const script = `
        import { mock } from 'bun:test'
        process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
        process.env.NODE_ENV = 'test'
        delete process.env.MERCURY_HOME
        globalThis.MACRO = { VERSION: '1.0.0' }
        ${mockBlock}
        const { assembleSessionGraph } = await import(${JSON.stringify(join(HERE, '../../src/crew/crewmates/graph.ts'))})
        try {
          await assembleSessionGraph()
          process.stdout.write('\\n' + JSON.stringify({ rejected: false }))
        } catch (error) {
          process.stdout.write('\\n' + JSON.stringify({ rejected: true, message: error instanceof Error ? error.message : String(error) }))
        }
      `
      const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
      return res.status === 0 ? JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') : { rejected: false, error: res.stderr.slice(-400) }
    }
    const sessionsFail = runGraphFault(`
      mock.module(${JSON.stringify(join(HERE, '../../src/crew/crewmates/projection.ts'))}, () => ({ resolveCrewSnapshot: async () => null }))
      mock.module(${JSON.stringify(join(HERE, '../../src/crew/crewmates/identity.ts'))}, () => ({ crewStoreRoot: () => ${JSON.stringify(HOME)}, listAgentSessions: async () => { throw new Error('injected sessions read error') } }))
    `)
    check('graph.assembleSessionGraph rejects when listAgentSessions fails', sessionsFail.rejected && (sessionsFail.message ?? '').includes('injected sessions read error'), JSON.stringify(sessionsFail))

    const convsFail = runGraphFault(`
      mock.module(${JSON.stringify(join(HERE, '../../src/crew/crewmates/projection.ts'))}, () => ({ resolveCrewSnapshot: async () => null }))
      mock.module(${JSON.stringify(join(HERE, '../../src/crew/crewmates/conversations.ts'))}, () => ({ listConversations: async () => { throw new Error('injected conversations read error') } }))
    `)
    check('graph.assembleSessionGraph rejects when listConversations fails', convsFail.rejected && (convsFail.message ?? '').includes('injected conversations read error'), JSON.stringify(convsFail))

    const artifactsFail = runGraphFault(`
      mock.module(${JSON.stringify(join(HERE, '../../src/crew/crewmates/projection.ts'))}, () => ({ resolveCrewSnapshot: async () => null }))
      mock.module(${JSON.stringify(join(HERE, '../../src/sessions/artifact-reviews/reviewStore.ts'))}, () => ({
        listReviewArtifactHeadsSource: () => ({ state: 'unavailable', reason: 'injected artifacts EACCES', retryable: true }),
      }))
    `)
    check('graph.assembleSessionGraph rejects when review artifacts are unavailable', artifactsFail.rejected && (artifactsFail.message ?? '').includes('injected artifacts EACCES'), JSON.stringify(artifactsFail))
  }

  console.log('6. src/crew/crewmates/obligations.ts')
  {
    const { upsertObligation, openObligations, foldLegacyObligationsIntoSwitchboardScope } = await import('../../src/crew/crewmates/obligations.ts')
    const dir = join(SCRATCH, 'crew-obligations')
    mkdirSync(dir, { recursive: true })
    await upsertObligation({ ref: 'legacy-fold-1', sessionId: 's-leg', question: 'still waiting?', owner: 'operator', dir })
    const blocker = join(dir, 'obligations-switchboard.json')
    mkdirSync(blocker, { recursive: true })
    writeFileSync(join(blocker, 'keep'), 'x')
    const firstErr = await rejects(() => foldLegacyObligationsIntoSwitchboardScope(dir))
    rmSync(blocker, { recursive: true, force: true })
    const moved = await foldLegacyObligationsIntoSwitchboardScope(dir)
    const after = await openObligations({ scope: 'switchboard', dir })
    check(
      'obligations.foldLegacyObligationsIntoSwitchboardScope rejects on failure and retries on next call',
      firstErr !== null && moved === 1 && after.some(o => o.ref === 'legacy-fold-1'),
      `firstErr=${firstErr?.message ?? 'null'} moved=${moved} open=${after.length}`,
    )
  }

  console.log('7. src/crew/crewmates/seatBridge.ts')
  {
    const { spawnSync } = await import('node:child_process')
    const dir = join(SCRATCH, 'crew-seatbridge')
    mkdirSync(dir, { recursive: true })
    const script = `
      import { mock } from 'bun:test'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      const realIdentity = await import(${JSON.stringify(join(HERE, '../../src/crew/crewmates/identity.ts'))})
      mock.module(${JSON.stringify(join(HERE, '../../src/crew/crewmates/identity.ts'))}, () => ({
        ...realIdentity,
        endAgentSession: async () => { throw new Error('injected session close error') },
      }))
      const { attachExternalSeat, detachExternalSeat } = await import(${JSON.stringify(join(HERE, '../../src/crew/crewmates/seatBridge.ts'))})
      const { publishSessionDescriptor, readSessionDescriptor } = await import(${JSON.stringify(join(HERE, '../../src/crew/crewmates/descriptor.ts'))})
      const dir = ${JSON.stringify(dir)}
      const seat = await attachExternalSeat({
        adapterKind: 'probe',
        displayName: 'Probe',
        mercuryOwnsProcess: true,
        handshake: async () => ({ protocol: 'p@1', revision: '1', externalSessionId: 'ext-detach-1', declared: {} }),
        detach: async () => {},
      }, { dir })
      await publishSessionDescriptor({ agentId: seat.agentId, sessionId: 'ext-detach-1' }, { dir })
      await detachExternalSeat(seat.seatId)
      const desc = await readSessionDescriptor('ext-detach-1', { dir })
      process.stdout.write('\\n' + JSON.stringify({ retired: desc?.retiredAt !== undefined }))
    `
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    const out = res.status === 0 ? JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') : { error: res.stderr.slice(-400) }
    check(
      'seatBridge.detachExternalSeat still retires session descriptor when endAgentSession fails',
      out.retired === true,
      JSON.stringify(out),
    )
  }

  console.log('8. src/integrations/debugger/dapClient.ts')
  {
    const { createDapSession, getDapSession } = await import('../../src/integrations/debugger/dapClient.ts')
    const { getExecution, requestStopExecution } = await import('../../src/engine/execution-plane/executionPlane.ts')
    const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')
    const owner = processMainOwner()
    const mockAdapter = join(HERE, '../dap/mock-dap-adapter.mjs')
    const program = join(SCRATCH, 'dummy.py')
    writeFileSync(program, 'x = 1\n')
    const session = await createDapSession({
      owner,
      id: 'stop-leak',
      adapterKey: 'mock',
      program,
      cwd: SCRATCH,
      specOverride: { command: process.execPath, args: [mockAdapter] },
    })
    try {
      session.dispose = async () => {
        throw new Error('injected dispose failure')
      }
      requestStopExecution(owner, 'debug:stop-leak')
      await new Promise(resolve => setTimeout(resolve, 50))
      const stillRegistered = getDapSession(owner, 'stop-leak') !== undefined
      const execState = getExecution(owner, 'debug:stop-leak')?.state
      check(
        'dapClient.requestStop terminates adapter and projects stopped even when dispose fails',
        session.terminated === true && !stillRegistered && execState === 'stopped',
        `terminated=${session.terminated} registered=${stillRegistered} execState=${String(execState)}`,
      )
    } finally {
      session.killSync()
    }
  }

  console.log('9. src/integrations/debugger/client/adapters.ts')
  {
    const { spawnSync } = await import('node:child_process')
    const emptyBin = join(SCRATCH, 'dap-empty-bin')
    mkdirSync(emptyBin, { recursive: true })
    const script = `
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      process.env.PATH = ${JSON.stringify(emptyBin)}
      process.env.MERCURY_DEBUGPY_VENDOR_DIR = ${JSON.stringify(join(SCRATCH, 'no-debugpy'))}
      process.env.MERCURY_PYTHON_VENDOR_DIR = ${JSON.stringify(join(SCRATCH, 'no-python'))}
      process.env.MERCURY_JS_DEBUG_DAP = ${JSON.stringify(join(SCRATCH, 'no-js-debug.js'))}
      process.env.MERCURY_DAP_ADAPTERS_FILE = ${JSON.stringify(join(SCRATCH, 'no-adapters.json'))}
      process.env.MERCURY_DAP_ADAPTERS = '{broken'
      globalThis.MACRO = { VERSION: '1.0.0' }
      const adapters = await import(${JSON.stringify(join(HERE, '../../src/integrations/debugger/client/adapters.ts'))})
      const reachable = adapters.reachableDapAdapterKeys()
      const withheld = adapters.debugToolWithholding()
      delete process.env.MERCURY_DAP_ADAPTERS
      const cleanWithheld = adapters.debugToolWithholding()
      process.stdout.write('\\n' + JSON.stringify({ reachable, withheld, cleanWithheld }))
    `
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    const out = res.status === 0 ? JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') : { error: res.stderr.slice(-400) }
    const why = out.withheld?.withheld ? String(out.withheld.why) : ''
    const cleanWhy = out.cleanWithheld?.withheld ? String(out.cleanWithheld.why) : ''
    check(
      'adapters.debugToolWithholding reports invalid MERCURY_DAP_ADAPTERS JSON without throwing',
      Array.isArray(out.reachable) &&
        why.includes('MERCURY_DAP_ADAPTERS is not valid JSON (') &&
        why.includes('so the adapters it names are not used — fix or unset it') &&
        !cleanWhy.includes('MERCURY_DAP_ADAPTERS is not valid JSON'),
      JSON.stringify(out),
    )
  }

  console.log('10. src/integrations/debugger/dapClient.ts (invalid MERCURY_DAP_ADAPTERS on Debug launch)')
  {
    const { DebugTool } = await import('../../src/tools/debug/DebugTool.ts')
    const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')
    const owner = processMainOwner()
    const program = join(SCRATCH, 'dummy.py')
    writeFileSync(program, 'x = 1\n')
    const prevEnv = process.env.MERCURY_DAP_ADAPTERS
    process.env.MERCURY_DAP_ADAPTERS = '{broken'
    try {
      const ctx = {
        owner,
        abortController: new AbortController(),
        getAppState: () => ({ toolPermissionContext: {} }),
      }
      const namedLaunch = await (DebugTool as { call: Function }).call(
        { op: 'launch', adapter: 'custom', program, cwd: SCRATCH, session: 'bad-env-named' },
        ctx,
      ) as { data: { result: string; outcome: string } }
      check(
        'dapClient.createDapSession names the invalid MERCURY_DAP_ADAPTERS when the adapter it should hold is unknown',
        namedLaunch.data.outcome === 'failed' &&
          namedLaunch.data.result.includes('MERCURY_DAP_ADAPTERS is not valid JSON (') &&
          namedLaunch.data.result.includes('so the adapters it names are not used — fix or unset it') &&
          namedLaunch.data.result.includes("unknown adapter 'custom'"),
        JSON.stringify(namedLaunch.data),
      )
    } finally {
      if (prevEnv === undefined) delete process.env.MERCURY_DAP_ADAPTERS
      else process.env.MERCURY_DAP_ADAPTERS = prevEnv
    }
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
