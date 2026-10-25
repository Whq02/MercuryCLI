#!/usr/bin/env bun
// gate-watch: src/components/permissions/** src/tools/BashTool/** src/utils/permissions/**
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'card-grant-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined, useKeybindings: () => undefined }))

const { createEditRuleSuggestion } = await import('../../src/utils/permissions/PermissionUpdate.js')
const { generateShellSuggestionsLabel } = await import('../../src/components/permissions/shellPermissionHelpers.tsx')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const StdinContext = (await import('../../src/ink/components/StdinContext.js')).default
const { Box, EventEmitter, Text, render, flushPendingSyncWork } = await import('../../src/ink.js')

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'card-grant-project-')))

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function renderLabel(node: React.ReactNode, columns = 120): Promise<string> {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 40 }) as unknown as NodeJS.WriteStream
  const store = createStore({ ...getDefaultAppState() })
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns, rows: 40 } },
      React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width: columns }, React.createElement(Text, null, node))),
    ),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  const text = stripAnsi(instance.lastFrame()).replace(/\s+$/, '').split('\n').map(line => line.trimEnd()).join(' ').replace(/\s+/g, ' ').trim()
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return text
}

section('§1 the words and the rule agree')
{
  const editRule = createEditRuleSuggestion(PROJECT, 'localSettings')
  check('the suggestion is an edit-family rule on the directory', editRule !== undefined && editRule.rules.every(rule => rule.toolName === 'Edit'), JSON.stringify(editRule))
  const label = await renderLabel(generateShellSuggestionsLabel([editRule!], 'Bash'))
  check(
    'the option says what it grants: file edits, never a generic "access"',
    label.startsWith('Yes, and allow file edits in') && !label.includes('allow access'),
    label,
  )
  const tail = PROJECT.split('/').pop() ?? ''
  check('the label names the directory (middle-truncated when long, its tail kept)', label.includes(tail.slice(-6)) && label.endsWith('in this project'), label)
}

section('§2 what the saved rule covers — a second shell touch still asks')
{
  const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
  type Ctx = import('../../src/utils/permissions/permissions.ts').ToolPermissionContext
  const editRule = createEditRuleSuggestion(PROJECT, 'localSettings')!
  const ctx = {
    mode: 'default',
    alwaysAllowRules: { localSettings: [`${editRule.rules.map(rule => `${rule.toolName}(${rule.ruleContent})`).join('\n')}`] },
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  } as unknown as Ctx
  const touch = await bashToolHasPermission({ command: `touch ${join(PROJECT, 'card-b.txt')}` }, ctx)
  check(
    'a second touch in the granted directory still asks (the rule grants file edits, not shell commands)',
    touch.behavior === 'ask' || touch.behavior === 'passthrough',
    touch.behavior,
  )
}

section('§3 the label never promises shell coverage')
{
  const label = await renderLabel(generateShellSuggestionsLabel([createEditRuleSuggestion(PROJECT, 'localSettings')!], 'Bash'))
  check('no promise of shell-command coverage rides the edit-grant option', !label.includes('access to') && !label.includes('run commands'), label)
}

section('§4 an edit folder beside a read folder: each folder is named under the grant its rule writes')
{
  const { createReadRuleSuggestion } = await import('../../src/utils/permissions/PermissionUpdate.js')
  const READ_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'card-grant-read-')))
  const readRule = createReadRuleSuggestion(READ_DIR)!
  check('the read suggestion is a Read rule on the folder', readRule.type === 'addRules' && readRule.rules.every(rule => rule.toolName === 'Read'), JSON.stringify(readRule))
  const editName = basename(PROJECT)
  const readName = basename(READ_DIR)
  const sep = process.platform === 'win32' ? '' : '/'
  const mixed = await renderLabel(generateShellSuggestionsLabel([createEditRuleSuggestion(PROJECT, 'localSettings')!, readRule], 'Bash'))
  check('the edit folder is named under "file edits in"', new RegExp(`allow file edits in ${editName}${sep} `).test(mixed), mixed)
  const [editPart, readPart] = mixed.split(' and reading from ')
  check('the read folder is named under "reading from", never under file edits', readPart === `${readName}${sep} in this project` && editPart !== undefined && editPart.includes(editName) && !editPart.includes(readName), mixed)
  check('the read folder is never listed as an edit folder', !mixed.includes(`${editName}${sep} and ${readName}${sep}`), mixed)
  const withCommand = await renderLabel(generateShellSuggestionsLabel([readRule, { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cat *' }], behavior: 'allow', destination: 'localSettings' }], 'Bash'))
  check('one read folder plus one command: the grant is reading, not file edits', /^Yes, and allow reading from .* plus cat commands in /.test(withCommand) && !withCommand.includes('file edits'), withCommand)
  rmSync(READ_DIR, { recursive: true, force: true })
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJECT, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-card-grant-words-match-rule: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nPASS prove-card-grant-words-match-rule')
process.exit(0)
