#!/usr/bin/env bun
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'card-folder-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined, useKeybindings: () => undefined }))
let platform: 'windows' | 'macos' = 'macos'
await stub('../../src/utils/platform.js', () => ({ getPlatform: () => platform }))

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { createEditRuleSuggestion, createReadRuleSuggestion } = await import('../../src/utils/permissions/PermissionUpdate.js')
const helpers = await import('../../src/components/permissions/shellPermissionHelpers.js')
const { generateShellSuggestionsLabel } = helpers
const displayFolderOfRule = (cleaned: string, spelling: 'windows' | 'posix'): string =>
  typeof helpers.displayFolderOfRule === 'function' ? helpers.displayFolderOfRule(cleaned, spelling) : '(this build has no displayFolderOfRule)'
const folderSeparator = (spelling: 'windows' | 'posix'): string => (typeof helpers.folderSeparator === 'function' ? helpers.folderSeparator(spelling) : '(this build has no folderSeparator)')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, Text, render, flushPendingSyncWork } = await import('../../src/ink.js')

const BOX_DIR = 'C:\\Users\\WHQ\\AppData\\Local\\Temp\\mercury\\C--Users-WHQ-Desktop-windowsbox\\f611f98b-d1c2-4f19-ad5b-379bf07e586e\\scratchpad\\f5'
const BOX_DISPLAY = 'C:\\Users\\WHQ\\AppData\\Lo…f07e586e\\scratchpad\\f5'
const MAC_DIR = '/Users/whq/Developer/orchard/tools/f5'

const ruleContentOf = (update: ReturnType<typeof createEditRuleSuggestion>): string => {
  const rule = (update as { rules: Array<{ ruleContent?: string }> }).rules[0]!
  return rule.ruleContent ?? ''
}

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

try {
  section('§1 the rule a Windows box mints for its project folder, and the folder the card must show')
  {
    const edit = createEditRuleSuggestion(BOX_DIR, 'localSettings')!
    const read = createReadRuleSuggestion(BOX_DIR)!
    const editContent = ruleContentOf(edit)
    const readContent = ruleContentOf(read)
    check('the Edit rule is root-anchored in the rule grammar (//C/…/**)', editContent === `//C/${BOX_DIR.slice(3).replace(/\\/g, '/')}/**`, editContent)
    const editCleaned = editContent.replace(/\/\*\*$/, '').replace(/^\/\//, '/')
    const readCleaned = readContent.replace('/**', '')
    check("on Windows the Edit rule's folder reads as the box's shell spells it — no Git Bash prefix, no trailing separator", displayFolderOfRule(editCleaned, 'windows') === BOX_DIR, displayFolderOfRule(editCleaned, 'windows'))
    check("on Windows the Read rule's folder reads the same (the root-anchored // folded)", displayFolderOfRule(readCleaned, 'windows') === BOX_DIR, displayFolderOfRule(readCleaned, 'windows'))
    check('a trailing slash in the rule never leaves a trailing backslash', displayFolderOfRule('/C/Users/WHQ/f5/', 'windows') === 'C:\\Users\\WHQ\\f5', displayFolderOfRule('/C/Users/WHQ/f5/', 'windows'))
    check('a lower-case drive letter reads upper-case, the way the shell prints it', displayFolderOfRule('/c/Users/WHQ/f5', 'windows') === 'C:\\Users\\WHQ\\f5', displayFolderOfRule('/c/Users/WHQ/f5', 'windows'))
    check('the Windows card appends no separator; the POSIX card keeps its trailing one', folderSeparator('windows') === '' && folderSeparator('posix') === '/')
    const macEdit = ruleContentOf(createEditRuleSuggestion(MAC_DIR, 'localSettings')!).replace(/\/\*\*$/, '').replace(/^\/\//, '/')
    const macRead = ruleContentOf(createReadRuleSuggestion(MAC_DIR)!).replace('/**', '')
    check("on a Mac the folder reads as the shell spells it (the rule's root anchoring folded from the Read rule too)", displayFolderOfRule(macEdit, 'posix') === MAC_DIR && displayFolderOfRule(macRead, 'posix') === MAC_DIR, `${displayFolderOfRule(macEdit, 'posix')} · ${displayFolderOfRule(macRead, 'posix')}`)
  }

  section('§2 the card rendered on a Mac keeps its words: the folder, then the trailing slash')
  {
    const text = await renderLabel(generateShellSuggestionsLabel([createEditRuleSuggestion(MAC_DIR, 'localSettings')!], 'Bash'))
    check('the single-folder choice reads "Yes, and allow access to <folder>/ in this project"', text === `Yes, and allow access to ${MAC_DIR}/ in this project`, text)
    const two = await renderLabel(generateShellSuggestionsLabel([createEditRuleSuggestion(MAC_DIR, 'localSettings')!, createReadRuleSuggestion('/Users/whq/Developer/orchard/docs')!], 'Bash'))
    check('two folders read by their names with the trailing slash', two === 'Yes, and allow access to f5/ and docs/ in this project', two)
  }

  section("§3 the card rendered on the Windows box: the box's folder spelling, middle-truncated, no trailing separator (the box read …/scratchpad/f5\\)")
  {
    platform = 'windows'
    const text = await renderLabel(generateShellSuggestionsLabel([createEditRuleSuggestion(BOX_DIR, 'localSettings')!], 'Bash'))
    check('the single-folder choice reads the Windows spelling, truncated in the middle, with no separator after f5', text === `Yes, and allow access to ${BOX_DISPLAY} in this project`, text)
    check('no Git Bash spelling (/C/Users) and no trailing backslash on the card', !text.includes('/C/Users') && !/f5\\ in this project/.test(text), text)
    const two = await renderLabel(generateShellSuggestionsLabel([createEditRuleSuggestion(BOX_DIR, 'localSettings')!, createReadRuleSuggestion('C:\\Users\\WHQ\\Desktop\\docs')!], 'Bash'))
    check('two folders read by their names with no separator', two === 'Yes, and allow access to f5 and docs in this project', two)
    platform = 'macos'
  }
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures ? `\n❌ card folder spelling: ${failures} FAILED` : '\n✅ card folder spelling: ALL PASS')
process.exit(failures ? 1 : 0)
