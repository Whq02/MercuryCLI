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

const rows: Array<() => Promise<void>> = [
  w08_1_sedUncompilablePatternFallsBackToRealSed,
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
