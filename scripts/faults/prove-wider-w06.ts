#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const REPO = join(HERE, '../..')

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-wider-w06-')))
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
    const fs = await import('node:fs')
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const SRC = ${JSON.stringify(SRC)}
    const REPO = ${JSON.stringify(REPO)}
    const HOME = ${JSON.stringify(home)}
    const SCRATCH = ${JSON.stringify(scratch)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', ...extraEnv },
    })
    if (res.status !== 0) throw new Error(`scenario failed (rc=${res.status}): ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nw06-1: VerbsPart.leave and ExitHandoff — failed abort interrupt lands in receipt detail and shows on screen')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const socketPath = path.join(SRC, 'daemon/controlSocket.ts')
    const realSocket = await import(socketPath)
    let releaseLeave = null
    mock.module(socketPath, () => ({
      ...realSocket,
      daemonControlRpc: () => new Promise(resolve => {
        releaseLeave = resolve
      }),
    }))
    const { VerbsPart } = await import(path.join(SRC, 'services/engine-connector/daemon/verbs.ts'))
    let failInterrupt = true
    const verbs = new VerbsPart({
      record: () => ({ sessionId: 'sess-leave-w06' }),
      rpc: async () => {
        if (failInterrupt) throw new Error('ECONNREFUSED')
        releaseLeave?.({ ok: true, outcome: 'applied', detail: JSON.stringify({ note: 'skipped' }) })
        return { ok: true }
      },
      chainRpc: async () => ({ ok: true }),
      verbChain: () => Promise.resolve(),
      tick: async () => {},
      readFacts: () => {},
    })

    const c1 = new AbortController()
    let settledBeforeLeave = false
    const p1 = verbs.leave({ signal: c1.signal }).then(v => {
      if (releaseLeave !== null) settledBeforeLeave = true
      return v
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    c1.abort(new Error('ctrl-c'))
    await new Promise(resolve => setTimeout(resolve, 60))
    const doneEarly = settledBeforeLeave
    const finish = releaseLeave
    releaseLeave = null
    finish?.({ ok: true, outcome: 'applied', detail: JSON.stringify({ note: 'none' }) })
    out.failedReceipt = await p1
    out.doneEarly = doneEarly

    failInterrupt = false
    const c2 = new AbortController()
    const p2 = verbs.leave({ signal: c2.signal })
    await new Promise(resolve => setTimeout(resolve, 20))
    c2.abort(new Error('ctrl-c'))
    out.okReceipt = await p2

    const { enableConfigs } = await import(path.join(SRC, 'utils/config/globalConfig.ts'))
    enableConfigs()
    const gsPath = path.join(SRC, 'utils/gracefulShutdown.ts')
    const realGs = await import(gsPath)
    const shutdownMessages = []
    mock.module(gsPath, () => ({
      ...realGs,
      gracefulShutdown: async (_code, _reason, opts) => {
        shutdownMessages.push(opts?.finalMessage ?? '')
      },
    }))
    const React = await import('react')
    const { Box } = await import(path.join(SRC, 'ink.ts'))
    const { ThemeProvider } = await import(path.join(SRC, 'components/design-system/ThemeProvider.tsx'))
    const { leaveNoteAtExit } = await import(path.join(SRC, 'components/ExitHandoff.tsx'))
    const { call: exitCall } = await import(path.join(SRC, 'commands/exit/exit.tsx'))
    const { ExitFlow } = await import(path.join(SRC, 'components/ExitFlow.tsx'))
    const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import(path.join(SRC, 'services/engine-connector/focusedConnector.ts'))
    const { noSessionConnector } = await import(path.join(SRC, 'services/engine-connector/noSessionConnector.ts'))
    const { mountOffscreen, waitFor } = await import(path.join(REPO, 'scripts/lib/settingsPopupHarness.ts'))
    const detailSentence = 'the handoff could not be interrupted (ECONNREFUSED) — the turn may still be running'
    setFocusedSessionConnector({
      ...noSessionConnector(),
      sessionId: () => '00000000-0000-4000-8000-0000000000ab',
      workRoster: () => ({ rows: [], mission: [], reported: true }),
      leave: async () => ({ note: 'none', detail: detailSentence }),
    })
    out.forwarded = await leaveNoteAtExit(new AbortController().signal)

    let exitDoneMsg = null
    const exitNode = await exitCall((msg) => { exitDoneMsg = msg ?? '' }, {})
    const m1 = await mountOffscreen(
      React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 100, height: 6 }, exitNode)),
      100,
      6,
    )
    await waitFor(() => exitDoneMsg !== null && shutdownMessages.length >= 1, 3000)
    m1.unmount()

    let flowDoneMsg = null
    const m2 = await mountOffscreen(
      React.createElement(
        ThemeProvider,
        {},
        React.createElement(
          Box,
          { flexDirection: 'column', width: 100, height: 6 },
          React.createElement(ExitFlow, { showWorktree: false, onDone: (msg) => { flowDoneMsg = msg ?? '' } }),
        ),
      ),
      100,
      6,
    )
    await waitFor(() => flowDoneMsg !== null && shutdownMessages.length >= 2, 3000)
    m2.unmount()
    releaseFocusedSessionConnector()
    out.exitDoneMsg = exitDoneMsg
    out.flowDoneMsg = flowDoneMsg
    out.shutdownMessages = shutdownMessages
  `)
  const failed = r.failedReceipt as { note?: string; detail?: string } | undefined
  const ok = r.okReceipt as { note?: string; detail?: string } | undefined
  const forwarded = r.forwarded as { note?: string; detail?: string } | undefined
  const shutdownMessages = (r.shutdownMessages as string[] | undefined) ?? []
  const expected = 'the handoff could not be interrupted (ECONNREFUSED) — the turn may still be running'
  check('VerbsPart.leave waits for leave RPC (no early race) and returns interrupt failure detail', r.doneEarly === false && failed?.note === 'none' && failed?.detail === expected, JSON.stringify(r))
  check('VerbsPart.leave returns skipped with no error detail when abort interrupt succeeds without outcome field', ok?.note === 'skipped' && ok?.detail === undefined, JSON.stringify(ok))
  check('ExitHandoff forwards receipt.detail and both /exit and ExitFlow put it in gracefulShutdown finalMessage', forwarded?.detail === expected && shutdownMessages.length === 2 && shutdownMessages.every(msg => msg.includes(expected)), JSON.stringify({ forwarded, shutdownMessages }))
}

console.log('\nw06-2: daemonConnector.sendWords and sessionSend — unreadable open questions add a one-time note on SendReceiptV1')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const oblPath = path.join(SRC, 'services/crew/obligations.ts')
    const realObl = await import(oblPath)
    let failRead = true
    mock.module(oblPath, () => ({
      ...realObl,
      openObligations: async () => {
        if (failRead) throw new Error('EACCES: obligations unreadable')
        return []
      },
    }))
    const ensurePath = path.join(SRC, 'services/switchboard/ensureDaemon.ts')
    const realEnsure = await import(ensurePath)
    mock.module(ensurePath, () => ({
      ...realEnsure,
      ensureOwnedDaemon: async () => true,
    }))
    const { DaemonSessionConnector } = await import(path.join(SRC, 'services/engine-connector/daemonConnector.ts'))
    const rpcCalls = []
    const connector = new DaemonSessionConnector(
      {
        sessionId: 'sess-conn-w06-2',
        runnerId: 'runner-1',
        title: 't',
        projectLabel: 'p',
        workspaceId: SCRATCH,
        home: HOME,
      },
      {
        rpc: async (req) => { rpcCalls.push(req); return { ok: true } },
        armTranscriptWatcher: () => {},
        armTranscriptTimer: () => {},
      },
    )
    out.first = await connector.sendWords('first reply')
    out.second = await connector.sendWords('second reply')
    failRead = false
    out.recovered = await connector.sendWords('third reply')
    out.rpcCount = rpcCalls.length

    const { sendToSession } = await import(path.join(SRC, 'screens/chat/submit/sessionSend.ts'))
    const notices = []
    const makeDeps = () => ({
      addNotification: (n) => notices.push(n),
      repinToBottom: () => {},
      setSubmitCount: () => {},
      isLoadingRef: { current: false },
      getFocusedSeatLive: () => ({ phase: 'idle' }),
      setInputValue: () => {},
      setInputMode: () => {},
      setPastedContents: () => {},
      armedHandedBackRef: { current: null },
      setHistoryIndex: () => {},
      onBeforeSubmit: () => {},
    })
    const makeLine = (receipt) => ({
      input: 'hi',
      helpers: { setCursorOffset: () => {}, clearBuffer: () => {}, resetHistory: () => {} },
      options: undefined,
      submittedAt: new Date().toISOString(),
      text: 'hi',
      focusedNow: { sendWords: async () => receipt },
      seatMode: 'prompt',
      seatPastes: {},
      seatCommand: undefined,
      seat: 'session',
    })
    await sendToSession(makeDeps(), makeLine(out.first))
    const noticesAfterNoted = notices.length
    await sendToSession(makeDeps(), makeLine(out.second))
    out.notices = notices
    out.noticesAfterNoted = noticesAfterNoted
  `)
  const first = r.first as { state?: string; note?: string } | undefined
  const second = r.second as { state?: string; note?: string } | undefined
  const recovered = r.recovered as { state?: string; note?: string } | undefined
  const notices = (r.notices as Array<{ text?: string }> | undefined) ?? []
  const expected = 'open questions could not be read (EACCES: obligations unreadable), so this went out as an ordinary message; answer the question from its card if it still shows.'
  check('DaemonSessionConnector.sendWords attaches the note once when openObligations fails and still sends', first?.state === 'accepted' && first?.note === expected && second?.state === 'accepted' && second?.note === undefined && recovered?.state === 'accepted' && recovered?.note === undefined && r.rpcCount === 3, JSON.stringify({ first, second, recovered, rpcCount: r.rpcCount }))
  check('sessionSend surfaces SendReceiptV1.note via addNotification once and stays quiet without a note', r.noticesAfterNoted === 1 && notices.length === 1 && notices[0]?.text === expected, JSON.stringify({ noticesAfterNoted: r.noticesAfterNoted, notices }))
}

console.log('\nw06-3: mcp/client.clearServerCache and runLaunch — failed duplicate server cleanup is returned and noted at start')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const mcpClient = await import(path.join(SRC, 'services/mcp/client.ts'))
    const dupConfig = { type: 'http', url: 'https://example.invalid/mcp-dup', scope: 'dynamic' }
    const directKey = mcpClient.getServerCacheKey('ext:direct', dupConfig)
    mcpClient.connectToServer.cache.set(directKey, Promise.resolve({
      type: 'connected',
      name: 'ext:direct',
      config: dupConfig,
      client: {},
      capabilities: {},
      cleanup: async () => { throw new Error('EPERM: process locked') },
    }))
    out.directFail = await mcpClient.clearServerCache('ext:direct', dupConfig)
    const cleanKey = mcpClient.getServerCacheKey('ext:clean', dupConfig)
    mcpClient.connectToServer.cache.set(cleanKey, Promise.resolve({
      type: 'connected',
      name: 'ext:clean',
      config: dupConfig,
      client: {},
      capabilities: {},
      cleanup: async () => {},
    }))
    out.directOk = await mcpClient.clearServerCache('ext:clean', dupConfig)

    mock.module(path.join(SRC, 'services/mcp/anthropicConnectors.ts'), () => ({
      fetchAnthropicConnectorsIfEligible: async () => ({ 'claudeai:dup': dupConfig }),
    }))
    mock.module(path.join(SRC, 'cli/run.ts'), () => ({
      runHeadless: async () => {},
    }))
    mcpClient.connectToServer.cache.set(mcpClient.getServerCacheKey('ext:dup', dupConfig), Promise.resolve({
      type: 'connected',
      name: 'ext:dup',
      config: dupConfig,
      client: {},
      capabilities: {},
      cleanup: async () => { throw new Error('EPERM: process locked') },
    }))
    mcpClient.fetchToolsForClient.cache.set('ext:dup', Promise.resolve([]))
    mcpClient.fetchCommandsForClient.cache.set('ext:dup', Promise.resolve([]))
    mcpClient.connectToServer.cache.set(mcpClient.getServerCacheKey('claudeai:dup', dupConfig), Promise.resolve({
      type: 'connected',
      name: 'claudeai:dup',
      config: dupConfig,
      client: {},
      capabilities: {},
      cleanup: async () => {},
    }))
    mcpClient.fetchToolsForClient.cache.set('claudeai:dup', Promise.resolve([]))
    mcpClient.fetchCommandsForClient.cache.set('claudeai:dup', Promise.resolve([]))

    const stderrLines = []
    const realStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true }
    const { getEmptyToolPermissionContext } = await import(path.join(SRC, 'Tool.ts'))
    const { runLaunch } = await import(path.join(SRC, 'main/runLaunch.ts'))
    await runLaunch({
      opts: { continue: true, onlyMcp: true },
      commands: [],
      prompt: 'hi',
      permissionMode: 'default',
      toolPermissionContext: getEmptyToolPermissionContext(),
      allowDangerousSkip: false,
      mcpConfigPromise: Promise.resolve({ 'ext:dup': dupConfig }),
      thinkingConfig: { type: 'disabled' },
      userSpecifiedModel: undefined,
      fallbackModel: undefined,
      mainThreadAgentDefinition: undefined,
      activeAgents: [],
      allAgents: [],
      customSystemPrompt: undefined,
      appendSystemPrompt: undefined,
      inputFormat: 'text',
      outputFormat: 'text',
      includePartialMessages: false,
      door: 'rows',
    })
    process.stderr.write = realStderrWrite
    out.stderr = stderrLines.join('')
  `)
  const directFail = r.directFail as { cleanupError?: string } | undefined
  const directOk = r.directOk as { cleanupError?: string } | undefined
  const expected = 'the duplicate MCP server ext:dup could not be closed (EPERM: process locked) and may still be running'
  check('clearServerCache returns cleanupError without throwing when cleanup fails, and none when it succeeds', directFail?.cleanupError === 'EPERM: process locked' && directOk?.cleanupError === undefined, JSON.stringify({ directFail, directOk }))
  check('runLaunch writes the duplicate server close-failure note to stderr at start', String(r.stderr ?? '').includes(expected), String(r.stderr ?? '').slice(0, 300))
}

console.log('\nw06-4: agents/store.listAgentDrafts and studioEditorModel — unreadable drafts folder surfaces notice instead of offering none')
{
  const r = runScenario(`
    const { enableConfigs } = await import(path.join(SRC, 'utils/config/globalConfig.ts'))
    enableConfigs()
    const store = await import(path.join(SRC, 'services/agents/store.ts'))
    const { createStudioEditorMachine } = await import(path.join(SRC, 'components/agents/studio/studioEditorModel.ts'))

    const makeMachine = () => createStudioEditorMachine(
      {
        mode: 'create',
        cwd: SCRATCH,
        getExistingAgents: () => [],
        getParentModel: () => 'claude-fable-5',
        onSaved: () => {},
        onCancel: () => {},
      },
      () => {},
    )

    const absentMachine = makeMachine()
    out.absentNote = absentMachine.snapshot().note
    absentMachine.dispose()

    const draftsPath = path.join(HOME, 'agent-drafts')
    fs.writeFileSync(draftsPath, 'not-a-directory', 'utf8')
    out.listDraftsArray = store.listAgentDrafts()
    const unreadMachine = makeMachine()
    out.unreadNote = unreadMachine.snapshot().note
    out.unreadRecover = unreadMachine.snapshot().recoverOffer
    unreadMachine.dispose()
  `)
  const unreadNote = r.unreadNote as { text?: string } | null | undefined
  check('studioEditorModel stays quiet when agent-drafts folder is absent (ENOENT)', r.absentNote === null, JSON.stringify(r.absentNote))
  check('studioEditorModel surfaces "saved drafts could not be read (<error>)" when drafts folder cannot be read, without throwing', Array.isArray(r.listDraftsArray) && r.listDraftsArray.length === 0 && r.unreadRecover === null && typeof unreadNote?.text === 'string' && unreadNote.text.startsWith('saved drafts could not be read (') && unreadNote.text.endsWith(')'), JSON.stringify({ listDraftsArray: r.listDraftsArray, unreadNote, unreadRecover: r.unreadRecover }))
}

console.log(failures === 0 ? `\nGREEN (${checks} checks)` : `\nRED (${failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
