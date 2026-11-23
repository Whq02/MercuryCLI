import '../lib/hermetic.ts'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { ApolloReviewTool } = await import('../../src/tools/apollo-review/ApolloReviewTool.tsx')
const { toolToAPISchema } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { normalizeToolSchemaFor } = await import('../../src/integrations/mcp/normalizeToolSchema.ts')
const { compileJsonSchema } = await import('../../src/platform/json-schema/jsonSchemaEngine.ts')
const { zodToJsonSchema } = await import('../../src/platform/primitives/zodToJsonSchema.ts')
const { mapToolsToOpenai } = await import('../../src/models/roads/openai/responsesBridge.ts')
const { codeAssistSchema } = await import('../../src/models/roads/gemini/geminiCodec.ts')
const { mapToolsToZai } = await import('../../src/models/roads/zai/zaiCodec.ts')

const AUTHORED = ['summary', 'blockers', 'specFiles', 'runNote']
const input = { summary: 'The spec is complete: a CLI that lists invoices by page.', blockers: [], specFiles: ['/tmp/spec/SPEC.md'], runNote: 'bun run start in the spec folder' }
const runtime = zodToJsonSchema(ApolloReviewTool.inputSchema) as any
const options = { tools: [ApolloReviewTool], agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext() }
for (const [lane, model] of [
  ['anthropic-strict', 'claude-fable-5-1'], ['llama-grammar', 'local/fixture-q4'],
  ['ref-default', 'compat/fixture'], ['responses', 'gpt-5.6-sol'], [null, 'gemini-4-argon'],
] as const) {
  const definition = await toolToAPISchema(ApolloReviewTool, { ...options, model }) as any
  const schema = definition.input_schema
  assert.deepEqual(Object.keys(schema.properties), AUTHORED, `${lane}: only the authored fields are model inputs. Fix: modelInputSchema in src/tools/apollo-review/ApolloReviewTool.tsx must list exactly summary, blockers, specFiles, runNote`)
  assert.deepEqual(schema.required, ['summary'], 'only summary is required. Fix: modelInputSchema in src/tools/apollo-review/ApolloReviewTool.tsx')
  assert.equal(schema.additionalProperties, false, 'the model schema must be closed. Fix: modelInputSchema in src/tools/apollo-review/ApolloReviewTool.tsx must stay a z.strictObject')
  for (const name of AUTHORED) assert.deepEqual(schema.properties[name], runtime.properties[name], `${name}: fields, defaults and bounds stay exact. Fix: modelInputSchema in src/tools/apollo-review/ApolloReviewTool.tsx must reuse the field from inputSchema unchanged`)
  assert.equal(normalizeToolSchemaFor(lane, schema).schema, schema, `${lane}: normalizeToolSchemaFor must hand back this schema unchanged. Fix: src/integrations/mcp/normalizeToolSchema.ts or the schema shape in src/tools/apollo-review/ApolloReviewTool.tsx`)
  const compiled = compileJsonSchema(schema)
  assert.ok(compiled.ok, compiled.ok ? '' : `${compiled.error}. Fix: the model schema must compile in compileJsonSchema (src/platform/json-schema/jsonSchemaEngine.ts); check modelInputSchema in src/tools/apollo-review/ApolloReviewTool.tsx`)
  assert.deepEqual(compiled.check(input), [], 'the authored input must satisfy the model schema. Fix: modelInputSchema in src/tools/apollo-review/ApolloReviewTool.tsx')
  for (const [name, value] of Object.entries({ decision: 'build', refineNote: 'the save system' })) assert.notEqual(compiled.check({ ...input, [name]: value }).length, 0, `${name} is not a model input. Fix: remove it from modelInputSchema in src/tools/apollo-review/ApolloReviewTool.tsx`)
  assert.notEqual(compiled.check({ blockers: [] }).length, 0, 'summary stays required. Fix: modelInputSchema in src/tools/apollo-review/ApolloReviewTool.tsx')
  for (const projected of [mapToolsToOpenai([definition])[0]!.parameters, mapToolsToZai([definition])[0]!.function.parameters, codeAssistSchema(schema)] as any[]) assert.deepEqual(Object.keys(projected.properties), AUTHORED, `${lane}: the codec projection carries the authored fields only. Fix: the tool mapper in src/models/roads/openai/responsesBridge.ts, zai/zaiCodec.ts or gemini/geminiCodec.ts is adding or dropping a field`)
  console.log(`PASS ${lane ?? 'gemini'}: authored-fields-only model schema and codec projections`)
}
const parsed = ApolloReviewTool.inputSchema.parse({ ...input, decision: 'more-questions', refineNote: 'the save system' })
assert.equal(parsed.decision, 'more-questions', 'the card-written decision is preserved at the runtime boundary. Fix: inputSchema in src/tools/apollo-review/ApolloReviewTool.tsx must keep the decision field')
assert.equal(parsed.refineNote, 'the save system', 'the card-written note is preserved at the runtime boundary. Fix: inputSchema in src/tools/apollo-review/ApolloReviewTool.tsx must keep the refineNote field')
console.log('PASS the consent card still writes decision and refineNote through the runtime schema')
