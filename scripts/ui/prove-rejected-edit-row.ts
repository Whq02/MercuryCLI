#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'rejected-edit-proj-')))
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'rejected-edit-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
process.chdir(PROJ)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { FileEditToolUseRejectedMessage } = await import('../../src/components/FileEditToolUseRejectedMessage.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const paint = async (props: Record<string, unknown>): Promise<string[]> => {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 200, rows: 30 }) as unknown as NodeJS.WriteStream
  const store = createStore(getDefaultAppState())
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns: 200, rows: 30 } },
      React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width: 200 }, React.createElement(FileEditToolUseRejectedMessage, props as never))),
    ),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  let frame = instance.lastFrame()
  for (let waited = 0; waited < 3000; waited += 25) {
    await settle()
    const next = instance.lastFrame()
    if (next === frame && stripAnsi(next).trim() !== '') break
    frame = next
  }
  const lines = stripAnsi(frame).replace(/\s+$/, '').split('\n').map(line => line.trimEnd()).filter(line => line !== '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return lines
}
const path = join(PROJ, 'src', 'app.ts')
const has = (lines: string[], text: string): boolean => lines.some(line => line.includes(text))

section('§1 THE HEADLINE — the operation and the path, relative unless verbose')
{
  const plain = await paint({ file_path: path, operation: 'update', firstLine: null, verbose: false })
  check('a bare update paints the headline alone with the relative path', plain.length === 1 && plain[0]?.includes('Operator rejected update to src/app.ts') === true, j(plain))
  const verbose = await paint({ file_path: path, operation: 'update', firstLine: null, verbose: true })
  check('verbose paints the full path', has(verbose, `Operator rejected update to ${path}`), j(verbose))
  const write = await paint({ file_path: path, operation: 'write', firstLine: null, verbose: false })
  check('a write names its operation', has(write, 'Operator rejected write to src/app.ts'), j(write))
}

section('§2 A WRITE WITH CONTENT — the preview is cut at ten lines, every line when verbose, (no content) when empty')
{
  const content = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n')
  const cut = await paint({ file_path: path, operation: 'write', content, firstLine: 'line 1', verbose: false })
  check('ten lines show and the cut is counted', has(cut, 'line 10') && !has(cut, 'line 11') && has(cut, '+4 lines'), j(cut))
  const whole = await paint({ file_path: path, operation: 'write', content, firstLine: 'line 1', verbose: true })
  check('verbose shows every line and no count', has(whole, 'line 14') && !has(whole, '+4 lines'), j(whole))
  const exact = await paint({ file_path: path, operation: 'write', content: Array.from({ length: 10 }, (_, index) => `row ${index + 1}`).join('\n'), firstLine: 'row 1', verbose: false })
  check('exactly ten lines show no count', has(exact, 'row 10') && !has(exact, 'lines'), j(exact))
  const empty = await paint({ file_path: path, operation: 'write', content: '', firstLine: null, verbose: false })
  check('empty content paints (no content) under the headline', empty.length === 2 && has(empty, '(no content)'), j(empty))
}

section('§3 A PATCH — the dimmed diff under the headline; condensed hides it unless verbose')
{
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const a = 1', '+const a = 2'] }]
  const diff = await paint({ file_path: path, operation: 'update', patch, firstLine: null, verbose: false })
  check('the hunk paints under the headline', has(diff, 'const a = 2') && diff[0]?.includes('Operator rejected') === true, j(diff))
  const condensed = await paint({ file_path: path, operation: 'update', patch, firstLine: null, verbose: false, style: 'condensed' })
  check('condensed without verbose is the headline alone', condensed.length === 1, j(condensed))
  const condensedVerbose = await paint({ file_path: path, operation: 'update', patch, firstLine: null, verbose: true, style: 'condensed' })
  check('condensed with verbose shows the diff', has(condensedVerbose, 'const a = 2'), j(condensedVerbose))
  const noHunks = await paint({ file_path: path, operation: 'update', patch: [], firstLine: null, verbose: true })
  check('an empty patch is the headline alone', noHunks.length === 1, j(noHunks))
}

console.log(failures === 0 ? '\nPASS rejected edit row' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
