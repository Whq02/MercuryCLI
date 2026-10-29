#!/usr/bin/env bun

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { mock } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'bang-rows-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 220)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined, useKeybindings: () => undefined }))

const { createUserMessage } = await import('../../src/utils/messages/factories.js')
const { liveTurnStateOf } = await import('../../src/utils/conversationRecovery.js')
const { UserTextMessage } = await import('../../src/components/messages/UserTextMessage.js')
const { OutputLine } = await import('../../src/components/shell/OutputLine.js')
const { PermissionExplainerContent } = await import('../../src/components/permissions/PermissionExplanation.js')
const { Text } = await import('../../src/ink.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const StdinContext = (await import('../../src/ink/components/StdinContext.js')).default
const { Box, render, flushPendingSyncWork } = await import('../../src/ink.js')

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function paint(node: React.ReactNode, columns = 100): Promise<string> {
  const emitter = new (await import('../../src/ink.js')).EventEmitter()
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
      React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width: columns }, node)),
    ),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  const text = stripAnsi(instance.lastFrame() ?? '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return text.split('\n').map(line => line.trimEnd()).join('\n')
}

section('§1 SH-06 · a running ! command paints no model spinner (the live fold)')
{
  const bangEcho = createUserMessage({ content: '<bash-input>sleep 200</bash-input>', timestamp: '2026-06-19T12:00:01.000Z' })
  const live = liveTurnStateOf([bangEcho])
  check('a bash-mode echo opens NO in-flight model turn', live.inFlight === false, JSON.stringify({ inFlight: live.inFlight, phase: live.phase }))
  check('the phase is idle while the shell runs', live.phase === 'idle', live.phase)
  const promptEcho = createUserMessage({ content: 'please count to three', timestamp: '2026-06-19T12:00:01.000Z' })
  const promptLive = liveTurnStateOf([promptEcho])
  check('control: a real prompt with no answer yet IS in flight', promptLive.inFlight === true && promptLive.phase === 'thinking', JSON.stringify({ inFlight: promptLive.inFlight, phase: promptLive.phase }))
  const withBlocks = createUserMessage({ content: [{ type: 'text', text: '<bash-input>seq 1 3</bash-input>' }], timestamp: '2026-06-19T12:00:02.000Z' })
  check('the block-shaped echo opens no in-flight turn either', liveTurnStateOf([withBlocks]).inFlight === false)
}

section('§2 SH-06 · the running row wears the ! glyph, not the prompt caret')
{
  const frame = await paint(React.createElement(UserTextMessage, { addMargin: false, param: { type: 'text', text: '<bash-input>sleep 200</bash-input>' }, verbose: false }))
  check('the row shows "! sleep 200"', frame.includes('! sleep 200'), frame)
  check('the row never reads as a plain prompt caret line', !/\]\s*❯\s*sleep 200/.test(frame), frame)
}

section('§3 SH-09 · the folded ! output keeps the truncation marker and its saved-file path')
{
  const marker = '[1259177 bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at /private/tmp/mercury-501/…/tasks/bh7ypw2ft.output]'
  const lines = Array.from({ length: 5489 }, (_, i) => String(i + 1))
  const head = lines.slice(0, 2000).join('\n')
  const tail = lines.slice(-2000).join('\n')
  const stored = `${head}\n\n${marker}\n\n${tail}`
  const frame = await paint(React.createElement(OutputLine, { content: stored, verbose: false }))
  check('the truncation marker is shown, not cut', frame.includes('truncated from the middle'), frame.slice(0, 200))
  const flatFrame = frame.split('\n').join(' ')
  check('the saved-file path is on screen (wrap-tolerant)', /the\s+complete\s+output\s+is\s+saved\s+at/.test(flatFrame), flatFrame.slice(0, 300))
  const foldLine = frame.split('\n').find(line => line.includes('+') && line.includes('lines'))
  check('the fold still names the lines not shown', foldLine !== undefined, foldLine ?? '(no fold line)')
}

section('§4 SH-07 · ctrl+e with no explanation keeps the description, never "No explanation available"')
{
  const frame = await paint(React.createElement(PermissionExplainerContent, { visible: true, promise: Promise.resolve(null), fallback: React.createElement(Text, { dimColor: true }, 'List Python files in current directory') }))
  check('the description stays when the explainer answers nothing', frame.includes('List Python files in current directory'), frame)
  check('the nothing-available line never replaces it', !frame.includes('No explanation available'), frame)
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ bang-rows PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
