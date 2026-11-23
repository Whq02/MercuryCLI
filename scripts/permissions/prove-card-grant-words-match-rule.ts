#!/usr/bin/env bun
// gate-watch: src/permissions/cards/** src/tools/shell/** src/permissions/rules/PermissionRule.ts src/permissions/rules/PermissionUpdateSchema.ts src/permissions/rules/askClock.ts src/permissions/rules/askWords.ts src/permissions/rules/bashRuleVerdict.ts src/permissions/rules/bypassPermissionsKillswitch.ts src/permissions/rules/capabilityGate.ts src/permissions/rules/commandContent.ts src/permissions/rules/dangerousPatterns.ts src/permissions/rules/decision/** src/permissions/rules/decisionReasonWire.ts src/permissions/rules/filesystem.ts src/permissions/rules/flowLaw.ts src/permissions/rules/flowPolicy.ts src/permissions/rules/getNextPermissionMode.ts src/permissions/rules/lateAllowRules.ts src/permissions/rules/modeTransitions.ts src/permissions/rules/ownGround.ts src/permissions/rules/pathValidation.ts src/permissions/rules/permissionDoor.ts src/permissions/rules/permissionFocus.ts src/permissions/rules/permissionMode.ts src/permissions/rules/permissionResult.ts src/permissions/rules/permissionRuleParser.ts src/permissions/rules/permissionSetup.ts src/permissions/rules/permissionUpdate.ts src/permissions/rules/permissionsLoader.ts src/permissions/rules/protectedPaths.ts src/permissions/rules/rootNotice.ts src/permissions/rules/ruleBraces.ts src/permissions/rules/ruleReason.ts src/permissions/rules/runtimeProtection.ts src/permissions/rules/safeWrappers.ts src/permissions/rules/serviceInputHistory.ts src/permissions/rules/shadowedRuleDetection.ts src/permissions/rules/shell-protected-paths/** src/permissions/rules/shellProtectedPaths.ts src/permissions/rules/shellRuleMatching.ts src/permissions/rules/uncPath.ts src/permissions/rules/webFetchRuleMatches.ts src/permissions/rules/windowsPath.ts
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
await stub('../../src/screen/keys/useKeybinding.js', () => ({ useKeybinding: () => undefined, useKeybindings: () => undefined }))

const { createEditRuleSuggestion } = await import('../../src/permissions/rules/permissionUpdate.js')
const { generateShellSuggestionsLabel } = await import('../../src/permissions/cards/shellAskParts.tsx')
const { AppStoreContext } = await import('../../src/screen/app-state/AppState.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { createStore } = await import('../../src/platform/primitives/store.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const StdinContext = (await import('../../src/screen/renderer/elements/StdinContext.js')).default
const { Box, EventEmitter, Text, render, flushPendingSyncWork } = await import('../../src/screen/themedRenderer.js')

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'card-grant-project-')))
const { setCwdState } = await import('../../src/boot/process-state/processState.js')
setCwdState(PROJECT)

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
  const { bashToolHasPermission } = await import('../../src/tools/shell/bashPermissions.js')
  type Ctx = import('../../src/permissions/rules/permissionDoor.ts').ToolPermissionContext
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
  const { createReadRuleSuggestion } = await import('../../src/permissions/rules/permissionUpdate.js')
  const READ_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'card-grant-read-')))
  const readRule = createReadRuleSuggestion(READ_DIR)!
  check('the read suggestion is a Read rule on the folder', readRule.type === 'addRules' && readRule.rules.every(rule => rule.toolName === 'Read'), JSON.stringify(readRule))
  const editName = basename(PROJECT)
  const readName = basename(READ_DIR)
  const sep = process.platform === 'win32' ? '' : '/'
  const mixed = await renderLabel(generateShellSuggestionsLabel([createEditRuleSuggestion(PROJECT, 'localSettings')!, readRule], 'Bash'))
  check('the edit folder is named under "file edits in"', new RegExp(`allow file edits in ${editName}${sep} `).test(mixed), mixed)
  const [editPart, readPart] = mixed.split(' and reading from ')
  check('the read folder is named under "reading from", never under file edits, and a folder outside the project is never called this project', readPart === `${readName}${sep}` && editPart !== undefined && editPart.includes(editName) && !editPart.includes(readName), mixed)
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
