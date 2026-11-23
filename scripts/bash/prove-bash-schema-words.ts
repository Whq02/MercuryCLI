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

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { getSessionSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
const cachePrimedBeforeTheTool = getSessionSettingsCache() !== null
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const cachePrimedByTheTool = getSessionSettingsCache() !== null
const { describeTimeout, describeMaxOutputChars, getSimplePrompt } = await import('../../src/tools/shell/prompt.ts')
const { resolveShellEngine } = await import('../../src/platform/shell/engineSession.ts')
const { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } = await import('../../src/tools/kit/timeouts.ts')
const { getMaxOutputLength, getMinOutputLength } = await import('../../src/platform/shell/outputLimits.ts')

type Field = { type?: string; description?: string; exclusiveMinimum?: number; maximum?: number }
type Schema = { $schema?: string; type?: string; properties?: Record<string, Field>; required?: string[]; additionalProperties?: boolean }
const schema = (BashTool as { inputJSONSchema: Schema }).inputJSONSchema
const props = schema.properties ?? {}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const field = (name: string): string => props[name]?.description ?? ''
const schemaWhere = ' | change the field text in buildModelSchema (src/tools/shell/BashTool.tsx) or in the describe functions of src/tools/shell/prompt.ts, or update this proof if the wording change is intended'

section('§1 the shape: seven fields, their names and types, command required, nothing else allowed')
check('exactly the seven property names, in order', JSON.stringify(Object.keys(props)) === JSON.stringify(['command', 'cwd', 'timeout', 'description', 'run_in_background', 'inherit_session_env', 'max_output_chars']), JSON.stringify(Object.keys(props)) + schemaWhere)
check('required is ["command"]', JSON.stringify(schema.required) === JSON.stringify(['command']), JSON.stringify(schema.required) + schemaWhere)
check('additionalProperties is false (a strict object)', schema.additionalProperties === false, String(schema.additionalProperties) + ' | buildModelSchema in src/tools/shell/BashTool.tsx must stay a z.strictObject')
check('cwd adds a string; existing field types stay unchanged', ['command', 'cwd', 'timeout', 'description', 'run_in_background', 'inherit_session_env', 'max_output_chars'].map(n => props[n]?.type).join(',') === 'string,string,number,string,boolean,boolean,integer', Object.values(props).map(f => f.type).join(',') + schemaWhere)
check('cwd is the exact text', field('cwd') === 'Run in this directory: absolute, or relative to the starting folder; the session directory stays.', field('cwd') + schemaWhere)
check('max_output_chars keeps its exclusiveMinimum 0 and its maximum', props.max_output_chars?.exclusiveMinimum === 0 && typeof props.max_output_chars?.maximum === 'number', JSON.stringify(props.max_output_chars) + ' | maxOutputCharsField used by buildModelSchema in src/tools/shell/BashTool.tsx must keep exclusiveMinimum 0 and a numeric maximum')
check('command keeps its text', field('command') === 'The command to execute', field('command') + schemaWhere)
check('inherit_session_env says what it hands over and why the default scrubs', field('inherit_session_env') === "Hand the command the session's own MERCURY_* values; by default they are scrubbed, so a build or a proof never sees them.", field('inherit_session_env') + schemaWhere)

section('§2 the size: the compact schema is at most 1,500 bytes')
const schemaBytes = bytes(schema)
check(`the compact schema is ≤ 1,500 bytes (${schemaBytes})`, schemaBytes <= 1500, `${schemaBytes} bytes | shorten the field texts in buildModelSchema (src/tools/shell/BashTool.tsx) or the describe functions in src/tools/shell/prompt.ts`)
console.log(`  bytes per field: ${Object.entries(props).map(([k, v]) => `${k} ${bytes({ [k]: v })}`).join(' · ')}`)

section('§3 the four texts that carry their facts alone: timeout, description, run_in_background, max_output_chars')
const defaultMs = getDefaultBashTimeoutMs()
const maxMs = getMaxBashTimeoutMs()
check('timeout says what the number is and its default and max from the timeout accessors', field('timeout').startsWith(`Milliseconds the call waits (default ${defaultMs}, max ${maxMs}).`), field('timeout') + ' | describeTimeout in src/tools/shell/prompt.ts must open with the defaults from getDefaultBashTimeoutMs and getMaxBashTimeoutMs')
check('timeout says the command moves to the background when it passes and the result names the task id', field('timeout').includes('moves to the background and keeps running, and the result names the task id TaskStop takes'), field('timeout') + ' | edit describeTimeout in src/tools/shell/prompt.ts')
check('timeout names the two exceptions: a sleep-first command, and the shell engine', field('timeout').includes('a `sleep`-first command, or any command under the shell engine, is killed instead'), field('timeout') + ' | edit describeTimeout in src/tools/shell/prompt.ts')
check('timeout is the exact text', field('timeout') === `Milliseconds the call waits (default ${defaultMs}, max ${maxMs}). When it passes, the command moves to the background and keeps running, and the result names the task id TaskStop takes; a \`sleep\`-first command, or any command under the shell engine, is killed instead.`, field('timeout') + schemaWhere)
check('description asks for a few words shown to the operator: no example, no forbidden words', field('description') === 'A few words naming what the command does, shown to the operator.', field('description') + ' | edit describeCommandDescription in src/tools/shell/prompt.ts')
check('run_in_background does not send the model to a file-reading tool', !field('run_in_background').includes('file-reading tool'), field('run_in_background') + ' | remove the file-reading tool pointer from describeRunInBackground in src/tools/shell/prompt.ts')
check('run_in_background carries the lifetime itself: the task id and output file, the exit notice, the stop when the run that started it ends', field('run_in_background') === 'Start the command and return at once with a task id and an output file. A notice with its exit code reaches you when it ends; the command is stopped when the run that started it ends.', field('run_in_background') + ' | edit describeRunInBackground in src/tools/shell/prompt.ts')
check('max_output_chars states the budget, the cap, the floor and the clamp from the output limits', field('max_output_chars') === `Inline character budget: a longer output comes back as its head and tail around a notice of the cut. Default and cap ${getMaxOutputLength()}, floor ${getMinOutputLength()}; a value outside is clamped and the result says so. Ignored by run_in_background.`, field('max_output_chars') + ' | edit describeMaxOutputChars in src/tools/shell/prompt.ts')
check('the max_output_chars text has one owner the schema reads', field('max_output_chars') === describeMaxOutputChars(), field('max_output_chars') + ' | buildModelSchema in src/tools/shell/BashTool.tsx must describe max_output_chars with describeMaxOutputChars() and nothing else')

section('§4 the schema reads no settings when it is built: the engine\'s truth lives in the per-request description')
check('the settings cache was empty before the Bash tool module was evaluated', !cachePrimedBeforeTheTool, 'something imported before BashTool (the hermetic helper or the settings cache module) primed the session settings cache; stop it reading settings at import')
check('evaluating the Bash tool module (which builds its schema) primed no settings cache', !cachePrimedByTheTool, 'importing src/tools/shell/BashTool.tsx primed the session settings cache; keep buildModelSchema and the describe functions in src/tools/shell/prompt.ts from reading settings, and move any settings read into getSimplePrompt')
process.env.MERCURY_SHELL_ENGINE = 'brush'
const brush = resolveShellEngine()
check('the timeout text is the same under the brush engine pin (it names both engines, it reads neither)', describeTimeout() === field('timeout'), field('timeout') + ' | describeTimeout in src/tools/shell/prompt.ts must not branch on the engine')
if (brush.engine === 'brush') {
  const brushPrompt = getSimplePrompt(null)
  check('under the brush engine the DESCRIPTION says the command is killed (exit 143) and the session resets', brushPrompt.includes('When `timeout` passes, the command is killed (exit 143) and the shell session resets.'), 'getSimplePrompt in src/tools/shell/prompt.ts must add that sentence when the shell origin is engine | ' + brushPrompt.slice(0, 600))
  check('…and never says it moves to the background', !brushPrompt.includes('moves to the background'), 'remove the moves-to-the-background wording from the brush branch of getSimplePrompt in src/tools/shell/prompt.ts')
} else {
  console.log(`  [INFO] the brush engine does not resolve here (${brush.reason}); the description's variant is not measured on this box`)
}
delete process.env.MERCURY_SHELL_ENGINE

try {
  rmSync(proofHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
