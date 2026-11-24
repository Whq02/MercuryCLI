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
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
function trySymlinkLoop(a: string, b: string): boolean {
  try {
    symlinkSync(b, a)
    symlinkSync(a, b)
    return true
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException | null)?.code === 'EPERM') return false
    throw error
  }
}
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { resolveCrewmateCwd } = await import('../../src/tools/crewmate/call/cwd.ts')

{
  const dir = join(scratch, 'cwd-loop')
  mkdirSync(dir, { recursive: true })
  const loopA = join(dir, 'a')
  const loopB = join(dir, 'b')
  if (trySymlinkLoop(loopA, loopB)) {
    let thrown: (Error & { code?: string }) | null = null
    try {
      resolveCrewmateCwd(loopA, getEmptyToolPermissionContext())
    } catch (error) {
      thrown = error as Error & { code?: string }
    }
    check(
      'agent/cwd: non-ENOENT stat failure throws real errno instead of claiming cwd does not exist',
      thrown !== null && thrown.code === 'ELOOP' && !thrown.message.includes('cwd does not exist'),
      thrown ? `${thrown.code ?? 'no-code'}: ${thrown.message}` : 'did not throw',
    )
  } else {
    skip('agent/cwd: non-ENOENT stat failure throws real errno instead of claiming cwd does not exist', 'not read on Windows: no symlink privilege')
  }
  let missing: Error | null = null
  try {
    resolveCrewmateCwd(join(dir, 'absent'), getEmptyToolPermissionContext())
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
    const storagePath = path.join(SRC, 'sessions/transcripts/sessionStorage.ts')
    const realStorage = await import(storagePath)
    let readCalls = 0
    let writeCalls = 0
    mock.module(storagePath, () => ({
      ...realStorage,
      getCrewmateTranscript: async () => ({
        messages: [{ type: 'user', uuid: '00000000-0000-4000-8000-000000000001', message: { role: 'user', content: 'hi' } }],
        contentReplacements: [],
      }),
      readCrewmateMetadata: async () => {
        readCalls++
        if (readCalls <= 2) return { agentType: 'mercury-crew', description: 'demo' }
        throw Object.assign(new Error('EIO: sidecar unreadable'), { code: 'EIO' })
      },
      writeCrewmateMetadata: async () => {
        writeCalls++
      },
    }))
    const runAgentPath = path.join(SRC, 'tools/crewmate/runCrewmate.ts')
    const realRunAgent = await import(runAgentPath)
    mock.module(runAgentPath, () => ({
      ...realRunAgent,
      runCrewmate: async function* () {},
    }))
    const { resumeAgentBackground } = await import(path.join(SRC, 'tools/crewmate/resumeCrewmate.ts'))
    const { getEmptyToolPermissionContext } = await import(path.join(SRC, 'tools/kit/tool.ts'))
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
    const firePath = path.join(SRC, 'integrations/event-hooks/fire.ts')
    mock.module(firePath, () => ({ fireHooks: async () => ({ outcomes: [], answer: { contexts: [] } }) }))
    const storagePath = path.join(SRC, 'sessions/transcripts/sessionStorage.ts')
    const realStorage = await import(storagePath)
    let mode = 'register-fail'
    let writeCalls = 0
    mock.module(storagePath, () => ({
      ...realStorage,
      registerCrewmateTranscriptDestination: () => {
        if (mode === 'register-fail') throw new Error('register bug')
      },
      readCrewmateMetadata: async () => {
        if (mode === 'read-fail') throw Object.assign(new Error('EIO: unreadable sidecar'), { code: 'EIO' })
        return null
      },
      writeCrewmateMetadata: async () => {
        writeCalls++
        if (mode === 'write-fail') throw Object.assign(new Error('EACCES: cannot write sidecar'), { code: 'EACCES' })
      },
    }))
    const { prepareCrewmateRun } = await import(path.join(SRC, 'tools/crewmate/run/prepare.ts'))
    const { getEmptyToolPermissionContext } = await import(path.join(SRC, 'tools/kit/tool.ts'))
    const { createFileStateCacheWithSizeLimit } = await import(path.join(SRC, 'platform/files/fileStateCache.ts'))
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
        await prepareCrewmateRun(baseArgs())
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
    'runAgent/prepare: a transcript registration that throws does not stop the launch, as before',
    reg.threw === null,
    JSON.stringify(reg),
  )
  check(
    'runAgent/prepare: a sidecar that cannot be read is not written over, and the launch goes on',
    rd.threw === null && rd.writeCalls === 0,
    JSON.stringify(rd),
  )
  check(
    'runAgent/prepare: a record that cannot be saved does not stop the launch, as before',
    wr.threw === null && wr.writeCalls === 1,
    JSON.stringify(wr),
  )
}

{
  const { AsepriteTool } = await import('../../src/tools/aseprite/AsepriteTool.ts')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
  const work = join(scratch, 'aseprite-tree')
  mkdirSync(work, { recursive: true })
  const loopA = join(work, 'loop-a.aseprite')
  const loopB = join(work, 'loop-b.aseprite')
  if (!trySymlinkLoop(loopA, loopB)) {
    skip('AsepriteTool: a path that does not resolve (ELOOP) is judged from its nearest folder, as before', 'not read on Windows: no symlink privilege')
  } else {
    const prevBin = process.env.MERCURY_ASEPRITE_BIN
    process.env.MERCURY_ASEPRITE_BIN = '/usr/bin/true'
    try {
      const res = await runWithCwdOverride(work, () =>
        AsepriteTool.call({ op: 'info', file: loopA } as never, {} as never),
      )
      const text = (res.data as { result: string }).result
      check(
        'AsepriteTool: a path that does not resolve (ELOOP) is judged from its nearest folder, as before',
        !/ELOOP|too many/i.test(text),
        text.slice(0, 160),
      )
    } finally {
      if (prevBin === undefined) delete process.env.MERCURY_ASEPRITE_BIN
      else process.env.MERCURY_ASEPRITE_BIN = prevBin
    }
  }
}

{
  const { AstEditTool } = await import('../../src/tools/ast-edit/AstEditTool.ts')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
  const work = join(scratch, 'ast-edit-fail')
  mkdirSync(work, { recursive: true })
  const ctx = {
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    abortController: new AbortController(),
    readFileState: new Map(),
  }
  const decision = await runWithCwdOverride(work, () =>
    AstEditTool.checkPermissions(
      { apply: true, plan: 'p1', lang: 'no-such-language-xyz', pattern: 'foo', rewrite: 'bar', path: work } as never,
      ctx as never,
    ),
  )
  check(
    'AstEditTool: checkPermissions lets the call go on when planFor throws, as before',
    decision.behavior === 'allow',
    JSON.stringify(decision),
  )
}

{
  const { BlenderTool } = await import('../../src/tools/blender/BlenderTool.ts')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
  const work = join(scratch, 'blender-tree')
  mkdirSync(work, { recursive: true })
  const loopA = join(work, 'loop-a.blend')
  const loopB = join(work, 'loop-b.blend')
  if (!trySymlinkLoop(loopA, loopB)) {
    skip('BlenderTool: a path that does not resolve (ELOOP) is judged from its nearest folder, as before', 'not read on Windows: no symlink privilege')
  } else {
    const res = await runWithCwdOverride(work, () =>
      BlenderTool.call({ op: 'blend_open', args: { path: loopA } } as never, {} as never),
    )
    const text = (res.data as { result: string }).result
    check(
      'BlenderTool: a path that does not resolve (ELOOP) is judged from its nearest folder, as before',
      !/ELOOP|too many/i.test(text),
      text.slice(0, 160),
    )
  }
}

{
  const { chmodSync, writeFileSync } = await import('node:fs')
  const { readShown } = await import('../../src/tools/blender/show.ts')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
  const work = join(scratch, 'blender-show')
  mkdirSync(work, { recursive: true })
  const loopA = join(work, 'loop-a.png')
  const loopB = join(work, 'loop-b.png')
  const hasLoop = trySymlinkLoop(loopA, loopB)
  const unreadable = join(work, 'secret.png')
  writeFileSync(unreadable, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
  const nonImage = join(work, 'plain.txt')
  writeFileSync(nonImage, 'hello world')
  const posix = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
  if (posix) chmodSync(unreadable, 0o200)
  try {
    const targets = [...(hasLoop ? [{ path: 'loop-a.png' }] : []), { path: 'absent.png' }, { path: 'plain.txt' }, ...(posix ? [{ path: 'secret.png' }] : [])]
    const parts = await runWithCwdOverride(work, () =>
      readShown(
        targets,
        targets.map(() => null),
        () => undefined,
      ),
    )
    const noteOf = (i: number): string => (parts[i]?.kind === 'note' ? parts[i]!.text : JSON.stringify(parts[i]))
    const offset = hasLoop ? 1 : 0
    if (hasLoop) {
      check(
        'BlenderTool/show: non-ENOENT stat failure reports real error instead of "was not written"',
        !noteOf(0).includes('was not written') && /ELOOP|too many/i.test(noteOf(0)),
        noteOf(0),
      )
    } else {
      skip('BlenderTool/show: non-ENOENT stat failure reports real error instead of "was not written"', 'not read on Windows: no symlink privilege')
    }
    check(
      'BlenderTool/show: absent file still reports "was not written" and text file reports "is not a picture"',
      noteOf(offset).includes('was not written') && noteOf(offset + 1).includes('is not a picture'),
      `${noteOf(offset)} | ${noteOf(offset + 1)}`,
    )
    if (posix) {
      check(
        'BlenderTool/show: unreadable file reports EACCES instead of "is not a picture"',
        !noteOf(offset + 2).includes('is not a picture') && /EACCES|permission denied/i.test(noteOf(offset + 2)),
        noteOf(offset + 2),
      )
    }
  } finally {
    if (posix) chmodSync(unreadable, 0o600)
  }
}

{
  const { BrowserTool } = await import('../../src/tools/browser/BrowserTool.ts')
  const missingShot = join(scratch, 'missing-browser-shot.png')
  const block = BrowserTool.mapToolResultToToolResultBlockParam(
    { op: 'screenshot', result: `screenshot: ${missingShot}`, outcome: 'succeeded', imagePath: missingShot },
    'tu-browser-shot',
  )
  const text = typeof block.content === 'string' ? block.content : ''
  check(
    'BrowserTool: mapToolResultToToolResultBlockParam reports image-not-inlined note when screenshot read fails',
    text.includes('(image not inlined') && /ENOENT|no such file/i.test(text),
    text,
  )
}

{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const path = await import('node:path')
    const sessionPath = path.join(SRC, 'integrations/browser/browserSession.ts')
    const realSession = await import(sessionPath)
    mock.module(sessionPath, () => ({
      ...realSession,
      activeSession: () => ({
        tab: 'main',
        crashed: false,
        page: {
          url: () => 'https://example.com',
          frames: () => [],
        },
      }),
    }))
    const { checkBrowserPermissions } = await import(path.join(SRC, 'tools/browser/ops/permissions.ts'))
    const { getEmptyToolPermissionContext } = await import(path.join(SRC, 'tools/kit/tool.ts'))
    const ctx = { getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
    out.decision = await checkBrowserPermissions({ op: 'click', frame: 99, selector: 'button' }, ctx)
    const ruled = { ...getEmptyToolPermissionContext(), alwaysDenyRules: { userSettings: ['Browser(origin:https://blocked.test)'] } }
    out.ruledDecision = await checkBrowserPermissions({ op: 'click', frame: 99, selector: 'button' }, { getAppState: () => ({ toolPermissionContext: ruled }) })
  `)
  const d = r.decision as { behavior?: string; message?: string }
  const ruledDecision = r.ruledDecision as { behavior?: string; message?: string }
  check(
    'BrowserTool/permissions: a target that cannot be told goes on, as before, when no rule names an origin',
    d.behavior === 'allow',
    JSON.stringify(d),
  )
  check(
    'BrowserTool/permissions: a target that cannot be told is refused when a rule of the user names an origin',
    ruledDecision.behavior === 'deny' && typeof ruledDecision.message === 'string' && ruledDecision.message.length > 0,
    JSON.stringify(ruledDecision),
  )
}

{
  const { ComputerTool } = await import('../../src/tools/computer/ComputerTool.ts')
  const missingShot = join(scratch, 'missing-computer-shot.png')
  const block = ComputerTool.mapToolResultToToolResultBlockParam(
    { action: 'screenshot', result: `screenshot: ${missingShot}`, outcome: 'succeeded', imagePath: missingShot },
    'tu-computer-shot',
  )
  const text = typeof block.content === 'string' ? block.content : ''
  check(
    'ComputerTool: mapToolResultToToolResultBlockParam reports image-not-inlined note when screenshot read fails',
    text.includes('(image not inlined') && /ENOENT|no such file/i.test(text),
    text,
  )
}

{
  const { tableRefusal } = await import('../../src/tools/computer/call/schema.ts')
  const work = join(scratch, 'computer-file-loop')
  mkdirSync(work, { recursive: true })
  const loopA = join(work, 'a')
  const loopB = join(work, 'b')
  if (trySymlinkLoop(loopA, loopB)) {
    const loopMsg = tableRefusal({ action: 'file', x: 10, y: 10, path: loopA } as never)
    check(
      'ComputerTool/schema: non-ENOENT stat failure reports real error instead of "is not a file on this machine"',
      loopMsg !== null && !loopMsg.includes('is not a file on this machine') && /ELOOP|too many/i.test(loopMsg),
      String(loopMsg),
    )
  } else {
    skip('ComputerTool/schema: non-ENOENT stat failure reports real error instead of "is not a file on this machine"', 'not read on Windows: no symlink privilege')
  }
  const absentMsg = tableRefusal({ action: 'file', x: 10, y: 10, path: join(work, 'absent.txt') } as never)
  check(
    'ComputerTool/schema: ENOENT still reports "is not a file on this machine"',
    absentMsg !== null && absentMsg.includes('is not a file on this machine'),
    String(absentMsg),
  )
}

{
  const { operatorIsTyping } = await import('../../src/tools/computer/operatorPause.ts')
  const throwingDriver = {
    keyboardIdleMs: async () => {
      throw new Error('idle read failed')
    },
  }
  const quietDriver = {
    keyboardIdleMs: async () => 60_000,
  }
  const onThrow = await operatorIsTyping(throwingDriver as never)
  const onQuiet = await operatorIsTyping(quietDriver as never)
  check(
    'ComputerTool/operatorPause: an idle read that throws does not hold the act; typing in this window decides, as before',
    onThrow === false && onQuiet === false,
    `onThrow=${String(onThrow)} onQuiet=${String(onQuiet)}`,
  )
}

{
  const { EvalTool } = await import('../../src/tools/eval/EvalTool.ts')
  const missingShot = join(scratch, 'missing-eval-shot.png')
  const block = EvalTool.mapToolResultToToolResultBlockParam(
    {
      status: 'ok',
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
      displays: [],
      annotations: [],
      durationMs: 1,
      language: 'js',
      screenshot: { imagePath: missingShot },
    } as never,
    'tu-eval-shot',
  )
  const text = typeof block.content === 'string' ? block.content : ''
  check(
    'EvalTool: mapToolResultToToolResultBlockParam reports image-not-inlined note when screenshot read fails',
    text.includes('(image not inlined') && /ENOENT|no such file/i.test(text),
    text,
  )
}

{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const path = await import('node:path')
    const pauseCarryPath = path.join(SRC, 'engine/tasks/local-agent/pauseCarry.ts')
    const realPauseCarry = await import(pauseCarryPath)
    let writeErr = 'ENOSPC: disk full'
    mock.module(pauseCarryPath, () => ({
      ...realPauseCarry,
      clearCrewmatePauseRecord: async () => {
        throw Object.assign(new Error('EACCES: unlink refused'), { code: 'EACCES' })
      },
      writeCrewmatePauseRecord: async () => {
        throw Object.assign(new Error(writeErr), { code: 'ENOSPC' })
      },
    }))
    const { getCommandQueue, resetCommandQueue } = await import(path.join(SRC, 'screen/composer/input-core/command-queue.ts'))
    const { cancelAutomaticResume, armBudgetCutResume, armOverloadProbe } = await import(path.join(SRC, 'tools/crewmate/crewmateLifecycle.ts'))
    const { getDefaultAppState } = await import(path.join(SRC, 'screen/app-state/AppStateStore.ts'))
    const notes = () => getCommandQueue().filter(c => c.mode === 'task-notification').map(c => String(c.value))

    resetCommandQueue()
    cancelAutomaticResume('agent-drop-fail')
    await new Promise(resolve => setTimeout(resolve, 30))
    out.dropPath = realPauseCarry.crewmatePauseRecordPath('agent-drop-fail')
    out.dropNotes = notes()

    let state = getDefaultAppState()
    const setAppState = fn => { state = fn(state) }
    const ctx = { getAppState: () => state, setAppState, setAppStateForTasks: setAppState, abortController: new AbortController(), options: { tools: [] }, messages: [] }

    resetCommandQueue()
    writeErr = 'ENOSPC: disk full'
    const t1 = armBudgetCutResume({
      taskId: 'agent-save-budget',
      description: 'budget worker',
      registration: new AbortController(),
      toolUseContext: ctx,
      rootSetAppState: setAppState,
      delayMs: 60_000,
      pause: { why: 'usage limit', words: 'spent', resumesAtMs: Date.now() + 60_000 },
    })
    if (t1) clearTimeout(t1)
    await new Promise(resolve => setTimeout(resolve, 30))
    out.budgetPath = realPauseCarry.crewmatePauseRecordPath('agent-save-budget')
    out.budgetNotes = notes()

    resetCommandQueue()
    writeErr = 'EACCES: read-only dir'
    const t2 = armOverloadProbe({
      taskId: 'agent-save-overload',
      description: 'overload worker',
      registration: new AbortController(),
      toolUseContext: ctx,
      rootSetAppState: setAppState,
      model: 'claude-fable-5-1',
      pause: { why: 'provider overloaded', words: 'overloaded' },
      afterDeath: true,
    })
    if (t2) clearTimeout(t2)
    await new Promise(resolve => setTimeout(resolve, 30))
    out.overloadPath = realPauseCarry.crewmatePauseRecordPath('agent-save-overload')
    out.overloadNotes = notes()
  `)
  const dropNotes = (r.dropNotes as string[]).join('\n')
  const budgetNotes = (r.budgetNotes as string[]).join('\n')
  const overloadNotes = (r.overloadNotes as string[]).join('\n')
  check(
    'agentToolUtils: dropPauseRecord failure notifies with path, error, and delete guidance',
    dropNotes.includes(String(r.dropPath)) && dropNotes.includes('could not be removed (EACCES: unlink refused)') && dropNotes.includes('delete it, or the next session start resumes it'),
    dropNotes || '(no notification)',
  )
  check(
    'agentToolUtils: armBudgetCutResume pause record save failure notifies with crewmate, path, error, and restart consequence',
    budgetNotes.includes('Crewmate "budget worker"') && budgetNotes.includes(String(r.budgetPath)) && budgetNotes.includes('could not be saved (ENOSPC: disk full)') && budgetNotes.includes('after a restart'),
    budgetNotes || '(no notification)',
  )
  check(
    'agentToolUtils: armOverloadProbe pause record save failure notifies with crewmate, path, error, and restart consequence',
    overloadNotes.includes('Crewmate "overload worker"') && overloadNotes.includes(String(r.overloadPath)) && overloadNotes.includes('could not be saved (EACCES: read-only dir)') && overloadNotes.includes('after a restart'),
    overloadNotes || '(no notification)',
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
