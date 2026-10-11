#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'shell-amendment-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { useShellPermissionFeedback } = await import('../../src/components/permissions/useShellPermissionFeedback.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')

type Feedback = ReturnType<typeof useShellPermissionFeedback>

const journal: string[] = []
const toolUseConfirm = {
  onUserInteraction: () => journal.push('interaction'),
  onReject: (text?: string) => journal.push(`onReject(${j(text)})`),
}
const onReject = (): void => { journal.push('card onReject') }
const onDone = (): void => { journal.push('card onDone') }

let latest: Feedback | null = null
function Probe(): React.ReactNode {
  latest = useShellPermissionFeedback({ toolUseConfirm: toolUseConfirm as never, onDone, onReject })
  return null
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const store = createStore(getDefaultAppState())
const emitter = new EventEmitter()
const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
const stream = new PassThrough()
stream.resume()
const stdout = Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
const tree = React.createElement(
  StdinContext.Provider,
  { value: stdinValue as never },
  React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, null, React.createElement(Probe))),
)
const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
await settle()

const state = (): Feedback => latest as Feedback
const shape = (): string => j([state().focusedOption, state().yesInputMode, state().acceptFeedback, state().noInputMode, state().rejectFeedback])
const drive = async (action: (feedback: Feedback) => void): Promise<void> => { action(state()); await settle() }
const escapes = (): number => store.getState().attribution.escapeCount
const taken = (): string[] => journal.splice(0, journal.length)

section('§1 THE OPENING STATE — yes focused, both amendments closed and empty')
check('the opening state', shape() === j(['yes', false, '', false, '']), shape())
check('mounting counts no interaction', taken().length === 0)

section('§2 TOGGLING — every toggle is an interaction; only yes and no own an input')
await drive(f => f.handleInputModeToggle('yes'))
check('toggling yes opens its input', shape() === j(['yes', true, '', false, '']), shape())
check('the toggle counted one interaction', j(taken()) === j(['interaction']))
await drive(f => f.handleInputModeToggle('yes-apply-suggestions'))
check('toggling another option changes nothing', shape() === j(['yes', true, '', false, '']), shape())
check('but still counts an interaction', j(taken()) === j(['interaction']))
await drive(f => f.handleInputModeToggle('no'))
await drive(f => f.handleInputModeToggle('no'))
check('toggling no twice leaves it closed', shape() === j(['yes', true, '', false, '']), shape())
taken()

section('§3 FOCUS — a blank open input collapses when focus leaves it; a typed one stays')
await drive(f => f.handleFocus('yes'))
check('focusing the already focused option is not an interaction', taken().length === 0)
await drive(f => f.handleFocus('no'))
check('moving to no collapses the blank yes input and moves the focus', shape() === j(['no', false, '', false, '']), shape())
check('the move counted one interaction', j(taken()) === j(['interaction']))
await drive(f => f.handleInputModeToggle('no'))
await drive(f => f.setRejectFeedback('  not now  '))
await drive(f => f.handleFocus('yes'))
check('a typed no input survives the focus leaving it', shape() === j(['yes', false, '', true, '  not now  ']), shape())
await drive(f => f.setRejectFeedback('   '))
await drive(f => f.handleFocus('no'))
await drive(f => f.handleFocus('yes'))
check('a whitespace-only input counts as blank and collapses on the next move away', shape() === j(['yes', false, '', false, '   ']), shape())
await drive(f => f.handleInputModeToggle('yes'))
await drive(f => f.setAcceptFeedback('and run the tests'))
await drive(f => f.handleFocus('yes-apply-suggestions'))
check('a typed yes input survives a move to a third option', shape() === j(['yes-apply-suggestions', true, 'and run the tests', false, '   ']), shape())
taken()

section('§4 REJECTING — a reject without words counts an escape; the card hears onReject then onDone')
const before = escapes()
await drive(f => f.handleReject(undefined))
check('an empty reject counts one escape', escapes() === before + 1, `${before} → ${escapes()}`)
check('the order is the tool rejection with no words, the card rejection, then done', j(taken()) === j(['onReject(undefined)', 'card onReject', 'card onDone']))
await drive(f => f.handleReject('   '))
check('a whitespace reject counts an escape and carries no words', escapes() === before + 2 && j(taken()) === j(['onReject(undefined)', 'card onReject', 'card onDone']))
await drive(f => f.handleReject('  use the fixture instead  '))
check('a reject with words counts no escape and carries the trimmed words', escapes() === before + 2 && j(taken()) === j(['onReject("use the fixture instead")', 'card onReject', 'card onDone']))

instance.unmount()
instance.cleanup()
stream.destroy()
console.log(failures === 0 ? '\nPASS shell amendment state' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
