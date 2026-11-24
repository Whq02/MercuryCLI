#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'file-dialog-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'file-dialog-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
process.chdir(PROJ)

let failures = 0
const fileDialogHint = 'change the dialog hook useFilePermissionDialog in src/permissions/cards/file-dialog/useFilePermissionDialog.ts (options, input modes, the confirm:cycleMode chord, onChange dispatch) or, for the symlink and card checks, FilePermissionDialog in src/permissions/cards/file-dialog/FilePermissionDialog.tsx'
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + fileDialogHint + (detail ? ' — ' + detail : '')}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { useFilePermissionDialog } = await import('../../src/permissions/cards/file-dialog/useFilePermissionDialog.js')
const { AppStoreContext } = await import('../../src/screen/app-state/AppState.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { createStore } = await import('../../src/platform/primitives/store.js')
const { KeybindingProvider } = await import('../../src/screen/keys/KeybindingContext.js')
const { default: StdinContext } = await import('../../src/screen/renderer/elements/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/screen/themedRenderer.js')
type Dialog = ReturnType<typeof useFilePermissionDialog<{ file_path: string; parsed?: boolean }>>
type Registration = { action: string; context: string; handler: () => void }

const journal: string[] = []
const originalInput = { file_path: join(PROJ, 'notes.md') }
const toolUseConfirm = {
  toolUseID: 'toolu_dialog',
  input: originalInput,
  onAllow: (input: unknown, updates: unknown, feedback?: string) => journal.push(`onAllow(${j(input)}, ${j(updates)}, ${j(feedback)})`),
  onReject: (feedback?: string) => journal.push(`onReject(${j(feedback)})`),
}
const onDone = (): void => { journal.push('onDone') }
const onReject = (): void => { journal.push('onReject') }
const parseInput = (input: unknown): { file_path: string; parsed: boolean } => ({ ...(input as { file_path: string }), parsed: true })

let latest: Dialog | null = null
function Probe({ path, operationType }: { path: string | null; operationType: 'read' | 'write' }): React.ReactNode {
  latest = useFilePermissionDialog({ filePath: path, toolUseConfirm: toolUseConfirm as never, onDone, onReject, parseInput, operationType })
  return null
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const registry = { current: new Map<string, Set<Registration>>() }
const pendingChordRef = { current: null }
const mount = async (path: string | null, operationType: 'read' | 'write') => {
  const store = createStore(getDefaultAppState())
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const keys = {
    bindings: [],
    pendingChordRef,
    pendingChord: null,
    setPendingChord() {},
    activeContexts: new Set(['Confirmation']),
    registerActiveContext() {},
    unregisterActiveContext() {},
    handlerRegistryRef: registry,
  }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      AppStoreContext.Provider,
      { value: store as never },
      React.createElement(KeybindingProvider, keys as never, React.createElement(Box, null, React.createElement(Probe, { path, operationType }))),
    ),
  )
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  await settle()
  return { store, close: () => { instance.unmount(); instance.cleanup(); stream.destroy() } }
}
const state = (): Dialog => latest as Dialog
const drive = async (action: (dialog: Dialog) => void): Promise<void> => { action(state()); await settle() }
const taken = (): string[] => journal.splice(0, journal.length)
const chord = (): void => { for (const registration of registry.current.get('confirm:cycleMode') ?? []) registration.handler() }
const shape = (): string => j([state().focusedOption, state().yesInputMode, state().acceptFeedback, state().noInputMode, state().rejectFeedback])
const values = (): string[] => state().options.map(option => option.value)

section('§1 THE OPTIONS — three choices for a write inside the project; the amendments open and close by role')
const write = await mount(originalInput.file_path, 'write')
check('the opening state focuses accept-once with both amendments closed', shape() === j(['accept-once', false, '', false, '']), shape())
check('a write path offers accept-once, accept-session and reject', j(values()) === j(['accept-once', 'accept-session', 'reject']), j(values()))
await drive(d => d.handleInputModeToggle('accept-once'))
check('toggling accept-once opens the yes input and the option becomes an input row', state().yesInputMode && state().options[0]?.type === 'input', j(state().options[0]))
await drive(d => d.handleInputModeToggle('accept-session'))
check('toggling the session option opens nothing', shape() === j(['accept-once', true, '', false, '']), shape())
const typed = state().options[0] as { onChange?: (text: string) => void }
typed.onChange?.('and lint it')
await settle()
check('the input row feeds the accept text', state().acceptFeedback === 'and lint it', state().acceptFeedback)
await drive(d => d.setFocusedOption('reject'))
check('a typed yes input survives the focus leaving it', shape() === j(['reject', true, 'and lint it', false, '']), shape())
await drive(d => d.handleInputModeToggle('reject'))
await drive(d => d.setFocusedOption('accept-once'))
check('a blank reject input collapses when the focus leaves it', shape() === j(['accept-once', true, 'and lint it', false, '']), shape())

section('§2 THE CHORD — inert while any amendment is open; otherwise the session grant with the input re-parsed')
chord()
await settle()
check('the chord does nothing while the yes input is open', taken().length === 0)
await drive(d => d.handleInputModeToggle('accept-once'))
chord()
await settle()
const granted = taken()
check('with both inputs closed the chord dispatches the session option: done, then the allow with the re-parsed input, the suggested rules and no words', granted[0] === 'onDone' && granted[1]?.startsWith(`onAllow(${j({ ...originalInput, parsed: true })}, [{`) === true && granted[1]?.endsWith('], undefined)') === true && granted.length === 2, j(granted))
check('the shared request object is never mutated by a dispatch', toolUseConfirm.input === originalInput && !('parsed' in toolUseConfirm.input))

section('§3 THE DISPATCH — each option type reaches its handler with a fresh request copy and the trimmed words')
await drive(d => d.onChange({ type: 'accept-once' }, { file_path: 'x', parsed: true }, '  keep going  '))
check('accept-once: done first, then the allow with the given input, no rules and the trimmed words', j(taken()) === j(['onDone', `onAllow(${j({ file_path: 'x', parsed: true })}, [], "keep going")`]))
await drive(d => d.onChange({ type: 'reject' }, { file_path: 'x' }, '   '))
check('reject with blank words: done, the card rejection, then the tool rejection with no words', j(taken()) === j(['onDone', 'onReject', 'onReject(undefined)']))
await drive(d => d.onChange({ type: 'reject' }, { file_path: 'x' }, 'use the fixture'))
check('reject with words carries them', j(taken()) === j(['onDone', 'onReject', 'onReject("use the fixture")']))
await drive(d => d.onChange({ type: 'accept-session', scope: 'config-home', pattern: '/.mercury/**' }, { file_path: 'x' }))
const estate = taken()
check('an estate grant carries its pattern as one session allow rule for the Edit tool', estate[0] === 'onDone' && estate[1]?.startsWith('onAllow(') === true && estate[1]?.includes('"ruleContent":"/.mercury/**"') === true && estate[1]?.includes('"destination":"session"') === true, j(estate))
check('the shared request object is still untouched', toolUseConfirm.input === originalInput)
write.close()

section('§4 A READ WITHOUT A PATH — no empty-grant session option exists and the chord is inert')
const read = await mount(null, 'read')
check('a pathless read offers Yes and No only', j(values()) === j(['accept-once', 'reject']), j(values()))
chord()
await settle()
check('the chord does nothing when no session option exists', j(taken()) === j([]), j(journal))
read.close()

section('§5 READ SYMLINKS — the same target and workspace escape row as edits')
const { FilePermissionDialog } = await import('../../src/permissions/cards/file-dialog/FilePermissionDialog.tsx')
const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { Text } = await import('../../src/screen/themedRenderer.js')
const inside = join(PROJ, 'target.txt')
const outside = join(HOME, 'target.txt')
writeFileSync(inside, 'inside')
writeFileSync(outside, 'outside')
const missing = join(PROJ, 'missing.txt')
const links = [
  { path: join(PROJ, 'inside-link.txt'), target: inside, warning: `Symlink target: ${inside}` },
  { path: join(PROJ, 'outside-link.txt'), target: outside, warning: `This operation will modify ${outside} — outside the working directory via a symlink` },
  { path: join(PROJ, 'dangling.txt'), target: missing, warning: `Symlink target: ${missing}` },
]
for (const link of links) symlinkSync(link.target, link.path)
const compact = (text: string): string => text.replace(/[│\s]+/g, '')
for (const operationType of ['write', 'read'] as const) {
  for (const entry of [...links, ...[inside, null].map(path => ({ path, target: '', warning: '' }))]) {
    const card = React.createElement(FilePermissionDialog, {
      toolUseConfirm: { ...toolUseConfirm, input: { file_path: entry.path }, permissionResult: { behavior: 'ask' } } as never,
      onDone,
      onReject,
      title: operationType === 'read' ? 'Read file' : 'Edit file',
      path: entry.path,
      operationType,
      parseInput,
      content: React.createElement(Text, null, 'Fixture content'),
    })
    const tree = React.createElement(ThemeProvider, null, React.createElement(AppStateProvider, null, React.createElement(KeybindingSetup, null, card)))
    const scene = await mountOffscreen(tree, 120, 24)
    try {
      check(`${operationType}: the file card renders`, await waitFor(() => scene.screen().includes('Fixture content'), 1800), scene.screen())
      const frame = scene.screen()
      check(`${operationType}: ${entry.path ?? 'no path'} shows only its existing symlink warning`, entry.warning !== ''
        ? compact(frame).includes(compact(entry.warning))
        : !frame.includes('Symlink target:') && !frame.includes('outside the working directory via a symlink'), frame)
      if (process.argv.includes('--frames') && entry.warning !== '') console.log(frame)
    } finally {
      scene.unmount()
    }
  }
}
process.chdir(tmpdir())
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })

console.log(failures === 0 ? '\nPASS file dialog dispatch' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
