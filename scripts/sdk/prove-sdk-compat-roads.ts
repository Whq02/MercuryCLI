import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, connect, defineAgent, structuredSchema, isMainThread, rowOf } from '../../sdk/src/index.ts'
import { startFixtureServer } from '../../sdk/src/testing.ts'
import { compatRoadFixture, mercury, anthropicModel, pythonProof, root } from './compatRoadFixture.ts'
import { handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
const turns: ScriptedTurn[] = []
for (const language of ['TS', 'Python']) {
  turns.push(
    { kind: 'tool_use', name: 'Bash', input: { command: 'printf SDK-TOOL' }, thinking: 'fixture reasoning', model: anthropicModel },
    { kind: 'text', text: 'TOOL-DONE', model: anthropicModel },
    { kind: 'tool_use', name: 'StructuredOutput', input: { answer: 'typed answer' }, model: anthropicModel },
    { kind: 'text', text: 'Structured result delivered.', model: anthropicModel },
    { kind: 'tool_use', name: 'StructuredOutput', input: { answer: 'runner answer' }, model: anthropicModel },
    { kind: 'text', text: 'Runner result delivered.', model: anthropicModel },
    { kind: 'tool_use', name: 'Crewmate', input: { description: `${language} declared model`, prompt: `${language}-CHILD-ONLY`, crewmate_type: 'sdk-compat-child' }, model: anthropicModel },
    { kind: 'text', text: 'CHILD-DONE', model: anthropicModel },
  )
}
turns.push(
  { kind: 'tool_use', name: 'Write', input: { file_path: 'refused-sdk.txt', content: 'must not write' }, model: anthropicModel },
  { kind: 'text', text: 'The write was denied.', model: anthropicModel },
  { kind: 'error', status: 401, errorType: 'authentication_error', message: 'fixture refused' },
  { kind: 'text', text: 'CLOSE-ANSWER', model: anthropicModel },
  handoffTurn('The SDK fixture session ended.'),
)
const c = await compatRoadFixture(turns)
const guard = setTimeout(() => { console.error('FAIL SDK compat roads timed out'); process.exit(1) }, 240_000)
const options = { mercury, cwd: c.cwd, env: c.env, mode: 'sovereign' as const, ephemeral: true, partial: true }
try {
  for (const model of [anthropicModel, c.model]) {
    if (model === c.model) c.script({ call: { name: 'Bash', input: { command: 'printf SDK-TOOL' } } }, { text: 'TOOL-DONE' })
    const task = run({ ...options, model, input: 'rows' })
    await task.sendPrompt('TS tool turn'); task.closeInput()
    const outcome = await task.outcome
    assert.equal(outcome.status, 'completed'); assert.equal(outcome.answer, 'TOOL-DONE'); assert.equal((await task.exit).code, 0)
    assert.equal((await task.session).model, model)
    assert(task.rows.every(row => rowOf(row).ok))
    for (const type of ['reasoning', 'reasoning_delta', 'tool_call', 'tool_result', 'step', 'outcome']) assert(task.rows.some(row => row.type === type), `${model}: ${type}`)
    assert(task.rows.some(row => row.type === 'tool_result' && row.output.includes('SDK-TOOL')))
    const steps = task.rows.filter(row => row.type === 'step' && isMainThread(row))
    assert.equal(steps.length, 2)
    assert(steps.every(row => row.type === 'step' && row.model === model))
    assert.equal(outcome.usage.input_tokens, steps.reduce((sum, row) => sum + (row.type === 'step' ? row.usage.input_tokens : 0), 0))
    assert.equal(outcome.models[model]?.output_tokens, outcome.usage.output_tokens)
    const replay = await startFixtureServer({ rows: task.rows as unknown as Record<string, unknown>[] })
    try { assert.deepEqual(await run({ mercury: replay.mercury, prompt: 'recorded rows' }).outcome, outcome) }
    finally { await replay.close() }
    console.log(`PASS TS ${model}: tool, partial rows, exact model, usage, exit and row replay`)

    if (model === c.model) c.script({ call: { name: 'StructuredOutput', input: { answer: 'typed answer' } } })
    const structured = run({ ...options, model, prompt: 'TS structured turn', schema: structuredSchema(schema, value => (value as { answer: string }).answer.toUpperCase()) })
    assert.equal((await structured.outcome).structured, 'TYPED ANSWER')
    assert.equal((await structured.exit).code, 0)
    if (model === c.model) c.script({ call: { name: 'StructuredOutput', input: { answer: 'runner answer' } } })
    const session = await connect({ ...options, model })
    try {
      const result = await session.prompt('TS per-turn schema', { schema: structuredSchema(schema, value => (value as { answer: string }).answer.toUpperCase()) })
      assert.equal(result.structured, 'RUNNER ANSWER')
    } finally { await session.close() }
    console.log(`PASS TS ${model}: run and runner structured output decoded`)
  }

  const before = c.requests.length
  const agent = defineAgent({ description: 'Compat SDK child', prompt: 'TS-CHILD-ONLY', model: c.model, tools: ['Read'] })
  const task = run({ ...options, model: anthropicModel, prompt: 'Launch the TS child', agentDefs: { 'sdk-compat-child': agent } })
  assert.equal((await task.outcome).status, 'completed')
  assert(task.rows.some(row => row.type === 'tool_result' && row.output.includes('LLMHOST-READY')), JSON.stringify(task.rows.filter(row => row.type === 'tool_result')))
  assert(c.requests.slice(before).some(request => JSON.stringify(request.body.messages).includes('TS-CHILD-ONLY')))
  assert(task.rows.some(row => row.type === 'step' && row.parent_call_id !== undefined && row.model === c.model))
  console.log('PASS TS inline AgentDefinition.model dispatches a compat child from an Anthropic parent')

  c.script(
    { call: { name: 'Bash', input: { command: 'printf SDK-TOOL' } } }, { text: 'TOOL-DONE' },
    { call: { name: 'StructuredOutput', input: { answer: 'typed answer' } } }, { text: 'Structured result delivered.' },
    { call: { name: 'StructuredOutput', input: { answer: 'runner answer' } } }, { text: 'Runner result delivered.' },
  )
  await pythonProof('python-compat-roads.py', c)
  for (const model of [anthropicModel, c.model]) {
    if (model === c.model) c.script({ call: { name: 'Write', input: { file_path: 'refused-sdk.txt', content: 'must not write' } } }, { text: 'The write was denied.' })
    const denied = run({ ...options, mode: 'dontAsk', model, prompt: 'write refused-sdk.txt' })
    const denial = await denied.outcome
    assert.equal(denial.status, 'blocked')
    assert(denial.denials.some(row => row.tool === 'Write'))
    assert.equal((await denied.exit).code, 1)
    assert.equal(existsSync(join(c.cwd, 'refused-sdk.txt')), false)
    assert(denied.rows.some(row => row.type === 'tool_result' && row.status === 'error'))
    if (model === c.model) c.state.mode = 'refuse'
    const failed = run({ ...options, model, prompt: 'authentication failure' })
    assert.equal((await failed.outcome).status, 'failed')
    assert.equal((await failed.exit).code, 1)
    c.state.mode = 'reply'
    const closed = run({ ...options, ephemeral: false, model, prompt: 'close with usage' })
    const outcome = await closed.outcome
    assert.equal(outcome.status, 'completed'); assert.equal((await closed.exit).code, 0)
    const usages = closed.rows.filter(row => row.type === 'step' && isMainThread(row)).map(row => 'usage' in row ? row.usage : undefined)
    assert(!closed.rows.some(row => row.type === 'close'))
    assert.equal(closed.rows.at(-1)?.type, 'outcome')
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const) assert.equal(outcome.usage[key], usages.reduce((sum, usage) => sum + (usage?.[key] ?? 0), 0))
    console.log(`PASS ${model}: unanswered permission exits 1, authentication fails with exit 1, a run ends on its answer with no close row and the step usage is the outcome's`)
  }
  assert(c.requests.every(request => request.fault === undefined && request.body.model === c.model.slice('compat/fixture/'.length)))
  assert(c.requests.some(request => request.body.messages.some((message: any) => message.role === 'tool')))
  assert(c.requests.some(request => request.body.messages.some((message: any) => message.role === 'assistant' && message.reasoning_content)))
  assert(c.requests.some(request => JSON.stringify(request.body.messages).includes('Python-CHILD-ONLY')))
  console.log('PASS every compat request satisfies llama.cpp engine rules and tool/reasoning replay')
  for (const path of ['sdk/README.md', 'sdk-py/README.md']) {
    const readme = readFileSync(join(process.env.SDK_PARITY_DOC_ROOT ?? root, path), 'utf8')
    assert(readme.includes('compat/<endpoint>/<model>'), `${path} must name the compat model grammar`)
    assert(readme.includes('mercury://models') && readme.includes('huggingface') && readme.includes('local'), `${path} must name model discovery and class choices`)
  }
  console.log('PASS both SDK READMEs describe the model routes the fixtures exercised')
} finally { await c.close(); clearTimeout(guard) }
