#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-binding-home-')))
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

await import('../../src/tools.js')
const { SyntheticOutputTool, createSyntheticOutputTool, isSyntheticOutputToolEnabled, SYNTHETIC_OUTPUT_TOOL_NAME } = await import('../../src/tools/SyntheticOutputTool/SyntheticOutputTool.js')
type Bound = { tool: { call: (input: unknown, context: unknown) => Promise<{ data: string; structured_output: unknown }>; inputJSONSchema?: unknown; name: string } } | { error: string }
type Row = { props?: { color?: string; children?: unknown } }

section('§1 THE BASE TOOL — the gate, the header, the rows, the echo')
check('the tool is enabled only for a non-interactive session', isSyntheticOutputToolEnabled({ isNonInteractiveSession: true }) && !isSyntheticOutputToolEnabled({ isNonInteractiveSession: false }))
check('the name is the constant', SyntheticOutputTool.name === SYNTHETIC_OUTPUT_TOOL_NAME)
check('no input, no header', SyntheticOutputTool.renderToolUseMessage!(undefined as never, {} as never) === '' && SyntheticOutputTool.renderToolUseMessage!({} as never, {} as never) === '')
check('up to three pairs read key: json', SyntheticOutputTool.renderToolUseMessage!({ a: 1, b: 'two', c: [3] } as never, {} as never) === 'a: 1, b: "two", c: [3]')
check('above three the header counts and names the first three', SyntheticOutputTool.renderToolUseMessage!({ a: 1, b: 2, c: 3, d: 4, e: 5 } as never, {} as never) === '5 fields: a, b, c…')
const call = await SyntheticOutputTool.call({ answer: 'yes' } as never, {} as never)
check('the base call echoes the input as structured output with the success words', j(call) === j({ data: 'Structured output provided successfully', structured_output: { answer: 'yes' } }), j(call))
const block = SyntheticOutputTool.mapToolResultToToolResultBlockParam!('the words' as never, 'toolu_s') as { content: string; type: string }
check('the tool_result carries the output text', block.type === 'tool_result' && block.content === 'the words')
const rejected = SyntheticOutputTool.renderToolUseRejectedMessage!({} as never, {} as never) as Row
const failed = SyntheticOutputTool.renderToolUseErrorMessage!('x' as never, {} as never) as Row
const result = SyntheticOutputTool.renderToolResultMessage!('done' as never, {} as never) as Row
check('the rejected, failed and result rows', React.isValidElement(rejected) && rejected.props?.children === 'Structured output rejected' && failed.props?.children === 'Structured output failed' && failed.props?.color === 'error' && result.props?.children === 'done')
check('no progress row', SyntheticOutputTool.renderToolUseProgressMessage!([] as never, {} as never) === null)
const permission = await SyntheticOutputTool.checkPermissions!({ k: 1 } as never, {} as never)
check('permission is always allow with the input as given', permission.behavior === 'allow' && j((permission as { updatedInput?: unknown }).updatedInput) === j({ k: 1 }))

section('§2 THE BOUND FACTORY — memoised by the schema object, judging the input against it')
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
const first = createSyntheticOutputTool(schema) as Bound
const again = createSyntheticOutputTool(schema) as Bound
check('a binding is answered once per schema object (identity memo)', first === again && 'tool' in first)
const copy = createSyntheticOutputTool({ ...schema }) as Bound
check('an equal but distinct schema object binds afresh', copy !== first && 'tool' in copy)
if ('tool' in first) {
  check('the bound tool keeps the base name and carries the schema as its declared input', first.tool.name === SYNTHETIC_OUTPUT_TOOL_NAME && first.tool.inputJSONSchema === schema)
  const ok = await first.tool.call({ answer: 'yes' }, {})
  check('a conforming input is delivered as structured output', j(ok) === j({ data: 'Structured output provided successfully', structured_output: { answer: 'yes' } }), j(ok))
  const refused = await first.tool.call({ answer: 7 }, {}).then(() => null, (error: Error) => error)
  check('a non-conforming input throws the mismatch sentence', refused instanceof Error && refused.message.startsWith('Output does not match the required schema: '), String(refused?.message))
  const extra = await first.tool.call({ answer: 'yes', more: 1 }, {}).then(() => null, (error: Error) => error)
  check('an extra property is a mismatch too', extra instanceof Error, String(extra))
}
const brokenSchema = { type: 'object', properties: { a: { type: 'not-a-type' } } }
const broken = createSyntheticOutputTool(brokenSchema) as Bound
check('a schema that does not compile answers an error', 'error' in broken && broken.error.length > 0, j(broken))
check('the failure is memoised as well', createSyntheticOutputTool(brokenSchema) === broken)

console.log(failures === 0 ? '\nPASS synthetic output binding' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
