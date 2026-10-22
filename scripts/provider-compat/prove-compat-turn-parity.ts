import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { configure, dialects, prepare, root, startWarmthEngine, turn } from './compatWarmthFixture.ts'
import { validateEngineRequest } from './fixtures/engineRules.mjs'

process.env.MERCURY_TOOL_DEFER = '0'
const api = await prepare()
const engine = startWarmthEngine()
const fetchBefore = globalThis.fetch
try {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    assert.equal(url.hostname, '127.0.0.1', 'parity verification stays on the fixture')
    return fetchBefore(input, init)
  }) as typeof fetch
  const { getSchemaBoundStructuredOutputTool } = await import(`${root}/src/tools/WorkflowTool/structuredOutputTool.ts`)
  const { finalizeAgentTool } = await import(`${root}/src/tools/AgentTool/agentToolUtils.ts`)
  const { refreshCompatCatalogues } = await import(`${root}/src/services/providers/openaicompat/compatCatalogue.ts`)
  const schema = { type: 'object', properties: { result: { type: 'string' }, steps: { type: 'integer' } }, required: ['result', 'steps'], additionalProperties: false }
  const payload = { result: 'ready', steps: 2 }
  const bound = getSchemaBoundStructuredOutputTool(schema)
  assert.equal(bound.error, undefined)
  const tools = [bound.tool]
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII='
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
  for (const dialect of ['responses', ...dialects.filter(dialect => dialect !== 'responses')]) {
    api.switchSession(randomUUID())
    const model = `compat/${dialect}/Fixture/Reasoner`
    const owner = `parity-${dialect}`
    const opts = { owner, agentId: `crew-${dialect}`, tools }
    await configure(api, { [dialect]: { baseUrl: `${engine.base}/${dialect}/v1`, dialect, models: ['Fixture/Reasoner'] } })
    engine.state.images = false
    engine.state.call = undefined
    engine.state.mode = 'reply'
    await refreshCompatCatalogues({ name: dialect, force: true })
    const prompt = api.createUserMessage({ content: [{ type: 'text', text: 'Read this picture and submit the structured answer.' }, image] })
    const textOnly = await turn(api, model, [prompt], opts)
    const omittedBody = engine.captures.at(-1)!.body
    assert.doesNotMatch(JSON.stringify(omittedBody.messages ?? omittedBody.input), /"(?:image_url|input_image)"/, `${dialect}: text-only capability holds even when tool deferral is off`)
    assert.match(JSON.stringify(textOnly.map(row => row.message.content)), /Image content was not sent/)
    assert.ok(textOnly.every(row => !row.isApiErrorMessage))
    engine.state.images = true
    await refreshCompatCatalogues({ name: dialect, force: true })
    engine.state.call = { name: 'StructuredOutput', arguments: JSON.stringify(payload) }
    const first = await turn(api, model, [prompt], opts)
    const request = engine.captures.at(-1)!.body
    assert.equal(request.model, 'Fixture/Reasoner')
    const declared = request.tools.map((tool: any) => tool.function ?? tool).find((tool: any) => tool.name === 'StructuredOutput')
    assert.deepEqual(declared.parameters, schema, `${dialect}: the bound output schema reaches the engine whole`)
    assert.match(JSON.stringify(request.messages ?? request.input), /"(?:image_url|input_image)"/)
    if (['llamacpp', 'vllm', 'sglang', 'ollama'].includes(dialect)) assert.equal(validateEngineRequest(dialect, request), undefined)
    assert.ok(first.every(row => !row.isApiErrorMessage))
    const calls = first.flatMap(row => row.message.content).filter((block: any) => block.type === 'tool_use')
    assert.equal(calls.length, 1, `${dialect}: one executable structured call`)
    assert.equal(calls[0].name, 'StructuredOutput')
    assert.deepEqual(calls[0].input, payload)
    const result = await bound.tool.call(calls[0].input)
    assert.deepEqual(result.structured_output, payload)
    const resultMessage = api.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: calls[0].id, content: [{ type: 'text', text: result.data }, image] }] })
    engine.state.call = undefined
    const history = [prompt, ...first, resultMessage]
    const reply = await turn(api, model, history, opts)
    const replay = engine.captures.at(-1)!.body
    assert.deepEqual(replay.tools, request.tools, `${dialect}: the structured tool prefix stays frozen`)
    const replayRows = replay.messages ?? replay.input
    assert.ok(replayRows.some((row: any) => row.tool_call_id === calls[0].id || row.type === 'function_call_output' && row.call_id === calls[0].id), `${dialect}: the validated result pairs with its call`)
    assert.match(JSON.stringify(replayRows), /"(?:image_url|input_image)"/)
    const metadata = { prompt: 'fixture', resolvedAgentModel: model, isBuiltInAgent: true, startTime: Date.now(), agentType: 'fixture', isAsync: false, structuredSpec: { mode: 'strict', source: 'dispatch' } }
    const complete = finalizeAgentTool([...history, ...reply], `crew-${dialect}`, metadata)
    assert.equal(complete.outcome.status, 'completed')
    assert.deepEqual(complete.structured.data, payload)
    assert.equal(complete.structured.mode, 'strict')
    const missing = finalizeAgentTool(reply, `crew-${dialect}`, metadata)
    assert.equal(missing.outcome.status, 'failed')
    assert.equal(missing.outcome.reason, 'schema-mismatch')
    engine.state.call = { name: 'StructuredOutput', arguments: JSON.stringify({ ...payload, extra: 'invalid' }) }
    const invalidRows = await turn(api, model, [prompt], { ...opts, owner: `${owner}-invalid` })
    const invalidCalls = invalidRows.flatMap(row => row.message.content).filter((block: any) => block.type === 'tool_use')
    if (invalidCalls.length) {
      assert.equal(invalidCalls.length, 1)
      await assert.rejects(() => bound.tool.call(invalidCalls[0].input), /does not match required schema/)
      const invalidResult = api.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: invalidCalls[0].id, content: 'Output does not match required schema: additional property extra', is_error: true }] })
      const invalid = finalizeAgentTool([...invalidRows, invalidResult, ...reply], `crew-${dialect}`, metadata)
      assert.equal(invalid.outcome.status, 'failed')
      assert.equal(invalid.outcome.reason, 'schema-mismatch')
    } else assert.ok(invalidRows.some(row => row.refusedToolCalls?.length))
    engine.state.call = undefined
    const finalUsage = reply.at(-1)!.message.usage
    const capture = engine.captures.at(-2)!
    assert.equal(finalUsage.output_tokens, 4)
    assert.ok(finalUsage.input_tokens + finalUsage.cache_read_input_tokens > 0)
    assert.ok(capture.total > 0)
    console.log(`PASS ${dialect}: crewmate prompt and result images, full output schema, typed call, frozen replay, usage and strict success/missing/invalid settlement`)
  }
  console.log('COMPAT TURN PARITY GREEN — seven dialects through the router and real schema-bound tool; loopback only')
} finally { globalThis.fetch = fetchBefore; engine.close() }
