#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'local-output-home-')))
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

const { UserLocalCommandOutputMessage } = await import('../../src/components/messages/UserLocalCommandOutputMessage.js')
const { earlierReleasesLine } = await import('../../src/utils/releaseNotes.js')
const { ctrlOToExpand } = await import('../../src/components/CtrlOToExpand.js')
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
const paint = async (content: string, verbose = false): Promise<string[]> => {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 100, rows: 30 }) as unknown as NodeJS.WriteStream
  const store = createStore(getDefaultAppState())
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns: 100, rows: 30 } },
      React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width: 100 }, React.createElement(UserLocalCommandOutputMessage, { content, verbose }))),
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
const out = (text: string): string => `<local-command-stdout>${text}</local-command-stdout>`
const err = (text: string): string => `<local-command-stderr>${text}</local-command-stderr>`
const has = (lines: string[], text: string): boolean => lines.some(line => line.includes(text))
const rowOf = (lines: string[], text: string): number => lines.findIndex(line => line.includes(text))

section('§1 THE STREAMS — stdout then stderr, each trimmed; nothing paints (no content)')
{
  const both = await paint(out('  all good  ') + err('  but noisy  '))
  check('stdout paints before stderr, trimmed', rowOf(both, 'all good') >= 0 && rowOf(both, 'but noisy') > rowOf(both, 'all good') && !has(both, '  all good'), j(both))
  const only = await paint(err('only errors'))
  check('a lone stderr paints alone', has(only, 'only errors') && only.length === 1, j(only))
  const empty = await paint(out('   ') + err(''))
  check('whitespace-only streams paint (no content)', empty.length === 1 && has(empty, '(no content)'), j(empty))
  const none = await paint('plain text with no tags')
  check('no tags at all paint (no content)', has(none, '(no content)'), j(none))
}

section('§2 A CLOUD-LAUNCH NOTICE — the diamond lead, the bold label, the dim remainder, the rest beneath')
{
  const notice = await paint(out('◇ Launched · 3 agents\nfollow along in the board'))
  check('the header keeps the label and the remainder on one line', has(notice, 'Launched · 3 agents'), j(notice))
  check('the rest paints beneath', rowOf(notice, 'follow along in the board') > rowOf(notice, 'Launched'), j(notice))
  const bare = await paint(out('◆ Done'))
  check('a one-line notice paints the header alone', bare.length === 1 && has(bare, 'Done'), j(bare))
  const notANotice = await paint(out('◇Launched without the space'))
  check('a diamond without the space is ordinary markdown', has(notANotice, '◇Launched without the space'), j(notANotice))
}

section('§3 THE EARLIER-RELEASES FOLD — hidden behind the transcript key unless verbose')
{
  const foldLine = earlierReleasesLine(3)
  const text = `## 1.0.0-beta.31\n\n- a fix\n\n${foldLine}\n\n## 1.0.0-beta.30\n\n- older`
  const folded = await paint(out(text))
  check('the fold line paints with the key hint and nothing after it', has(folded, `${foldLine} ${ctrlOToExpand()}`) && !has(folded, 'older'), j(folded))
  check('the lines before the fold paint', has(folded, 'a fix'), j(folded))
  const expanded = await paint(out(text), true)
  check('verbose drops the fold line and shows the earlier release', !has(expanded, foldLine) && has(expanded, 'older'), j(expanded))
  const plain = await paint(out('just\n\n\n\nlines'))
  check('text without a fold line is markdown as is', has(plain, 'just') && has(plain, 'lines') && !has(plain, 'expand'), j(plain))
}

console.log(failures === 0 ? '\nPASS local command output row' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
