#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-schema-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_LINE_ANCHORS

const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { compileJsonSchema } = await import('../../src/services/schema/jsonSchemaEngine.ts')
const { mapToolsToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { mapToolsToOpenai } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { buildGeminiRequest } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Branch = { description?: string; type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown }
type Wire = { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown; anyOf?: Branch[] }

const wire = zodToJsonSchema(FileEditTool.inputSchema as never) as Wire
const branches = wire.anyOf ?? []
const rootRequired = wire.required ?? []
const rootKeys = Object.keys(wire.properties ?? {})
const plain = branches.find(b => (b.required ?? []).includes('old_string'))
const hunks = branches.find(b => (b.required ?? []).includes('hunks'))
const append = branches.find(b => (b.required ?? []).includes('append'))
const sectionShape = branches.find(b => (b.required ?? []).includes('section'))

section('§1 the wire schema is one object root with four shapes')
check('the root stays an object with every field listed (the form every road takes)', wire.type === 'object' && rootKeys.length === 8 && wire.additionalProperties === false, JSON.stringify(rootKeys))
check('the root requires file_path and nothing else: replace_all no longer reads as required', JSON.stringify(rootRequired) === JSON.stringify(['file_path']), JSON.stringify(rootRequired))
check('four shapes ride under anyOf: old_string+new_string · hunks · append · section', branches.length === 4 && plain !== undefined && hunks !== undefined && append !== undefined && sectionShape !== undefined, `${branches.length} branches: ${branches.map(b => JSON.stringify(b.required ?? [])).join(' ')}`)
check('the plain shape requires old_string AND new_string', (plain?.required ?? []).includes('old_string') && (plain?.required ?? []).includes('new_string') && (plain?.required ?? []).includes('file_path'), JSON.stringify(plain?.required ?? []))
check('every shape is a closed object naming its own fields, each a field of the root', branches.every(b => b.type === 'object' && b.additionalProperties === false && (b.required ?? []).includes('file_path') && Object.keys(b.properties ?? {}).every(k => rootKeys.includes(k)) && (b.required ?? []).every(k => Object.keys(b.properties ?? {}).includes(k))), branches.map(b => Object.keys(b.properties ?? {}).join('+')).join(' | '))
check('each shape carries a sentence a model reads', branches.every(b => typeof b.description === 'string' && b.description.length > 0))
check('the old_string and new_string field words say they travel together', String((wire.properties?.old_string as { description?: string })?.description ?? '').includes('new_string') && String((wire.properties?.new_string as { description?: string })?.description ?? '').includes('old_string'))

section('§2 under the one JSON-schema engine the four shapes validate and the Kimi-K3 shape is refused')
const compiled = compileJsonSchema(wire)
check('the wire schema compiles under the one engine', compiled.ok, compiled.ok ? '' : compiled.error)
const valid = (value: unknown): boolean => compiled.ok && compiled.check(value).length === 0
const issuesOf = (value: unknown): string => (compiled.ok ? compiled.check(value).map(i => `${i.path} ${i.message}`).join('; ') : 'uncompiled')
const file_path = '/tmp/edit-schema-shapes.txt'
const accepted: Array<[string, Record<string, unknown>]> = [
  ['plain: old_string + new_string', { file_path, old_string: 'a', new_string: 'b' }],
  ['plain with replace_all and expected_anchor', { file_path, old_string: 'a', new_string: 'b', replace_all: true, expected_anchor: 'fa:0123456789ab' }],
  ['plain deletion: new_string ""', { file_path, old_string: 'a', new_string: '' }],
  ['hunks with expected_anchor', { file_path, hunks: [{ lines: '3', replace: 'x' }, { lines: '5-6', replace: '', insert: 'after' }], expected_anchor: 'fa:0123456789ab' }],
  ['hunks anchor-qualified without expected_anchor', { file_path, hunks: [{ lines: '3#ab3f', replace: 'x' }] }],
  ['append', { file_path, append: 'tail' }],
  ['append inside a section', { file_path, append: 'tail', section: '## Checks' }],
  ['section replaced by new_string', { file_path, section: '## Checks', new_string: '## Checks\nnew' }],
  ['section replaced with expected_anchor', { file_path, section: '## Checks', new_string: '## Checks\nnew', expected_anchor: 'fa:0123456789ab' }],
]
for (const [label, value] of accepted) check(`accepted — ${label}`, valid(value), issuesOf(value))
const refused: Array<[string, Record<string, unknown>]> = [
  ['the Kimi-K3 shape: old_string without new_string', { file_path, old_string: 'a' }],
  ['the Kimi-K3 shape with replace_all', { file_path, old_string: 'a', replace_all: false }],
  ['new_string without old_string', { file_path, new_string: 'b' }],
  ['file_path alone', { file_path }],
  ['replace_all alone', { file_path, replace_all: true }],
  ['old_string + new_string beside hunks', { file_path, old_string: 'a', new_string: 'b', hunks: [{ lines: '3', replace: 'x' }] }],
  ['hunks beside replace_all', { file_path, hunks: [{ lines: '3', replace: 'x' }], replace_all: true }],
  ['section alone', { file_path, section: '## Checks' }],
  ['section with both new_string and append', { file_path, section: '## Checks', new_string: 'n', append: 'a' }],
  ['append beside old_string', { file_path, append: 'tail', old_string: 'a' }],
  ['a hunk without its replace', { file_path, hunks: [{ lines: '3' }], expected_anchor: 'fa:0123456789ab' }],
]
for (const [label, value] of refused) check(`refused — ${label}`, !valid(value))

section('§3 the runtime agrees with the schema')
const parse = (value: unknown): boolean => (FileEditTool.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse(value).success
check('the zod schema the executor re-parses accepts each of the nine accepted shapes', accepted.every(([, value]) => parse(value)))
const context = {
  readFileState: new Map<string, unknown>(),
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
} as never
const k3 = await FileEditTool.validateInput({ file_path, old_string: 'a' } as never, context)
check('validateInput refuses the Kimi-K3 shape with the existing words', k3.result === false && k3.message === 'old_string and new_string are required unless hunks, append or section are provided.', JSON.stringify(k3))
const bare = await FileEditTool.validateInput({ file_path } as never, context)
check('validateInput refuses file_path alone with the same words', bare.result === false && bare.message === 'old_string and new_string are required unless hunks, append or section are provided.', JSON.stringify(bare))
const lone = await FileEditTool.validateInput({ file_path, section: '## Checks' } as never, context)
check('validateInput refuses section alone with the existing section words', lone.result === false && (lone.message ?? '').startsWith('section takes exactly one of new_string'), JSON.stringify(lone))
const both = await FileEditTool.validateInput({ file_path, old_string: 'a', new_string: 'b', hunks: [{ lines: '3', replace: 'x' }], expected_anchor: 'fa:0123456789ab' } as never, context)
check('validateInput refuses old_string beside hunks with the existing exclusivity words', both.result === false && (both.message ?? '').startsWith('hunks and old_string/new_string/replace_all are mutually exclusive'), JSON.stringify(both))

section('§4 every road sends the same four-shape schema')
const shaped = [{ name: 'Edit', description: 'd', input_schema: wire }]
const chat = mapToolsToZai(shaped)[0] as { function: { parameters: unknown } }
check('the chat-completions family (Z.AI, Moonshot, DeepSeek, OpenRouter, Hugging Face, local servers) carries the root with its anyOf as the function parameters', JSON.stringify(chat.function.parameters) === JSON.stringify(wire))
const responses = mapToolsToOpenai(shaped)[0] as { parameters: unknown }
check('the OpenAI Responses road carries the same parameters, flat, no strict flag', JSON.stringify(responses.parameters) === JSON.stringify(wire) && !('strict' in responses))
const gemini = buildGeminiRequest({ model: 'gemini-2.5-pro', messages: [], tools: mapToolsToZai(shaped) as never } as never, []) as { tools?: Array<{ functionDeclarations: Array<{ parametersJsonSchema: unknown }> }> }
check('the Gemini road carries the same schema as parametersJsonSchema', JSON.stringify(gemini.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema) === JSON.stringify(wire))
const again = zodToJsonSchema(FileEditTool.inputSchema as never)
check('the conversion is one object per schema identity (the request-hot path memo)', again === wire)

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-edit-schema-shapes — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
