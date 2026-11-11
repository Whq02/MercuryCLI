#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'monitor-row-'))
delete process.env.MERCURY_HOME
process.env.FORCE_COLOR = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const React = (await import('react')).default
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { AssistantToolUseMessage } = await import('../../src/components/messages/AssistantToolUseMessage.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { MonitorTool } = await import('../../src/tools/MonitorTool/MonitorTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const lookups = {
  siblingToolUseIDs: new Map(), progressMessagesByToolUseID: new Map(), inProgressHookCounts: new Map(), resolvedHookCounts: new Map(),
  toolResultByToolUseID: new Map(), toolUseByToolUseID: new Map(), normalizedMessageCount: 1,
  resolvedToolUseIDs: new Set(['toolu_row']), erroredToolUseIDs: new Set(), deniedToolUseIDs: new Set(),
}
async function rowOf(tool: { name: string }, input: Record<string, unknown>, verbose = false): Promise<string> {
  const node = React.createElement(AppStateProvider as never, {}, React.createElement(AssistantToolUseMessage as never, {
    param: { type: 'tool_use', id: 'toolu_row', name: tool.name, input }, tools: [tool], verbose, inProgressToolUseIDs: new Set(), shouldAnimate: false, shouldShowDot: true, lookups,
  } as never))
  return stripAnsi(await renderToAnsiString(node as never, 120)).split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '').join(' | ')
}
const said = (input: Record<string, unknown>, verbose = false): string => String(MonitorTool.renderToolUseMessage(input as never, { theme: undefined, verbose } as never))
const WATCH = { timeout_ms: 300_000, persistent: false }

console.log("the Monitor row in the transcript names the command that ran, as a Bash row does")
{
  const row = await rowOf(MonitorTool as never, { command: 'tail -f build.log', description: 'watch the build log', ...WATCH })
  const bashRow = await rowOf(BashTool as never, { command: 'tail -f build.log', description: 'watch the build log' })
  check('the row holds the command', row.includes('tail -f build.log'), row)
  check('the model\'s description comes after the command', /tail -f build\.log — watch the build log/.test(row), row)
  check('the row no longer reads "Monitor: <description>" in the command\'s place', !row.includes('Monitor: watch the build log'), row)
  check('the Bash row for the same command holds the same command text', bashRow.includes('tail -f build.log'), bashRow)
  check('a watch with no description names the command alone', said({ command: 'tail -f build.log', ...WATCH }) === 'tail -f build.log', said({ command: 'tail -f build.log', ...WATCH }))
  const twoLines = said({ command: 'while true; do\n  date\ndone', description: 'tick', ...WATCH })
  check('a command of several lines is folded onto one line as a Bash row folds it', twoLines === 'while true; do ↵ date ↵ done — tick', twoLines)
  const long = said({ command: `grep -R ${'needle-'.repeat(60)} .`, ...WATCH })
  check('a long command is cut at the row\'s length with an ellipsis', long.endsWith('…') && long.length < 200 && long.startsWith('grep -R needle-'), `${long.length} characters`)
  const whole = said({ command: `grep -R ${'needle-'.repeat(60)} .`, ...WATCH }, true)
  check('the detailed view keeps the whole command', whole === `grep -R ${'needle-'.repeat(60)} .`, `${whole.length} characters`)
}

console.log(`\nprove-monitor-row-names-command: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
