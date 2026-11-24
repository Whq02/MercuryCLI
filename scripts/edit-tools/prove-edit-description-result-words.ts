#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-description-words-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_PROJECT_INTEL = '0'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.NODE_ENV

const { getEditToolDescription } = await import('../../src/tools/edit/prompt.ts')
const { EditTool } = await import('../../src/tools/edit/EditTool.ts')
const { zodToJsonSchema } = await import('../../src/platform/primitives/zodToJsonSchema.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 600 ? `${detail.slice(0, 600)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const TEXT = 'Edits one text file in place: an exact string swapped for another, line-addressed hunks against a read snapshot, text appended, or a Markdown section replaced or appended to. Edits need current read coverage of the lines they touch; append needs none. A landed edit returns the changed lines with context, which count as read, and names any new syntax error.'

section('W1. one text: the shapes, the coverage fact, what a landed edit returns')
const description = getEditToolDescription(null)
check('W1 the description is the one text, byte for byte, whatever is offered', description === TEXT && getEditToolDescription(new Set(['Edit', 'AstEdit', 'LspRename'])) === TEXT, `make getEditToolDescription in src/tools/edit/prompt.ts return exactly TEXT for every offered set; got: ${description}`)
check('W1b no manual rides behind it', (EditTool as { wireDescription?: unknown }).wireDescription === undefined, 'remove wireDescription from FileEditTool in src/tools/edit/EditTool.ts')
for (const gone of ['Usage:', 'Semantic shortcut', 'AstEdit', 'LspRename', 'line-number prefix', 'Preserve indentation', 'do not reread', 'makes the edit fail outright', 'the refusal\'s first sentence', 'Full usage notes']) {
  check(`W1c gone: "${gone}" (a rule, another tool, a repeat or a pre-empted refusal)`, !description.includes(gone), `delete this phrase from getEditToolDescription in src/tools/edit/prompt.ts`)
}
check('W1d the coverage sentence is the fact, not a Read-only prerequisite', description.includes('Edits need current read coverage of the lines they touch; append needs none.') && !description.includes('only after `Read`'), `restore the coverage sentence in getEditToolDescription (src/tools/edit/prompt.ts) and drop any only-after-Read wording; got: ${description}`)

section('W2. the size')
check('W2 the description is under 400 bytes (1,801 + a 1,907-byte manual before)', Buffer.byteLength(description) <= 400, `shorten getEditToolDescription in src/tools/edit/prompt.ts; it is ${Buffer.byteLength(description)} bytes`)

section('W3. the input schema: shapes unchanged, prose carries each fact alone, byte-identical to the stored copy')
const schema = JSON.stringify(zodToJsonSchema((EditTool as { inputSchema: never }).inputSchema))
const stored = readFileSync(join(import.meta.dirname, 'fixtures', 'edit-input-schema-28.json'), 'utf8').replace(/\n$/, '')
check('W3 the JSON Schema of inputSchema() equals fixtures/edit-input-schema-28.json byte for byte', schema === stored, `inputSchema in src/tools/edit/schema.ts differs from scripts/edit-tools/fixtures/edit-input-schema-28.json: restore the schema or, if the change is intended, update the fixture; ${schema.length} vs ${stored.length} bytes`)
check('W3b it is under 1,950 bytes (2,595 before; every field and bound kept)', Buffer.byteLength(schema) <= 1950, `shorten field descriptions in inputSchema (src/tools/edit/schema.ts); the schema is ${Buffer.byteLength(schema)} bytes`)
const parsed = JSON.parse(schema) as { description?: string; properties: Record<string, { description?: string }> }
check('W3c the root description indexes the four shapes', parsed.description === 'One of four shapes: old_string + new_string · hunks · append · section + new_string or append', `set the root description of inputSchema in src/tools/edit/schema.ts to the four-shapes index; got: ${parsed.description ?? ''}`)
check('W3d old_string says unique unless replace_all; new_string says "" deletes; hunks.lines carries no drift recipe', (parsed.properties.old_string?.description ?? '').includes('unique in the file unless replace_all') && (parsed.properties.new_string?.description ?? '').includes('"" deletes') && !JSON.stringify(parsed).includes('never retype content'), 'fix the old_string, new_string and hunks.lines descriptions in inputSchema (src/tools/edit/schema.ts)')

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
