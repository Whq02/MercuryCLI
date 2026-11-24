#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

const proofHome = mkdtempSync(join(tmpdir(), 'tool-row-words-cut-'))
process.env.MERCURY_CONFIG_DIR = proofHome
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { renderToAnsiString } = await import('../../src/screen/renderer/staticRender.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { SleepTool } = await import('../../src/tools/sleep/SleepTool.tsx')
const { SendMessageTool } = await import('../../src/tools/send-message/SendMessageTool.ts')

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}

async function paint(node: React.ReactNode, width = 160): Promise<string> {
  const wrapped = React.createElement(ThemeProvider as never, null, node)
  return stripAnsi(await renderToAnsiString(wrapped as never, width)).trim()
}

{
  const fullMessage =
    'Returned after 3s — the tracked work you were waiting on finished. ' +
    'Mercury tracks crewmate tasks and your own background commands for you; their completion arrives on its own, so a wait ' +
    'never needs to run its full duration to poll one.'
  const output = { message: fullMessage, slept_seconds: 3, interrupted: false }
  const screenText = await paint(SleepTool.renderToolResultMessage(output, [], { verbose: false, theme: 'dark' } as never))
  check(
    'K-29 Sleep early-settle row reads only the short sentence',
    screenText === 'Returned after 3s — the tracked work you were waiting on finished.',
    JSON.stringify(screenText),
  )
  const block = SleepTool.mapToolResultToToolResultBlockParam(output, 'toolu_sleep_1')
  const modelPayload = JSON.parse(typeof block.content === 'string' ? block.content : '') as { message?: string }
  check(
    'K-29 Sleep model payload keeps the full long sentence byte for byte',
    modelPayload.message === fullMessage,
    JSON.stringify(modelPayload.message),
  )
  const fullWait = { message: 'Slept for 5s', slept_seconds: 5, interrupted: false }
  const fullWaitScreen = await paint(SleepTool.renderToolResultMessage(fullWait, [], { verbose: false, theme: 'dark' } as never))
  check('K-29 Sleep full-wait row stays unchanged', fullWaitScreen === 'Slept for 5s', JSON.stringify(fullWaitScreen))
  const interruptedWait = { message: 'Sleep interrupted after 2s', slept_seconds: 2, interrupted: true }
  const interruptedScreen = await paint(SleepTool.renderToolResultMessage(interruptedWait, [], { verbose: false, theme: 'dark' } as never))
  check('K-29 Sleep interrupted row stays unchanged', interruptedScreen === 'Sleep interrupted after 2s', JSON.stringify(interruptedScreen))
}

{
  const fullMessage = 'Delivered to scout (id a1); it reads it at its next tool boundary.'
  const output = { success: true, message: fullMessage }
  const screenText = (await paint(SendMessageTool.renderToolResultMessage(output, [], { verbose: false, theme: 'dark' } as never))).replace(/^└\s*/, '')
  check(
    'K-30 SendMessage delivered row reads only Delivered to <who>',
    screenText === 'Delivered to scout (id a1)',
    JSON.stringify(screenText),
  )
  const block = SendMessageTool.mapToolResultToToolResultBlockParam(output, 'toolu_sm_1')
  check(
    'K-30 SendMessage delivered model payload keeps the full long sentence byte for byte',
    Array.isArray(block.content) && block.content.length === 1 && block.content[0]?.type === 'text' && block.content[0].text === fullMessage,
    JSON.stringify(block.content),
  )
}

{
  const fullMessage =
    'Not delivered: scout (id a1) has completed, so no turn of it is running to read a message. To give it this message as a new turn, call ResumeCrewmate with the same to and message.'
  const output = { success: false, message: fullMessage }
  const screenText = (await paint(SendMessageTool.renderToolResultMessage(output, [], { verbose: false, theme: 'dark' } as never))).replace(/^└\s*/, '')
  check(
    'K-31 SendMessage not-delivered row reads only Not delivered: <who> has <ended>',
    screenText === 'Not delivered: scout (id a1) has completed',
    JSON.stringify(screenText),
  )
  const block = SendMessageTool.mapToolResultToToolResultBlockParam(output, 'toolu_sm_2')
  check(
    'K-31 SendMessage not-delivered model payload keeps the full long sentence byte for byte',
    Array.isArray(block.content) && block.content.length === 1 && block.content[0]?.type === 'text' && block.content[0].text === fullMessage,
    JSON.stringify(block.content),
  )
}

{
  const { GLYPH } = await import('../../src/screen/theme/glyphs.js')
  const { renderToolResultMessage: renderMcpResult } = await import('../../src/tools/mcp/rows.tsx')
  const screenText = await paint(renderMcpResult('x'.repeat(50_000), [], { verbose: false }))
  const firstLine = (screenText.split('\n')[0] ?? '').trim().replace(/^└\s*/, '')
  check(
    'K-32 large MCP response flag reads only <warn> Large MCP response (~<n> tokens)',
    firstLine.startsWith(`${GLYPH.warn} Large MCP response (~`) && firstLine.endsWith(' tokens)') && !firstLine.includes('eat context fast'),
    JSON.stringify(firstLine),
  )
}

{
  const { default: BashToolResultMessage } = await import('../../src/tools/shell/BashToolResultMessage.tsx')
  const screenText = await paint(
    React.createElement(BashToolResultMessage, {
      content: { stdout: '', stderr: '', isImage: true },
      verbose: false,
    }),
  )
  check(
    'K-33 Bash image result row reads [image data sent to the model]',
    screenText === '[image data sent to the model]',
    JSON.stringify(screenText),
  )
}

{
  const { renderRecallResult } = await import('../../src/tools/memory/rows.tsx')
  const screenText = (await paint(renderRecallResult({ kind: 'search', query: 'nothing', pointers: [] } as never))).replace(/^└\s*/, '')
  check(
    'K-34 Recall empty search row reads no memory matched',
    screenText === 'no memory matched',
    JSON.stringify(screenText),
  )
}
console.log(`\ntool-row-words-cut: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
