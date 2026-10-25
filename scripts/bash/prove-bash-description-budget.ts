#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { rmSync } from 'node:fs'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_SHELL_ENGINE
delete process.env.MERCURY_SHELL_TIMEOUT_MS
delete process.env.MERCURY_SHELL_MAX_TIMEOUT_MS
delete process.env.MERCURY_SHELL_MAX_OUTPUT
delete process.env.MERCURY_EMBEDDED_SEARCH

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { resolveShellEngine } = await import('../../src/utils/shell/engineSession.ts')

const POOL = ['Crewmate', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'ProviderSearch', 'TaskStop', 'AskUserQuestion', 'Skill', 'ApolloReview', 'LSP', 'Inspect', 'Service', 'Debug', 'Test', 'Eval', 'Launch', 'Transaction', 'Structure', 'AstSearch', 'AstEdit', 'ChangeSet', 'Git', 'Journey', 'Browser', 'Computer', 'JevEval', 'EnterWorktree', 'ExitWorktree', 'Checkpoint', 'Rewind', 'SendMessage', 'Workflow', 'Sleep', 'Monitor', 'ContextLeft', 'RecordConvention', 'Retain', 'Recall', 'Reflect', 'Correct', 'ToolSearch', 'mcp__mercury__lease_take', 'mcp__mercury__lease_release', 'mcp__mercury__lease_list', 'mcp__mercury__render_tui']
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
const byteAt = (text: string, needle: string): number => (text.includes(needle) ? bytes(text.slice(0, text.indexOf(needle))) : -1)

section('§1 the measured branch: the bench pool of 52 tools, the default engine')
check('the default engine is the system shell here', resolveShellEngine().engine === 'system')
const text = getSimplePrompt(new Set(POOL))
const size = bytes(text)
const fields = (BashTool as { inputJSONSchema: { properties: Record<string, { description?: string }> } }).inputJSONSchema.properties
check(`the description is at most 3,563 bytes, half of .28's 7,126 (${size})`, size <= 3563, `${size} bytes`)
check(`\`timeout\` is first met before byte 400 (at ${byteAt(text, '`timeout`')})`, byteAt(text, '`timeout`') >= 0 && byteAt(text, '`timeout`') < 400)
check(`run_in_background is first met before byte 1,600 (at ${byteAt(text, 'run_in_background')})`, byteAt(text, 'run_in_background') >= 0 && byteAt(text, 'run_in_background') < 1600)
check('the background lifetime is told: "It is stopped when the run that started it ends"', text.includes('It is stopped when the run that started it ends'))
check('…naming the one-prompt run: "`mercury run` given its prompt at launch"', text.includes('`mercury run` given its prompt at launch'))
check('the start result is named as the place that says which case applies', text.includes('The start result says which applies and how to wait.'))
check('the timeout rule says the result shows the output so far and a task id; the default, the maximum and the move to the background are the timeout field\'s alone', text.includes("When `timeout` passes, the result shows the command's output so far and a task id.") && !text.includes('default 120000') && !text.includes('moves to the background') && /^Milliseconds the call waits \(default 120000, max 600000\)\. When it passes, the command moves to the background and keeps running/.test(fields.timeout?.description ?? ''))
check('TaskStop is named as the way to bound a command that may hang, with no watchdog script', text.includes('pass a short `timeout`, then TaskStop it; no watchdog script is needed'))
check('the sleep exception is told once, in the timeout field, and not again in the description', (fields.timeout?.description ?? '').includes('a `sleep`-first command, or any command under the shell engine, is killed instead') && !text.includes('`sleep`'))
check('the output rule keeps the whole-output size, the file and the preview and names max_output_chars; the floor, the clamp and the head-and-tail cut are the max_output_chars field\'s alone', text.includes('Output: up to 30000 characters come back whole. A longer output is saved to a file, and you get its size, its path and about 2000 characters from its start and end. A smaller `max_output_chars` narrows that inline budget.') && !text.includes('512') && !text.includes('Every cut is marked') && !text.includes('keeps only the head and the tail') && (fields.max_output_chars?.description ?? '').includes('Default and cap 30000, floor 512') && (fields.max_output_chars?.description ?? '').includes('head and tail around a notice of the cut'))
check('the exit-1 rule lists which and command -v beside grep and the others', text.includes('grep, rg, find, diff, cmp, pgrep, test, `[`, which or `command -v`'))
check('no git workflow: "# Committing changes with git"', !text.includes('# Committing changes with git'))
check('no git workflow: "gh pr create"', !text.includes('gh pr create'))
check('no git bullet: "For git commands:"', !text.includes('For git commands:'))
check('no false promise: "since completion is notified"', !text.includes('since completion is notified'))
check('no `ls` contradiction: "`ls` the parent"', !text.includes('`ls` the parent'))
check('no "# Instructions" bullet list', !text.includes('# Instructions'))
check('no sandbox words and no trailing blank', !/sandbox/i.test(text) && !text.endsWith('\n'))
check('the Browser paragraph is present with its ToolSearch note (both are in the pool)', text.includes('use the `Browser` tool (ToolSearch `select:Browser` loads it when deferred)'))
check('seven paragraphs on this branch', text.split('\n\n').length === 7, String(text.split('\n\n').length))
console.log(`  paragraph bytes: ${text.split('\n\n').map(p => bytes(p)).join(' · ')}`)

section('§2 the whole definition as the wire carries it')
const definition = JSON.stringify({ name: 'Bash', description: text, input_schema: (BashTool as { inputJSONSchema: unknown }).inputJSONSchema, eager_input_streaming: true })
check(`the definition with eager_input_streaming is at most 4,200 bytes (${bytes(definition)}; .28 sent 9,302)`, bytes(definition) <= 4200, `${bytes(definition)} bytes`)

section('§3 the variants')
const noStop = getSimplePrompt(new Set(POOL.filter(n => n !== 'TaskStop')))
check('without TaskStop in the pool the timeout rule names no TaskStop', !noStop.includes('TaskStop') && noStop.includes("When `timeout` passes, the result shows the command's output so far and a task id.\n\nOutput:"), noStop.slice(0, 600))
const noSearch = getSimplePrompt(new Set(POOL.filter(n => n !== 'ToolSearch')))
check('without ToolSearch the two load notes go and the rest stays', !noSearch.includes('ToolSearch') && noSearch.includes('TaskStop with that id ends it and the processes under it. So to bound') && noSearch.includes('use the `Browser` tool; never install'), noSearch.slice(0, 800))
const noBrowser = getSimplePrompt(new Set(POOL.filter(n => n !== 'Browser')))
check('without Browser the web-page paragraph is absent', !noBrowser.includes('Browser') && noBrowser.split('\n\n').length === 6)
const everything = getSimplePrompt(null)
check('with no pool given (every tool offered) the text is the measured branch', everything === text)

section('§4 the brush engine variant')
process.env.MERCURY_SHELL_ENGINE = 'brush'
const brush = resolveShellEngine()
if (brush.engine === 'brush') {
  const brushText = getSimplePrompt(new Set(POOL))
  check('under the brush engine the timeout rule says the command is killed (exit 143)', brushText.includes('the command is killed (exit 143) and the shell session resets'), brushText.slice(0, 600))
  check('…and never says it moves to the background', !brushText.includes('moves to the background'))
  check('…and points at run_in_background for longer work', brushText.includes('For work that may take longer, use `run_in_background`.'))
  check('the engine session paragraphs are the .28 ones', brushText.includes('One shell session serves the whole conversation') && brushText.includes('engine sessions are kept alive at once') && brushText.includes('Prefer absolute paths or `cwd` to `cd`, and double-quote a path with spaces.'))
  check(`the brush description is still under the half budget (${bytes(brushText)})`, bytes(brushText) <= 3563)
} else {
  console.log(`  [INFO] the brush engine does not resolve here (${brush.reason}); the variant is not measured on this box`)
}
delete process.env.MERCURY_SHELL_ENGINE

try {
  rmSync(proofHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
