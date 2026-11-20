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
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

async function w08_1_sedUncompilablePatternFallsBackToRealSed(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prove-w08-1-'))
  const filePath = join(dir, 'sample.txt')
  writeFileSync(filePath, 'hello world\n')
  try {
    const parser = await import(join(SRC, 'tools/BashTool/sedEditParser.ts'))
    const badInfo = { filePath, pattern: '[z-a]', replacement: 'x', flags: '', extendedRegex: false }
    const simulated = parser.applySedSubstitution('hello world\n', badInfo)
    check('w08-1: applySedSubstitution returns null when JS RegExp cannot compile the pattern', simulated === null, `got ${JSON.stringify(simulated)}`)

    const { SedEditPermissionRequest } = await import(join(SRC, 'components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx'))
    const { BashTool } = await import(join(SRC, 'tools/BashTool/BashTool.tsx'))
    const { getEmptyToolPermissionContext } = await import(join(SRC, 'Tool.ts'))
    const { noSessionConnector } = await import(join(SRC, 'services/engine-connector/noSessionConnector.ts'))
    const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(join(SRC, 'services/engine-connector/focusedConnector.ts'))
    const { AppStoreContext } = await import(join(SRC, 'state/AppState.tsx'))
    const { getDefaultAppState } = await import(join(SRC, 'state/AppStateStore.ts'))
    const { createStore } = await import(join(SRC, 'state/store.ts'))
    const { TerminalSizeContext } = await import(join(SRC, 'ink/components/TerminalSizeContext.tsx'))
    const { Box, render, flushPendingSyncWork } = await import(join(SRC, 'ink.ts'))
    const { KeybindingSetup } = await import(join(SRC, 'keybindings/KeybindingProviderSetup.tsx'))

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
        workerBadge: undefined,
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
  const mgr = await import(join(SRC, 'services/projectServices/serviceManager.ts'))
  const { ServiceTool } = await import(join(SRC, 'tools/ServiceTool/ServiceTool.ts'))
  const { serviceAdapter } = await import(join(SRC, 'services/resources/adapters/service.ts'))
  const { getOriginalCwd, setOriginalCwd } = await import(join(SRC, 'bootstrap/state.ts'))
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
  const { getCwd } = await import(join(SRC, 'utils/cwd.ts'))
  const { setCwd } = await import(join(SRC, 'utils/Shell.ts'))
  const runners = await import(join(SRC, 'services/ide/projectRunners.ts'))
  const { TestTool } = await import(join(SRC, 'tools/TestTool/TestTool.ts'))
  const { codingLoopFastChecks } = await import(join(SRC, 'utils/health/sections/coding-loop-fast.ts'))
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
  const { getCwd } = await import(join(SRC, 'utils/cwd.ts'))
  const { setCwd } = await import(join(SRC, 'utils/Shell.ts'))
  const { lspCheck } = await import(join(SRC, 'utils/health/sections/runtime/lsp.ts'))
  const { LspReadTool } = await import(join(SRC, 'tools/LSPTool/LSPTool.ts'))
  const { initializeLspServerManager, waitForInitialization, shutdownLspServerManager } = await import(join(SRC, 'services/lsp/manager.ts'))
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
  const { workspaceSymbolRequest } = await import(join(SRC, 'services/lsp/tsSidecar/sidecar/requests/navigation.ts'))
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
  const { getCwd } = await import(join(SRC, 'utils/cwd.ts'))
  const { setCwd } = await import(join(SRC, 'utils/Shell.ts'))
  const { LspReadTool } = await import(join(SRC, 'tools/LSPTool/LSPTool.ts'))
  const { initializeLspServerManager, waitForInitialization, shutdownLspServerManager } = await import(join(SRC, 'services/lsp/manager.ts'))
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
  const plane = await import(join(SRC, 'services/primitives/executionPlane.ts'))
  const runWatch = await import(join(SRC, 'services/repoHost/runWatch.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'services/primitives/owner.ts'))
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
  const stopped = runWatch.cancelRunWatch(owner, '9991') as { state: string; stopHookError?: string; outcome?: { reason?: string } } | undefined
  check('w08-6: requestStopExecution does not throw and surfaces stop hook failure in record outcome and stopHookError', stopped !== undefined && stopped.state === 'stopping' && typeof stopped.stopHookError === 'string' && stopped.stopHookError.includes('the stop was asked for, but its hook failed (domain hook crashed) — it may still be running') && (stopped.outcome?.reason ?? '').includes('the stop was asked for, but its hook failed (domain hook crashed) — it may still be running'), JSON.stringify(stopped))
}

const rows: Array<() => Promise<void>> = [
  w08_1_sedUncompilablePatternFallsBackToRealSed,
  w08_2_serviceListAndStatusReportReadErrors,
  w08_3_corruptPackageJsonReportedInTestAndHealth,
  w08_4_invalidMercuryLspServersReportedOnce,
  w08_5_tsSidecarWorkspaceSymbolIncompleteReported,
  w08_6_executionStopHookFailureSurfaced,
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
