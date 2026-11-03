import '../lib/hermetic.ts'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { normalizeToolSchemaFor } = await import('../../src/utils/normalizeToolSchema.ts')
const { compileJsonSchema } = await import('../../src/services/schema/jsonSchemaEngine.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { mapToolsToOpenai } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { codeAssistSchema } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { mapToolsToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const ctl = await import('../../src/services/interview/controller.ts')
const store = await import('../../src/services/interview/store.ts')
const input = { questions: [{ id: 'iq_color', decisionId: 'id_color', question: 'Which color?', header: 'Color', options: [{ id: 'io_blue', label: 'Blue', description: 'Blue option', preview: 'Blue preview' }, { id: 'io_green', label: 'Green', description: 'Green option' }] }] }
const runtime = zodToJsonSchema(AskUserQuestionTool.inputSchema) as any
const options = { tools: [AskUserQuestionTool], agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext() }
for (const [lane, model] of [
  ['anthropic-strict', 'claude-fable-5-1'], ['llama-grammar', 'local/fixture-q4'],
  ['ref-default', 'compat/fixture'], ['responses', 'gpt-5.6-sol'], [null, 'gemini-4-argon'],
] as const) {
  const definition = await toolToAPISchema(AskUserQuestionTool, { ...options, model }) as any
  const schema = definition.input_schema
  assert.deepEqual(Object.keys(schema.properties), ['questions'], `${lane}: only questions are model inputs`)
  assert.deepEqual(schema.required, ['questions'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.questions, runtime.properties.questions, 'question fields, defaults and bounds stay exact')
  assert.equal(normalizeToolSchemaFor(lane, schema).schema, schema)
  const compiled = compileJsonSchema(schema)
  assert.ok(compiled.ok, compiled.ok ? '' : compiled.error)
  assert.deepEqual(compiled.check(input), [])
  for (const [name, value] of Object.entries({ answers: {}, annotations: {}, outcome: { kind: 'cancelled' }, metadata: { source: 'host' } })) assert.notEqual(compiled.check({ ...input, [name]: value }).length, 0, `${name} is not a model argument`)
  assert.notEqual(compiled.check({ questions: [] }).length, 0)
  assert.notEqual(compiled.check({ questions: Array(5).fill(input.questions[0]) }).length, 0)
  for (const projected of [mapToolsToOpenai([definition])[0]!.parameters, mapToolsToZai([definition])[0]!.function.parameters, codeAssistSchema(schema)] as any[]) assert.deepEqual(Object.keys(projected.properties), ['questions'])
  console.log(`PASS ${lane ?? 'gemini'}: questions-only model schema and codec projections`)
}
assert.equal(AskUserQuestionTool.inputSchema.safeParse({ questions: [input.questions[0], input.questions[0]] }).success, false, 'runtime uniqueness checks remain')
store._resetInterviewForProofs()
try {
  ctl.presentToolCall({ input: input as never, toolUseId: 'question-schema-proof' })
  ctl.commitAnswer('iq_color', { optionIds: ['io_blue'] })
  ctl.setNote('iq_color', 'operator note')
  for (const outcome of [{ kind: 'answers-submitted', decisionRecordId: 'ir_proof' }, { kind: 'discussion-requested', questionId: 'iq_color' }, { kind: 'cancelled', preserveDraft: true }]) {
    const updated = ctl.buildUpdatedInput(store.interviewSnapshot(), { ...input, metadata: { source: 'host' } }, outcome)
    const parsed = AskUserQuestionTool.inputSchema.parse(updated)
    assert.equal(parsed.metadata?.source, 'host', 'host metadata is preserved at the runtime boundary')
    const result = await AskUserQuestionTool.call(parsed)
    assert.equal(result.data.answers.iq_color, 'Blue')
    assert.deepEqual(result.data.annotations?.iq_color, { preview: 'Blue preview', notes: 'operator note' })
    assert.equal(result.data.outcome?.kind, outcome.kind)
    const text = String(AskUserQuestionTool.mapToolResultToToolResultBlockParam(result.data, 'proof').content)
    assert.ok(text.includes(outcome.kind === 'discussion-requested' ? 'DISCUSS' : outcome.kind === 'cancelled' ? 'cancelled' : 'Blue'))
  }
  console.log('PASS controller-supplied answers, notes, previews and all outcomes still reach the tool; metadata survives runtime parsing')
} finally { store._resetInterviewForProofs() }
