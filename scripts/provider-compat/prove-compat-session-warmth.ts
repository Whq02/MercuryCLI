import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { configure, fixtureTool, prepare, root, startWarmthEngine, turn } from './compatWarmthFixture.ts'

if (process.argv[2] === '--worker') {
  const args = JSON.parse(process.argv[3]!)
  const api = await prepare()
  api.switchSession(args.session)
  let history: any[] = [{ ...api.createUserMessage({ content: args.name + ' ' + 'tok '.repeat(50_000) }), uuid: 'u-first' }]
  let rounds = 0
  console.log('WARMTH READY')
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line)
    if (command.reset) history = [{ ...api.createUserMessage({ content: 'summary' }), uuid: randomUUID() }]
    if (rounds && !command.reset) history.push(api.createUserMessage({ content: `next ${rounds}` }))
    const reply = await turn(api, args.model, history, { owner: args.owner, agentId: args.agent ? 'crew-fixture' : undefined })
    history.push(...reply)
    rounds++
    console.log('WARMTH ' + JSON.stringify({ ok: reply.some(m => m.message.stop_reason === 'end_turn') && !reply.some(m => m.isApiErrorMessage), usage: reply.at(-1)?.message.usage }))
  }
  process.exit(0)
}

const api = await prepare()
const engine = startWarmthEngine()
let checks = 0
let failures = 0
const check = (name: string, truth: unknown) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${name}`) }
const workers: ReturnType<typeof worker>[] = []
const model = 'compat/llamacpp/Fixture/Reasoner'
function worker(name: string, owner: string, agent = false) {
  const child = spawn(process.execPath, [import.meta.filename, '--worker', JSON.stringify({ name, owner, model, session: randomUUID(), agent })], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const answers: Array<(value: any) => void> = []
  const errors: string[] = []
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { if (line === 'WARMTH READY') ready(); else if (line.startsWith('WARMTH ')) answers.shift()?.(JSON.parse(line.slice(7))) })
  child.stderr.on('data', bytes => errors.push(String(bytes)))
  const exited = new Promise<number | null>(resolve => child.once('exit', (code) => { ready(); for (const answer of answers.splice(0)) answer({ ok: false, error: errors.join('') }); resolve(code) }))
  return { child, started, exited, async next(reset = false) { await started; if (child.exitCode !== null) throw new Error(errors.join('')); return await new Promise<any>(resolve => { answers.push(resolve); child.stdin.write(JSON.stringify({ reset }) + '\n') }) }, async close() { child.stdin.end(); return await exited } }
}
try {
  await configure(api, { llamacpp: { baseUrl: engine.base + '/llamacpp/v1', dialect: 'llamacpp', models: ['Fixture/Reasoner', 'kimi-k3'] } })
  const owners: string[] = []
  for (let n = 0; owners.length < 5; n++) {
    const owner = 'fixture-owner-' + n
    if (createHash('sha256').update(`${owner}|u-first|${model}`).digest().readUInt32BE(0) % 4 === 0) owners.push(owner)
  }
  for (let i = 0; i < 4; i++) workers.push(worker(i === 0 ? 'lead' : `crew-${i}`, owners[i]!, i > 0))
  await Promise.all(workers.map(w => w.started))
  const initial = await Promise.all(workers.map(w => w.next()))
  check('four independent processes all complete their first turn', initial.every(result => result.ok))
  const first = engine.captures.slice()
  check('four live sessions use four different slots, despite colliding preferred hashes', new Set(first.map(c => c.body.id_slot)).size === 4 && first.every(c => Number.isInteger(c.body.id_slot)))
  const isLead = (capture: any) => capture.body.messages?.some((row: any) => typeof row.content === 'string' && row.content.startsWith('lead '))
  const leadSlot = first.find(isLead)?.body.id_slot
  for (let n = 0; n < 2; n++) {
    await workers[1]!.next()
    const reply = await workers[0]!.next()
    check(`lead turn ${n + 2} completes after a crewmate turn`, reply.ok)
  }
  const lead = engine.captures.filter(isLead)
  const coldTokens = lead.reduce((sum, c) => sum + c.total, 0)
  const rereadTokens = lead.reduce((sum, c) => sum + c.prefill, 0)
  console.log(`MEASURE three 50k-token turns: cold=${coldTokens} tokens / ${(coldTokens * engine.state.msPerToken).toFixed(3)} modeled ms; served=${rereadTokens} tokens / ${lead.reduce((sum, c) => sum + c.costMs, 0).toFixed(3)} modeled ms; cached=${lead.map(c => c.cached).join(',')}`)
  check('three turns pay for one full prefill plus appended tokens, not three full reads', lead.length === 3 && rereadTokens <= lead[0]!.total + 1000 && coldTokens > 150_000)
  check('a lead keeps its id_slot across turns', lead.every(c => c.body.id_slot === leadSlot))
  check('every pinned request enables cache_prompt', engine.captures.every(c => c.body.cache_prompt === true))
  const beforeReset = engine.captures.length
  await workers[0]!.next(true)
  check('compaction changes the conversation prefix, not the session slot', engine.captures[beforeReset]?.body.id_slot === leadSlot)
  workers.push(worker('overflow', owners[4]!, true))
  await workers[4]!.next()
  const assigned = engine.captures.at(-1)!.body.id_slot
  check('a fifth session shares a legal slot rather than inventing capacity', Number.isInteger(assigned) && assigned >= 0 && assigned < 4)
  await workers[0]!.next()
  check('overflow never reassigns an existing session slot', engine.captures.at(-1)!.body.id_slot === leadSlot)
  const { configuredCompatEndpoints } = await import(`${root}/src/services/providers/openaicompat/compatAccounts.ts`)
  const endpoint = configuredCompatEndpoints()[0]!
  const kimi = await turn(api, 'compat/llamacpp/kimi-k3', [api.createUserMessage({ content: 'kimi fixture' })])
  check('the Kimi model-specific extras retain slot pinning and cache_prompt', kimi.some(m => !m.isApiErrorMessage) && Number.isInteger(engine.captures.at(-1)!.body.id_slot) && engine.captures.at(-1)!.body.cache_prompt === true)
  check('the Kimi model-specific effort remains max', engine.captures.at(-1)!.body.reasoning_effort === 'max')
  const forkHistory = [api.createUserMessage({ content: 'shared fork prefix' })]
  await turn(api, model, forkHistory, { owner: 'shared-roster' })
  const parentSlot = engine.captures.at(-1)!.body.id_slot
  await turn(api, model, forkHistory, { owner: 'shared-roster', agentId: 'in-process-crew' })
  check('a crewmate sharing its parent roster has a separate slot identity', engine.captures.at(-1)!.body.id_slot !== parentSlot)
  await turn(api, model, [api.createUserMessage({ content: 'parent summary' })], { owner: 'shared-roster' })
  check('the parent keeps its own slot after the in-process crewmate', engine.captures.at(-1)!.body.id_slot === parentSlot)
  const { HOST_RECIPES } = await import(`${root}/src/services/host/recipes.ts`)
  check('llama recipes explicitly keep prompt caching on and their reuse threshold', HOST_RECIPES.filter((r: any) => r.engine === 'llamacpp').every((r: any) => r.flags.includes('--cache-prompt') && r.flags[r.flags.indexOf('--cache-reuse') + 1] === '256'))
  check('vLLM recipes explicitly enable prefix caching', HOST_RECIPES.filter((r: any) => r.engine === 'vllm').every((r: any) => r.flags.includes('--enable-prefix-caching')))
  check('SGLang recipes keep radix caching on and report measured cache tokens', HOST_RECIPES.filter((r: any) => !r.engine).every((r: any) => !r.flags.includes('--disable-radix-cache') && r.flags.includes('--enable-cache-report')))
  const { exportHostRecipesJson } = await import(`${root}/src/services/host/recipesFile.ts`)
  check('recipe asset is exactly the exporter output', readFileSync(root + '/assets/host/recipes.json', 'utf8') === exportHostRecipesJson())
  try {
    const { compatPrefixCacheWords } = await import(`${root}/src/services/providers/openaicompat/compatPrefixCache.ts`)
    check('last-turn cache words carry measured totals', /prefix cached.*tokens/.test(compatPrefixCacheWords(endpoint)))
    const { hostPaidPodWords } = await import(`${root}/src/commands/llmhost/words.ts`)
    const pod = { id: 'fixture-pod', name: 'Fixture', status: 'RUNNING', cost: 1, createdAt: new Date().toISOString() }
    const record = { provider: 'llamacpp', step: 'ready', startedAt: pod.createdAt }
    check('the paid-pod row displays the engine reading from the completed turn', hostPaidPodWords(pod, record).includes(compatPrefixCacheWords(endpoint)))
    check('stopped or reloading pods never show an old cache reading', !hostPaidPodWords({ ...pod, status: 'EXITED' }, record).includes('prefix cached') && !hostPaidPodWords(pod, { ...record, step: 'reloading' }).includes('prefix cached'))
    check('an expired cache reading is not displayed as current', compatPrefixCacheWords(endpoint, Date.now() + 16 * 60_000) === '')
    engine.state.report = false
    await turn(api, model, [api.createUserMessage({ content: 'no cache counters' })])
    check('a turn without cache counters clears the old measurement rather than inventing zero', compatPrefixCacheWords(endpoint) === '')
    engine.state.report = true
  } catch (error) { check('last-turn cache words are available', false); console.log(String(error).split('\n')[0]) }
  engine.state.mode = 'retry'
  const retryStart = engine.captures.length
  const retry = await turn(api, model, [api.createUserMessage({ content: 'retry fixture' })], { owner: 'retry' })
  const retried = engine.captures.slice(retryStart)
  check('a retry retains the identical body and slot', retry.some(m => m.message.stop_reason === 'end_turn') && retried.length === 2 && JSON.stringify(retried[0]!.body) === JSON.stringify(retried[1]!.body))
  engine.state.mode = 'refuse'
  const refused = await turn(api, model, [api.createUserMessage({ content: 'refusal fixture' })])
  check('a provider refusal remains a refusal', refused.some(m => m.isApiErrorMessage))
  engine.state.mode = 'reply'
  const resumed = await turn(api, model, [api.createUserMessage({ content: 'resume fixture' })])
  check('the next turn reaches the provider after its refusal', resumed.some(m => m.message.stop_reason === 'end_turn'))
  const abort = new AbortController()
  abort.abort()
  const beforeCancel = engine.captures.length
  await turn(api, model, [api.createUserMessage({ content: 'cancel fixture' })], { signal: abort.signal })
  check('cancellation sends no generation request', engine.captures.length === beforeCancel)
  engine.state.mode = 'tools'
  const toolHistory = [api.createUserMessage({ content: 'call the echo tool' })]
  const toolReply = await turn(api, model, toolHistory, { owner: 'tool-round' })
  const calls = toolReply.flatMap(m => m.message.content).filter(b => b.type === 'tool_use')
  check('a warm route preserves the complete executable tool call', calls.length === 1 && calls[0].id === 'call-warmth' && calls[0].name === 'WarmthEcho' && calls[0].input.text === 'hello')
  engine.state.mode = 'reply'
  await turn(api, model, [...toolHistory, ...toolReply, api.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call-warmth', content: 'hello' }] })], { owner: 'tool-round' })
  const replay = engine.captures.at(-1)!.body.messages
  check('tool and result identity survives replay on the pinned route', replay.some((row: any) => row.tool_calls?.some((call: any) => call.id === 'call-warmth')) && replay.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call-warmth' && row.content === 'hello'))
  engine.state.mode = 'truncated'
  const cut = await turn(api, model, [api.createUserMessage({ content: 'truncated fixture' })])
  check('a missing terminal event keeps partial content and remains a failure', cut.some(m => m.isApiErrorMessage) && cut.some(m => !m.isApiErrorMessage && m.message.content.some((b: any) => b.type === 'text' && b.text === 'WARM')))
  engine.state.slots = 0
  engine.state.mode = 'retry'
  await configure(api, { unavailable: { baseUrl: engine.base + '/unavailable/v1', dialect: 'llamacpp', models: ['Fixture/Reasoner'] } })
  const unknownStart = engine.captures.length
  const unknown = await turn(api, 'compat/unavailable/Fixture/Reasoner', [api.createUserMessage({ content: 'unknown slots fixture' })])
  check('unavailable slot metadata leaves engine scheduling and prompt caching enabled on the retry too', unknown.some(m => m.message.stop_reason === 'end_turn') && engine.captures.slice(unknownStart).length === 2 && engine.captures.slice(unknownStart).every(c => c.body.id_slot === undefined && c.body.cache_prompt === true))
  console.log(`COMPAT WARMTH ${failures ? 'RED' : 'GREEN'} — ${checks} checks, ${failures} failures`)
} finally { for (const w of workers) await w.close(); engine.close() }
process.exit(failures ? 1 : 0)
