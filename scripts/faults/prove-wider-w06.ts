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
    const socketPath = path.join(SRC, 'daemon/control/controlSocket.ts')
    const realSocket = await import(socketPath)
    let releaseLeave = null
    mock.module(socketPath, () => ({
      ...realSocket,
      daemonControlRpc: () => new Promise(resolve => {
        releaseLeave = resolve
      }),
    }))
    const { VerbsPart } = await import(path.join(SRC, 'engine/connector/daemon/verbs.ts'))
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

    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const gsPath = path.join(SRC, 'platform/processes/gracefulShutdown.ts')
    const realGs = await import(gsPath)
    const shutdownMessages = []
    mock.module(gsPath, () => ({
      ...realGs,
      gracefulShutdown: async (_code, _reason, opts) => {
        shutdownMessages.push(opts?.finalMessage ?? '')
      },
    }))
    const React = await import('react')
    const { Box } = await import(path.join(SRC, 'screen/themedRenderer.ts'))
    const { ThemeProvider } = await import(path.join(SRC, 'screen/theme/ThemeProvider.tsx'))
    const { leaveNoteAtExit } = await import(path.join(SRC, 'commands/exit/ExitHandoff.tsx'))
    const { call: exitCall } = await import(path.join(SRC, 'commands/exit/exit.tsx'))
    const { ExitFlow } = await import(path.join(SRC, 'commands/exit/ExitFlow.tsx'))
    const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import(path.join(SRC, 'engine/connector/focusedConnector.ts'))
    const { noSessionConnector } = await import(path.join(SRC, 'engine/connector/noSessionConnector.ts'))
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
    const oblPath = path.join(SRC, 'crew/crewmates/obligations.ts')
    const realObl = await import(oblPath)
    let failRead = true
    mock.module(oblPath, () => ({
      ...realObl,
      openObligations: async () => {
        if (failRead) throw new Error('EACCES: obligations unreadable')
        return []
      },
    }))
    const ensurePath = path.join(SRC, 'daemon/switchboard/ensureDaemon.ts')
    const realEnsure = await import(ensurePath)
    mock.module(ensurePath, () => ({
      ...realEnsure,
      ensureOwnedDaemon: async () => true,
    }))
    const { DaemonSessionConnector } = await import(path.join(SRC, 'engine/connector/daemonConnector.ts'))
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

    const { sendToSession } = await import(path.join(SRC, 'screen/chat/submit/sessionSend.ts'))
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
    const mcpClient = await import(path.join(SRC, 'integrations/mcp/client.ts'))
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

    mock.module(path.join(SRC, 'integrations/mcp/anthropicConnectors.ts'), () => ({
      fetchAnthropicConnectorsIfEligible: async () => ({ 'claudeai:dup': dupConfig }),
    }))
    mock.module(path.join(SRC, 'daemon/runner/runHeadless.ts'), () => ({
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
    const { getEmptyToolPermissionContext } = await import(path.join(SRC, 'tools/kit/tool.ts'))
    const { runLaunch } = await import(path.join(SRC, 'boot/main/runLaunch.ts'))
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
    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const store = await import(path.join(SRC, 'crew/agents/store.ts'))
    const { createStudioEditorMachine } = await import(path.join(SRC, 'screen/agents/studio/studioEditorModel.ts'))

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

console.log('\nw06-5: agents/store.discardAgentDraft and studioEditorModel — failed draft removal returns error and surfaces notice')
{
  const r = runScenario(`
    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const store = await import(path.join(SRC, 'crew/agents/store.ts'))
    const { createStudioEditorMachine } = await import(path.join(SRC, 'screen/agents/studio/studioEditorModel.ts'))

    const absentPath = path.join(SCRATCH, 'missing-draft.json')
    out.absentDiscard = store.discardAgentDraft(absentPath)

    const dirPath = path.join(SCRATCH, 'unremovable-draft-dir')
    fs.mkdirSync(dirPath)
    out.dirDiscard = store.discardAgentDraft(dirPath)

    const { serializeAgentMarkdown } = await import(path.join(SRC, 'crew/agents/codec.ts'))
    const draftPath = '/drafts/new.json'
    const draftRaw = serializeAgentMarkdown({ name: 'scout-one', description: 'Use when testing draft removal.' }, 'You are scout-one, a careful verification agent.')
    const machine1 = createStudioEditorMachine(
      {
        mode: 'create',
        cwd: SCRATCH,
        getExistingAgents: () => [],
        getParentModel: () => 'claude-fable-5',
        onSaved: () => {},
        onCancel: () => {},
      },
      () => {},
      {
        listDrafts: () => [{ path: draftPath, draft: { version: 1, savedAt: 'now', raw: draftRaw } }],
        discardDraft: () => ({ ok: false, error: 'EACCES: permission denied' }),
      },
    )
    machine1.declineRecover()
    out.declineNote = machine1.snapshot().note
    machine1.dispose()

    let savedMessage = ''
    const machine2 = createStudioEditorMachine(
      {
        mode: 'create',
        cwd: SCRATCH,
        getExistingAgents: () => [],
        getParentModel: () => 'claude-fable-5',
        onSaved: (msg) => { savedMessage = msg },
        onCancel: () => {},
      },
      () => {},
      {
        listDrafts: () => [{ path: draftPath, draft: { version: 1, savedAt: 'now', raw: draftRaw } }],
        discardDraft: () => ({ ok: false, error: 'EACCES: permission denied' }),
        saveDocument: async () => ({ path: '/dest/scout-one.md', afterRevision: 'rev-1', semanticChanges: ['name'], bytes: 10, at: 'now' }),
      },
    )
    machine2.loadRaw(draftRaw)
    await machine2.save()
    out.savedMessage = savedMessage
    out.saveNote = machine2.snapshot().note
    machine2.dispose()
  `)
  const absentDiscard = r.absentDiscard as { ok?: boolean } | undefined
  const dirDiscard = r.dirDiscard as { ok?: boolean; error?: string } | undefined
  const declineNote = r.declineNote as { text?: string } | null | undefined
  const saveNote = r.saveNote as { text?: string } | null | undefined
  const expected = 'the draft at /drafts/new.json could not be removed (EACCES: permission denied) — it will be offered again'
  check('discardAgentDraft returns { ok: true } on ENOENT and { ok: false, error } on non-ENOENT failure', absentDiscard?.ok === true && dirDiscard?.ok === false && typeof dirDiscard?.error === 'string' && dirDiscard.error.length > 0, JSON.stringify({ absentDiscard, dirDiscard }))
  check('studioEditorModel surfaces removal failure sentence on declineRecover and save', declineNote?.text === expected && saveNote?.text === expected && String(r.savedMessage ?? '').includes(expected), JSON.stringify({ declineNote, saveNote, savedMessage: r.savedMessage }))
}

console.log('\nw06-6: extensions/load/servers and reload — failed dataDir mkdir and media server env surface in reload receipt')
{
  const r = runScenario(`
    const { setCwdState, setOriginalCwd, setProjectRoot } = await import(path.join(SRC, 'boot/process-state/processState.ts'))
    setCwdState(SCRATCH)
    setOriginalCwd(SCRATCH)
    setProjectRoot(SCRATCH)
    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const { updateSettingsForSource } = await import(path.join(SRC, 'platform/settings/settings.ts'))
    const { MEDIA_EXTENSION_ID } = await import(path.join(SRC, 'integrations/media/settings.ts'))
    const { setSwitch } = await import(path.join(SRC, 'integrations/extensions/install.ts'))
    const { getExtensionDataDir } = await import(path.join(SRC, 'integrations/extensions/paths.ts'))
    const { reloadExtensions } = await import(path.join(SRC, 'integrations/extensions/reload.ts'))
    const { getExtensionMcpServers } = await import(path.join(SRC, 'integrations/extensions/load/servers.ts'))

    setSwitch(MEDIA_EXTENSION_ID, true)
    updateSettingsForSource('userSettings', { media: { serverPath: 'relative/not-absolute.js' } })
    const dataDir = getExtensionDataDir(MEDIA_EXTENSION_ID)
    fs.mkdirSync(path.dirname(dataDir), { recursive: true })
    fs.writeFileSync(dataDir, 'file-blocking-dir', 'utf8')

    const bad = await reloadExtensions({ cwd: SCRATCH })
    out.badLine = bad.line
    out.badWarnings = bad.warnings ?? null
    out.dataDir = dataDir
    out.serversWhenBad = Object.keys(getExtensionMcpServers())

    fs.rmSync(dataDir, { force: true })
    const okRoot = path.join(SCRATCH, 'media-root')
    const okServer = path.join(SCRATCH, 'media-server.js')
    fs.mkdirSync(okRoot, { recursive: true })
    fs.writeFileSync(okServer, '', 'utf8')
    updateSettingsForSource('userSettings', { media: { root: okRoot, serverPath: okServer } })
    const ok = await reloadExtensions({ cwd: SCRATCH })
    out.okLine = ok.line
    out.okWarnings = ok.warnings ?? null
    out.serversWhenOk = Object.keys(getExtensionMcpServers())
  `)
  const dataDir = String(r.dataDir ?? '')
  const badLine = String(r.badLine ?? '')
  const okLine = String(r.okLine ?? '')
  const serversWhenBad = (r.serversWhenBad as string[] | undefined) ?? []
  const serversWhenOk = (r.serversWhenOk as string[] | undefined) ?? []
  check('reloadExtensions receipt includes dataDir mkdir failure and media server load failure while keeping other servers', badLine.includes(`mercury-media: its data folder ${dataDir} could not be made (`) && badLine.includes('mercury-media: its media server was not loaded (media.serverPath must be an absolute path.)') && serversWhenBad.length >= 3, JSON.stringify({ badLine, badWarnings: r.badWarnings, serversWhenBad }))
  check('reloadExtensions stays quiet and loads media server when dataDir and media settings succeed', r.okWarnings === null && !okLine.includes('could not be made') && !okLine.includes('was not loaded') && serversWhenOk.some(s => s.includes('mercury-media')), JSON.stringify({ okLine, okWarnings: r.okWarnings, serversWhenOk }))
}

console.log('\nw06-7: useDiffData and DiffDialog — failed git diff fetch carries error and displays load failure sentence')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const gitDiffPath = path.join(SRC, 'screen/diff/gitDiff.ts')
    const realGitDiff = await import(gitDiffPath)
    let mode = 'throw'
    mock.module(gitDiffPath, () => ({
      ...realGitDiff,
      fetchGitDiff: async () => {
        if (mode === 'throw') throw new Error('git exited 128: dubious ownership')
        return null
      },
      fetchGitDiffHunks: async () => new Map(),
      fetchGitDiffFor: async () => {
        if (mode === 'throw') throw new Error('git exited 128: dubious ownership')
        return null
      },
      fetchGitDiffHunksFor: async () => new Map(),
    }))
    const React = await import('react')
    const { Box } = await import(path.join(SRC, 'screen/themedRenderer.ts'))
    const { AppStateProvider } = await import(path.join(SRC, 'screen/app-state/AppState.tsx'))
    const { getDefaultAppState } = await import(path.join(SRC, 'screen/app-state/AppStateStore.ts'))
    const { ThemeProvider } = await import(path.join(SRC, 'screen/theme/ThemeProvider.tsx'))
    const { KeybindingSetup } = await import(path.join(SRC, 'screen/keys/KeybindingProviderSetup.tsx'))
    const { DiffDialog } = await import(path.join(SRC, 'screen/diff/DiffDialog.tsx'))
    const { mountOffscreen, waitFor } = await import(path.join(REPO, 'scripts/lib/settingsPopupHarness.ts'))

    const renderDiff = async () => {
      const el = React.createElement(
        AppStateProvider,
        { initialState: getDefaultAppState() },
        React.createElement(
          ThemeProvider,
          {},
          React.createElement(
            KeybindingSetup,
            null,
            React.createElement(
              Box,
              { flexDirection: 'column', width: 120, height: 24 },
              React.createElement(DiffDialog, { messages: [], onDone: () => {} }),
            ),
          ),
        ),
      )
      const m = await mountOffscreen(el, 120, 24)
      await waitFor(() => !m.lines().some(l => l.includes('Reading the diff')), 3000)
      const text = m.lines().map(l => l.trim()).filter(Boolean).join('\\n')
      m.unmount()
      return text
    }

    out.errorScreen = await renderDiff()
    mode = 'clean'
    out.cleanScreen = await renderDiff()
  `)
  const errorScreen = String(r.errorScreen ?? '')
  const cleanScreen = String(r.cleanScreen ?? '')
  check('DiffDialog shows "Git diff could not be loaded (<error>) — try again." instead of clean tree on fetch failure', errorScreen.includes('Git diff could not be loaded (git exited 128: dubious ownership) — try again.') && !errorScreen.includes('The working tree is clean.'), errorScreen.slice(0, 300))
  check('DiffDialog still shows "The working tree is clean." when git diff succeeds with no changes', cleanScreen.includes('The working tree is clean.') && !cleanScreen.includes('Git diff could not be loaded'), cleanScreen.slice(0, 300))
}

console.log('\nw06-8: acpServer/mercuryRequests — _mercury/crew surfaces readErrors for failed sources and omits it when clean')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const convPath = path.join(SRC, 'crew/crewmates/conversations.ts')
    const descPath = path.join(SRC, 'crew/crewmates/descriptor.ts')
    const graphPath = path.join(SRC, 'crew/crewmates/graph.ts')
    const projPath = path.join(SRC, 'crew/crewmates/projection.ts')
    const [realConv, realDesc, realGraph, realProj] = await Promise.all([
      import(convPath),
      import(descPath),
      import(graphPath),
      import(projPath),
    ])
    let failReads = true
    mock.module(convPath, () => ({
      ...realConv,
      listConversations: async () => {
        if (failReads) throw new Error('conv boom')
        return []
      },
      listReadCursors: async () => {
        if (failReads) throw new Error('cursor boom')
        return new Map()
      },
    }))
    mock.module(descPath, () => ({
      ...realDesc,
      listSessionDescriptors: async () => {
        if (failReads) throw new Error('desc boom')
        return []
      },
    }))
    mock.module(graphPath, () => ({
      ...realGraph,
      assembleSessionGraph: async () => {
        if (failReads) throw new Error('graph boom')
        return null
      },
    }))
    mock.module(projPath, () => ({
      ...realProj,
      resolveCrewSnapshot: async () => ({ members: [], sources: null }),
    }))

    const { mercuryRequests } = await import(path.join(SRC, 'integrations/acp/server/mercuryRequests.ts'))
    const handlers = new Map()
    const fakeApp = {
      onRequest(method, _validate, handler) {
        handlers.set(method, handler)
        return this
      },
    }
    mercuryRequests(fakeApp)
    const crewHandler = handlers.get('_mercury/crew')

    out.failedAnswer = await crewHandler({ params: {} })
    failReads = false
    const okAnswer = await crewHandler({ params: {} })
    out.okHasReadErrors = 'readErrors' in okAnswer
  `)
  const failed = r.failedAnswer as { readErrors?: Record<string, string>; members?: unknown[]; conversations?: unknown[]; descriptors?: unknown[] } | undefined
  const re = failed?.readErrors
  check('_mercury/crew carries readErrors naming all four failed sources while still answering members and empty lists', Array.isArray(failed?.members) && Array.isArray(failed?.conversations) && Array.isArray(failed?.descriptors) && re?.conversations === 'conv boom' && re?.readCursors === 'cursor boom' && re?.descriptors === 'desc boom' && re?.graph === 'graph boom', JSON.stringify(failed))
  check('_mercury/crew omits readErrors when all four reads succeed', r.okHasReadErrors === false, JSON.stringify(r))
}

console.log('\nw06-9: MercuryExitConfirm — leave dialog reads live running work as it paints')
{
  const r = runScenario(`
    const { enableConfigs } = await import(path.join(SRC, 'platform/config/globalConfig.ts'))
    enableConfigs()
    const React = await import('react')
    const { Box } = await import(path.join(SRC, 'screen/themedRenderer.ts'))
    const { ThemeProvider } = await import(path.join(SRC, 'screen/theme/ThemeProvider.tsx'))
    const { AppStoreContext } = await import(path.join(SRC, 'screen/app-state/AppState.tsx'))
    const { createStore } = await import(path.join(SRC, 'platform/primitives/store.ts'))
    const { getDefaultAppState } = await import(path.join(SRC, 'screen/app-state/AppStateStore.ts'))
    const { call: exitCall } = await import(path.join(SRC, 'commands/exit/exit.tsx'))
    const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import(path.join(SRC, 'engine/connector/focusedConnector.ts'))
    const { noSessionConnector } = await import(path.join(SRC, 'engine/connector/noSessionConnector.ts'))
    const { mountOffscreen, settle } = await import(path.join(REPO, 'scripts/lib/settingsPopupHarness.ts'))

    const workListeners = new Set()
    let rosterRows = [{ id: 'sh-1', kind: 'shell', label: 'sleep 90', status: 'running', startedAt: 1 }]
    const conn = {
      ...noSessionConnector(),
      sessionId: () => '00000000-0000-4000-8000-0000000000cd',
      workRoster: () => ({ rows: rosterRows, mission: [], reported: true }),
      subscribeWork: (listener) => {
        workListeners.add(listener)
        return () => { workListeners.delete(listener) }
      },
    }
    setFocusedSessionConnector(conn)
    try {
      const store = createStore(getDefaultAppState())
      const node = await exitCall(() => {}, { getAppState: () => store.getState(), setAppState: (u) => store.setState(u) })
      const m = await mountOffscreen(
        React.createElement(
          AppStoreContext.Provider,
          { value: store },
          React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 100, height: 8 }, node)),
        ),
        100,
        8,
      )
      await settle(80)
      out.hostedBefore = m.screen()

      rosterRows = [{ id: 'sh-1', kind: 'shell', label: 'sleep 90', status: 'completed', startedAt: 1 }]
      for (const listener of [...workListeners]) listener()
      await settle(80)
      out.hostedAfter = m.screen()
      m.unmount()
    } finally {
      releaseFocusedSessionConnector(conn)
    }

    const localStore = createStore({
      ...getDefaultAppState(),
      tasks: {
        't-1': { id: 't-1', type: 'local_bash', status: 'running', isBackgrounded: true, description: 'sleep 10', startTime: Date.now(), shellCommand: { status: 'backgrounded' } },
        't-2': { id: 't-2', type: 'local_bash', status: 'running', isBackgrounded: true, description: 'sleep 20', startTime: Date.now(), shellCommand: { status: 'backgrounded' } },
      },
    })
    const localNode = await exitCall(() => {}, { getAppState: () => localStore.getState(), setAppState: (u) => localStore.setState(u) })
    const m2 = await mountOffscreen(
      React.createElement(
        AppStoreContext.Provider,
        { value: localStore },
        React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 100, height: 8 }, localNode)),
      ),
      100,
      8,
    )
    await settle(80)
    out.localTwo = m2.screen()
    localStore.setState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        't-1': { ...prev.tasks['t-1'], status: 'completed' },
      },
    }))
    await settle(80)
    out.localOne = m2.screen()
    localStore.setState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        't-2': { ...prev.tasks['t-2'], status: 'completed' },
      },
    }))
    await settle(80)
    out.localNone = m2.screen()
    m2.unmount()
  `)
  const hostedBefore = String(r.hostedBefore ?? '')
  const hostedAfter = String(r.hostedAfter ?? '')
  const localTwo = String(r.localTwo ?? '')
  const localOne = String(r.localOne ?? '')
  const localNone = String(r.localNone ?? '')
  check(
    'hosted shell running initially paints "1 shell command still running" and "quitting stops them"',
    hostedBefore.includes('1 shell command still running') && hostedBefore.includes('quitting stops them · see them with /runs · the session itself stays resumable'),
    hostedBefore,
  )
  check(
    'when hosted shell finishes while dialog stands, dialog updates to "nothing still running" and drops "quitting stops them"',
    !hostedAfter.includes('1 shell command still running') && hostedAfter.includes('nothing still running') && !hostedAfter.includes('quitting stops them') && hostedAfter.includes('the session itself stays resumable'),
    hostedAfter,
  )
  check(
    'local background tasks update live from 2 -> 1 -> nothing while dialog stands',
    localTwo.includes('2 shell commands still running') &&
      localOne.includes('1 shell command still running') &&
      !localNone.includes('shell command') &&
      localNone.includes('nothing still running'),
    JSON.stringify({ localTwo, localOne, localNone }),
  )
}

console.log(failures === 0 ? `\nGREEN (${checks} checks)` : `\nRED (${failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
