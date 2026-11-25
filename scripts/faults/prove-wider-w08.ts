#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
const W08_WHERE: Record<string, string> = {
  'w08-1': 'applySedSubstitution in src/tools/shell/sedEditParser.ts and src/permissions/cards/sed-edit/SedEditPermissionRequest.tsx',
  'w08-2': 'src/tools/engines/project-services/serviceManager.ts, src/tools/service/ServiceTool.ts and src/integrations/resources/adapters/service.ts',
  'w08-3': 'discoverRunnerProfiles in src/integrations/ide/projectRunners.ts, src/tools/test/TestTool.ts and src/platform/health/sections/coding-loop-fast.ts',
  'w08-4': 'src/platform/health/sections/runtime/lsp.ts, src/tools/lsp/lspTools.ts and src/integrations/lsp/serverManagerLifecycle.ts',
  'w08-5': 'workspaceSymbolRequest in src/integrations/lsp/ts-sidecar/sidecar/requests/navigation.ts and src/tools/lsp/lspTools.ts',
  'w08-6': 'cancelRunWatch in src/platform/repo-host/runWatch.ts, src/engine/execution-plane/executionPlane.ts and src/tools/git/GitTool.ts',
  'w08-7': 'resolveAstScope in src/tools/engines/structure/ast-patterns/scope.ts and renderSearchTrailer in src/tools/engines/structure/ast-patterns/render.ts',
  'w08-8': 'analyzeContextUsage in src/engine/context-window/analyzeContext.ts and src/commands/context/ContextVisualization.tsx',
  'w08-9': 'trackGitOperations in src/tools/kit/gitOperationTracking.ts and src/tools/shell/BashTool.tsx',
  'w08-10': 'src/platform/host-os/browser.ts, openMemoryFolder in src/screen/memory/InstructionFileSelector.tsx and src/screen/mcp/ElicitationDialog.tsx',
  'w08-11': 'videoToolEnabled in src/integrations/media-video/registry.ts and src/engine/tool-dispatch/withheldTools.ts',
  'w08-12': 'resolveAdapter in src/integrations/debugger/client/adapters.ts, src/tools/debug/DebugTool.ts and src/engine/tool-dispatch/withheldTools.ts',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const where = W08_WHERE[label.split(':')[0] ?? '']
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && where ? ` — to fix, change the code this check exercises: ${where}` : ''}`)
}
const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

async function w08_1_sedUncompilablePatternFallsBackToRealSed(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-1-'))
  const filePath = join(dir, 'sample.txt')
  writeFileSync(filePath, 'hello world\n')
  try {
    const parser = await import(join(SRC, 'tools/shell/sedEditParser.ts'))
    const badInfo = { filePath, pattern: '[z-a]', replacement: 'x', flags: '', extendedRegex: false }
    const simulated = parser.applySedSubstitution('hello world\n', badInfo)
    check('w08-1: applySedSubstitution returns null when JS RegExp cannot compile the pattern', simulated === null, `got ${JSON.stringify(simulated)}`)

    const { SedEditPermissionRequest } = await import(join(SRC, 'permissions/cards/sed-edit/SedEditPermissionRequest.tsx'))
    const { BashTool } = await import(join(SRC, 'tools/shell/BashTool.tsx'))
    const { getEmptyToolPermissionContext } = await import(join(SRC, 'tools/kit/tool.ts'))
    const { noSessionConnector } = await import(join(SRC, 'engine/connector/noSessionConnector.ts'))
    const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(join(SRC, 'engine/connector/focusedConnector.ts'))
    const { AppStoreContext } = await import(join(SRC, 'screen/app-state/AppState.tsx'))
    const { getDefaultAppState } = await import(join(SRC, 'screen/app-state/AppStateStore.ts'))
    const { createStore } = await import(join(SRC, 'platform/primitives/store.ts'))
    const { TerminalSizeContext } = await import(join(SRC, 'screen/renderer/elements/TerminalSizeContext.tsx'))
    const { Box, render, flushPendingSyncWork } = await import(join(SRC, 'screen/themedRenderer.ts'))
    const { KeybindingSetup } = await import(join(SRC, 'screen/keys/KeybindingProviderSetup.tsx'))

    const resting = noSessionConnector()
    const hosted = new Proxy(resting, {
      get(target, key, receiver) {
        if (key === 'workspace') return () => ({ cwd: dir, originalCwd: dir, projectRoot: dir })
        const value = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    setFocusedSessionConnector(hosted as never)
    try {
      let approved: Record<string, unknown> | null = null
      const toolUseContext = {
        abortController: new AbortController(),
        getAppState: () => getDefaultAppState(),
        setAppState: () => {},
        messages: [],
        options: {},
        readFileState: new Map(),
        userModified: false,
        updateFileHistoryState: () => {},
        dynamicSkillDirTriggers: new Set(),
        nestedMemoryAttachmentTriggers: new Set(),
      }
      const command = `sed -i 's/[z-a]/x/' ${filePath}`
      const toolUseConfirm = {
        assistantMessage: { message: { id: 'msg_w08_1' } },
        tool: BashTool,
        description: 'sed edit',
        input: { command },
        toolUseContext,
        toolUseID: 'toolu_w08_1',
        permissionResult: { behavior: 'ask', message: 'Bash needs approval: sed' },
        permissionPromptStartTimeMs: 0,
        cwd: dir,
        onUserInteraction() {},
        onAbort() {},
        onAllow(updated: Record<string, unknown>) {
          approved = updated
        },
        onReject() {},
        recheckPermission: async () => {},
      }
      const stdinStream = new PassThrough()
      const stdin = Object.assign(stdinStream, {
        isTTY: true,
        isRaw: false,
        setRawMode() { return this },
        unref() { return this },
        ref() { return this },
      }) as unknown as NodeJS.ReadStream
      const stream = new PassThrough()
      stream.resume()
      const stdout = Object.assign(stream, { columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream
      const store = createStore({ ...getDefaultAppState(), toolPermissionContext: getEmptyToolPermissionContext() })
      const node = React.createElement(SedEditPermissionRequest, {
        toolUseConfirm: toolUseConfirm as never,
        toolUseContext: toolUseContext as never,
        onDone() {},
        onReject() {},
        verbose: false,
        sedEditInfo: badInfo,
      })
      const tree = React.createElement(
        TerminalSizeContext.Provider,
        { value: { columns: 120, rows: 40 } },
        React.createElement(
          AppStoreContext.Provider,
          { value: store as never },
          React.createElement(KeybindingSetup, null, React.createElement(Box, { flexDirection: 'column', width: 120 }, node)),
        ),
      )
      const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
      for (let i = 0; i < 12; i++) {
        flushPendingSyncWork()
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      const frame = stripAnsi(instance.lastFrame() ?? '')
      check('w08-1: card does not claim "The pattern did not match any content"', !frame.includes('The pattern did not match any content'), frame.slice(0, 300))
      check('w08-1: card explains the pattern could not be previewed', frame.includes('could not be previewed'), frame.slice(0, 300))
      stdinStream.write('\r')
      for (let i = 0; i < 12; i++) {
        flushPendingSyncWork()
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      const got = approved as Record<string, unknown> | null
      check('w08-1: approving runs real sed without _simulatedSedEdit', got !== null && got._simulatedSedEdit === undefined && got.command === command, JSON.stringify(got))
      instance.unmount()
      instance.cleanup()
      stream.destroy()
    } finally {
      _resetFocusedSessionConnectorForTesting()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function w08_2_serviceListAndStatusReportReadErrors(): Promise<void> {
  const { chmodSync, mkdirSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-2-'))
  const mgr = await import(join(SRC, 'tools/engines/project-services/serviceManager.ts'))
  const { ServiceTool } = await import(join(SRC, 'tools/service/ServiceTool.ts'))
  const { serviceAdapter } = await import(join(SRC, 'integrations/resources/adapters/service.ts'))
  const { getOriginalCwd, setOriginalCwd } = await import(join(SRC, 'boot/process-state/processState.ts'))
  const prevCwd = getOriginalCwd()
  setOriginalCwd(dir)
  const svcDir = mgr.servicesDir(dir)
  try {
    mkdirSync(svcDir, { recursive: true })
    writeFileSync(join(svcDir, 'good.json'), JSON.stringify({
      schema: 1,
      spec: { name: 'good', command: 'true', args: [], cwd: dir, project: dir, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session' },
      state: 'stopped',
      pid: null,
      startToken: null,
      ownerSessionId: 's1',
      logFile: join(svcDir, 'good.log'),
      logStartByte: 0,
      restartCount: 0,
      explicitStop: true,
      startedAt: 1,
      stoppedAt: 2,
      lastExitCode: 0,
      readiness: [],
      updatedAt: 2,
    }))
    writeFileSync(join(svcDir, 'broken.json'), JSON.stringify({ schema: 2 }))
    const ctx = { options: {} } as never
    const desc = await ServiceTool.call({ op: 'describe', name: 'broken' } as never, ctx)
    check('w08-2: Service describe reports invalid service record instead of unknown', desc.data.state === 'failed' && desc.data.result.includes('invalid service record at'), JSON.stringify(desc.data))
    const listMixed = await ServiceTool.call({ op: 'list' } as never, ctx)
    check('w08-2: Service list keeps good service and names unreadable record', listMixed.data.state !== 'failed' && listMixed.data.result.includes('good — stopped') && listMixed.data.result.includes('not read: broken (invalid service record at'), JSON.stringify(listMixed.data))
    const resItem = await serviceAdapter.resolve({ canonical: 'mercury://service/broken', kind: 'service', id: 'broken', selectors: {} } as never, {} as never)
    check('w08-2: resource adapter reports unavailable for corrupt service record', resItem.state === 'unavailable' && (resItem.note ?? '').includes('invalid service record at'), JSON.stringify(resItem))
    const resList = await serviceAdapter.resolve({ canonical: 'mercury://service', kind: 'service', id: '', selectors: {} } as never, {} as never)
    check('w08-2: resource adapter list keeps good service and names unreadable record', resList.state === 'ok' && resList.resource.children?.some((c: { title: string }) => c.title === 'good') === true && (resList.resource.text ?? '').includes('not read: broken (invalid service record at'), JSON.stringify(resList))
    chmodSync(svcDir, 0o000)
    try {
      const listLocked = await ServiceTool.call({ op: 'list' } as never, ctx)
      check('w08-2: Service list reports unreadable services folder instead of empty', listLocked.data.state === 'failed' && !listLocked.data.result.includes('no services in this project'), JSON.stringify(listLocked.data))
      const resLocked = await serviceAdapter.resolve({ canonical: 'mercury://service', kind: 'service', id: '', selectors: {} } as never, {} as never)
      check('w08-2: resource adapter list reports unavailable on unreadable services folder', resLocked.state === 'unavailable', JSON.stringify(resLocked))
    } finally {
      chmodSync(svcDir, 0o755)
    }
  } finally {
    setOriginalCwd(prevCwd)
    rmSync(dir, { recursive: true, force: true })
    rmSync(svcDir, { recursive: true, force: true })
  }
}

async function w08_3_corruptPackageJsonReportedInTestAndHealth(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-3-'))
  writeFileSync(join(dir, 'package.json'), '{not valid json')
  const { getCwd } = await import(join(SRC, 'platform/files/cwd.ts'))
  const { setCwd } = await import(join(SRC, 'platform/shell/shellExec.ts'))
  const runners = await import(join(SRC, 'integrations/ide/projectRunners.ts'))
  const { TestTool } = await import(join(SRC, 'tools/test/TestTool.ts'))
  const { codingLoopFastChecks } = await import(join(SRC, 'platform/health/sections/coding-loop-fast.ts'))
  const prev = getCwd()
  setCwd(dir)
  try {
    const discovered = runners.discoverRunnerProfiles(dir)
    check('w08-3: discoverRunnerProfiles does not throw and records manifestError for corrupt package.json', discovered.profiles.length === 0 && typeof discovered.manifestError === 'string' && discovered.manifestError.includes('package.json could not be read') && discovered.manifestError.includes('fix it or declare a lockfile'), JSON.stringify(discovered))

    const ctx = { abortController: new AbortController(), options: {} } as never
    const disc = await TestTool.call({ op: 'discover' } as never, ctx)
    check('w08-3: Test discover reports package.json could not be read instead of falling through', disc.data.result.includes('package.json could not be read') && disc.data.result.includes('fix it or declare a lockfile'), JSON.stringify(disc.data))

    const missing = await TestTool.call({ op: 'discover', framework: 'vitest' } as never, ctx)
    check('w08-3: Test discover with explicit framework mentions unreadable package.json', missing.data.result.includes('package.json could not be read'), JSON.stringify(missing.data))

    const spec = codingLoopFastChecks().find((c: { id: string }) => c.id === 'anvil-workbench-fast')
    const health = await spec.run()
    check('w08-3: coding-loop-fast health row reports unreadable package.json instead of no runner manifests', health.evidence.includes('package.json could not be read') && health.evidence.includes('fix it or declare a lockfile'), JSON.stringify(health))
  } finally {
    setCwd(prev)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function w08_4_invalidMercuryLspServersReportedOnce(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-4-'))
  const filePath = join(dir, 'sample.unknownext')
  writeFileSync(filePath, 'hello\n')
  const prevEnv = process.env.MERCURY_LSP_SERVERS
  const prevLsp = process.env.MERCURY_LSP
  process.env.MERCURY_LSP = '1'
  process.env.MERCURY_LSP_SERVERS = '{bad json'
  const { getCwd } = await import(join(SRC, 'platform/files/cwd.ts'))
  const { setCwd } = await import(join(SRC, 'platform/shell/shellExec.ts'))
  const { lspCheck } = await import(join(SRC, 'platform/health/sections/runtime/lsp.ts'))
  const { LspReadTool } = await import(join(SRC, 'tools/lsp/lspTools.ts'))
  const { initializeLspServerManager, waitForInitialization, shutdownLspServerManager } = await import(join(SRC, 'integrations/lsp/serverManagerLifecycle.ts'))
  const prevCwd = getCwd()
  setCwd(dir)
  try {
    const health = await lspCheck().run()
    check('w08-4: LSP health row reports invalid MERCURY_LSP_SERVERS JSON', health.status === 'warn' && health.evidence.includes('MERCURY_LSP_SERVERS is not valid JSON') && health.evidence.includes('so the language servers it names were not loaded.'), JSON.stringify(health))

    initializeLspServerManager()
    await waitForInitialization()
    const ctx = { abortController: new AbortController(), options: {} } as never
    const first = await LspReadTool.call({ operation: 'hover', filePath, line: 1, character: 1 } as never, ctx)
    check('w08-4: LspRead missing-server answer includes invalid MERCURY_LSP_SERVERS sentence first time', first.data.result.includes('MERCURY_LSP_SERVERS is not valid JSON') && first.data.result.includes('so the language servers it names were not loaded.'), JSON.stringify(first.data))
    const second = await LspReadTool.call({ operation: 'hover', filePath, line: 1, character: 1 } as never, ctx)
    check('w08-4: LspRead does not repeat invalid MERCURY_LSP_SERVERS sentence on second call', !second.data.result.includes('MERCURY_LSP_SERVERS is not valid JSON'), JSON.stringify(second.data))
  } finally {
    await shutdownLspServerManager()
    setCwd(prevCwd)
    if (prevEnv === undefined) delete process.env.MERCURY_LSP_SERVERS
    else process.env.MERCURY_LSP_SERVERS = prevEnv
    if (prevLsp === undefined) delete process.env.MERCURY_LSP
    else process.env.MERCURY_LSP = prevLsp
    rmSync(dir, { recursive: true, force: true })
  }
}

async function w08_5_tsSidecarWorkspaceSymbolIncompleteReported(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-5-'))
  const filePath = join(dir, 'sample.w08sym')
  writeFileSync(filePath, 'export const alpha = 1\n')
  const { workspaceSymbolRequest } = await import(join(SRC, 'integrations/lsp/ts-sidecar/sidecar/requests/navigation.ts'))
  const goodProject = {
    key: 'good',
    service: {
      getNavigateToItems: () => [{ name: 'alpha', kind: 'const', fileName: filePath, textSpan: { start: 13, length: 5 } }],
    },
  }
  const badProject = {
    key: 'bad',
    service: {
      getNavigateToItems: () => { throw new Error('corrupt tsconfig graph') },
    },
  }
  const fakeState = {
    workspaceProjects: () => [badProject, goodProject],
    allProjects: () => [badProject, goodProject],
    normalize: (p: string) => p,
    textOf: () => 'export const alpha = 1\n',
  }
  const sidecarResult = workspaceSymbolRequest({ query: 'alpha' }, (() => fakeState) as never) as { symbols?: unknown[]; incompleteError?: string } | unknown[]
  check('w08-5: workspaceSymbolRequest returns incompleteError alongside partial symbols when a project throws', !Array.isArray(sidecarResult) && Array.isArray(sidecarResult.symbols) && sidecarResult.symbols.length === 1 && sidecarResult.incompleteError === 'corrupt tsconfig graph', JSON.stringify(sidecarResult))

  const stubScript = join(dir, 'stub-lsp.mjs')
  writeFileSync(stubScript, `
    let buf = Buffer.alloc(0)
    const send = msg => {
      const body = Buffer.from(JSON.stringify(msg), 'utf8')
      process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n')
      process.stdout.write(body)
    }
    const payload = ${JSON.stringify(sidecarResult)}
    process.stdin.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const sep = buf.indexOf('\\r\\n\\r\\n')
        if (sep === -1) break
        const header = buf.subarray(0, sep).toString('utf8')
        const m = /Content-Length:\\s*(\\d+)/i.exec(header)
        if (!m) break
        const len = Number(m[1])
        if (buf.length < sep + 4 + len) break
        const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf8'))
        buf = buf.subarray(sep + 4 + len)
        if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { workspaceSymbolProvider: true } } })
        else if (msg.method === 'workspace/symbol') send({ jsonrpc: '2.0', id: msg.id, result: payload })
        else if (msg.method === 'shutdown') send({ jsonrpc: '2.0', id: msg.id, result: null })
        else if (msg.method === 'exit') process.exit(0)
        else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: null })
      }
    })
  `)
  const prevEnv = process.env.MERCURY_LSP_SERVERS
  const prevLsp = process.env.MERCURY_LSP
  process.env.MERCURY_LSP = '1'
  process.env.MERCURY_LSP_SERVERS = JSON.stringify({
    stub: { command: process.execPath, args: [stubScript], extensionToLanguage: { '.w08sym': 'w08sym' } },
  })
  const { getCwd } = await import(join(SRC, 'platform/files/cwd.ts'))
  const { setCwd } = await import(join(SRC, 'platform/shell/shellExec.ts'))
  const { LspReadTool } = await import(join(SRC, 'tools/lsp/lspTools.ts'))
  const { initializeLspServerManager, waitForInitialization, shutdownLspServerManager } = await import(join(SRC, 'integrations/lsp/serverManagerLifecycle.ts'))
  const prevCwd = getCwd()
  setCwd(dir)
  try {
    initializeLspServerManager()
    await waitForInitialization()
    const ctx = { abortController: new AbortController(), options: {} } as never
    const res = await LspReadTool.call({ operation: 'workspaceSymbol', filePath, query: 'alpha' } as never, ctx)
    check('w08-5: LSPTool workspaceSymbol includes found symbols and the incomplete-search note', res.data.result.includes('alpha') && res.data.result.includes('Workspace symbols may be incomplete: one or more TypeScript projects failed to search (corrupt tsconfig graph).'), JSON.stringify(res.data))
  } finally {
    await shutdownLspServerManager()
    setCwd(prevCwd)
    if (prevEnv === undefined) delete process.env.MERCURY_LSP_SERVERS
    else process.env.MERCURY_LSP_SERVERS = prevEnv
    if (prevLsp === undefined) delete process.env.MERCURY_LSP
    else process.env.MERCURY_LSP = prevLsp
    rmSync(dir, { recursive: true, force: true })
  }
}

async function w08_6_executionStopHookFailureSurfaced(): Promise<void> {
  const plane = await import(join(SRC, 'engine/execution-plane/executionPlane.ts'))
  const runWatch = await import(join(SRC, 'platform/repo-host/runWatch.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'engine/execution-plane/owner.ts'))
  const owner = makeOwnerKey('w08-6-owner')
  const id = 'run-watch-9991'
  plane.registerExecutionDomain('host-run-watch', {
    requestStop() {
      throw new Error('domain hook crashed')
    },
  })
  plane.registerExecution({
    version: 1,
    id,
    owner,
    kind: 'host-run-watch',
    label: 'watch run 9991',
    lifecycle: 'session',
  })
  plane.transitionExecution(owner, id, 'starting')
  plane.transitionExecution(owner, id, 'running')
  const { GitTool } = await import(join(SRC, 'tools/git/GitTool.ts'))
  const { ownerFromToolUseContext } = await import(join(SRC, 'engine/run-owner/resolveOwner.ts'))
  const gitCtx = { abortController: new AbortController(), options: {} } as never
  const gitOwner = ownerFromToolUseContext(gitCtx)
  const gitWatchId = 'run-watch-9992'
  plane.registerExecution({
    version: 1,
    id: gitWatchId,
    owner: gitOwner,
    kind: 'host-run-watch',
    label: 'watch run 9992',
    lifecycle: 'session',
  })
  plane.transitionExecution(gitOwner, gitWatchId, 'starting')
  plane.transitionExecution(gitOwner, gitWatchId, 'running')
  const gitOut = await GitTool.call({ op: 'runWatch', run: '9992', cancel: true } as never, gitCtx)
  check('w08-6: GitTool runWatch cancel surfaces stop hook failure sentence', gitOut.data.result.includes('the stop was asked for, but its hook failed (domain hook crashed) — it may still be running'), JSON.stringify(gitOut.data))
  const stopped = runWatch.cancelRunWatch(owner, '9991') as { state: string; stopHookError?: string; outcome?: { reason?: string } } | undefined
  check('w08-6: requestStopExecution does not throw and surfaces stop hook failure in record outcome and stopHookError', stopped !== undefined && stopped.state === 'stopping' && typeof stopped.stopHookError === 'string' && stopped.stopHookError.includes('the stop was asked for, but its hook failed (domain hook crashed) — it may still be running') && (stopped.outcome?.reason ?? '').includes('the stop was asked for, but its hook failed (domain hook crashed) — it may still be running'), JSON.stringify(stopped))
}

async function w08_8_contextUnserializableToolAndMessageBlockNoted(): Promise<void> {
  const { analyzeContextUsage } = await import(join(SRC, 'engine/context-window/analyzeContext.ts'))
  const { ContextVisualization } = await import(join(SRC, 'commands/context/ContextVisualization.tsx'))
  const { renderToString } = await import(join(SRC, 'screen/renderer/staticRender.tsx'))
  let schemaReads = 0
  const mcpTool = {
    name: 'mcp__srv__unserializable',
    get inputJSONSchema() {
      schemaReads++
      if (schemaReads === 1) return { type: 'object', properties: {} }
      return { type: 'object', bad: 1n }
    },
    prompt: async () => 'desc',
    description: async () => 'desc',
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  }
  const msg = {
    type: 'attachment',
    uuid: 'a-1',
    attachment: { type: 'custom', bad: 1n },
  }
  const data = await analyzeContextUsage(
    [msg] as never,
    'claude-sonnet-4-6',
    async () => ({ mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false } as never),
    [mcpTool] as never,
    { activeAgents: [], allAgents: [], allowedAgentTypes: [] } as never,
    100,
    { options: {} },
  )
  check('w08-8: ContextData flags toolDefinitionsUnmeasured and messageBlocksUnmeasured', data.toolDefinitionsUnmeasured === true && data.messageBlocksUnmeasured === true, JSON.stringify({ toolDefinitionsUnmeasured: data.toolDefinitionsUnmeasured, messageBlocksUnmeasured: data.messageBlocksUnmeasured }))
  const rendered = await renderToString(React.createElement(ContextVisualization, { data }), 120)
  check('w08-8: ContextVisualization shows tool definition unmeasured notice', rendered.includes('Some tool definitions could not be measured; tool token counts may be understated.'), rendered.slice(0, 400))
  check('w08-8: ContextVisualization shows message block unmeasured notice', rendered.includes('Some message blocks could not be measured; message breakdown figures may be understated.'), rendered.slice(0, 400))
}

async function w08_7_polyglotUnreadableDirAndStatNoted(): Promise<void> {
  const { chmodSync, mkdirSync, symlinkSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-7-'))
  const okFile = join(dir, 'ok.ts')
  const lockedDir = join(dir, 'locked')
  const brokenLink = join(dir, 'broken.ts')
  writeFileSync(okFile, 'export const ok = 1\n')
  mkdirSync(lockedDir)
  writeFileSync(join(lockedDir, 'hidden.ts'), 'export const hidden = 2\n')
  symlinkSync(join(dir, 'nonexistent-target.ts'), brokenLink)
  chmodSync(lockedDir, 0o000)
  const { resolveAstScope } = await import(join(SRC, 'tools/engines/structure/ast-patterns/scope.ts'))
  const { renderSearchTrailer } = await import(join(SRC, 'tools/engines/structure/ast-patterns/render.ts'))
  try {
    const scope = resolveAstScope({ cwd: dir })
    check('w08-7: resolveAstScope counts unreadable folder and dangling stat entry', !('refused' in scope) && scope.skippedUnreadable?.count === 2 && typeof scope.skippedUnreadable.firstPath === 'string' && typeof scope.skippedUnreadable.firstError === 'string', JSON.stringify(scope))
    if (!('refused' in scope)) {
      const trailer = renderSearchTrailer(scope, {
        matches: [],
        capped: false,
        filesParsed: 1,
        filesWithMatches: 0,
        parseFailures: [],
        patternRefusals: [],
        captureNamesByLang: new Map(),
        skippedLarge: 0,
        truncatedParse: false,
        languagesSearched: [['typescript', 1]],
        compiledSomewhere: true,
      }).join('\n')
      check('w08-7: renderSearchTrailer adds unreadable folders/files note with count and first error', trailer.includes('2 folders or files could not be read and were not searched (first: '), trailer)
    }
  } finally {
    chmodSync(lockedDir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function w08_9_gitOperationTrackingPrLinkFailureSurfaced(): Promise<void> {
  const { mkdirSync, readFileSync } = await import('node:fs')
  const { getTranscriptPathForSession } = await import(join(SRC, 'sessions/transcripts/sessionStorage.ts'))
  const { getSessionId } = await import(join(SRC, 'boot/process-state/processState.ts'))
  const { trackGitOperations } = await import(join(SRC, 'tools/kit/gitOperationTracking.ts'))
  const { BashTool } = await import(join(SRC, 'tools/shell/BashTool.tsx'))
  const { getDefaultAppState } = await import(join(SRC, 'screen/app-state/AppStateStore.ts'))
  const dbg = await import(join(SRC, 'platform/logs/debugLog.ts'))
  const prevNodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  dbg.enableDebugLogging()
  const dbgPath = dbg.getDebugLogPath()
  const transcriptPath = getTranscriptPathForSession(String(getSessionId()) as never)
  rmSync(transcriptPath, { recursive: true, force: true })
  mkdirSync(transcriptPath, { recursive: true })
  try {
    const note = await trackGitOperations('gh pr create --fill', 0, 'https://github.com/org/repo/pull/42\n')
    const dbgText = (() => { try { return readFileSync(dbgPath, 'utf8') } catch { return '' } })()
    check(
      'w08-9: trackGitOperations returns plain failure note and logs detail when PR link write fails',
      note === 'the pull request link could not be saved, so this session will not show it' &&
        dbgText.includes('https://github.com/org/repo/pull/42') &&
        dbgText.includes('EISDIR'),
      `note=${JSON.stringify(note)} dbg=${JSON.stringify(dbgText.slice(-300))}`,
    )

    const ctx = {
      abortController: new AbortController(),
      getAppState: () => getDefaultAppState(),
      setAppState: () => {},
      messages: [],
      options: {},
      readFileState: new Map(),
      userModified: false,
      updateFileHistoryState: () => {},
      dynamicSkillDirTriggers: new Set(),
      nestedMemoryAttachmentTriggers: new Set(),
    } as never
    const res = await BashTool.call({ command: 'echo https://github.com/org/repo/pull/42 # gh pr create' } as never, ctx)
    check('w08-9: BashTool includes the plain PR link save failure note in output', (res.data as { stdout: string }).stdout.includes('the pull request link could not be saved, so this session will not show it'), JSON.stringify(res.data))
  } finally {
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv
    rmSync(transcriptPath, { recursive: true, force: true })
  }
}

async function w08_10_browserAndPathOpenFailuresSurfaced(): Promise<void> {
  const { chmodSync, mkdirSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-10-'))
  let fakeBrowser = join(dir, 'fail-browser.sh')
  if (process.platform === 'win32') {
    const src = join(dir, 'fail-browser.ts')
    fakeBrowser = join(dir, 'fail-browser.exe')
    writeFileSync(src, 'console.error("no display available"); process.exit(1)\n')
    const built = spawnSync(process.execPath, ['build', '--compile', src, '--outfile', fakeBrowser], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    if (built.status !== 0) throw new Error(`fail-browser compile failed: ${built.stderr}`)
  } else {
    writeFileSync(fakeBrowser, '#!/bin/sh\necho "no display available" >&2\nexit 1\n')
    chmodSync(fakeBrowser, 0o755)
  }
  const prevBrowser = process.env.BROWSER
  process.env.BROWSER = fakeBrowser
  const browser = await import(join(SRC, 'platform/host-os/browser.ts'))
  const { openMemoryFolder } = await import(join(SRC, 'screen/memory/InstructionFileSelector.tsx'))
  const { ElicitationDialog } = await import(join(SRC, 'screen/mcp/ElicitationDialog.tsx'))
  const { AppStoreContext } = await import(join(SRC, 'screen/app-state/AppState.tsx'))
  const { getDefaultAppState } = await import(join(SRC, 'screen/app-state/AppStateStore.ts'))
  const { createStore } = await import(join(SRC, 'platform/primitives/store.ts'))
  const { TerminalSizeContext } = await import(join(SRC, 'screen/renderer/elements/TerminalSizeContext.tsx'))
  const { Box, render, flushPendingSyncWork } = await import(join(SRC, 'screen/themedRenderer.ts'))
  const { KeybindingSetup } = await import(join(SRC, 'screen/keys/KeybindingProviderSetup.tsx'))
  try {
    let browserErr: string | null = null
    const bOk = await browser.openBrowser('https://example.test/doc', (err: string) => { browserErr = err })
    const gotBrowserErr = browserErr as string | null
    check('w08-10: openBrowser hands error message beside false', bOk === false && gotBrowserErr !== null && gotBrowserErr.includes('no display available'), JSON.stringify({ bOk, gotBrowserErr }))

    let pathErr: string | null = null
    const pOk = await browser.openPath(join(dir, 'does-not-exist-w08-10'), (err: string) => { pathErr = err })
    const gotPathErr = pathErr as string | null
    check('w08-10: openPath hands error message beside false for missing path', pOk === false && gotPathErr !== null && gotPathErr.length > 0, JSON.stringify({ pOk, gotPathErr }))

    let folderOpenErr: string | null = null
    const notesDir = join(dir, 'notes')
    mkdirSync(notesDir)
    openMemoryFolder(
      notesDir,
      { mkdirSync, openPath: async () => false },
      (msg: string) => { folderOpenErr = msg },
    )
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    const gotFolderErr = folderOpenErr as string | null
    check('w08-10: MemoryFileSelector openMemoryFolder reports failed open via callback', gotFolderErr !== null && gotFolderErr.includes('could not be opened (') && gotFolderErr.includes('open it yourself'), JSON.stringify(gotFolderErr))

    const stdinStream = new PassThrough()
    const stdin = Object.assign(stdinStream, { isTTY: true, isRaw: false, setRawMode() { return this }, unref() { return this }, ref() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream
    const controller = new AbortController()
    const node = React.createElement(ElicitationDialog, {
      event: {
        serverName: 'demo-mcp',
        params: { mode: 'url', message: 'Sign in', url: 'https://example.test/oauth' },
        signal: controller.signal,
      } as never,
      onResponse() {},
      onWaitingDismiss() {},
    })
    const store = createStore(getDefaultAppState())
    const tree = React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns: 120, rows: 40 } },
      React.createElement(
        AppStoreContext.Provider,
        { value: store as never },
        React.createElement(KeybindingSetup, null, React.createElement(Box, { flexDirection: 'column', width: 120 }, node)),
      ),
    )
    const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
    for (let i = 0; i < 6; i++) { flushPendingSyncWork(); await new Promise<void>(resolve => setTimeout(resolve, 10)) }
    stdinStream.write('\r')
    for (let i = 0; i < 20; i++) { flushPendingSyncWork(); await new Promise<void>(resolve => setTimeout(resolve, 20)) }
    const frame = stripAnsi(instance.lastFrame() ?? '')
    check('w08-10: ElicitationDialog shows open failure sentence when browser fails', frame.includes('https://example.test/oauth could not be opened (no display available) — open it yourself'), frame.slice(0, 400))
    instance.unmount()
    instance.cleanup()
    stream.destroy()
  } finally {
    if (prevBrowser === undefined) delete process.env.BROWSER
    else process.env.BROWSER = prevBrowser
    rmSync(dir, { recursive: true, force: true })
  }
}

async function w08_11_videoProviderSettingReadErrorWithheldWhy(): Promise<void> {
  const { enableConfigs, saveGlobalConfig } = await import(join(SRC, 'platform/config/globalConfig.ts'))
  const { resetSettingsCache } = await import(join(SRC, 'platform/settings/settingsCache.ts'))
  const { videoToolEnabled } = await import(join(SRC, 'integrations/media-video/registry.ts'))
  const { withheldTools } = await import(join(SRC, 'engine/tool-dispatch/withheldTools.ts'))
  enableConfigs()
  saveGlobalConfig((prev: Record<string, unknown>) => ({ ...prev, videoProvider: { bad: { kind: 'unknown-provider' } } }))
  resetSettingsCache()
  try {
    check('w08-11: videoToolEnabled returns false without throwing on invalid videoProvider', videoToolEnabled() === false)
    const videoRow = withheldTools().find((w: { tool: string }) => w.tool === 'Video')
    check('w08-11: withheldTools explains videoProvider setting could not be read', videoRow !== undefined && videoRow.why.includes('the videoProvider setting could not be read (') && videoRow.why.includes('fix it in settings'), JSON.stringify(videoRow))
  } finally {
    saveGlobalConfig((prev: Record<string, unknown>) => {
      const next = { ...prev }
      delete next.videoProvider
      return next
    })
    resetSettingsCache()
  }
}

async function w08_12_dapAdapterFileReadErrorSurfaced(): Promise<void> {
  const { chmodSync, mkdirSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-12-'))
  const lockedFile = join(dir, 'dap-adapters.json')
  writeFileSync(lockedFile, '{"custom":{"command":"echo"}}')
  chmodSync(lockedFile, 0o000)
  const program = join(dir, 'dummy.py')
  writeFileSync(program, 'x = 1\n')
  const prevFile = process.env.MERCURY_DAP_ADAPTERS_FILE
  const prevEnv = process.env.MERCURY_DAP_ADAPTERS
  process.env.MERCURY_DAP_ADAPTERS_FILE = lockedFile
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fromEnv: { command: process.execPath, args: [] } })
  const { DebugTool } = await import(join(SRC, 'tools/debug/DebugTool.ts'))
  const adapters = await import(join(SRC, 'integrations/debugger/client/adapters.ts'))
  const { processMainOwner } = await import(join(SRC, 'engine/run-owner/resolveOwner.ts'))
  try {
    check('w08-12: launch still resolves adapters from other sources when adapter file is unreadable', adapters.resolveAdapter('fromEnv')?.command === process.execPath)
    const ctx = {
      owner: processMainOwner(),
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext: {} }),
    } as never
    const res = await DebugTool.call({ op: 'launch', adapter: 'custom', program, cwd: dir, session: 'w08-12-bad' } as never, ctx)
    check('w08-12: DebugTool unknown adapter refusal names unreadable adapter file and read error', res.data.outcome === 'failed' && res.data.result.includes(lockedFile) && res.data.result.includes('could not be read (') && res.data.result.includes("unknown adapter 'custom'"), JSON.stringify(res.data))

    const emptyBin = join(dir, 'empty-bin')
    mkdirSync(emptyBin)
    const child = spawnSync(process.execPath, ['-e', `
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(join(dir, 'cfg'))}
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      delete process.env.MERCURY_DAP_ADAPTERS
      process.env.PATH = ${JSON.stringify(emptyBin)}
      process.env.MERCURY_DEBUGPY_VENDOR_DIR = ${JSON.stringify(join(dir, 'no-debugpy'))}
      process.env.MERCURY_PYTHON_VENDOR_DIR = ${JSON.stringify(join(dir, 'no-python'))}
      process.env.MERCURY_JS_DEBUG_DAP = ${JSON.stringify(join(dir, 'no-js-debug.js'))}
      process.env.MERCURY_DAP_ADAPTERS_FILE = ${JSON.stringify(lockedFile)}
      globalThis.MACRO = { VERSION: '1.0.0' }
      const { withheldTools } = await import(${JSON.stringify(join(SRC, 'engine/tool-dispatch/withheldTools.ts'))})
      const debug = withheldTools().find(w => w.tool === 'Debug')
      process.stdout.write('\\n' + JSON.stringify(debug ?? null))
    `], { encoding: 'utf8' })
    const debugRow = child.status === 0 ? JSON.parse(child.stdout.trim().split('\n').pop() ?? 'null') : { error: child.stderr.slice(-300) }
    check('w08-12: withheld Debug tool message names unreadable adapter file and read error', debugRow !== null && typeof debugRow.why === 'string' && debugRow.why.includes(lockedFile) && debugRow.why.includes('could not be read ('), JSON.stringify(debugRow))
  } finally {
    chmodSync(lockedFile, 0o644)
    if (prevFile === undefined) delete process.env.MERCURY_DAP_ADAPTERS_FILE
    else process.env.MERCURY_DAP_ADAPTERS_FILE = prevFile
    if (prevEnv === undefined) delete process.env.MERCURY_DAP_ADAPTERS
    else process.env.MERCURY_DAP_ADAPTERS = prevEnv
    rmSync(dir, { recursive: true, force: true })
  }
}
const rows: Array<() => Promise<void>> = [
  w08_1_sedUncompilablePatternFallsBackToRealSed,
  w08_2_serviceListAndStatusReportReadErrors,
  w08_3_corruptPackageJsonReportedInTestAndHealth,
  w08_4_invalidMercuryLspServersReportedOnce,
  w08_5_tsSidecarWorkspaceSymbolIncompleteReported,
  w08_6_executionStopHookFailureSurfaced,
  w08_7_polyglotUnreadableDirAndStatNoted,
  w08_8_contextUnserializableToolAndMessageBlockNoted,
  w08_9_gitOperationTrackingPrLinkFailureSurfaced,
  w08_10_browserAndPathOpenFailuresSurfaced,
  w08_11_videoProviderSettingReadErrorWithheldWhy,
  w08_12_dapAdapterFileReadErrorSurfaced,
]
for (const row of rows) {
  try {
    await row()
  } catch (error) {
    check(row.name, false, error instanceof Error ? error.message : String(error))
  }
}
console.log(failures === 0 ? 'prove-wider-w08: all rows pass' : `prove-wider-w08: ${failures} row(s) failed`)
process.exit(failures === 0 ? 0 : 1)
