import { randomUUID } from 'node:crypto'
import { configure, dialects, fixtureTool, prepare, root, startWarmthEngine, turn } from './compatWarmthFixture.ts'

const api = await prepare()
const engine = startWarmthEngine()
let checks = 0
let failures = 0
const check = (name: string, truth: unknown) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${name}`) }
const j = JSON.stringify
try {
  await configure(api, Object.fromEntries(dialects.map(dialect => [dialect, { baseUrl: `${engine.base}/${dialect}/v1`, dialect, models: ['Fixture/Reasoner'] }])))
  const { clearSystemPromptSections } = await import(`${root}/src/constants/systemPromptSections.ts`)
  const { clearToolSchemaCache } = await import(`${root}/src/utils/toolSchemaCache.ts`)
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
      check(`${dialect} turn ${n + 1}: complete reply`, reply.some(m => m.message.stop_reason === 'end_turn') && !reply.some(m => m.isApiErrorMessage))
      history.push(...reply)
      if (n < 2) history.push(attachment(`<system-reminder>capsule turn ${n + 2} at ${new Date().toISOString()}</system-reminder>`), api.createUserMessage({ content: `turn ${n + 2}` }))
    }
    const requests = engine.captures.slice(start).map(c => c.body)
    check(`${dialect}: exactly three requests`, requests.length === 3)
    for (let n = 1; n < requests.length; n++) {
      const a = requests[n - 1], b = requests[n]
      const am = a.messages ?? a.input, bm = b.messages ?? b.input
      check(`${dialect} ${n}→${n + 1}: system byte-identical`, j(a.instructions ?? am[0]) === j(b.instructions ?? bm[0]))
      check(`${dialect} ${n}→${n + 1}: tools byte-identical after reorder/refetch`, j(a.tools) === j(b.tools))
      check(`${dialect} ${n}→${n + 1}: every sent message byte-identical, new turn appended`, bm.length > am.length && am.every((row: unknown, i: number) => j(row) === j(bm[i])))
      check(`${dialect} ${n}→${n + 1}: cache key and effort stable`, a.prompt_cache_key === b.prompt_cache_key && j(a.chat_template_kwargs) === j(b.chat_template_kwargs) && a.reasoning_effort === b.reasoning_effort)
      check(`${dialect} ${n}→${n + 1}: no timestamps or cache-control markers injected into prefix`, !j(am).includes('"timestamp"') && !j(am).includes('"cache_control"'))
    }
  }
  console.log(`COMPAT PREFIX ${failures ? 'RED' : 'GREEN'} — ${checks} checks, ${failures} failures`)
} finally { engine.close() }
process.exit(failures ? 1 : 0)
