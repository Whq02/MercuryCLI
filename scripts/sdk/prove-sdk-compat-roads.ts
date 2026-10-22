import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, connect, defineAgent, structuredSchema, isMainThread, rowOf } from '../../sdk/src/index.ts'
import { startFixtureServer } from '../../sdk/src/testing.ts'
import { compatRoadFixture, mercury, anthropicModel, pythonProof, root } from './compatRoadFixture.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

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
