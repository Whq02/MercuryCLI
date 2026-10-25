import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'card-identity-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
async function stub(path: string, fixture: Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture }))
}
type Selector = { options: Array<{ value: string }>; onChange(value: string): void }
let selector: Selector | undefined
await stub('../../src/keybindings/useKeybinding.js', { useKeybinding() {}, useKeybindings() {} })
await stub('../../src/components/CustomSelect/select.js', {
  Select(props: Selector) { selector = props; return null },
})
const { SkillPermissionRequest } = await import('../../src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.js')
const { NotebookEditPermissionRequest } = await import('../../src/components/permissions/NotebookEditPermissionRequest/NotebookEditPermissionRequest.js')
const { SkillTool } = await import('../../src/tools/SkillTool/SkillTool.js')
const { NotebookEditTool } = await import('../../src/tools/NotebookEditTool/NotebookEditTool.js')
const { permissionRuleValueToString, permissionRuleValueFromString } = await import('../../src/utils/permissions/permissionRuleParser.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const StdinContext = (await import('../../src/ink/components/StdinContext.js')).default
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
const settle = async () => {
  for (let i = 0; i < 15; i++) {
    flushPendingSyncWork()
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function mount(node: React.ReactNode) {
  selector = undefined
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: new EventEmitter(), internal_querier: null }
  const tree = React.createElement(StdinContext.Provider, { value: stdinValue as never },
    React.createElement(TerminalSizeContext.Provider, { value: { columns: 120, rows: 40 } },
      React.createElement(AppStoreContext.Provider, { value: createStore(getDefaultAppState()) as never },
        React.createElement(Box, { flexDirection: 'column', width: 120 }, node))))
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame() ?? ''),
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}
const toolUseContext = { options: {}, getAppState: () => getDefaultAppState(), setAppState() {} }
function props(tool: unknown, input: Record<string, unknown>, onAllow: (input: unknown, updates: Array<{ rules: Array<{ toolName: string; ruleContent?: string }> }>) => void) {
  return {
    toolUseConfirm: { tool, input, toolUseContext, toolUseID: 'identity', permissionResult: { behavior: 'ask', message: 'approval' }, onAllow, onReject() {}, onUserInteraction() {}, onAbort() {}, recheckPermission: async () => {} },
    toolUseContext, onDone() {}, onReject() {}, verbose: false, workerBadge: undefined,
  } as never
}
try {
  let updates: Array<{ rules: Array<{ toolName: string; ruleContent?: string }> }> = []
  const skill = await mount(React.createElement(SkillPermissionRequest, props(SkillTool, { skill: ' /deploy ', args: 'staging' }, (_input, next) => { updates = next })))
  check('the skill card names the normalized schema field', skill.frame().includes('Use skill "deploy"?'), skill.frame())
  selector?.onChange('yes-exact')
  const rule = updates[0]?.rules[0]
  check('empty rule content would persist as a whole-tool grant', permissionRuleValueFromString(permissionRuleValueToString({ toolName: 'Skill', ruleContent: '' })).ruleContent === undefined)
  check('the exact grant names only the chosen skill', rule?.ruleContent === 'deploy', JSON.stringify(updates))
  check('persisting the grant preserves its scope', !!rule && permissionRuleValueFromString(permissionRuleValueToString(rule)).ruleContent === 'deploy', JSON.stringify(rule))
  skill.close()

  const notebook = join(scratch, 'cells.ipynb')
  writeFileSync(notebook, JSON.stringify({ cells: [
    { id: 'cell-1', cell_type: 'code', source: ['chosen-by-id\n'] },
    { id: 'other', cell_type: 'code', source: ['different-positional-cell\n'] },
  ] }))
  const byId = await mount(React.createElement(NotebookEditPermissionRequest, props(NotebookEditTool, { notebook_path: notebook, cell_id: 'cell-1', new_source: '', edit_mode: 'delete' }, () => {})))
  check('index-shaped cell IDs take precedence over positional indexes', byId.frame().includes('chosen-by-id') && !byId.frame().includes('different-positional-cell'), byId.frame())
  byId.close()
  const positional = await mount(React.createElement(NotebookEditPermissionRequest, props(NotebookEditTool, { notebook_path: notebook, cell_id: 'cell-0', new_source: '', edit_mode: 'delete' }, () => {})))
  check('positional indexes still work without a matching ID', positional.frame().includes('chosen-by-id'), positional.frame())
  positional.close()
  const insert = await mount(React.createElement(NotebookEditPermissionRequest, props(NotebookEditTool, { notebook_path: notebook, new_source: 'inserted-first', cell_type: 'code', edit_mode: 'insert' }, () => {})))
  check('insert without a cell ID renders its source', insert.frame().includes('inserted-first'), insert.frame())
  insert.close()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
