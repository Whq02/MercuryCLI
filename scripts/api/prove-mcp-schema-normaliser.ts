import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'schema-normaliser-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const normaliser = await import('../../src/utils/normalizeToolSchema.ts')
const { normalizeToolSchemaFor, restoreRenamedArgumentKeys, rememberRenamedArgumentKeys, schemaLaneFor, legalPropertyKey, PROPERTY_KEY_PATTERN } = normaliser

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 500 ? `${detail.slice(0, 500)}…` : detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
type Node = Record<string, unknown>
const quirky = (): Node => ({
  type: 'object',
  properties: {
    'file name': { type: 'string' },
    'count#': { type: ['integer', 'null'] },
    bag: { type: 'object' },
    mode: 'string',
    tags: { type: 'array', items: { type: 'object', properties: { 'a b': { type: 'string' } } } },
    nested: { type: 'object', properties: { 'x/y': { type: 'number' }, inner: { type: 'object', properties: { 'p q': 'string' } } } },
    withDefault: { $ref: '#/$defs/External', default: 1 },
  },
  required: ['file name', 'mode'],
})

section('A. the lanes')
{
  check('the routes map to the four lanes and nothing else', schemaLaneFor('anthropic') === 'anthropic-strict' && schemaLaneFor('local') === 'llama-grammar' && schemaLaneFor('openai-compat') === 'ref-default' && schemaLaneFor('openai') === 'responses' && schemaLaneFor('gemini') === null && schemaLaneFor(null) === null)
  const { schema: llama } = normalizeToolSchemaFor('llama-grammar', quirky())
  const props = llama.properties as Record<string, Node>
  check('llama.cpp: an object without properties gains properties: {}', JSON.stringify(props.bag) === '{"type":"object","properties":{}}', JSON.stringify(props.bag))
  check('llama.cpp: a bare-string schema becomes {type: string}, at the top and inside', JSON.stringify(props.mode) === '{"type":"string"}' && JSON.stringify(((props.nested!.properties as Record<string, Node>).inner!.properties as Record<string, Node>)['p q']) === '{"type":"string"}', JSON.stringify(props.mode))
  check('llama.cpp: a type array becomes an anyOf of single types', JSON.stringify(props['count#']) === '{"anyOf":[{"type":"integer"},{"type":"null"}]}', JSON.stringify(props['count#']))
  check('llama.cpp: property keys are left as they are', 'file name' in props && 'count#' in props)
  const { schema: anthropic, renamed } = normalizeToolSchemaFor('anthropic-strict', quirky())
  const keys = Object.keys(anthropic.properties as Node)
  check('anthropic: every property key matches ^[a-zA-Z0-9_.-]{1,64}$ at every depth', keys.every(key => PROPERTY_KEY_PATTERN.test(key)) && Object.keys(((anthropic.properties as Record<string, Node>).nested!.properties as Node)).every(key => PROPERTY_KEY_PATTERN.test(key)) && Object.keys((((anthropic.properties as Record<string, Node>).tags!.items as Node).properties as Node)).every(key => PROPERTY_KEY_PATTERN.test(key)), JSON.stringify(keys))
  check('anthropic: the rename is deterministic (space to underscore, hash to underscore) and required follows it', keys.includes('file_name') && keys.includes('count_') && JSON.stringify(anthropic.required) === '["file_name","mode"]', JSON.stringify(anthropic))
  check('anthropic: the rename tree records the top keys, the nested object and the array items', renamed !== null && renamed.keys.file_name === 'file name' && renamed.children.nested?.keys['x_y'] === 'x/y' && renamed.children.nested?.children.inner?.keys['p_q'] === 'p q' && renamed.children.tags?.children['*']?.keys['a_b'] === 'a b', JSON.stringify(renamed))
  check('anthropic: a bare-string schema is mended there too (no backend takes it), the type array is left as it is', JSON.stringify((anthropic.properties as Record<string, Node>).mode) === '{"type":"string"}' && Array.isArray(((anthropic.properties as Record<string, Node>).count_ as Node).type))
  const nullable = normalizeToolSchemaFor('anthropic-strict', { description: 'd', anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }] }).schema
  check('anthropic: a nullable top-level anyOf becomes the object branch, the description kept', JSON.stringify(nullable) === '{"description":"d","type":"object","properties":{"a":{"type":"string"}}}', JSON.stringify(nullable))
  const { schema: fireworks } = normalizeToolSchemaFor('ref-default', quirky())
  check('fireworks: a default beside a $ref is dropped, the $ref kept', JSON.stringify((fireworks.properties as Record<string, Node>).withDefault) === '{"$ref":"#/$defs/External"}', JSON.stringify((fireworks.properties as Record<string, Node>).withDefault))
  const responses = normalizeToolSchemaFor('responses', { oneOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }] }).schema
  check('responses: a top-level combinator of objects becomes one object with the union of their properties and no required', JSON.stringify(responses) === '{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"number"}}}', JSON.stringify(responses))
}

section('B. a renamed key round-trips through the arguments on the way back')
{
  const { renamed } = normalizeToolSchemaFor('anthropic-strict', quirky())
  rememberRenamedArgumentKeys('mcp__quirky__run', renamed)
  const wire = { file_name: 'a.txt', count_: 3, mode: 'fast', tags: [{ a_b: 'x' }, { a_b: 'y' }], nested: { x_y: 1, inner: { p_q: 'deep' } }, untouched: true }
  const back = restoreRenamedArgumentKeys('mcp__quirky__run', wire) as Node
  check('the top keys come back as the server spelled them', back['file name'] === 'a.txt' && back['count#'] === 3 && back.mode === 'fast' && back.untouched === true, JSON.stringify(back))
  check('the array items and the nested objects come back too', JSON.stringify(back.tags) === '[{"a b":"x"},{"a b":"y"}]' && JSON.stringify(back.nested) === '{"x/y":1,"inner":{"p q":"deep"}}', JSON.stringify(back))
  check('a tool with no rename is handed its arguments untouched (the same object)', restoreRenamedArgumentKeys('mcp__plain__run', wire) === wire)
  rememberRenamedArgumentKeys('mcp__quirky__run', null)
  check('forgetting the rename leaves the wire keys alone', (restoreRenamedArgumentKeys('mcp__quirky__run', wire) as Node).file_name === 'a.txt')
}

section('C. refusals: collisions, length, an empty name, and a schema that needs nothing is the same object')
{
  const taken = new Set<string>()
  const first = legalPropertyKey('a b', taken)
  taken.add(first)
  const second = legalPropertyKey('a#b', taken)
  taken.add(second)
  check('two illegal keys that would collide get distinct names', first === 'a_b' && second === 'a_b_2', `${first} ${second}`)
  const long = legalPropertyKey('x'.repeat(80), new Set())
  check('a 65+ character key is cut to 64', long.length === 64 && PROPERTY_KEY_PATTERN.test(long))
  const longTaken = new Set([long])
  const longSecond = legalPropertyKey('x'.repeat(80), longTaken)
  check('a cut key that collides still fits 64 with its suffix', longSecond.length === 64 && longSecond.endsWith('_2'))
  check('an empty key becomes key', legalPropertyKey('', new Set()) === 'key')
  check('a legal key is itself', legalPropertyKey('ok.name-1_', new Set()) === 'ok.name-1_')
  const clean = { type: 'object', properties: { path: { type: 'string' }, deep: { type: 'object', properties: { n: { type: 'integer' } } } }, required: ['path'] }
  for (const lane of ['anthropic-strict', 'llama-grammar', 'ref-default', 'responses'] as const) {
    const result = normalizeToolSchemaFor(lane, clean)
    check(`${lane}: a schema that needs nothing is the same object with no rename`, result.schema === clean && result.renamed === null)
  }
  const once = normalizeToolSchemaFor('anthropic-strict', quirky())
  const again = normalizeToolSchemaFor('anthropic-strict', once.schema)
  check('a normalised schema normalised again is itself (idempotent)', again.schema === once.schema && again.renamed === null)
  const q = quirky()
  check('the memo answers the same object for the same schema and lane', normalizeToolSchemaFor('llama-grammar', q).schema === normalizeToolSchemaFor('llama-grammar', q).schema)
  const bool = normalizeToolSchemaFor('llama-grammar', { type: 'object', properties: { any: true } }).schema
  check('a boolean true schema becomes the empty schema', JSON.stringify((bool.properties as Node).any) === '{}')
  const notObject = normalizeToolSchemaFor('anthropic-strict', { anyOf: [{ type: 'string' }, { type: 'null' }] })
  check('a top-level anyOf with no object branch is left alone (nothing lawful to pick)', notObject.schema.anyOf !== undefined)
}

section('D. the builder applies the lane to an explicit schema only; every built-in tool is byte-identical (the corpus parity proof runs in this suite)')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { toolToAPISchema } = await import('../../src/utils/api.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
  const permissionContext = getEmptyToolPermissionContext()
  const options = { getToolPermissionContext: async () => permissionContext, tools: [GrepTool], agents: [] }
  const mcpLike = { ...GrepTool, name: 'mcp__quirky__search', inputJSONSchema: quirky(), prompt: async () => 'a quirky search' } as typeof GrepTool
  const onAnthropic = (await toolToAPISchema(mcpLike, { ...options, tools: [mcpLike], model: 'claude-fable-5-1' })) as { input_schema: Node }
  check('on the Anthropic road the explicit schema reaches the wire with legal keys', Object.keys(onAnthropic.input_schema.properties as Node).every(key => PROPERTY_KEY_PATTERN.test(key)), JSON.stringify(onAnthropic.input_schema))
  check('and the tool is remembered for the un-rename', normaliser._renamedToolsForTesting().includes('mcp__quirky__search'))
  const onLocal = (await toolToAPISchema(mcpLike, { ...options, tools: [mcpLike], model: 'local/fixture-q4' })) as { input_schema: Node }
  check('on the local road the same schema takes the grammar shape instead', JSON.stringify(((onLocal.input_schema.properties as Record<string, Node>).bag)) === '{"type":"object","properties":{}}' && 'file name' in (onLocal.input_schema.properties as Node), JSON.stringify(onLocal.input_schema))
  const onAnthropicCached = (await toolToAPISchema(mcpLike, { ...options, tools: [mcpLike], model: 'claude-fable-5-1' })) as { input_schema: Node }
  check('building the schema for another route does not erase the Anthropic rename tree across a cached Anthropic turn', Object.keys(onAnthropicCached.input_schema.properties as Node).includes('file_name') && (restoreRenamedArgumentKeys('mcp__quirky__search', { file_name: 'a.txt' }) as Node)['file name'] === 'a.txt', JSON.stringify(restoreRenamedArgumentKeys('mcp__quirky__search', { file_name: 'a.txt' })))
  const builtin = (await toolToAPISchema(GrepTool, { ...options, model: 'claude-fable-5-1' })) as { input_schema: Node }
  const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
  check('a built-in tool is its own zod schema, byte for byte, on the strict road', JSON.stringify(builtin.input_schema) === JSON.stringify(zodToJsonSchema(GrepTool.inputSchema as never)))
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  console.log('RED: prove-mcp-schema-normaliser.ts')
  process.exit(1)
}
console.log('\nALL GREEN')
