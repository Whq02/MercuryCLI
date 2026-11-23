import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const home = mkdtempSync(join(tmpdir(), 'prompt-cache-delivery-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
const load = (path: string): Promise<any> => import(join(root, path))
const { enableConfigs } = await load('src/platform/settings/config.ts'); enableConfigs()
const { compatChatCallModel } = await load('src/models/roads/openaicompat/compatChatCallModel.ts')
const { asSystemPrompt } = await load('src/engine/system-prompt/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await load('src/tools/kit/tool.ts')
let failures = 0
const check = (label: string, yes: boolean, detail = ''): void => { if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${!yes && detail ? ` — ${detail}` : ''}`) }
const captured: Array<{ path: string; body: any }> = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const body = await req.json() as any
  captured.push({ path, body })
  if (path.startsWith('/reject') && body.prompt_cache_key !== undefined) return Response.json({ error: { message: 'Unknown field prompt_cache_key', param: 'prompt_cache_key' } }, { status: 400 })
  if (path === '/unrelated') return Response.json({ error: { message: 'Invalid tool name' } }, { status: 400 })
  return new Response(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'complete' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 10 } } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
} })
async function run(lane: string, path: string, model = 'fixture-model'): Promise<any[]> {
  const results: any[] = []
  const profile = { lane, providerLabel: 'fixture', resolveCredential: () => ({}), credentialHint: 'fixture', requestUrl: () => `http://127.0.0.1:${server.port}${path}`, wireModelId: () => model, buildExtras: () => ({ max_tokens: 1024, temperature: 0.2 }) }
  for await (const event of compatChatCallModel(profile, { messages: [{ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Say complete.' } }], systemPrompt: asSystemPrompt(['fixture instructions']), tools: [], thinkingConfig: { type: 'disabled' }, signal: new AbortController().signal, options: { model: lane === 'openrouter' ? 'openrouter/fixture/model' : lane === 'openai-compat' ? 'compat/fixture-model' : 'deepseek-chat', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], mcpTools: [], hasAppendSystemPrompt: false } })) results.push(event)
  return results
}
try {
  for (const lane of ['openai-compat', 'openrouter']) {
    await run(lane, '/accept-'+lane)
    await run(lane, '/accept-'+lane)
    const bodies = captured.filter(r=>r.path === '/accept-'+lane).map(r=>r.body)
    check(lane+' sends the minted stable key even without tool deferral', bodies.length === 2 && typeof bodies[0].prompt_cache_key === 'string' && bodies[0].prompt_cache_key === bodies[1].prompt_cache_key, `${bodies.length} requests captured; makeRequestExtra in src/models/roads/openaicompat/chat-call-model/prepare.ts must send the same string prompt_cache_key on every turn for the openai-compat and openrouter lanes`)
    const out = await run(lane, '/reject-'+lane)
    await run(lane, '/reject-'+lane)
    const rejected = captured.filter(r=>r.path === '/reject-'+lane).map(r=>r.body)
    check(lane+' retries only the field refusal and remembers it', rejected.length === 3 && typeof rejected[0].prompt_cache_key === 'string' && rejected.slice(1).every(b=>b.prompt_cache_key === undefined), `${rejected.length} requests (3 expected: refused, retried without the field, then sent without it); sendWithCacheField in src/models/roads/cacheFieldRetry.ts must retry once without prompt_cache_key on a refusal naming it and remember that for the endpoint`)
    check(lane+' loses no turn or usage at the refusal', out.some(e=>e.type === 'assistant' && !e.isApiErrorMessage && e.message.usage.output_tokens === 3), 'the retried request must still yield an assistant message with the usage of the successful reply; see sendWithCacheField in src/models/roads/cacheFieldRetry.ts and its caller in src/models/roads/openaicompat/compatChatClient.ts')
    if(rejected.length >= 2) { const {prompt_cache_key, ...first}=rejected[0]; check(lane+' retry otherwise preserves exact request bytes', JSON.stringify(first) === JSON.stringify(rejected[1]), 'the retry must differ from the first request only by the removed prompt_cache_key; see sendWithCacheField in src/models/roads/cacheFieldRetry.ts') }
  }
  console.log('\nrefusals')
  await run('deepseek', '/control')
  check('other native chat roads receive no added field', captured.filter(r=>r.path==='/control').every(r=>r.body.prompt_cache_key===undefined), 'prompt_cache_key is added only for the openai-compat and openrouter lanes in makeRequestExtra in src/models/roads/openaicompat/chat-call-model/prepare.ts; other lanes must not receive it')
  await run('openai-compat', '/unrelated')
  check('an unrelated 400 is not retried as a cache refusal', captured.filter(r=>r.path==='/unrelated').length===1, 'sendWithCacheField in src/models/roads/cacheFieldRetry.ts must retry only a 400 that names the cache field, not any 400')
  await run('openai-compat', '/new-endpoint')
  check('one endpoint refusal never disables another endpoint', typeof captured.at(-1)?.body.prompt_cache_key==='string', 'the remembered refusal must be keyed per endpoint URL, so a new endpoint still gets prompt_cache_key; see sendWithCacheField in src/models/roads/cacheFieldRetry.ts')
  const { switchSession } = await load('src/boot/process-state/processState.ts')
  switchSession(randomUUID())
  const beforeSession = captured.length
  await run('openai-compat', '/reject-openai-compat')
  const fresh = captured.slice(beforeSession)
  check('a later session asks the gateway again', fresh.length === 2 && typeof fresh[0].body.prompt_cache_key === 'string' && fresh[1].body.prompt_cache_key === undefined, `${fresh.length} requests after switchSession (2 expected: the field sent again, then the retry without it); the remembered refusal must be scoped to the session id, see sendWithCacheField in src/models/roads/cacheFieldRetry.ts`)
} finally { server.stop(true); rmSync(home,{recursive:true,force:true}) }
console.log(`${failures?'FAIL':'PASS'} prompt-cache-delivery: ${failures} failed`)
process.exit(failures?1:0)
