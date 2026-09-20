#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'ops', 'check-typed-model-ids.ts')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')
const { GLM_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/zai.js')
const { KIMI_DISPLAY_PINS } = await import('../../src/services/providers/moonshot/kimiPins.js')
const { DEEPSEEK_DISPLAY_PINS } = await import('../../src/services/providers/deepseek/deepseekPins.js')
const { GEMINI_PRICE_PINS } = await import('../../src/services/providers/gemini/geminiPins.js')
const { HUGGINGFACE_DISPLAY_PINS } = await import('../../src/services/providers/huggingface/huggingfacePins.js')
const model = await import('../../src/utils/model/model.js')
const { geminiGuidePages } = await import('../../src/components/geminiConnectGuide.js')
const pages = geminiGuidePages()
const { keyLanePins } = await import('../../src/utils/model/modelOptions.js')

const gptIds = GPT_DISPLAY_PINS.map(p => p.id)
const glmIds = GLM_STATIC_CATALOGUE.map(e => e.id)
const glmDated = keyLanePins('zai')[0]?.observedAt ?? ''
const OWNER_LIST = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
const anthropicIds = [...new Set([model.getDefaultFableModel(), model.getDefaultOpusModel(), model.getDefaultSonnetModel(), model.getDefaultHaikuModel(), model.getSmallFastModel()].map(id => model.normalizeModelStringForAPI(id)))]
const KEYS = { anthropic: 'proof-key-ci-gate-not-a-real-key', openai: 'fixture-openai-key-0001', gemini: 'fixture-gemini-key-0001', deepseek: 'fixture-deepseek-key-0001', openrouter: 'fixture-openrouter-key-0001', hf: 'fixture-hf-token-0001', zai: 'fixture-zai-key-0001', moonshot: 'fixture-moonshot-key-0001', chatgpt: 'fixture-chatgpt-access-token-0001' }

const lists: Record<string, string[]> = {
  subscription: [...gptIds],
  apiKey: [...gptIds],
  anthropic: [...anthropicIds],
  gemini: GEMINI_PRICE_PINS.map(p => p.id),
  deepseek: DEEPSEEK_DISPLAY_PINS.map(p => p.id),
  openrouter: ['openai/gpt-5.5', 'anthropic/claude-opus-5'],
  huggingface: HUGGINGFACE_DISPLAY_PINS.map(p => p.id),
  zai: GLM_STATIC_CATALOGUE.map(e => e.id),
  moonshot: KIMI_DISPLAY_PINS.map(p => p.id),
}
const failing: Record<string, number> = {}
let deadPage: string | undefined
const hits: string[] = []
const zaiProbes: Array<{ model: string; maxTokens: unknown; stream: unknown; bearer: string | undefined }> = []
let zaiRefusesKey = false
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? '').split('?')[0] ?? ''
  hits.push(`${req.method} ${path}`)
  const json = (body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const failWith = (family: string): boolean => {
    const status = failing[family]
    if (status === undefined) return false
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `fixture ${family} answers ${status}` } }))
    return true
  }
  if (req.method === 'HEAD') {
    if (path === deadPage) { res.writeHead(404); res.end(); return }
    res.writeHead(302, { location: 'https://accounts.google.com/ServiceLogin' }); res.end(); return
  }
  if (req.method === 'POST' && path === '/zai/v4/chat/completions') {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      let body: { model?: string; max_tokens?: unknown; stream?: unknown } = {}
      try { body = JSON.parse(raw) as typeof body } catch { body = {} }
      zaiProbes.push({ model: body.model ?? '', maxTokens: body.max_tokens, stream: body.stream, bearer: req.headers.authorization })
      if (zaiRefusesKey) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: '1002', message: 'Authentication failed' } })); return }
      if (!lists.zai!.includes(body.model ?? '')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: '1211', message: 'Model does not exist, please check the model code.' } })); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"id":"probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
    })
    return
  }
  if (req.method !== 'GET') { json({}); return }
  if (path === '/openai/chatgpt/models') { if (failWith('subscription')) return; json({ models: lists.subscription!.map((slug, i) => ({ slug, display_name: slug, supported_reasoning_levels: ['low', 'high'], visibility: 'list', priority: i + 1 })) }); return }
  if (path === '/openai/v1/models') { if (failWith('apiKey')) return; json({ object: 'list', data: lists.apiKey!.map(id => ({ id, object: 'model' })) }); return }
  if (path === '/anthropic/v1/models') { if (failWith('anthropic')) return; json({ data: lists.anthropic!.map(id => ({ type: 'model', id, display_name: id })), has_more: false }); return }
  if (path === '/gemini/v1beta/models') { if (failWith('gemini')) return; json({ models: lists.gemini!.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'] })) }); return }
  if (path === '/deepseek/models') { if (failWith('deepseek')) return; json({ object: 'list', data: lists.deepseek!.map(id => ({ id, object: 'model', owned_by: 'deepseek' })) }); return }
  if (path === '/openrouter/api/v1/models') { if (failWith('openrouter')) return; json({ data: lists.openrouter!.map(id => ({ id, name: id, pricing: { prompt: '0.000001', completion: '0.000002' } })) }); return }
  if (path === '/hf/v1/models') { if (failWith('huggingface')) return; json({ object: 'list', data: lists.huggingface!.map(id => ({ id, object: 'model', owned_by: id.split('/')[0], providers: [{ provider: 'fixture', status: 'live' }] })) }); return }
  if (path === '/moonshot/v1/models') { if (failWith('moonshot')) return; json({ object: 'list', data: lists.moonshot!.map(id => ({ id, object: 'model', owned_by: 'moonshot', created: 1 })) }); return }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const scratch = mkdtempSync(join(tmpdir(), 'typed-model-ids-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
writeFileSync(join(home, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3, theme: 'dark', customApiKeyResponses: { approved: [KEYS.anthropic.slice(-20)], rejected: [] } }))
writeFileSync(join(home, 'settings.json'), '{}')
const seedSubscription = (expiresAtMs: number): void =>
  writeFileSync(join(home, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: { idToken: 'fixture-id-token', accessToken: KEYS.chatgpt, refreshToken: 'fixture-refresh-token-0001', accountId: 'acct_fixture', planType: 'pro', email: 'sam@example.test', accessTokenExpiresAtMs: expiresAtMs } }))
seedSubscription(Date.now() + 24 * 3600_000)

const snapshotHome = (): string =>
  readdirSync(home, { recursive: true })
    .map(String)
    .sort()
    .map(name => {
      const full = join(home, name)
      const stat = statSync(full)
      return `${name}:${stat.isFile() ? readFileSync(full, 'utf8').length + ':' + stat.mtimeMs : 'dir'}`
    })
    .join('\n')

const baseEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: scratch,
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  BROWSER: '/usr/bin/true',
  MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
  ANTHROPIC_API_KEY: KEYS.anthropic,
  ANTHROPIC_BASE_URL: `${base}/anthropic`,
  OPENAI_API_KEY: KEYS.openai,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:1',
  GEMINI_API_KEY: KEYS.gemini,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  DEEPSEEK_API_KEY: KEYS.deepseek,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  OPENROUTER_API_KEY: KEYS.openrouter,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  HF_TOKEN: KEYS.hf,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  ZAI_API_KEY: KEYS.zai,
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  MOONSHOT_API_KEY: KEYS.moonshot,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
}
type Run = { status: number | null; lines: string[]; stdout: string; stderr: string }
const run = async (extra: Record<string, string | undefined> = {}, args: string[] = []): Promise<Run> => {
  const env: Record<string, string> = { ...baseEnv }
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v }
  hits.length = 0
  zaiProbes.length = 0
  const child = spawn(process.execPath, [SCRIPT, '--signin-pages-base', `${base}/pages`, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  clearTimeout(killer)
  return { status, lines: stdout.split('\n').filter(l => l.trim() !== ''), stdout, stderr }
}
const rows = (r: Run, family: string, verdict: string): string[] => r.lines.filter(l => l.startsWith(`${family} · `) && l.endsWith(` · ${verdict}`))
const secretLeak = (r: Run): string | undefined => Object.values(KEYS).find(k => r.stdout.includes(k) || r.stderr.includes(k))

const before = snapshotHome()
console.log('============================================================')
console.log(' the release-day typed-id check over recorded lists')
console.log('============================================================')

section('§1 every list serves every typed id: one line per typed id, every one served, exit 0')
const all = await run()
const typedTotal = gptIds.length * 2 + anthropicIds.length + lists.gemini!.length + lists.deepseek!.length + lists.huggingface!.length + lists.moonshot!.length
check('exit 0', all.status === 0, `status ${all.status}; stderr ${all.stderr.slice(-300)}`)
check(`one served line per typed id per fetched list (${typedTotal})`, all.lines.filter(l => l.endsWith(' · served')).length === typedTotal, all.lines.join('\n').slice(0, 1500))
check('no typed id reads not served or unreachable', !all.lines.some(l => / · (not served|unreachable \()/.test(l)), all.lines.filter(l => / · (not served|unreachable)/.test(l)).join('\n'))
check('the two OpenAI sources are judged apart (the subscription list and the key list)', rows(all, 'openai', 'served').some(l => l.includes('ChatGPT pro subscription')) && rows(all, 'openai', 'served').some(l => l.includes('OpenAI API key (env)')))
check('the OpenRouter list, with no typed ids, prints its count', all.lines.some(l => l.startsWith('openrouter · ') && / · 2 served$/.test(l)), all.lines.filter(l => l.startsWith('openrouter')).join('\n'))
check('every fixture list was fetched once', ['/openai/chatgpt/models', '/openai/v1/models', '/anthropic/v1/models', '/gemini/v1beta/models', '/deepseek/models', '/openrouter/api/v1/models', '/hf/v1/models', '/moonshot/v1/models'].every(p => hits.some(h => h.endsWith(p))), hits.join(', '))
check('Z.AI, with no model list, reads its dated typed table without the flag: one line per typed id, the table\'s own date', /^\d{4}-\d{2}-\d{2}$/.test(glmDated) && glmIds.length > 0 && glmIds.every(id => all.lines.includes(`zai · Z.AI API key (env) · ${id} · no live list — typed table dated ${glmDated}`)), all.lines.filter(l => l.startsWith('zai')).join('\n'))
check('no Z.AI request of any kind without the flag (no models GET, no completion)', !hits.some(h => h.includes('/zai/')) && zaiProbes.length === 0, hits.filter(h => h.includes('/zai/')).join(', '))
check('the summary line says every judged id is served and counts the eight lists, the dated family left out', all.lines.some(l => l.startsWith('typed model ids: every typed id a fetched list could judge is served') && / \(8 of 8 lists fetched\)$/.test(l)), all.lines.at(-1))
check('no credential value appears in the output', secretLeak(all) === undefined, secretLeak(all))
const pageLines = all.lines.filter(l => l.startsWith('sign-in page · '))
check(`one line per sign-in page from the one address owner (${pages.length}), each dated and answering the fixture's redirect`, pageLines.length === pages.length && pages.every(p => pageLines.some(l => l.includes(` · ${p.address} · observed ${p.observedAt} · answers HTTP 302`))), pageLines.join('\n'))
check('every page was asked with one HEAD on the fixture, never a GET', pages.every(p => hits.includes(`HEAD /pages${new URL(p.address).pathname}`)) && !hits.some(h => h.startsWith('GET /pages')), hits.filter(h => h.includes('/pages')).join(', '))
check('the pages summary says every page answered and names the sign-in wall the HEAD cannot see past', all.lines.some(l => l.startsWith(`sign-in pages: every one of ${pages.length} answered`) && l.includes("a page that moved behind that wall still reads alive here")), all.lines.filter(l => l.startsWith('sign-in pages')).join('\n'))

section("§2 the subscription serves the owner's five ids: every typed id served under that source, exit 0")
lists.subscription = [...OWNER_LIST]
const ownerServed = await run()
check("exit 0 (no typed id is lacking on the owner's account)", ownerServed.status === 0, `status ${ownerServed.status}; ${ownerServed.lines.filter(l => l.includes('not served')).join('\n')}`)
check('every typed id reads served under the subscription', gptIds.every(id => ownerServed.lines.includes(`openai · ChatGPT pro subscription · ${id} · served`)), ownerServed.lines.filter(l => l.includes('subscription')).join('\n'))
check('the summary line says every judged id is served', ownerServed.lines.some(l => l.startsWith('typed model ids: every typed id a fetched list could judge is served')), ownerServed.lines.at(-1))

section('§2b the subscription list lacks one typed id: it reads not served under that source, exit 1')
const lacking = 'gpt-5.5'
lists.subscription = OWNER_LIST.filter(id => id !== lacking)
const owner = await run()
const retired = gptIds.filter(id => !lists.subscription!.includes(id))
check('the typed table carries the lacking id (the leg judges something)', retired.length === 1 && retired[0] === lacking, retired.join(', '))
check('exit 1', owner.status === 1, `status ${owner.status}`)
check(`the typed ids the subscription list lacks read not served (${retired.join(', ')})`, retired.every(id => owner.lines.some(l => l === `openai · ChatGPT pro subscription · ${id} · not served`)), owner.lines.filter(l => l.includes('not served')).join('\n'))
check('the served ids read served under the subscription', lists.subscription!.every(id => owner.lines.includes(`openai · ChatGPT pro subscription · ${id} · served`)))
check('the same lacking id reads served under the key source, whose list still serves it', retired.every(id => owner.lines.includes(`openai · OpenAI API key (env) · ${id} · served`)))
check(`the summary counts them (${retired.length})`, owner.lines.some(l => l.startsWith(`typed model ids: ${retired.length} typed id(s) not served`)), owner.lines.at(-1))
lists.subscription = [...gptIds]

section("§3 a family's list unreachable: its typed ids say so with the status, the other families are still judged, the exit stays on served ids alone")
failing.deepseek = 500
const down = await run()
check('exit 0 (an unreachable list judges nothing)', down.status === 0, `status ${down.status}`)
check('every DeepSeek typed id reads unreachable with the HTTP status', lists.deepseek!.every(id => down.lines.some(l => l.startsWith(`deepseek · DeepSeek API key (env) · ${id} · unreachable (`) && l.includes('500'))), down.lines.filter(l => l.startsWith('deepseek')).join('\n'))
check('the other families are still judged served', rows(down, 'openai', 'served').length === gptIds.length * 2 && rows(down, 'moonshot', 'served').length === lists.moonshot!.length)
check('the summary names the fetched-list count short by one', down.lines.some(l => /\(7 of 8 lists fetched\)$/.test(l)), down.lines.at(-1))
delete failing.deepseek

section('§4 a family with no credential is not judged and says so in one line')
const keyless = await run({ ZAI_API_KEY: undefined, MOONSHOT_API_KEY: undefined })
check('exit 0', keyless.status === 0, `status ${keyless.status}`)
check('one line names the Z.AI family as skipped with its typed count', keyless.lines.includes(`zai · no credential · ${lists.zai!.length} typed ids not judged`), keyless.lines.filter(l => l.startsWith('zai')).join('\n'))
check('one line names the Moonshot family as skipped', keyless.lines.includes(`moonshot · no credential · ${lists.moonshot!.length} typed ids not judged`))
check('no Z.AI request or Moonshot list was fetched', !hits.some(h => h.includes('/zai/') || h.endsWith('/moonshot/v1/models')), hits.join(', '))

section('§4b no Anthropic key in the environment: the check still runs, reading any stored credential through the product, and never dies before the first list')
const noEnvKey = await run({ ANTHROPIC_API_KEY: undefined })
check('the script does not die before judging', !noEnvKey.stderr.includes('Config accessed before allowed') && typeof noEnvKey.status === 'number', `status ${noEnvKey.status}; stderr ${noEnvKey.stderr.slice(-240)}`)
check('the Anthropic family reads no credential, every other typed id is still judged, exit 0', noEnvKey.lines.some(l => l.startsWith('anthropic · no credential · ')) && noEnvKey.lines.filter(l => l.endsWith(' · served')).length === typedTotal - anthropicIds.length && noEnvKey.status === 0, noEnvKey.lines.join('\n').slice(0, 600))

section('§5 a stale ChatGPT sign-in is reported, never refreshed: no request to the token endpoint, the auth file untouched')
seedSubscription(Date.now() - 60_000)
const authBefore = readFileSync(join(home, '.openai-auth.json'), 'utf8')
const stale = await run()
check('exit 0 (the subscription list judged nothing; the key list served every id)', stale.status === 0, `status ${stale.status}`)
check('every typed id under the subscription reads unreachable naming the expired token and the road back', gptIds.every(id => stale.lines.some(l => l.startsWith(`openai · ChatGPT pro subscription · ${id} · unreachable (the stored ChatGPT access token has expired`))), stale.lines.filter(l => l.includes('subscription')).slice(0, 3).join('\n'))
check('no subscription models request was made', !hits.some(h => h.endsWith('/openai/chatgpt/models')), hits.join(', '))
check('the stored auth file is byte-identical (no refresh, no rewrite)', readFileSync(join(home, '.openai-auth.json'), 'utf8') === authBefore)
seedSubscription(Date.now() + 24 * 3600_000)

section('§5b --probe-by-completion: a family with no model list (Z.AI) is judged by one minimal completion per typed id, never without the flag')
const [servedGlm, ...unknownGlm] = glmIds
lists.zai = servedGlm === undefined ? [] : [servedGlm]
const probed = await run({}, ['--probe-by-completion'])
check('the typed table carries an id the fixture refuses as unknown (the leg judges something)', servedGlm !== undefined && unknownGlm.length >= 1, glmIds.join(', '))
check('exit 1 (an id the provider refuses as unknown is not served)', probed.status === 1, `status ${probed.status}; stderr ${probed.stderr.slice(-300)}`)
check('the id the provider completed reads served', probed.lines.includes(`zai · Z.AI API key (env) · ${servedGlm} · served`), probed.lines.filter(l => l.startsWith('zai')).join('\n'))
check("an id the provider refuses as unknown reads not served with Z.AI's own code and reason", unknownGlm.every(id => probed.lines.includes(`zai · Z.AI API key (env) · ${id} · not served (zai-1211: Model does not exist, please check the model code.)`)), probed.lines.filter(l => l.startsWith('zai')).join('\n'))
check('one completion per typed id, each naming its id, one token at most, streamed as the chat streams', zaiProbes.length === glmIds.length && glmIds.every(id => zaiProbes.filter(p => p.model === id).length === 1) && zaiProbes.every(p => p.maxTokens === 1 && p.stream === true), JSON.stringify(zaiProbes.map(p => [p.model, p.maxTokens, p.stream])))
check('the completion carried the key as the chat does, and the output never printed it', zaiProbes.every(p => p.bearer === `Bearer ${KEYS.zai}`) && secretLeak(probed) === undefined, secretLeak(probed))
check('no models GET was tried on Z.AI', !hits.some(h => h.startsWith('GET /zai/')), hits.filter(h => h.includes('/zai/')).join(', '))
check('the summary counts the refused id and the probed family among the fetched lists', probed.lines.some(l => l.startsWith(`typed model ids: ${unknownGlm.length} typed id(s) not served`) && / \(9 of 9 lists fetched\)$/.test(l)), probed.lines.at(-1))
check('the other families are judged as before', rows(probed, 'openai', 'served').length === gptIds.length * 2 && rows(probed, 'moonshot', 'served').length === lists.moonshot!.length)
zaiRefusesKey = true
const refusedKey = await run({}, ['--probe-by-completion'])
check('a refused key: every typed id reads unreachable with the auth code, nothing judged, exit 0', refusedKey.status === 0 && glmIds.every(id => refusedKey.lines.includes(`zai · Z.AI API key (env) · ${id} · unreachable (zai-1002: Authentication failed)`)), refusedKey.lines.filter(l => l.startsWith('zai')).join('\n'))
check('the summary leaves the refused family out of the fetched lists', refusedKey.lines.some(l => / \(8 of 9 lists fetched\)$/.test(l)), refusedKey.lines.at(-1))
check('the refused key never printed', secretLeak(refusedKey) === undefined, secretLeak(refusedKey))
zaiRefusesKey = false
const dead = await run({ MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1' }, ['--probe-by-completion'])
check('a dead endpoint: every typed id reads unreachable with the transport failure, never served or not served', dead.status === 0 && glmIds.every(id => dead.lines.some(l => l.startsWith(`zai · Z.AI API key (env) · ${id} · unreachable (`) && !l.includes('zai-'))) && !dead.lines.some(l => l.startsWith('zai') && / · (served|not served)/.test(l)), dead.lines.filter(l => l.startsWith('zai')).join('\n'))
check('no completion reached the fixture', zaiProbes.length === 0)
const noKeyFlag = await run({ ZAI_API_KEY: undefined }, ['--probe-by-completion'])
check('the flag without a Z.AI credential probes nothing and the family reads not judged', noKeyFlag.lines.includes(`zai · no credential · ${glmIds.length} typed ids not judged`) && zaiProbes.length === 0, noKeyFlag.lines.filter(l => l.startsWith('zai')).join('\n'))
lists.zai = [...glmIds]

section('§5c the traffic switch stops the probe: with MERCURY_DISABLE_NONESSENTIAL_TRAFFIC set, --probe-by-completion sends nothing and Z.AI reads the dated table')
const dark = await run({ MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, ['--probe-by-completion'])
check('no completion reached the fixture and no Z.AI request of any kind was made', zaiProbes.length === 0 && !hits.some(h => h.includes('/zai/')), JSON.stringify(zaiProbes.map(p => p.model)))
check('the script says so once, in its own words', dark.lines.filter(l => l === '--probe-by-completion sends nothing: MERCURY_DISABLE_NONESSENTIAL_TRAFFIC is set; the Z.AI ids read the dated table').length === 1, dark.lines.filter(l => l.startsWith('--probe')).join('\n'))
check('the Z.AI ids read their dated-table lines exactly as without the flag', glmIds.every(id => dark.lines.includes(`zai · Z.AI API key (env) · ${id} · no live list — typed table dated ${glmDated}`)) && !dark.lines.some(l => l.startsWith('zai') && / · (served|not served|unreachable)/.test(l)), dark.lines.filter(l => l.startsWith('zai')).join('\n'))
check('Z.AI stays out of the fetched count', dark.lines.some(l => / of 8 lists fetched\)$/.test(l)), dark.lines.at(-1))
check('exit 0 and no credential value in the output', dark.status === 0 && secretLeak(dark) === undefined, `status ${dark.status}`)

section('§5d a dead sign-in page: the line names it, the summary counts it, the exit is 1 while every typed id still reads served')
deadPage = '/pages/auth/clients'
const deadPageRun = await run()
check('exit 1', deadPageRun.status === 1, `status ${deadPageRun.status}`)
check('the clients page reads dead with the status', deadPageRun.lines.some(l => l.startsWith('sign-in page · https://console.developers.google.com/auth/clients · ') && l.endsWith(' · dead (HTTP 404)')), deadPageRun.lines.filter(l => l.startsWith('sign-in page')).join('\n'))
check('the other pages still answer', deadPageRun.lines.filter(l => l.startsWith('sign-in page · ') && l.endsWith(' · answers HTTP 302')).length === pages.length - 1)
check(`the pages summary counts the one dead page of ${pages.length}`, deadPageRun.lines.some(l => l.startsWith(`sign-in pages: 1 of ${pages.length} dead`)), deadPageRun.lines.filter(l => l.startsWith('sign-in pages')).join('\n'))
check('every typed id still reads served (the model-id judgement is untouched)', deadPageRun.lines.filter(l => l.endsWith(' · served')).length === typedTotal && deadPageRun.lines.some(l => l.startsWith('typed model ids: every typed id a fetched list could judge is served')))
deadPage = undefined

section('§6 the check writes nothing under the config home across every run')
check('the home holds the same files with the same sizes and mtimes as before the first run, but the auth file the proof itself rewrote', snapshotHome().split('\n').filter(l => !l.startsWith('.openai-auth.json')).join('\n') === before.split('\n').filter(l => !l.startsWith('.openai-auth.json')).join('\n'), `before:\n${before}\nafter:\n${snapshotHome()}`)
check('the script reads no MERCURY_ flag of its own (every seam rides the product resolvers)', !/process\.env\.MERCURY_|env\.MERCURY_|env\['MERCURY_/.test(readFileSync(SCRIPT, 'utf8')))

server.close()
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
