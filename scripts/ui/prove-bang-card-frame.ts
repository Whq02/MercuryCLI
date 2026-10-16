#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import React from 'react'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_SHELL_ENGINE = 'system'
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'bang-card-frame-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MERCURY_') && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE', 'MERCURY_SHELL_ENGINE', 'MERCURY_TMPDIR', 'MERCURY_DESKTOP_DRIVER'].includes(name)) delete process.env[name]
}
process.env.MERCURY_ENTRYPOINT = 'cli'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const clip = (text: string, limit = 300): string => JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text)
const NOTICE = /session env scrubbed|inherit_session_env|Mercury's own stamps/

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { processBashCommand } = await import('../../src/utils/processUserInput/processBashCommand.tsx')
const { extractTag } = await import('../../src/utils/messages.ts')
const { unescapeXml } = await import('../../src/utils/xml.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
const { render, Box, flushPendingSyncWork } = await import('../../src/ink.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { UserBashOutputMessage } = await import('../../src/components/messages/UserBashOutputMessage.js')
setIsInteractive(false)

let appState = getDefaultAppState()
const makeContext = (): never =>
  ({
    options: { commands: [], verbose: false, engineModel: 'claude-sonnet-5', tools: [], mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
    messages: [],
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
    toolUseId: 'bang-card-frame',
  }) as never

type Card = { stdout: string; stderr: string; code: string | null; content: string }
async function bangCard(command: string): Promise<Card | null> {
  const outcome = await processBashCommand(command, [], [], makeContext(), (() => undefined) as never)
  const texts = (outcome.messages as Array<{ message?: { content?: unknown } }>).map(m => (typeof m.message?.content === 'string' ? m.message.content : ''))
  const content = texts.find(text => text.startsWith('<bash-stdout>'))
  if (content === undefined) return null
  return { stdout: extractTag(content, 'bash-stdout') ?? '', stderr: unescapeXml(extractTag(content, 'bash-stderr') ?? ''), code: extractTag(content, 'bash-exit-code'), content }
}

async function paint(content: string, columns: number): Promise<string[]> {
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 24 }) as unknown as NodeJS.WriteStream
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const node = React.createElement(TerminalSizeContext.Provider, { value: { columns, rows: 24 } },
    React.createElement(Box, { flexDirection: 'column', width: columns }, React.createElement(UserBashOutputMessage, { content, verbose: false })))
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

console.log('============================================================')
console.log(" The `!` card's frame — a failed command paints what it printed and nothing else")
console.log('============================================================')

section("§1 the first scrubbing command of the session fails: the card's transcript row")
const failed = await bangCard('echo own-line; echo own-error >&2; exit 7')
console.log(`        the card's stderr reads ${clip(failed?.stderr ?? '(no card)')}`)
check('the transcript carries the card row with the exit code', failed !== null && failed.code === '7', failed === null ? 'no <bash-stdout> row' : `code ${failed.code}`)
check("the card carries the command's own output", failed !== null && failed.stderr.includes('own-line') && failed.stderr.includes('own-error') && /Exited with code 7/.test(failed.stderr), clip(failed?.stderr ?? ''))
check('the card carries no session-env note', failed !== null && !NOTICE.test(failed.stderr) && !NOTICE.test(failed.stdout), clip(failed?.stderr ?? ''))

section('§2 the painted card at 80 and 140 columns')
if (failed !== null) {
  for (const columns of [80, 140]) {
    const lines = await paint(failed.content, columns)
    for (const line of lines) console.log(`        │ ${line}`)
    check(`${columns} cols: the frame paints the command's own lines and the exit words`, lines.some(l => l.includes('own-line')) && lines.some(l => l.includes('own-error')) && lines.some(l => /exit 7/.test(l)), JSON.stringify(lines))
    check(`${columns} cols: no line of the frame carries the session-env note`, !lines.some(l => NOTICE.test(l)), lines.find(l => NOTICE.test(l)) ?? '')
    check(`${columns} cols: the frame paints without a render error`, !lines.some(l => l.includes('RENDER ERROR')))
  }
}

section('§3 control: a succeeding command that names a scrubbed stamp')
const ok = await bangCard('echo fine; echo "[$MERCURY_ENTRYPOINT]"')
check("a succeeding command's card carries its output and no note", ok !== null && ok.code === '0' && ok.stdout.includes('fine') && ok.stdout.includes('[]') && !NOTICE.test(ok.stdout) && !NOTICE.test(ok.stderr), clip(ok?.content ?? ''))

rmSync(SCRATCH, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR as string, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL BANG-CARD FRAME PROOFS PASS' : `\n${failures} BANG-CARD FRAME PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
