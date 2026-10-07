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

const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { describeTimeout, describeMaxOutputChars } = await import('../../src/tools/BashTool/prompt.ts')
const { resolveShellEngine } = await import('../../src/utils/shell/engineSession.ts')
const { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } = await import('../../src/utils/timeouts.ts')
const { getMaxOutputLength, getMinOutputLength } = await import('../../src/utils/shell/outputLimits.ts')

type Field = { type?: string; description?: string; exclusiveMinimum?: number; maximum?: number }
type Schema = { $schema?: string; type?: string; properties?: Record<string, Field>; required?: string[]; additionalProperties?: boolean }
const schema = (BashTool as { inputJSONSchema: Schema }).inputJSONSchema
const props = schema.properties ?? {}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const field = (name: string): string => props[name]?.description ?? ''

section('§1 the shape: seven fields, their names and types, command required, nothing else allowed')
check('exactly the seven property names, in order', JSON.stringify(Object.keys(props)) === JSON.stringify(['command', 'timeout', 'description', 'run_in_background', 'dangerouslyDisableSandbox', 'inherit_session_env', 'max_output_chars']), JSON.stringify(Object.keys(props)))
check('required is ["command"]', JSON.stringify(schema.required) === JSON.stringify(['command']), JSON.stringify(schema.required))
check('additionalProperties is false (a strict object)', schema.additionalProperties === false, String(schema.additionalProperties))
check('the types are unchanged: string, number, string, boolean, boolean, boolean, integer', ['command', 'timeout', 'description', 'run_in_background', 'dangerouslyDisableSandbox', 'inherit_session_env', 'max_output_chars'].map(n => props[n]?.type).join(',') === 'string,number,string,boolean,boolean,boolean,integer', Object.values(props).map(f => f.type).join(','))
check('max_output_chars keeps its exclusiveMinimum 0 and its maximum', props.max_output_chars?.exclusiveMinimum === 0 && typeof props.max_output_chars?.maximum === 'number')
check('command keeps its text', field('command') === 'The command to execute', field('command'))
check('dangerouslyDisableSandbox keeps its text', field('dangerouslyDisableSandbox') === 'An explicit, dangerous override that runs the command without sandboxing.', field('dangerouslyDisableSandbox'))
check('inherit_session_env keeps its text', field('inherit_session_env') === "Set to true to hand the command the session's own MERCURY_* stamps (the values Mercury wrote on this process); by default they are scrubbed, since a proof or a build must not see them.", field('inherit_session_env'))

section('§2 the size: the compact schema is at most 1,600 bytes')
const schemaBytes = bytes(schema)
check(`the compact schema is ≤ 1,600 bytes (${schemaBytes})`, schemaBytes <= 1600, `${schemaBytes} bytes`)
console.log(`  bytes per field: ${Object.entries(props).map(([k, v]) => `${k} ${bytes({ [k]: v })}`).join(' · ')}`)

section('§3 the four texts that moved: timeout, description, run_in_background, max_output_chars')
const defaultMs = getDefaultBashTimeoutMs()
const maxMs = getMaxBashTimeoutMs()
check('timeout says what the number is and its default and max from the timeout accessors', field('timeout').startsWith(`Milliseconds the call waits (default ${defaultMs}, max ${maxMs}).`), field('timeout'))
check('timeout says the command moves to the background when it passes', field('timeout').includes('moves to the background'), field('timeout'))
check('timeout names the sleep exception', field('timeout').includes('a command whose first word is `sleep` is killed instead'), field('timeout'))
check('timeout is the exact text', field('timeout') === `Milliseconds the call waits (default ${defaultMs}, max ${maxMs}). When it passes, the command moves to the background and keeps running; a command whose first word is \`sleep\` is killed instead.`, field('timeout'))
check('description is the short guide with its example and the two forbidden words', field('description') === 'What the command does, in five to ten words of active voice, shown to the operator: for example "List files in the current directory". Do not use the words "complex" or "risk".', field('description'))
check('run_in_background does not send the model to a file-reading tool', !field('run_in_background').includes('file-reading tool'), field('run_in_background'))
check('run_in_background points at the tool description for the lifetime rule', field('run_in_background') === 'Start the command and return at once with a task id and an output file; the tool description says when its end is reported and when it is stopped.', field('run_in_background'))
check('max_output_chars states the budget, the cap, the floor and the clamp from the output limits', field('max_output_chars') === `Inline character budget: a longer output comes back as its head and tail around a notice of the cut. Default and cap ${getMaxOutputLength()}, floor ${getMinOutputLength()} (a value outside is clamped, and the result says so). Ignored by run_in_background.`, field('max_output_chars'))
check('the max_output_chars text has one owner the schema reads', field('max_output_chars') === describeMaxOutputChars())

section('§4 the brush variant of the timeout text')
process.env.MERCURY_SHELL_ENGINE = 'brush'
const brush = resolveShellEngine()
if (brush.engine === 'brush') {
  check('under the brush engine the timeout text says the command is killed and the session resets', describeTimeout() === `Milliseconds the call waits (default ${defaultMs}, max ${maxMs}). When it passes, the command is killed and the shell session resets.`, describeTimeout())
  check('…and never says it moves to the background', !describeTimeout().includes('moves to the background'))
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
