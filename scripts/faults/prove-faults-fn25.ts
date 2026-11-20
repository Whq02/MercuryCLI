#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn25-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }

function runSub(body: string): Record<string, unknown> {
  const subHome = realpathSync(mkdtempSync(join(scratch, 'sub-home-')))
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(subHome)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n__PROOF_JSON__' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, MERCURY_CONFIG_DIR: subHome, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file' },
  })
  if (res.status !== 0) throw new Error(`sub failed (${res.status}): ${res.stderr.slice(-1000)}`)
  const line = res.stdout.split('\n').reverse().find(l => l.startsWith('__PROOF_JSON__'))
  return JSON.parse((line ?? '__PROOF_JSON__{}').slice('__PROOF_JSON__'.length)) as Record<string, unknown>
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { resolveAgentCwd } = await import('../../src/tools/AgentTool/agent/cwd.ts')

{
  const dir = join(scratch, 'cwd-loop')
  mkdirSync(dir, { recursive: true })
  const loopA = join(dir, 'a')
  const loopB = join(dir, 'b')
  symlinkSync(loopB, loopA)
  symlinkSync(loopA, loopB)
  let thrown: (Error & { code?: string }) | null = null
  try {
    resolveAgentCwd(loopA, getEmptyToolPermissionContext())
  } catch (error) {
    thrown = error as Error & { code?: string }
  }
  check(
    'agent/cwd: non-ENOENT stat failure throws real errno instead of claiming cwd does not exist',
    thrown !== null && thrown.code === 'ELOOP' && !thrown.message.includes('cwd does not exist'),
    thrown ? `${thrown.code ?? 'no-code'}: ${thrown.message}` : 'did not throw',
  )
  let missing: Error | null = null
  try {
    resolveAgentCwd(join(dir, 'absent'), getEmptyToolPermissionContext())
  } catch (error) {
    missing = error as Error
  }
  check(
    'agent/cwd: ENOENT still reports cwd does not exist',
    missing !== null && missing.message.includes('cwd does not exist'),
    missing ? missing.message : 'did not throw',
  )
}

{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const path = await import('node:path')
    const storagePath = path.join(SRC, 'utils/sessionStorage.ts')
    const realStorage = await import(storagePath)
    let readCalls = 0
    let writeCalls = 0
    mock.module(storagePath, () => ({
      ...realStorage,
      getAgentTranscript: async () => ({
        messages: [{ type: 'user', uuid: '00000000-0000-4000-8000-000000000001', message: { role: 'user', content: 'hi' } }],
        contentReplacements: [],
      }),
      readAgentMetadata: async () => {
        readCalls++
        if (readCalls <= 2) return { agentType: 'mercury-crew', description: 'demo' }
        throw Object.assign(new Error('EIO: sidecar unreadable'), { code: 'EIO' })
      },
      writeAgentMetadata: async () => {
        writeCalls++
      },
    }))
    const runAgentPath = path.join(SRC, 'tools/AgentTool/runAgent.ts')
    const realRunAgent = await import(runAgentPath)
    mock.module(runAgentPath, () => ({
      ...realRunAgent,
      runAgent: async function* () {},
    }))
    const { resumeAgentBackground } = await import(path.join(SRC, 'tools/AgentTool/resumeAgent.ts'))
    const { getEmptyToolPermissionContext } = await import(path.join(SRC, 'Tool.ts'))
    const state = { toolPermissionContext: getEmptyToolPermissionContext(), tasks: {}, mcp: { tools: [], clients: [] } }
    const ctx = {
      getAppState: () => state,
      setAppState: fn => { Object.assign(state, fn(state)) },
      setAppStateForTasks: fn => { Object.assign(state, fn(state)) },
      abortController: new AbortController(),
      readFileState: new Map(),
      messages: [],
      options: { tools: [], mcpClients: [], mcpResources: {}, agentDefinitions: { activeAgents: [], allAgents: [] }, engineModel: 'claude-fable-5-1' },
    }
    const res = await resumeAgentBackground({ agentId: 'agent-eio-resume', prompt: 'go', toolUseContext: ctx })
    out.readCalls = readCalls
    out.writeCalls = writeCalls
    out.note = res.note ?? ''
  `)
  check(
    'resumeAgent: readAgentMetadata EIO skips overwrite and reports recordNote',
    r.readCalls === 3 && r.writeCalls === 0 && typeof r.note === 'string' && r.note.includes('could not be saved') && r.note.includes('EIO'),
    JSON.stringify(r),
  )
}

{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const path = await import('node:path')
    const firePath = path.join(SRC, 'utils/hooks/fire.ts')
    mock.module(firePath, () => ({ fireHooks: async () => ({ outcomes: [], answer: { contexts: [] } }) }))
    const storagePath = path.join(SRC, 'utils/sessionStorage.ts')
    const realStorage = await import(storagePath)
    let mode = 'register-fail'
    let writeCalls = 0
    mock.module(storagePath, () => ({
      ...realStorage,
      registerAgentTranscriptDestination: () => {
        if (mode === 'register-fail') throw new Error('register bug')
      },
      readAgentMetadata: async () => {
        if (mode === 'read-fail') throw Object.assign(new Error('EIO: unreadable sidecar'), { code: 'EIO' })
        return null
      },
      writeAgentMetadata: async () => {
        writeCalls++
        if (mode === 'write-fail') throw Object.assign(new Error('EACCES: cannot write sidecar'), { code: 'EACCES' })
      },
    }))
    const { prepareAgentRun } = await import(path.join(SRC, 'tools/AgentTool/runAgent/prepare.ts'))
    const { getEmptyToolPermissionContext } = await import(path.join(SRC, 'Tool.ts'))
    const { createFileStateCacheWithSizeLimit } = await import(path.join(SRC, 'utils/fileStateCache.ts'))
    const state = { toolPermissionContext: getEmptyToolPermissionContext(), tasks: {}, mcp: { tools: [], clients: [] }, sessionHooks: new Map() }
    const ctx = {
      getAppState: () => state,
      setAppState: fn => { Object.assign(state, fn(state)) },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(100),
      messages: [],
      options: { tools: [], mcpClients: [], mcpResources: {}, agentDefinitions: { activeAgents: [], allAgents: [] }, engineModel: 'claude-fable-5-1', debug: false, verbose: false, isNonInteractiveSession: true },
    }
    const baseArgs = () => ({
      agentId: 'agent-prepare-test',
      name: 'worker',
      description: 'worker',
      swarm: false,
      abortController: new AbortController(),
      override: { userContext: {}, systemContext: {}, systemPrompt: ['sys'] },
      agentDefinition: { agentType: 'mercury-crew', whenToUse: 'test', source: 'built-in', getSystemPrompt: () => 'sys', omitProjectInstructions: true },
      slimAgentGateOn: () => false,
      withoutInstructionBlob: c => c,
      readOnlyScout: false,
      toolUseContext: ctx,
      isAsync: true,
      resolveAgentEffort: () => undefined,
      hookScope: { sessionId: 'sess-1', crewmateId: 'agent-prepare-test' },
      promptMessages: [],
      resolvedAgentModel: 'claude-fable-5-1',
      rootSetAppState: ctx.setAppState,
      preloadSkills: async () => [],
      connectAgentMcpServers: async () => ({ clients: [], tools: [], cleanup: async () => {} }),
      mcp: { clients: [], tools: [], cleanup: async () => {} },
      availableTools: [],
      reviewReceipt: undefined,
      buildAgentSystemPrompt: async () => ['sys'],
      seat: 'crewmate',
      isFork: false,
      readFileState: createFileStateCacheWithSizeLimit(100),
      childContextRef: { current: undefined },
      agentKind: 'subagent',
      run: { watchdog: { touch: () => {} }, eventsSeen: 0, toolUsesSeen: 0, pendingAsks: 0, askHeartbeat: null, deferredTouch: null, throttled: null, stoppedAfterRetry: false, retryStalledRequest: null },
      accountant: { wait: () => {}, spoke: () => {}, standing: () => false, end: () => {} },
      touchThrough: () => {},
      initialMessages: [],
      landAgentTranscriptRows: async () => undefined,
      resolvedEffort: undefined,
    })
    const attempt = async m => {
      mode = m
      writeCalls = 0
      try {
        await prepareAgentRun(baseArgs())
        return { threw: null, writeCalls }
      } catch (e) {
        return { threw: e instanceof Error ? e.message : String(e), writeCalls }
      }
    }
    out.registerFail = await attempt('register-fail')
    out.readFail = await attempt('read-fail')
    out.writeFail = await attempt('write-fail')
  `)
  const reg = r.registerFail as { threw: string | null }
  const rd = r.readFail as { threw: string | null; writeCalls: number }
  const wr = r.writeFail as { threw: string | null; writeCalls: number }
  check(
    'runAgent/prepare: registerAgentTranscriptDestination error propagates instead of being swallowed',
    reg.threw !== null && reg.threw.includes('register bug'),
    JSON.stringify(reg),
  )
  check(
    'runAgent/prepare: readAgentMetadata EIO rejects without overwriting sidecar',
    rd.threw !== null && rd.threw.includes('EIO') && rd.writeCalls === 0,
    JSON.stringify(rd),
  )
  check(
    'runAgent/prepare: writeAgentMetadata EACCES rejects instead of running unrecorded',
    wr.threw !== null && wr.threw.includes('EACCES') && wr.writeCalls === 1,
    JSON.stringify(wr),
  )
}

{
  const { AsepriteTool } = await import('../../src/tools/AsepriteTool/AsepriteTool.ts')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const work = join(scratch, 'aseprite-tree')
  mkdirSync(work, { recursive: true })
  const loopA = join(work, 'loop-a.aseprite')
  const loopB = join(work, 'loop-b.aseprite')
  symlinkSync(loopB, loopA)
  symlinkSync(loopA, loopB)
  const prevBin = process.env.MERCURY_ASEPRITE_BIN
  process.env.MERCURY_ASEPRITE_BIN = '/usr/bin/true'
  try {
    const res = await runWithCwdOverride(work, () =>
      AsepriteTool.call({ op: 'info', file: loopA } as never, {} as never),
    )
    const text = (res.data as { result: string }).result
    check(
      'AsepriteTool: non-ENOENT realpath failure (ELOOP) refuses inside fencePath instead of running',
      text.includes('info failed:') && /ELOOP|too many/i.test(text),
      text.slice(0, 160),
    )
  } finally {
    if (prevBin === undefined) delete process.env.MERCURY_ASEPRITE_BIN
    else process.env.MERCURY_ASEPRITE_BIN = prevBin
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
