import '../lib/hermetic.ts'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { WorkflowTool } = await import('../../src/tools/WorkflowTool/WorkflowTool.tsx')
const { parseWorkflowScript, MAX_SCRIPT_BYTES } = await import('../../src/tools/WorkflowTool/compiler.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { normalizeToolSchemaFor } = await import('../../src/utils/normalizeToolSchema.ts')
const { compileJsonSchema } = await import('../../src/services/schema/jsonSchemaEngine.ts')
const { mapToolsToOpenai } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { codeAssistSchema } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { mapToolsToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const keys = ['script', 'name', 'args', 'scriptPath', 'resumeFromRunId']
const script = "export const meta = { name: 'schema-proof', title: 'Schema proof', description: 'Check inputs', phases: [{title: 'Check'}] }; return args"
const input = { script, args: { nested: ['a', 3, true, null] } }
const options = { tools: [WorkflowTool], agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext() }
for (const [lane, model] of [
  ['anthropic-strict', 'claude-fable-5-1'], ['llama-grammar', 'local/fixture-q4'],
  ['ref-default', 'compat/fixture'], ['responses', 'gpt-5.6-sol'], [null, 'gemini-4-argon'],
] as const) {
  const definition = await toolToAPISchema(WorkflowTool, { ...options, model }) as any
  const schema = definition.input_schema
  assert.deepEqual(Object.keys(schema.properties), keys, `${lane}: only the five live inputs remain`)
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required ?? [], [])
  assert.equal(schema.properties.script.type, 'string')
  assert.equal(schema.properties.script.maxLength, MAX_SCRIPT_BYTES)
  assert.equal(schema.properties.name.type, 'string')
  assert.equal(schema.properties.scriptPath.type, 'string')
  assert.equal(schema.properties.resumeFromRunId.pattern, '^wf_[a-z0-9-]{6,}$')
  assert.equal(schema.properties.args.type, undefined, 'args still accepts arbitrary JSON values')
  assert.equal(normalizeToolSchemaFor(lane, schema).schema, schema)
  const compiled = compileJsonSchema(schema)
  assert.ok(compiled.ok, compiled.ok ? '' : compiled.error)
  for (const accepted of [input, { name: 'saved' }, { scriptPath: 'saved.js', resumeFromRunId: 'wf_abc123' }]) assert.deepEqual(compiled.check(accepted), [])
  for (const [key, value] of Object.entries({ description: 'ignored', title: 'ignored', run_in_background: false })) assert.notEqual(compiled.check({ ...input, [key]: value }).length, 0, `${key} is no longer advertised`)
  for (const projected of [mapToolsToOpenai([definition])[0]!.parameters, mapToolsToZai([definition])[0]!.function.parameters, codeAssistSchema(schema)] as any[]) assert.deepEqual(Object.keys(projected.properties), keys)
  console.log(`PASS ${lane ?? 'gemini'}: five-field closed schema, unchanged JSON args/source/resume shapes and codec projections`)
}
assert.deepEqual(WorkflowTool.inputSchema.parse(input).args, input.args)
assert.equal(WorkflowTool.inputSchema.safeParse({}).success, false, 'runtime still requires a source')
for (const value of [{ description: 'ignored' }, { title: 'ignored' }, { run_in_background: true }]) assert.equal(WorkflowTool.inputSchema.safeParse({ ...input, ...value }).success, false)
const parsed = parseWorkflowScript(script)
assert.ok('meta' in parsed)
assert.equal(parsed.meta.title, 'Schema proof')
assert.equal(parsed.meta.description, 'Check inputs')
assert.equal(parsed.meta.name, 'schema-proof')
assert.ok(WorkflowTool.wireDescription().includes('Returns a task ID immediately and notifies on completion.'))
console.log('PASS runtime rejects the retired inputs; script meta still owns names and descriptions; background launch contract remains')
