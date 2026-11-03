import '../lib/hermetic.ts'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'fake'
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { normalizeToolSchemaFor } = await import('../../src/utils/normalizeToolSchema.ts')
const { compileJsonSchema } = await import('../../src/services/schema/jsonSchemaEngine.ts')
const { mapToolsToOpenai } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { codeAssistSchema } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { mapToolsToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { toolContext } = await import('./computerToolKit.ts')

const actions = ['screenshot', 'click', 'doubleClick', 'rightClick', 'move', 'drag', 'scroll', 'type', 'key', 'hold', 'wait', 'cursor', 'displays', 'frontmost', 'tree', 'find', 'read', 'focusApp']
const stripDescriptions = (node: any): any => Array.isArray(node) ? node.map(stripDescriptions) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'description').map(([key, value]) => [key, stripDescriptions(value)])) : node
const options = { tools: [ComputerTool], agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext() }
for (const [lane, model] of [
  ['anthropic-strict', 'claude-fable-5-1'], ['llama-grammar', 'local/fixture-q4'],
  ['ref-default', 'compat/fixture'], ['responses', 'gpt-5.6-sol'], [null, 'gemini-4-argon'],
] as const) {
  const definition = await toolToAPISchema(ComputerTool, { ...options, model }) as any
  const schema = definition.input_schema
  const step = schema.properties.steps.items
  assert.deepEqual(step.properties.action.enum, actions, `${lane}: sequence is not a step action`)
  assert.deepEqual(schema.properties.action.enum.filter((action: string) => action !== 'sequence'), actions)
  assert.equal(schema.properties.action.enum.includes('sequence'), true)
  assert.deepEqual(Object.keys(step.properties), Object.keys(schema.properties).filter(key => key !== 'steps'))
  assert.deepEqual(step.required, ['action'])
  assert.equal(step.additionalProperties, false)
  for (const key of Object.keys(step.properties).filter(key => key !== 'action')) assert.deepEqual(stripDescriptions(step.properties[key]), stripDescriptions(schema.properties[key]), `${lane}: ${key} keeps its type and bounds`)
  assert.ok(!/"\$(ref|defs)"/.test(JSON.stringify(schema)))
  assert.equal(normalizeToolSchemaFor(lane, schema).schema, schema)
  const compiled = compileJsonSchema(schema)
  assert.ok(compiled.ok, compiled.ok ? '' : compiled.error)
  for (const action of actions) assert.deepEqual(compiled.check({ action: 'sequence', steps: [{ action }] }), [], `${lane}: ${action} remains representable`)
  assert.notEqual(compiled.check({ action: 'sequence', steps: [{ action: 'sequence' }] }).length, 0)
  assert.notEqual(compiled.check({ action: 'sequence', steps: [{ action: 'click', steps: [] }] }).length, 0)
  assert.notEqual(compiled.check({ action: 'sequence', steps: [{ action: 'click', x: 'bad' }] }).length, 0)
  assert.ok(Buffer.byteLength(JSON.stringify(schema)) <= 7700)
  assert.deepEqual((mapToolsToZai([definition])[0]!.function.parameters as any).properties.steps.items.properties.action.enum, actions)
  const responses = mapToolsToOpenai([definition])[0]!.parameters as any
  const responseSteps = responses.properties.steps
  const array = responseSteps.type === 'array' ? responseSteps : responseSteps.anyOf.find((branch: any) => branch.type === 'array')
  assert.deepEqual(array.items.properties.action.enum, actions)
  const gemini = codeAssistSchema(schema) as any
  assert.deepEqual(gemini.properties.steps.items.properties.action.enum, actions)
  console.log(`PASS ${lane ?? 'gemini'}: exact inline step fields, non-sequence actions, valid schema and codec projections`)
}
const nested = await ComputerTool.validateInput!({ action: 'sequence', steps: [{ action: 'sequence', steps: [{ action: 'screenshot' }] }] }, toolContext())
assert.equal(nested.result, false)
assert.match((nested as { message: string }).message, /no nested sequence/)
console.log('PASS runtime still refuses nesting; top-level sequence remains available')
