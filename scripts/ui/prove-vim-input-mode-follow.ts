#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React, { useState } from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'vim-follow-home-')))
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

const { default: VimTextInput } = await import('../../src/components/VimTextInput.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
type VimMode = 'INSERT' | 'NORMAL'

const modes: VimMode[] = []
let setInitial: ((mode: VimMode | undefined) => void) | null = null
function Host(): React.ReactNode {
  const [initialMode, setInitialMode] = useState<VimMode | undefined>(undefined)
  const [value, setValue] = useState('abc')
  setInitial = setInitialMode
  return React.createElement(VimTextInput, {
    value,
    onChange: setValue,
    columns: 40,
    cursorOffset: 1,
    onChangeCursorOffset() {},
    initialMode,
    onModeChange: (mode: VimMode) => { modes.push(mode) },
  } as never)
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const emitter = new EventEmitter()
const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
const stream = new PassThrough()
stream.resume()
const stdout = Object.assign(stream, { columns: 60, rows: 10 }) as unknown as NodeJS.WriteStream
const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
const store = createStore(getDefaultAppState())
const tree = React.createElement(
  StdinContext.Provider,
  { value: stdinValue as never },
  React.createElement(
    TerminalSizeContext.Provider,
    { value: { columns: 60, rows: 10 } },
    React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { width: 60 }, React.createElement(Host))),
  ),
)
const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
await settle()
const frame = (): string => stripAnsi(instance.lastFrame()).replace(/\s+$/, '')

section('§1 THE OPENING — no initial mode means the field keeps its own (insert) and nothing is announced')
check('the field paints its text', frame().includes('abc'), frame())
check('no mode change was announced', modes.length === 0, j(modes))

section('§2 THE FOLLOW — a supplied initial mode is applied when it differs, and re-applied whenever it changes')
setInitial?.('NORMAL')
await settle()
check('NORMAL is applied and announced once', j(modes) === j(['NORMAL']), j(modes))
setInitial?.('NORMAL')
await settle()
check('the same mode again changes nothing', j(modes) === j(['NORMAL']), j(modes))
setInitial?.('INSERT')
await settle()
check('INSERT is applied and announced', j(modes) === j(['NORMAL', 'INSERT']), j(modes))
setInitial?.(undefined)
await settle()
check('withdrawing the initial mode leaves the field where it is', j(modes) === j(['NORMAL', 'INSERT']), j(modes))

instance.unmount()
instance.cleanup()
stream.destroy()
console.log(failures === 0 ? '\nPASS vim input mode follow' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
