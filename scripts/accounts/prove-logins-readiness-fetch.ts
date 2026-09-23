#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'logins-readiness-fetch-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CUSTOM_OAUTH_URL = 'http://127.0.0.1:1'
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'OPENROUTER_API_KEY', 'MERCURY_MODEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'CI', 'NODE_ENV']) delete process.env[key]
for (const base of ['MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_GEMINI_OAUTH_AUTH_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE']) process.env[base] = 'http://127.0.0.1:1'
const FIXTURE_KEY = 'proof-key-ci-gate-not-a-real-key'
writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3, theme: 'dark', customApiKeyResponses: { approved: [FIXTURE_KEY.slice(-20)], rejected: [] } }))
writeFileSync(join(HOME, 'settings.json'), '{}')

const hits: string[] = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? '').split('?')[0] ?? ''
  hits.push(`${req.method} ${path}`)
  const json = (body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (path === '/openai/v1/models') { json({ object: 'list', data: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-7-fixture'].map(id => ({ id, object: 'model' })) }); return }
  if (path === '/anthropic/v1/models') { json({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { type: 'model', id: 'claude-opus-5-7', display_name: 'Claude Opus 5.7' }], has_more: false }); return }
  if (path === '/gemini/v1beta/models') { json({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] }] }); return }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
process.env.MERCURY_OPENAI_API_BASE = `${base}/openai/v1`
process.env.ANTHROPIC_BASE_URL = `${base}/anthropic`
process.env.MERCURY_GEMINI_API_BASE = `${base}/gemini/v1beta`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const settle = (ms = 60): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await settle(10)
  }
  return predicate()
}
const count = (path: string): number => hits.filter(h => h === `GET ${path}`).length

const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const openaiCatalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const geminiCatalogue = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const anthropicCatalogue = await import('../../src/services/providers/anthropic/anthropicCatalogue.ts')
const { getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
const PENDING = 'live catalogue not fetched yet — retry shortly'

section('§1 a ChatGPT/OpenAI sign-in on a Claude seat: the passive read asks nothing and says not fetched; the card\'s read fetches once; the row flips')
{
  process.env.OPENAI_API_KEY = 'fixture-openai-key-0001'
  process.env.ANTHROPIC_API_KEY = FIXTURE_KEY
  openaiCatalogue.__resetOpenaiCatalogueForTest()
  anthropicCatalogue.__resetAnthropicCatalogueForTest()
  hits.length = 0
  const passive = resolveProviderUsability()
  await settle()
  check('the passive read: the OpenAI row reads not fetched yet', !passive.openai.usable && passive.openai.blockers[0] === PENDING, JSON.stringify(passive.openai))
  check('the passive read makes no request of any family', hits.length === 0, hits.join(', '))
  resolveProviderUsability()
  await settle()
  check('a second passive read still asks nothing', hits.length === 0, hits.join(', '))
  const e0 = catalogueEpoch()
  const asked = resolveProviderUsability(undefined, { fetchCatalogues: true })
  check("the card's read still says not fetched on the same tick (the fetch is in flight)", !asked.openai.usable && asked.openai.blockers[0] === PENDING, JSON.stringify(asked.openai))
  check('the landing bumps the catalogue epoch (the card re-reads on it)', await waitFor(() => catalogueEpoch() > e0), `${e0} → ${catalogueEpoch()}`)
  check("the card's read fetched the OpenAI list exactly once", count('/openai/v1/models') === 1, hits.join(', '))
  const landed = resolveProviderUsability()
  check('after the landing the row reads the catalogue state: ready', landed.openai.usable && landed.openai.blockers.length === 0, JSON.stringify(landed.openai))
  resolveProviderUsability(undefined, { fetchCatalogues: true })
  await settle()
  check('a second card read inside the TTL asks nothing more', count('/openai/v1/models') === 1, hits.join(', '))
}

section('§2 the Anthropic door: the card\'s read fetches every signed-in door once; the readiness words stay ready on the credential')
{
  anthropicCatalogue.__resetAnthropicCatalogueForTest()
  hits.length = 0
  const before = resolveProviderUsability()
  await settle()
  check('the passive read makes no Anthropic list request and the row reads ready on the credential', count('/anthropic/v1/models') === 0 && before.anthropic.usable && before.anthropic.credential === 'api-key' && before.anthropic.blockers.length === 0, JSON.stringify(before.anthropic))
  check('the door is pending before the card asks', anthropicCatalogue.anthropicCatalogueDoorStates().map(s => `${s.door}:${s.state}`).join(',') === 'api-key:pending')
  const e0 = catalogueEpoch()
  resolveProviderUsability(undefined, { fetchCatalogues: true })
  check('the landing bumps the epoch', await waitFor(() => catalogueEpoch() > e0), `${e0} → ${catalogueEpoch()}`)
  check("the card's read fetched the Anthropic list exactly once", count('/anthropic/v1/models') === 1, hits.join(', '))
  const after = resolveProviderUsability()
  check('the Anthropic row keeps the same words after the landing (the list never gates the credential)', JSON.stringify(after.anthropic) === JSON.stringify(before.anthropic), JSON.stringify(after.anthropic))
  check('the door reads ready with its count', anthropicCatalogue.anthropicCatalogueDoorStates().map(s => `${s.door}:${s.state}${s.state === 'ready' ? `:${s.count}` : ''}`).join(',') === 'api-key:ready:2')
  const rows = getModelOptions({ anthropicCredentialed: () => true }).filter(o => o.group === undefined).map(o => o.value)
  check('the picker composed after the card lists the live id the table lacks', rows.includes('claude-opus-5-7') && rows.at(-1) === 'claude-opus-5-7', rows.join(','))
  check('the picker composition made no Anthropic request of its own', count('/anthropic/v1/models') === 1, hits.join(', '))
}

section('§3 Gemini, the verified non-defect: the /logins row is a presence row and never reads a catalogue; the picker\'s own read kicks the refresh and flips through the epoch')
{
  process.env.GEMINI_API_KEY = 'fixture-gemini-key-0001'
  geminiCatalogue.__resetGeminiCatalogueForTest()
  hits.length = 0
  const passive = resolveProviderUsability()
  await settle()
  check('the Gemini readiness row reads ready on the key with no catalogue words', passive.gemini.usable && passive.gemini.credential === 'api-key' && passive.gemini.blockers.length === 0, JSON.stringify(passive.gemini))
  resolveProviderUsability(undefined, { fetchCatalogues: true })
  await settle()
  check('neither the passive read nor the card read asks Gemini for its list', count('/gemini/v1beta/models') === 0, hits.join(', '))
  const e0 = catalogueEpoch()
  const pending = geminiCatalogue.getGeminiAvailability()
  check("the picker's availability read reports pending in the same words and kicks its own refresh", pending.state === 'disabled' && pending.why === 'catalogue-pending' && pending.reason === PENDING, JSON.stringify(pending))
  check('the refresh lands and bumps the epoch, so the picker group flips in place', await waitFor(() => catalogueEpoch() > e0) && count('/gemini/v1beta/models') === 1, hits.join(', '))
  const ready = geminiCatalogue.getGeminiAvailability()
  check('the availability now reads ready with the live id', ready.state === 'ready' && ready.ids.join(',') === 'gemini-2.5-pro', JSON.stringify(ready))
  delete process.env.GEMINI_API_KEY
}

section('§4 traffic off: the card\'s read asks nothing and the OpenAI row names the switch, never retry shortly')
{
  openaiCatalogue.__resetOpenaiCatalogueForTest()
  anthropicCatalogue.__resetAnthropicCatalogueForTest()
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  hits.length = 0
  const dark = resolveProviderUsability(undefined, { fetchCatalogues: true })
  await settle()
  check('no request of any family', hits.length === 0, hits.join(', '))
  check('the OpenAI row names the switch', !dark.openai.usable && (dark.openai.blockers[0] ?? '').includes('catalogue traffic is off') && !(dark.openai.blockers[0] ?? '').includes('retry shortly'), JSON.stringify(dark.openai))
  check('the Anthropic row is unchanged by the switch', dark.anthropic.usable && dark.anthropic.blockers.length === 0)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
}

section('§5 the two logins surfaces ask on open and re-read on the epoch (call-shaped)')
{
  const card = readFileSync(join(ROOT, 'src/components/ConsoleOAuthFlow.tsx'), 'utf8')
  const block = card.slice(card.indexOf('function ProviderReadinessBlock'))
  check('the readiness block subscribes to the catalogue epoch', block.includes('useCatalogueEpoch()'))
  check('the readiness block asks once on mount, inside an effect, and paints from the passive read', /useEffect\(\(\) => \{\s*resolveProviderUsability\(undefined, \{ fetchCatalogues: true \}\)\s*\}, \[\]\)/.test(block) && block.includes('const map = resolveProviderUsability()'))
  const face = readFileSync(join(ROOT, 'src/components/BootLoginsScreen.tsx'), 'utf8')
  check('the boot logins face asks on mount and re-reads its facts when the epoch moves', face.includes("import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js'") && face.includes('resolveProviderUsability(undefined, { fetchCatalogues: true });') && /catalogueEpoch === mountCatalogueEpoch\.current\) return;\s*if \(given === undefined\) setFacts\(collectLoginsScreenFacts\(\)\);/.test(face))
  const usability = readFileSync(join(ROOT, 'src/services/providers/providerUsability.ts'), 'utf8')
  check('the passive reads bundle never passes fetch and every other caller of the resolver passes no option', usability.includes("gptSeat: () => getGptSeatAvailability(fetch ? { fetch: true } : undefined)") && !/resolveProviderUsability\([^)]*fetchCatalogues/.test(readFileSync(join(ROOT, 'src/services/capFailover.ts'), 'utf8')))
}

server.close()
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ LOGINS READINESS FETCH — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
