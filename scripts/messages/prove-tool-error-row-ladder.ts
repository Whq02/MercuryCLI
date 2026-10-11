#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'tool-error-row-home-')))
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

const { UserToolErrorMessage } = await import('../../src/components/messages/UserToolResultMessage/UserToolErrorMessage.js')
const { INTERRUPT_MESSAGE_FOR_TOOL_USE, REJECT_MESSAGE_WITH_REASON_PREFIX } = await import('../../src/utils/messages.js')
const { OUTPUT_CONNECTOR } = await import('../../src/constants/figures.js')
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, Text, render, flushPendingSyncWork } = await import('../../src/ink.js')

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
  const stdout = Object.assign(stream, { columns: 100, rows: 20 }) as unknown as NodeJS.WriteStream
  const store = createStore(getDefaultAppState())
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns: 100, rows: 20 } },
      React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width: 100 }, React.createElement(UserToolErrorMessage, { progressMessagesForMessage: [], tools: [], verbose: false, ...props } as never))),
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
  const lines = stripAnsi(frame).replace(/\s+$/, '').split('\n').map(line => line.trimEnd())
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return lines
}
const param = (content: unknown) => ({ type: 'tool_result', tool_use_id: 'toolu_row', content, is_error: true })
const has = (lines: string[], text: string): boolean => lines.some(line => line.includes(text))

section('§1 A CAPABILITY KILL — the × lead, the tool, its target, and the faint blocked line')
{
  const full = await paint({ param: param('x'), hermesKill: { tool: 'Bash', target: 'rm -rf /', kind: 'destructive', killPattern: 'rm -rf' } })
  check('the first row leads with the fail glyph, the tool and its target', has(full, `${GLYPH.fail} Bash  rm -rf /`), j(full))
  check('the second row is the connector and the full reason', has(full, `${OUTPUT_CONNECTOR}blocked · destructive · killed by MERCURY_KILL=rm -rf`), j(full))
  const bare = await paint({ param: param('x'), hermesKill: { tool: 'WebFetch', kind: 'network' } })
  check('without a target the row is the glyph and the tool alone', has(bare, `${GLYPH.fail} WebFetch`) && !has(bare, '  undefined'), j(bare))
  check('without a pattern the reason stops at the kind', has(bare, `${OUTPUT_CONNECTOR}blocked · network`) && !has(bare, 'killed by'), j(bare))
  const interruptedButKilled = await paint({ param: param(INTERRUPT_MESSAGE_FOR_TOOL_USE), hermesKill: { tool: 'Bash', kind: 'destructive' } })
  check('a kill wins over an interrupt sentence in the content', has(interruptedButKilled, 'blocked · destructive'), j(interruptedButKilled))
}

section('§2 THE SENTENCES — an interrupt paints the interrupted row; a reasoned rejection the rejected row')
{
  const interruptedRow = await paint({ param: param(`before ${INTERRUPT_MESSAGE_FOR_TOOL_USE} after`) })
  check('a content containing the interrupt sentence paints the interrupted row', has(interruptedRow, 'Interrupted'), j(interruptedRow))
  const rejected = await paint({ param: param(`${REJECT_MESSAGE_WITH_REASON_PREFIX}use the fixture`) })
  check('a content opening with the rejection prefix paints the rejected row', has(rejected, 'Tool use rejected'), j(rejected))
  const notAtStart = await paint({ param: param(`x ${REJECT_MESSAGE_WITH_REASON_PREFIX}y`) })
  check('the rejection prefix counts only at the start', !has(notAtStart, 'Tool use rejected'), j(notAtStart))
  const blocks = await paint({ param: param([{ type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE }]) })
  check('a block-array content is not a sentence match (the fallback paints it)', !has(blocks, 'Interrupted'), j(blocks))
}

section("§3 THE TOOL'S OWN ROW — used when the tool has one and answers; otherwise the fallback")
{
  const seen: unknown[] = []
  const tool = { name: 'Probe', renderToolUseErrorMessage: (content: unknown, options: Record<string, unknown>) => { seen.push([content, Object.keys(options).sort(), options.progressMessagesForMessage]); return React.createElement(Text, null, 'the probe says no') } }
  const progress = [{ type: 'progress', data: { type: 'bash_progress' } }, { type: 'progress', data: { type: 'agent_progress' } }]
  const own = await paint({ param: param('plain failure'), tool, progressMessagesForMessage: progress, isTranscriptMode: true, toolUseResult: { r: 1 }, input: { i: 2 } })
  check("the tool's own row paints", has(own, 'the probe says no'), j(own))
  check('it receives the content and the six options, the progress list filtered to tool progress', seen.length === 1 && (seen[0] as unknown[])[0] === 'plain failure' && j((seen[0] as unknown[])[1]) === j(['input', 'isTranscriptMode', 'progressMessagesForMessage', 'toolUseResult', 'tools', 'verbose']) && Array.isArray((seen[0] as unknown[])[2]), j(seen))
  const declined = await paint({ param: param('plain failure'), tool: { name: 'Quiet', renderToolUseErrorMessage: () => null } })
  check('a tool whose renderer answers nothing gets the fallback with the content', has(declined, 'plain failure'), j(declined))
  const absent = await paint({ param: param('no tool here') })
  check('no tool at all (a resumed transcript) gets the fallback', has(absent, 'no tool here'), j(absent))
}

console.log(failures === 0 ? '\nPASS tool error row ladder' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
