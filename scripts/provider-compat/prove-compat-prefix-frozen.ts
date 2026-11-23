import { randomUUID } from 'node:crypto'
import { configure, dialects, fixtureTool, prepare, root, startWarmthEngine, turn } from './compatWarmthFixture.ts'

const api = await prepare()
const engine = startWarmthEngine()
let checks = 0
let failures = 0
const check = (name: string, truth: unknown, detail?: string) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${name}${!truth && detail ? ` — ${detail}` : ''}`) }
const j = JSON.stringify
try {
  await configure(api, Object.fromEntries(dialects.map(dialect => [dialect, { baseUrl: `${engine.base}/${dialect}/v1`, dialect, models: ['Fixture/Reasoner'] }])))
  const { clearSystemPromptSections } = await import(`${root}/src/engine/system-prompt/systemPromptSections.ts`)
  const { clearToolSchemaCache } = await import(`${root}/src/models/roads/toolSchemaCache.ts`)
  const attachment = (body: string) => ({ type: 'attachment', uuid: randomUUID(), timestamp: new Date().toISOString(), attachment: { type: 'user_context', body } })
  for (const dialect of dialects) {
    api.switchSession(randomUUID())
    clearSystemPromptSections()
    const model = `compat/${dialect}/Fixture/Reasoner`
    const owner = `prefix-${dialect}`
    const history: any[] = [attachment('<system-reminder>initial capsule</system-reminder>'), api.createUserMessage({ content: 'first turn' })]
    const start = engine.captures.length
    for (let n = 0; n < 3; n++) {
      const tools = n === 0 ? [fixtureTool('WarmthEcho'), fixtureTool('WarmthRead')] : [fixtureTool('WarmthRead', 'refetched'), fixtureTool('WarmthEcho', 'refetched')]
      clearToolSchemaCache()
      const system = await api.getSystemPrompt(tools, model, [])
      const reply = await turn(api, model, history, { owner, tools, system })
      check(`${dialect} turn ${n + 1}: complete reply`, reply.some(m => m.message.stop_reason === 'end_turn') && !reply.some(m => m.isApiErrorMessage), 'the fixture engine answered with an error or no end_turn; read the reply and the engine capture, and start from the request builder in src/models/roads/openaicompat/chat-call-model/prepare.ts')
      history.push(...reply)
      if (n < 2) history.push(attachment(`<system-reminder>capsule turn ${n + 2} at ${new Date().toISOString()}</system-reminder>`), api.createUserMessage({ content: `turn ${n + 2}` }))
    }
    const requests = engine.captures.slice(start).map(c => c.body)
    check(`${dialect}: exactly three requests`, requests.length === 3, `${requests.length} requests reached the fixture engine; a turn was retried, skipped or sent to another path, so look at src/models/roads/openaicompat/chat-call-model/attempt.ts`)
    for (let n = 1; n < requests.length; n++) {
      const a = requests[n - 1], b = requests[n]
      const am = a.messages ?? a.input, bm = b.messages ?? b.input
      check(`${dialect} ${n}→${n + 1}: system byte-identical`, j(a.instructions ?? am[0]) === j(b.instructions ?? bm[0]), 'the system prompt changed between turns; make getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts (and the sections in src/engine/system-prompt/systemPromptSections.ts) return the same text each turn')
      check(`${dialect} ${n}→${n + 1}: tools byte-identical after reorder/refetch`, j(a.tools) === j(b.tools), 'the tools array changed between turns; keep tool order and schema text stable when tools are reordered or refetched, see src/models/roads/toolSchemaCache.ts and src/models/roads/openaicompat/compatToolSchemas.ts')
      check(`${dialect} ${n}→${n + 1}: every sent message byte-identical, new turn appended`, bm.length > am.length && am.every((row: unknown, i: number) => j(row) === j(bm[i])), 'an earlier message was rewritten or the new turn was not appended; stop the request builder from changing sent history, in src/models/roads/openaicompat/chat-call-model/prepare.ts')
      check(`${dialect} ${n}→${n + 1}: cache key and effort stable`, a.prompt_cache_key === b.prompt_cache_key && j(a.chat_template_kwargs) === j(b.chat_template_kwargs) && a.reasoning_effort === b.reasoning_effort, 'the cache key or effort fields changed between turns; keep them constant for one session, where prompt_cache_key is set in src/models/roads/openaicompat/chat-call-model/prepare.ts')
      check(`${dialect} ${n}→${n + 1}: no timestamps or cache-control markers injected into prefix`, !j(am).includes('"timestamp"') && !j(am).includes('"cache_control"'), 'a timestamp or cache_control marker is in the sent prefix; strip it from the compat request builder, src/models/roads/openaicompat/chat-call-model/prepare.ts')
    }
  }
  console.log(`COMPAT PREFIX ${failures ? 'RED' : 'GREEN'} — ${checks} checks, ${failures} failures`)
} finally { engine.close() }
process.exit(failures ? 1 : 0)
