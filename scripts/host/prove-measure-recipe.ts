import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { HOST_RECIPES } from '../../src/services/host/recipes.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
assert.ok(existsSync(new URL('./measure-recipe.ts', import.meta.url)), 'the owner has a runnable recipe measurement script')
const { measureRecipe } = await import('./measure-recipe.ts')
const recipe = HOST_RECIPES.find(row => row.id === 'qwen38-flash-next-fp8-h200')!
let mode = 'good'
let requests: Record<string, any>[] = []
const sse = (value: unknown): string => 'data: ' + JSON.stringify(value) + '\n\n'
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
  assert.equal(request.headers.get('authorization'), null)
  const path = new URL(request.url).pathname
  if (path === '/v1/models') return Response.json({ data: [{ id: mode === 'identity' ? 'wrong/model' : recipe.model }] })
  assert.equal(path, '/v1/chat/completions')
  const body = await request.json() as Record<string, any>
  requests.push(body)
  assert.equal(body.model, recipe.model)
  assert.equal(body.stream, true)
  assert.equal(body.stream_options.include_usage, true)
  assert.equal(body.reasoning_effort, 'xhigh')
  assert.equal(body.chat_template_kwargs.clear_thinking, false)
  assert.ok(!('max_tokens' in body) && !('max_completion_tokens' in body))
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.tools[0].function.name, 'measurement_echo')
  const last = body.messages.at(-1)
  const query = [...body.messages].reverse().find((row: any) => row.role === 'user').content as string
  const match = /MEASURE turn=(\d+) nonce=([a-z0-9-]+)/.exec(query)!
  const turn = Number(match[1])
  const nonce = match[2]!
  const inputTokens = mode === 'small' ? 100 : body.messages.reduce((sum: number, row: any) => sum + ((String(row.content).match(/fixture_line/g) ?? []).length * 12), 111)
  const prefix = { model: recipe.model }
  const chunks: string[] = []
  if (mode !== 'reasoning') chunks.push(sse({ ...prefix, choices: [{ delta: { reasoning_content: 'Keep this reasoning verbatim for turn ' + turn + '.' } }] }))
  if (last.role === 'tool') {
    const assistant = body.messages.at(-2)
    assert.equal(assistant.reasoning_content, 'Keep this reasoning verbatim for turn ' + turn + '.')
    assert.equal(assistant.tool_calls[0].id, last.tool_call_id)
    const receipt = JSON.parse(last.content).receipt
    chunks.push(sse({ ...prefix, choices: [{ delta: { content: mode === 'late' && turn === 19 ? 'wrong receipt' : receipt } }] }))
    chunks.push(sse({ ...prefix, choices: [{ delta: {}, finish_reason: 'stop' }] }))
  } else {
    const args = JSON.stringify({ turn, nonce })
    chunks.push(sse({ ...prefix, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-' + nonce + '-' + turn, type: 'function', function: { name: 'measurement_echo', arguments: args.slice(0, 7) } }] } }] }))
    chunks.push(sse({ ...prefix, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: mode === 'malformed' ? '{' : args.slice(7) } }] }, finish_reason: mode === 'length' ? 'length' : 'tool_calls' }] }))
  }
  if (mode !== 'usage') chunks.push(sse({ ...prefix, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 32, prompt_tokens_details: { cached_tokens: 0 } } }))
  if (mode === 'fault') chunks.push(sse({ error: { message: 'fixture engine failed', code: 'fixture_error' } }))
  chunks.push('data: [DONE]\n\n')
  return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } })
} })
try {
  const endpoint = `http://127.0.0.1:${server.port}/v1`
  const result = await measureRecipe({ recipe, endpoint })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.measured)
  assert.equal(result.turns, 20)
  assert.equal(result.reasoningReplays, 20)
  assert.ok(result.promptTokens! >= 50000 && result.promptTokens! <= 51000)
  assert.ok(result.firstTokenSeconds! >= 0 && result.outputTokensPerSecond! > 0)
  assert.equal(result.measured.verified.by, 'measured')
  assert.match(result.measured.verified.on!, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(result.measured.verified.note!, /20 turns/)
  assert.equal(requests.length, result.calibrationAttempts + 40)
  const measured = requests.slice(result.calibrationAttempts)
  const firstPrefix = measured[0]!.messages[0]
  for (const body of measured) assert.deepEqual(body.messages[0], firstPrefix)
  assert.notEqual(requests[0]!.messages[0].content, firstPrefix.content, 'calibration and measured cold prefixes differ')
  console.log('PASS calibrated 50k, 20 real HTTP tool/result pairs, preserved thinking, usage, max effort and pasteable measured block')
  for (const failure of ['identity', 'small', 'usage', 'malformed', 'length', 'reasoning', 'fault', 'late', 'ttft']) {
    mode = failure
    requests = []
    const failed = await measureRecipe({ recipe, endpoint, ...(failure === 'ttft' ? { ttftSeconds: Number.MIN_VALUE } : {}) })
    assert.equal(failed.ok, false, failure)
    assert.equal(failed.measured, undefined, failure + ' must never print a measured block')
    assert.ok(failed.failures.length, failure)
    if (failure === 'identity') assert.equal(requests.length, 0)
    console.log('PASS ' + failure + ' fails honestly without measured certification')
  }
  mode = 'good'
  const cancelled = new AbortController()
  cancelled.abort()
  const stopped = await measureRecipe({ recipe, endpoint, signal: cancelled.signal })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.measured, undefined)
  assert.equal((await measureRecipe({ recipe, endpoint: 'https://user:password@example.test/v1' })).ok, false)
  console.log('PASS cancellation and credential-bearing URLs cannot certify a recipe')
  const cli = async (...args: string[]): Promise<{ rc: number | null; stdout: string; stderr: string }> => await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./measure-recipe.ts', import.meta.url).pathname, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', rc => resolve({ rc, stdout, stderr }))
  })
  const goodCli = await cli('--recipe', recipe.id, '--endpoint', endpoint)
  assert.equal(goodCli.rc, 0, goodCli.stderr + goodCli.stdout)
  assert.equal(JSON.parse(goodCli.stdout).measured.verified.by, 'measured')
  mode = 'late'
  const badCli = await cli('--recipe', recipe.id, '--endpoint', endpoint)
  assert.equal(badCli.rc, 1)
  assert.equal(JSON.parse(badCli.stdout).measured, undefined)
  assert.equal((await cli('--unknown')).rc, 1)
  console.log('PASS actual CLI exits 0 only with a measured block, 1 for a late failure or unknown option')
  console.log('MEASURE RECIPE GREEN — loopback transport, not GPU performance')
} finally { await server.stop(true) }
