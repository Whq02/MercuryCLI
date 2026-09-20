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

const gptIds = GPT_DISPLAY_PINS.map(p => p.id)
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
const hits: string[] = []
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
  if (req.method !== 'GET') { json({}); return }
  if (path === '/openai/chatgpt/models') { if (failWith('subscription')) return; json({ models: lists.subscription!.map((slug, i) => ({ slug, display_name: slug, supported_reasoning_levels: ['low', 'high'], visibility: 'list', priority: i + 1 })) }); return }
  if (path === '/openai/v1/models') { if (failWith('apiKey')) return; json({ object: 'list', data: lists.apiKey!.map(id => ({ id, object: 'model' })) }); return }
  if (path === '/anthropic/v1/models') { if (failWith('anthropic')) return; json({ data: lists.anthropic!.map(id => ({ type: 'model', id, display_name: id })), has_more: false }); return }
  if (path === '/gemini/v1beta/models') { if (failWith('gemini')) return; json({ models: lists.gemini!.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'] })) }); return }
  if (path === '/deepseek/models') { if (failWith('deepseek')) return; json({ object: 'list', data: lists.deepseek!.map(id => ({ id, object: 'model', owned_by: 'deepseek' })) }); return }
  if (path === '/openrouter/api/v1/models') { if (failWith('openrouter')) return; json({ data: lists.openrouter!.map(id => ({ id, name: id, pricing: { prompt: '0.000001', completion: '0.000002' } })) }); return }
  if (path === '/hf/v1/models') { if (failWith('huggingface')) return; json({ object: 'list', data: lists.huggingface!.map(id => ({ id, object: 'model', owned_by: id.split('/')[0], providers: [{ provider: 'fixture', status: 'live' }] })) }); return }
  if (path === '/zai/v4/models') { if (failWith('zai')) return; json({ object: 'list', data: lists.zai!.map(id => ({ id, object: 'model' })) }); return }
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
const run = async (extra: Record<string, string | undefined> = {}): Promise<Run> => {
  const env: Record<string, string> = { ...baseEnv }
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v }
  hits.length = 0
  const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
const typedTotal = gptIds.length * 2 + anthropicIds.length + lists.gemini!.length + lists.deepseek!.length + lists.huggingface!.length + lists.zai!.length + lists.moonshot!.length
check('exit 0', all.status === 0, `status ${all.status}; stderr ${all.stderr.slice(-300)}`)
check(`one served line per typed id per fetched list (${typedTotal})`, all.lines.filter(l => l.endsWith(' · served')).length === typedTotal, all.lines.join('\n').slice(0, 1500))
check('no typed id reads not served or unreachable', !all.lines.some(l => / · (not served|unreachable \()/.test(l)), all.lines.filter(l => / · (not served|unreachable)/.test(l)).join('\n'))
check('the two OpenAI sources are judged apart (the subscription list and the key list)', rows(all, 'openai', 'served').some(l => l.includes('ChatGPT pro subscription')) && rows(all, 'openai', 'served').some(l => l.includes('OpenAI API key (env)')))
check('the OpenRouter list, with no typed ids, prints its count', all.lines.some(l => l.startsWith('openrouter · ') && / · 2 served$/.test(l)), all.lines.filter(l => l.startsWith('openrouter')).join('\n'))
check('every fixture list was fetched once', ['/openai/chatgpt/models', '/openai/v1/models', '/anthropic/v1/models', '/gemini/v1beta/models', '/deepseek/models', '/openrouter/api/v1/models', '/hf/v1/models', '/zai/v4/models', '/moonshot/v1/models'].every(p => hits.some(h => h.endsWith(p))), hits.join(', '))
check('the summary line says every judged id is served', all.lines.some(l => l.startsWith('typed model ids: every typed id a fetched list could judge is served')), all.lines.at(-1))
check('no credential value appears in the output', secretLeak(all) === undefined, secretLeak(all))

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
check('the other families are still judged served', rows(down, 'openai', 'served').length === gptIds.length * 2 && rows(down, 'zai', 'served').length === lists.zai!.length)
check('the summary names the fetched-list count short by one', down.lines.some(l => /\(8 of 9 lists fetched\)$/.test(l)), down.lines.at(-1))
delete failing.deepseek

section('§4 a family with no credential is not judged and says so in one line')
const keyless = await run({ ZAI_API_KEY: undefined, MOONSHOT_API_KEY: undefined })
check('exit 0', keyless.status === 0, `status ${keyless.status}`)
check('one line names the Z.AI family as skipped with its typed count', keyless.lines.includes(`zai · no credential · ${lists.zai!.length} typed ids not judged`), keyless.lines.filter(l => l.startsWith('zai')).join('\n'))
check('one line names the Moonshot family as skipped', keyless.lines.includes(`moonshot · no credential · ${lists.moonshot!.length} typed ids not judged`))
check('no Z.AI or Moonshot list was fetched', !hits.some(h => h.endsWith('/zai/v4/models') || h.endsWith('/moonshot/v1/models')), hits.join(', '))

section('§5 a stale ChatGPT sign-in is reported, never refreshed: no request to the token endpoint, the auth file untouched')
seedSubscription(Date.now() - 60_000)
const authBefore = readFileSync(join(home, '.openai-auth.json'), 'utf8')
const stale = await run()
check('exit 0 (the subscription list judged nothing; the key list served every id)', stale.status === 0, `status ${stale.status}`)
check('every typed id under the subscription reads unreachable naming the expired token and the road back', gptIds.every(id => stale.lines.some(l => l.startsWith(`openai · ChatGPT pro subscription · ${id} · unreachable (the stored ChatGPT access token has expired`))), stale.lines.filter(l => l.includes('subscription')).slice(0, 3).join('\n'))
check('no subscription models request was made', !hits.some(h => h.endsWith('/openai/chatgpt/models')), hits.join(', '))
check('the stored auth file is byte-identical (no refresh, no rewrite)', readFileSync(join(home, '.openai-auth.json'), 'utf8') === authBefore)
seedSubscription(Date.now() + 24 * 3600_000)

section('§6 the check writes nothing under the config home across every run')
check('the home holds the same files with the same sizes and mtimes as before the first run, but the auth file the proof itself rewrote', snapshotHome().split('\n').filter(l => !l.startsWith('.openai-auth.json')).join('\n') === before.split('\n').filter(l => !l.startsWith('.openai-auth.json')).join('\n'), `before:\n${before}\nafter:\n${snapshotHome()}`)
check('the script reads no MERCURY_ flag of its own (every seam rides the product resolvers)', !/process\.env\.MERCURY_|env\.MERCURY_|env\['MERCURY_/.test(readFileSync(SCRIPT, 'utf8')))

server.close()
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
