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

section('§1 the measured branch: the bench pool of 52 tools, the default engine')
check('the default engine is the system shell here', resolveShellEngine().engine === 'system')
const text = getSimplePrompt(new Set(POOL))
const size = bytes(text)
const fields = (BashTool as { inputJSONSchema: { properties: Record<string, { description?: string }> } }).inputJSONSchema.properties
const field = (name: string): string => fields[name]?.description ?? ''
check(`the description is at most 800 bytes, a fifth of .28's 7,126 (${size})`, size <= 800, `${size} bytes`)
check('it opens with what the tool runs and what comes back', text.startsWith('Runs one shell command and returns its output, stdout and stderr merged in the order written.'))
check('it says once who sees the output', text.includes('The output comes back to you, not to the operator.'))
check('the output rule names the inline size, the saved file with its path and the preview', text.includes('Up to 30000 characters come back inline; a longer output is saved to a file, and the result carries its path with about 2000 characters from its start and end.'))
check('the exit-1 rule lists which and command -v beside grep and the others', text.includes('grep, rg, find, diff, cmp, pgrep, test, `[`, which or `command -v`'))
check('the shell rule says what persists and what does not', text.includes('The working directory persists between calls; shell variables, functions and options do not'))
check('three paragraphs on this branch: the tool, its output, its shell', text.split('\n\n').length === 3, String(text.split('\n\n').length))
console.log(`  paragraph bytes: ${text.split('\n\n').map(p => bytes(p)).join(' · ')}`)

section('§2 each fact lives once, in the field that causes it')
check('the timeout field alone carries the default, the maximum, the move to the background, the task id and the sleep exception', /^Milliseconds the call waits \(default 120000, max 600000\)\. When it passes, the command moves to the background and keeps running, and the result names its task id; a `sleep`-first command, or any command under the shell engine, is killed instead\.$/.test(field('timeout')) && !text.includes('timeout') && !text.includes('`sleep`'))
check('the run_in_background field alone carries the lifetime: the exit notice, and the stop when the run that started it ends', field('run_in_background').includes('A notice with its exit code reaches you when it ends; the command is stopped when the run that started it ends.') && !text.includes('run_in_background') && !text.includes('Background:'))
check('the max_output_chars field alone carries the cap, the floor, the clamp and the head-and-tail cut', field('max_output_chars').includes('Default and cap 30000, floor 512') && field('max_output_chars').includes('head and tail around a notice of the cut') && !text.includes('max_output_chars') && !text.includes('512'))
check('the description field asks for a few words shown to the operator, with no example and no forbidden words', field('description') === 'A few words naming what the command does, shown to the operator.')

section('§3 what the description no longer carries: other tools, incident rules, repeats')
for (const name of ['Glob', 'Grep', 'Read', 'Edit', 'Write', 'WebFetch', 'Browser', 'Service', 'TaskStop', 'ToolSearch', 'Test', 'Debug']) {
  check(`no other tool is described: ${name}`, !new RegExp(`\\b${name}\\b`).test(text))
}
for (const phrase of ['watchdog', 'Never poll', 'install a browser driver', 'bare newline', 'Prefer the dedicated tools', 'Chain dependent commands', 'identify Mercury honestly', 'Semantic shortcut', 'Use `Test`']) {
  check(`no incident rule: "${phrase}"`, !text.includes(phrase))
}
check('no git workflow, no instructions list, no sandbox words, no trailing blank', !text.includes('# Committing changes with git') && !text.includes('gh pr create') && !text.includes('# Instructions') && !/sandbox/i.test(text) && !text.endsWith('\n'))
check('the pool does not change the text: no tool is named, so none is withheld', getSimplePrompt(new Set(['Bash'])) === text && getSimplePrompt(null) === text)

section('§4 the whole definition as the wire carries it')
const definition = JSON.stringify({ name: 'Bash', description: text, input_schema: (BashTool as { inputJSONSchema: unknown }).inputJSONSchema, eager_input_streaming: true })
check(`the definition with eager_input_streaming is at most 2,400 bytes (${bytes(definition)}; .28 sent 9,302, 1.0.4 sent 4,138 + the envelope)`, bytes(definition) <= 2400, `${bytes(definition)} bytes`)

section('§5 the brush engine variant')
process.env.MERCURY_SHELL_ENGINE = 'brush'
const brush = resolveShellEngine()
if (brush.engine === 'brush') {
  const brushText = getSimplePrompt(new Set(POOL))
  check('under the brush engine the timeout rule says the command is killed (exit 143) and the session resets', brushText.includes('When `timeout` passes, the command is killed (exit 143) and the shell session resets.'), brushText.slice(0, 600))
  check('…and never says it moves to the background', !brushText.includes('moves to the background'))
  check('the engine session paragraphs say what one session is, what resets it, and the ceiling', brushText.includes('One shell session serves the whole conversation') && brushText.includes('resets the session') && (brushText.includes('engine sessions are kept alive at once') || brushText.includes('The shell.sessions setting is 1')))
  check(`the brush description is under 1,500 bytes (${bytes(brushText)})`, bytes(brushText) <= 1500)
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
