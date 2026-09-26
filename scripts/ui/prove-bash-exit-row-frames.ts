#!/usr/bin/env bun
import React from 'react'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const { render, Box, flushPendingSyncWork } = await import('../../src/ink.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { UserBashInputMessage } = await import('../../src/components/messages/UserBashInputMessage.js')
const { UserBashOutputMessage } = await import('../../src/components/messages/UserBashOutputMessage.js')
const { stringWidth } = await import('../../src/ink/stringWidth.js')
const { escapeXml } = await import('../../src/utils/xml.js')
const xml = await import('../../src/constants/xml.js')

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const pair = (stdout: string, stderr: string): string => `<${xml.BASH_STDOUT_TAG}>${stdout}</${xml.BASH_STDOUT_TAG}><${xml.BASH_STDERR_TAG}>${escapeXml(stderr)}</${xml.BASH_STDERR_TAG}>`
const exit = (code: number, durationMs: number): string => `<bash-exit-code>${code}</bash-exit-code><bash-duration-ms>${durationMs}</bash-duration-ms>`

type Row = { input: string; content: string; words: string | null; output: string[] }
const rows: Row[] = [
  { input: 'echo hello', content: pair('hello', '') + exit(0, 1234), words: 'exit 0 · 1.2s', output: ['hello'] },
  { input: 'true', content: pair('', '') + exit(0, 7), words: 'exit 0 · 7ms', output: ['No output'] },
  { input: 'false', content: pair('', '\n\nExited with code 1') + exit(1, 3), words: 'exit 1 · 3ms', output: ['Exited with code 1'] },
  { input: 'git fetch --all', content: pair('Fetching origin', '') + exit(0, 65_000), words: 'exit 0 · 1m 5s', output: ['Fetching origin'] },
  { input: 'printf older', content: pair('older', ''), words: null, output: ['older'] },
]

async function mount(columns: number, terminalRows: number): Promise<string[]> {
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: terminalRows }) as unknown as NodeJS.WriteStream
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const children = rows.flatMap((row, index) => [
    React.createElement(UserBashInputMessage, { key: `in-${index}`, addMargin: index > 0, param: { type: 'text', text: `<${xml.BASH_INPUT_TAG}>${row.input}</${xml.BASH_INPUT_TAG}>` } }),
    React.createElement(UserBashOutputMessage, { key: `out-${index}`, content: row.content, verbose: false }),
  ])
  const node = React.createElement(TerminalSizeContext.Provider, { value: { columns, rows: terminalRows } },
    React.createElement(Box, { flexDirection: 'column', width: columns }, ...children))
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  const frame = stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return frame.split('\n')
}

const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

for (const [columns, terminalRows] of [[178, 51], [80, 21]] as const) {
  const label = `${columns}x${terminalRows}`
  const lines = await mount(columns, terminalRows)
  if (frameDir) writeFileSync(join(frameDir, `${label}.txt`), lines.join('\n') + '\n')
  console.log(`\n${label}:`)
  for (const line of lines) console.log(line)
  console.log('')
  check(`${label}: the frame paints without a render error`, !lines.some(line => line.includes('RENDER ERROR')))
  check(`${label}: no row is wider than the screen`, lines.every(line => stringWidth(line) <= columns), String(Math.max(...lines.map(line => stringWidth(line)))))
  check(`${label}: no wrapper tag leaks into the painted row`, !lines.some(line => /<\/?bash-|bash-exit-code|bash-duration-ms/.test(line)), lines.find(line => /bash-/.test(line)) ?? '')
  const at = (needle: string, from: number): number => lines.findIndex((line, index) => index >= from && line.includes(needle))
  let cursor = 0
  for (const row of rows) {
    const head = at(`! ${row.input}`, cursor)
    check(`${label}: the echoed row for \`${row.input}\` paints`, head >= 0, `not found after line ${cursor}`)
    if (head < 0) continue
    const body = row.output.map(text => at(text, head + 1)).reduce((a, b) => Math.max(a, b), -1)
    check(`${label}: the output of \`${row.input}\` paints under its echo`, body > head, JSON.stringify(row.output))
    const next = rows.indexOf(row) + 1 < rows.length ? at(`! ${rows[rows.indexOf(row) + 1]!.input}`, head + 1) : lines.length
    const stop = next < 0 ? lines.length : next
    const wordLines = lines.slice(head + 1, stop).filter(line => /\bexit \d+/.test(line))
    if (row.words === null) {
      check(`${label}: a row without the exit pair (an older transcript, a backgrounded shell) paints no exit words`, wordLines.length === 0, JSON.stringify(wordLines))
    } else {
      const found = wordLines.findIndex(line => line.trimEnd().endsWith(row.words!))
      check(`${label}: the row of \`${row.input}\` says "${row.words}" once, after its output`, wordLines.length === 1 && found === 0 && lines.indexOf(wordLines[0]!, body) > body, JSON.stringify(wordLines))
      check(`${label}: the words sit in the response gutter like the output lines`, wordLines[0]?.trimStart().startsWith('└') === true, JSON.stringify(wordLines[0] ?? ''))
    }
    cursor = stop
  }
}

console.log(`\nbash exit row frames: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
