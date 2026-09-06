#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const accountName = (() => { try { return userInfo().username } catch { return '' } })()
const OPERATOR_NEEDLE = new RegExp(
  ['github', 'hermes', 'tempest', ...(accountName ? [accountName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] : [])].join('|'),
  'i',
)

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir)
    if (up === dir) return process.cwd()
    dir = up
  }
  return dir
}

delete process.env.NODE_ENV
delete process.env.CI
for (const key of [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'MERCURY_CUSTOM_MODEL_OPTION',
  'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'BRAVE_API_KEY', 'TAVILY_API_KEY',
  'MERCURY_SEARCH_BACKEND', 'MERCURY_SEARCH_KEYLESS', 'MERCURY_SEARCH_DDG_HTML_URL',
  'MERCURY_SEARCH_DDG_LITE_URL', 'MERCURY_SEARCH_BRAVE_URL', 'MERCURY_SEARCH_TAVILY_URL',
  'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_SCRIPTED_STREAM',
]) {
  delete process.env[key]
}
const scratch = mkdtempSync(join(tmpdir(), 'websearch-doors-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const PORT = 41211

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — websearch doors prover exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const { startSearchFixture } = await import('./lib/searchFixture.ts')
const fixture = await startSearchFixture(PORT)
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { WebSearchTool } = await import('../../src/tools/WebSearchTool/WebSearchTool.js')
const { ProviderSearchTool } = await import('../../src/tools/WebSearchTool/ProviderSearchTool.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const secrets = await import('../../src/utils/router/providerSecrets.js')
const pacing = await import('../../src/services/search/searchPacing.js')
const { keylessSearch } = await import('../../src/services/search/duckduckgo.js')
const { KEYED_DOOR_REMEDY } = await import('../../src/services/search/searchContract.js')

function seedHome(model: string): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model }))
  resetSettingsCache()
  process.env.MERCURY_MODEL = model
}

function makeContext(model: string): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = { toolPermissionContext, effortValue: undefined }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    agentId: undefined,
    options: {
      mainLoopModel: model,
      isNonInteractiveSession: true,
      thinkingConfig: { type: 'disabled' as const },
      agentDefinitions: { activeAgents: [] },
      appendSystemPrompt: undefined,
    },
  }
}

type ToolOutput = {
  query: string
  results: Array<{ tool_use_id: string; content: Array<{ title: string; url: string; snippet?: string }> } | string>
  durationSeconds: number
  via?: string
  tier?: string
  notes?: string[]
}

type SearchToolLike = typeof WebSearchTool | typeof ProviderSearchTool

async function runSearchTool(tool: SearchToolLike, model: string, input: Record<string, unknown>, opts: { keepPacing?: boolean } = {}): Promise<{ output?: ToolOutput; error?: Error; perLane: Record<string, number> }> {
  seedHome(model)
  if (!opts.keepPacing) pacing.resetSearchPacing()
  const before = fixture.hits.length
  let output: ToolOutput | undefined
  let error: Error | undefined
  try {
    const answer = (await tool.call(input as never, makeContext(model) as never, undefined as never, undefined as never, () => {})) as { data: ToolOutput }
    output = answer.data
  } catch (err) {
    error = err as Error
  }
  const perLane: Record<string, number> = {}
  for (const hit of fixture.hits.slice(before)) perLane[hit.lane] = (perLane[hit.lane] ?? 0) + 1
  return { ...(output ? { output } : {}), ...(error ? { error } : {}), perLane }
}
const runTool = (model: string, input: Record<string, unknown>, opts: { keepPacing?: boolean } = {}) => runSearchTool(WebSearchTool, model, input, opts)
const runProvider = (model: string, input: Record<string, unknown>) => runSearchTool(ProviderSearchTool, model, input)

const modelText = (output: ToolOutput, tool: SearchToolLike = WebSearchTool): string => {
  const block = tool.mapToolResultToToolResultBlockParam(output as never, 'toolu_doors_1') as { content: string }
  return block.content
}

const QUERY = 'terminal harness for software development'
const NEMOTRON = 'openrouter/nvidia/nemotron-nano-9b-v2:free'

section("§1 NATIVE-ANTHROPIC — ProviderSearch on the session's own wire; the vendored tool never dials it")
{
  process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
  const run = await runProvider('claude-opus-4-8', { query: QUERY, allowed_domains: ['example.org'] })
  check('the ProviderSearch call resolves', run.output !== undefined && run.error === undefined, (run.error?.stack ?? '').slice(0, 400))
  check('exactly one POST, on the anthropic lane only', j(run.perLane) === j({ anthropic: 1 }), j(run.perLane))
  const body = (() => { try { return JSON.parse(fixture.hitsOn('anthropic').at(-1)?.body ?? '{}') as { tools?: Array<Record<string, unknown>> } } catch { return {} as { tools?: Array<Record<string, unknown>> } } })()
  const serverTool = (body.tools ?? []).find(t => t.type === 'web_search_20250305')
  check('the body carries the web_search_20250305 server tool (name, max_uses 8, the call\'s domain filter)',
    serverTool !== undefined && serverTool.name === 'web_search' && serverTool.max_uses === 8 && j(serverTool.allowed_domains) === j(['example.org']), j(body.tools ?? []).slice(0, 300))
  check('via names the door', run.output?.via === 'anthropic-native' && run.output?.tier === 'native', j([run.output?.via, run.output?.tier]))
  const groups = (run.output?.results ?? []).filter((e): e is Exclude<ToolOutput['results'][number], string> => typeof e !== 'string')
  check('the fixture hit folded into a group (example.org admitted by the filter)', groups.length === 1 && groups[0]?.content[0]?.url === 'https://example.org/anthropic-hit', j(groups))
  check('the model commentary folded as a string entry', (run.output?.results ?? []).some(e => typeof e === 'string' && e.includes('fixture-native-commentary')), j(run.output?.results))
  check('the model-facing text names the door and keeps the REMINDER', run.output !== undefined && modelText(run.output, ProviderSearchTool).includes('via Anthropic web search (native)') && modelText(run.output, ProviderSearchTool).includes('REMINDER'), run.output ? modelText(run.output, ProviderSearchTool).slice(0, 200) : '')
  fixture.reset()
  const vendored = await runTool('claude-opus-4-8', { query: QUERY })
  check('the vendored WebSearch on an anthropic home answers KEYLESS with ZERO anthropic hits',
    vendored.output?.via === 'duckduckgo' && (vendored.perLane['anthropic'] ?? 0) === 0 && (vendored.perLane['ddg-html'] ?? 0) === 1, j({ via: vendored.output?.via, lanes: vendored.perLane }))
  delete process.env.ANTHROPIC_API_KEY
  fixture.reset()
}

section('§2 NATIVE-OPENAI + THE REGISTRATION CENSUS — the anthropic spy sees NOTHING')
{
  process.env.OPENAI_API_KEY = 'fixture-openai-key'
  const run = await runProvider('gpt-5.5', { query: QUERY, allowed_domains: ['example.org'] })
  check('the ProviderSearch call resolves', run.output !== undefined && run.error === undefined, (run.error?.stack ?? '').slice(0, 400))
  check('ZERO anthropic hits (the leak\'s exact shape, dead) and zero ddg/brave/tavily', (run.perLane['anthropic'] ?? 0) === 0 && (run.perLane['ddg-html'] ?? 0) === 0 && (run.perLane['brave'] ?? 0) === 0 && (run.perLane['tavily'] ?? 0) === 0, j(run.perLane))
  check('exactly one POST on the openai responses lane', (run.perLane['openai'] ?? 0) === 1, j(run.perLane))
  const body = (() => { try { return JSON.parse(fixture.hitsOn('openai').at(-1)?.body ?? '{}') as Record<string, unknown> } catch { return {} } })()
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  const hosted = tools.find(t => t.type === 'web_search')
  check('the request carries the hosted web_search tool with filters.allowed_domains, and no function tools',
    hosted !== undefined && j((hosted.filters as Record<string, unknown> | undefined)?.allowed_domains) === j(['example.org']) && tools.every(t => t.type !== 'function'), j(tools))
  check('…and stays stateless (store:false)', body.store === false, j(body.store))
  check('via names the door', run.output?.via === 'openai-native' && run.output?.tier === 'native', j([run.output?.via, run.output?.tier]))
  const groups = (run.output?.results ?? []).filter((e): e is Exclude<ToolOutput['results'][number], string> => typeof e !== 'string')
  check('the url_citation folded into the hit group', groups.length === 1 && groups[0]?.content[0]?.url === 'https://example.org/openai-hit' && groups[0]?.content[0]?.title === 'OpenAI Fixture Hit', j(groups))
  check('the answer text folded as commentary', (run.output?.results ?? []).some(e => typeof e === 'string' && e.includes('gpt-native-commentary')), j(run.output?.results))
  seedHome('gpt-5.5')
  check('a gpt home lists BOTH tools', WebSearchTool.isEnabled() === true && ProviderSearchTool.isEnabled() === true)
  seedHome('claude-opus-4-8')
  check('an anthropic home lists BOTH tools', WebSearchTool.isEnabled() === true && ProviderSearchTool.isEnabled() === true)
  seedHome(NEMOTRON)
  const { getMainLoopModel } = await import('../../src/utils/model/model.js')
  check('a nemotron home lists the vendored tool ALONE', WebSearchTool.isEnabled() === true && ProviderSearchTool.isEnabled() === false, `mainModel=${getMainLoopModel()}`)
  seedHome('local/qwen3-coder')
  check('a local home lists the vendored tool ALONE', ProviderSearchTool.isEnabled() === false, `mainModel=${getMainLoopModel()}`)
  const providerPrompt = await ProviderSearchTool.prompt({ getToolPermissionContext: async () => getEmptyToolPermissionContext() } as never)
  const vendoredPrompt = await WebSearchTool.prompt({ getToolPermissionContext: async () => getEmptyToolPermissionContext() } as never)
  check("the prompts are DISTINGUISHABLE and honest: ProviderSearch says provider's OWN + spends this session's account",
    providerPrompt.includes("PROVIDER'S OWN") && providerPrompt.includes("spends this session's own provider account"), providerPrompt.slice(0, 160))
  check('…and WebSearch says vendored + NEVER spends the provider account + names the other door',
    vendoredPrompt.includes('VENDORED') && vendoredPrompt.includes('NEVER spends your provider account') && vendoredPrompt.includes('ProviderSearch'), vendoredPrompt.slice(0, 160))
  delete process.env.OPENAI_API_KEY
  fixture.reset()
}

section('§3 THE SOVEREIGN HOME — the cross-account poison: keyless nemotron:free, zero first-party requests')
{
  const run = await runTool(NEMOTRON, { query: QUERY })
  check('the tool call resolves with NO credential anywhere', run.output !== undefined && run.error === undefined, (run.error?.stack ?? '').slice(0, 400))
  check('the WHOLE request census is EXACTLY one ddg-html POST (zero on the spy, the openai lanes, the keyed doors, anything else pinned)',
    j(run.perLane) === j({ 'ddg-html': 1 }), j(run.perLane))
  const ddgHit = fixture.hitsOn('ddg-html').at(-1)
  check('…as a form POST carrying the query, under the stable Mercury agent, cookie-free',
    ddgHit?.method === 'POST' && (ddgHit?.body ?? '').includes(encodeURIComponent('terminal harness').replace(/%20/g, '+')) && /^Mozilla\/5\.0 \(compatible; Mercury\/[^)]+\)$/.test(ddgHit?.headers['user-agent'] ?? '') && ddgHit?.headers['cookie'] === undefined,
    j({ method: ddgHit?.method, body: (ddgHit?.body ?? '').slice(0, 80), ua: ddgHit?.headers['user-agent'] }))
  check('…and the agent DISCLOSES nothing beyond Mercury/<version> — no +url, no repo, no host (the ruled spelling)',
    !(ddgHit?.headers['user-agent'] ?? '').includes('+') && !OPERATOR_NEEDLE.test(ddgHit?.headers['user-agent'] ?? ''), ddgHit?.headers['user-agent'])
  check('via names the keyless door', run.output?.via === 'duckduckgo' && run.output?.tier === 'keyless', j([run.output?.via, run.output?.tier]))
  const groups = (run.output?.results ?? []).filter((e): e is Exclude<ToolOutput['results'][number], string> => typeof e !== 'string')
  check('the captured page\'s hits came back as ONE plain group (harness.io first, snippet carried)',
    groups.length === 1 && groups[0]?.content[0]?.url === 'https://www.harness.io/' && (groups[0]?.content[0]?.snippet ?? '').includes('software delivery platform'), j(groups[0]?.content[0]))
  check('no commentary strings from a keyless door', (run.output?.results ?? []).every(e => typeof e !== 'string'), j(run.output?.results))
  check('the model-facing text is plain JSON links + the plain keyless via line + the once-per-session key hint (a fresh process\'s first keyless answer)',
    run.output !== undefined && modelText(run.output).includes('Links: [') && modelText(run.output).includes('Searched via DuckDuckGo (keyless).') && modelText(run.output).includes(`Hint (tell the user once): ${KEYED_DOOR_REMEDY}.`), run.output ? modelText(run.output).slice(0, 400) : '')
  fixture.reset()
}

section('§4 KEYED — Brave then Tavily; the order; the override; the key rides only its header')
{
  process.env.BRAVE_API_KEY = 'brave-fixture-key-XYZ'
  let run = await runTool(NEMOTRON, { query: QUERY })
  check('with a Brave key the keyed door answers before keyless', run.output?.via === 'brave' && run.output?.tier === 'keyed' && (run.perLane['ddg-html'] ?? 0) === 0, j([run.output?.via, run.perLane]))
  check('…census exactly {brave:1}', j(run.perLane) === j({ brave: 1 }), j(run.perLane))
  check('the key rode X-Subscription-Token exactly', fixture.hitsOn('brave').at(-1)?.headers['x-subscription-token'] === 'brave-fixture-key-XYZ')
  check('the blocked-host hit is present (no block list asked)', j((run.output?.results ?? [])[0]).includes('blocked.example.net'))
  const braveRendered = run.output ? modelText(run.output) : ''
  check('the key value appears NOWHERE in the output or the model-facing text', !j(run.output).includes('brave-fixture-key-XYZ') && !braveRendered.includes('brave-fixture-key-XYZ'))
  fixture.reset()

  run = await runTool(NEMOTRON, { query: QUERY, blocked_domains: ['blocked.example.net'] })
  check('blocked_domains post-filters the keyed door\'s hits', run.output !== undefined && !j(run.output.results).includes('blocked.example.net'), j(run.output?.results))
  fixture.reset()

  delete process.env.BRAVE_API_KEY
  process.env.TAVILY_API_KEY = 'tavily-fixture-key-ABC'
  run = await runTool(NEMOTRON, { query: QUERY })
  check('with only a Tavily key that door answers', run.output?.via === 'tavily' && run.output?.tier === 'keyed', j(run.output?.via))
  check('…census exactly {tavily:1}', j(run.perLane) === j({ tavily: 1 }), j(run.perLane))
  check('the key rode as the Bearer token', fixture.hitsOn('tavily').at(-1)?.headers['authorization'] === 'Bearer tavily-fixture-key-ABC')
  const tavilyBody = (() => { try { return JSON.parse(fixture.hitsOn('tavily').at(-1)?.body ?? '{}') as Record<string, unknown> } catch { return {} } })()
  check('the Tavily body is the documented shape', tavilyBody.query === QUERY && tavilyBody.search_depth === 'basic' && tavilyBody.include_answer === false, j(tavilyBody))
  fixture.reset()

  process.env.BRAVE_API_KEY = 'brave-fixture-key-XYZ'
  run = await runTool(NEMOTRON, { query: QUERY })
  check('with BOTH keys Brave wins the order', run.output?.via === 'brave', j(run.output?.via))
  fixture.reset()
  process.env.MERCURY_SEARCH_BACKEND = 'tavily'
  run = await runTool(NEMOTRON, { query: QUERY })
  check('MERCURY_SEARCH_BACKEND=tavily names that one door', run.output?.via === 'tavily' && (run.perLane['brave'] ?? 0) === 0, j([run.output?.via, run.perLane]))
  check('…census exactly {tavily:1} even with BOTH keys present', j(run.perLane) === j({ tavily: 1 }), j(run.perLane))
  fixture.reset()
  process.env.MERCURY_SEARCH_BACKEND = 'duckduckgo'
  run = await runTool(NEMOTRON, { query: QUERY })
  check('MERCURY_SEARCH_BACKEND=duckduckgo answers keyless even with keys present', run.output?.via === 'duckduckgo' && (run.perLane['brave'] ?? 0) === 0 && (run.perLane['tavily'] ?? 0) === 0, j([run.output?.via, run.perLane]))
  check("…census exactly {'ddg-html':1}", j(run.perLane) === j({ 'ddg-html': 1 }), j(run.perLane))
  delete process.env.MERCURY_SEARCH_BACKEND
  delete process.env.BRAVE_API_KEY
  delete process.env.TAVILY_API_KEY
  fixture.reset()
}

section('§5 TYPED FAILURES — the challenge, the poison, the fallthroughs, the closed walk')
{
  fixture.modes.ddgHtml = 'anomaly'
  fixture.modes.ddgLite = 'anomaly'
  let run = await runTool(NEMOTRON, { query: QUERY })
  check('the captured 202 challenge on both doors throws ONE rate-limited line naming the challenge and the html door\'s fact',
    run.output === undefined && /rate-limited this client/.test(run.error?.message ?? '') && /bot challenge page/.test(run.error?.message ?? '') && /the html door/.test(run.error?.message ?? ''), run.error?.message)
  fixture.modes.ddgHtml = 'poison'
  fixture.modes.ddgLite = 'poison'
  run = await runTool(NEMOTRON, { query: QUERY })
  check('a changed page shape throws the parse-failed line — no result was guessed',
    run.output === undefined && /shape Mercury does not recognise/.test(run.error?.message ?? '') && /no result was guessed/.test(run.error?.message ?? ''), run.error?.message)
  fixture.modes.ddgHtml = 'entity-poison'
  fixture.modes.ddgLite = 'entity-poison'
  run = await runTool(NEMOTRON, { query: QUERY })
  check('an over-range numeric entity on a RESULTS page settles TYPED (total parse, the literal kept — never a thrown RangeError)',
    run.error === undefined && run.output?.via === 'duckduckgo' && j(run.output?.results).includes('poison &#x110000; title'), run.error?.message ?? j(run.output?.results).slice(0, 200))
  fixture.modes.ddgHtml = 'results'
  fixture.modes.ddgLite = 'results'

  process.env.BRAVE_API_KEY = 'brave-fixture-key-XYZ'
  fixture.modes.brave = 'http-401'
  fixture.reset()
  run = await runTool(NEMOTRON, { query: QUERY })
  check('a keyed 401 FALLS THROUGH to keyless with its note on the result',
    run.output?.via === 'duckduckgo' && (run.output?.notes ?? []).some(n => /Brave Search refused the stored key/.test(n) && /HTTP 401/.test(n)), j(run.output?.notes))
  check('…and the model-facing text carries the note', run.output !== undefined && modelText(run.output).includes('Note: Brave Search refused'), '')
  fixture.modes.brave = 'results'
  delete process.env.BRAVE_API_KEY

  process.env.OPENAI_API_KEY = 'fixture-openai-key'
  fixture.modes.openai = 'http-500'
  fixture.reset()
  run = await runProvider('gpt-5.5', { query: QUERY })
  check('a failing ProviderSearch THROWS its typed line naming the vendored alternative — no harness fallthrough',
    run.output === undefined && /OpenAI web search refused the search/.test(run.error?.message ?? '') && /vendored WebSearch tool is still available/.test(run.error?.message ?? ''), run.error?.message)
  check('…and dialled NO other lane (no anthropic, no ddg, no keyed)',
    (run.perLane['anthropic'] ?? 0) === 0 && (run.perLane['ddg-html'] ?? 0) === 0 && (run.perLane['brave'] ?? 0) === 0 && (run.perLane['tavily'] ?? 0) === 0, j(run.perLane))
  fixture.reset()
  run = await runTool('gpt-5.5', { query: QUERY })
  check("…while the model's own fallback — choosing WebSearch — answers keyless on the same home",
    run.output?.via === 'duckduckgo' && (run.perLane['openai'] ?? 0) === 0 && (run.perLane['anthropic'] ?? 0) === 0, j({ via: run.output?.via, lanes: run.perLane }))
  fixture.modes.openai = 'results'
  delete process.env.OPENAI_API_KEY

  process.env.MERCURY_SEARCH_KEYLESS = '0'
  fixture.reset()
  run = await runTool(NEMOTRON, { query: QUERY })
  check('keyless off + no keys + no native ⇒ the typed no-backend line naming the key door and the flag',
    run.output === undefined && /no open door/.test(run.error?.message ?? '') && /\/router key brave/.test(run.error?.message ?? '') && /MERCURY_SEARCH_KEYLESS=0/.test(run.error?.message ?? ''), run.error?.message)
  check('…and NOTHING was dialled', j(run.perLane) === j({}), j(run.perLane))
  delete process.env.MERCURY_SEARCH_KEYLESS
  fixture.reset()
}

section('§6 A LOCAL MODEL — local/qwen3-coder reads plain JSON, zero model calls')
{
  const run = await runTool('local/qwen3-coder', { query: QUERY })
  check('the local session searches keyless', run.output?.via === 'duckduckgo' && run.output?.tier === 'keyless', j(run.output?.via))
  check("the local session's census is EXACTLY one ddg-html POST — zero on every model lane and every keyed door", j(run.perLane) === j({ 'ddg-html': 1 }), j(run.perLane))
  check('the result is plain data a local model reads (title/url/snippet strings only)',
    (run.output?.results ?? []).every(e => typeof e !== 'string' && e.content.every(h => typeof h.title === 'string' && typeof h.url === 'string')), j(run.output?.results).slice(0, 200))
  fixture.reset()
}

section('§7 SCHEMA — the tool\'s own zod parses it; JSON round-trips; a pre-door output still renders')
{
  process.env.BRAVE_API_KEY = 'brave-fixture-key-XYZ'
  const run = await runTool(NEMOTRON, { query: QUERY })
  delete process.env.BRAVE_API_KEY
  const parsed = (WebSearchTool as { outputSchema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } }).outputSchema.safeParse(run.output)
  check('the live output parses under the tool\'s output schema', parsed.success === true, j(parsed.error ?? '').slice(0, 300))
  const roundTripped = JSON.parse(JSON.stringify(run.output)) as ToolOutput
  check('…and survives the JSON round-trip byte-equal', j(roundTripped) === j(run.output))
  check('the output keys are exactly the declared ones', j(Object.keys(run.output ?? {}).sort()) === j(['durationSeconds', 'query', 'results', 'tier', 'via'].sort()), j(Object.keys(run.output ?? {})))
  const legacy: ToolOutput = { query: 'old', results: [{ tool_use_id: 'srvtoolu_old', content: [{ title: 'T', url: 'https://x.org/' }] }, 'old commentary'], durationSeconds: 1.2 }
  const legacyParsed = (WebSearchTool as { outputSchema: { safeParse: (v: unknown) => { success: boolean } } }).outputSchema.safeParse(legacy)
  check('a pre-door persisted output (no via/tier) still satisfies the schema', legacyParsed.success === true)
  check('…and still renders for the model without a via line', modelText(legacy).includes('Links: [') && !modelText(legacy).includes('Searched via'), modelText(legacy).slice(0, 120))
  fixture.reset()
}

section('§8 KEY AT REST — the stored key: mode 600 in the engines\' store, resolved as stored, env wins')
{
  secrets.writeStoredBraveSearchApiKey('stored-brave-key-123')
  const path = secrets.providerSecretsPathForDisplay()
  const mode = statSync(path).mode & 0o777
  check('the store file is mode 600', mode === 0o600, mode.toString(8))
  check('the stored value reads back through its own reader only', secrets.readStoredBraveSearchApiKey() === 'stored-brave-key-123')
  const { resolveBraveSearchApiKey } = await import('../../src/services/search/brave.js')
  check("the resolver answers source 'stored'", resolveBraveSearchApiKey({})?.source === 'stored')
  check("…and an env pin WINS", resolveBraveSearchApiKey({ BRAVE_API_KEY: 'env-wins' })?.key === 'env-wins')
  const run = await runTool(NEMOTRON, { query: QUERY })
  check('the walk sends exactly the stored value', fixture.hitsOn('brave').at(-1)?.headers['x-subscription-token'] === 'stored-brave-key-123')
  check('…and the value appears nowhere in the output or model text', !j(run.output).includes('stored-brave-key-123') && (run.output === undefined || !modelText(run.output).includes('stored-brave-key-123')))
  check('the raw store file never entered the output either', !j(run.output).includes(readFileSync(path, 'utf8').slice(2, 20)))
  secrets.writeStoredBraveSearchApiKey(null)
  check('clear removes the slot', secrets.readStoredBraveSearchApiKey() === undefined)
  fixture.reset()
}

section('§9 THE WEBFETCH PREFLIGHT — first-party policy only for the first party')
{
  process.env.MERCURY_WEBFETCH_PREFLIGHT_URL = `${fixture.base}/api/web/domain_info`
  const { getURLMarkdownContent, clearWebFetchCache, DomainBlockedError, DomainCheckFailedError } = await import('../../src/tools/WebFetchTool/utils.js')
  const fetchDuring = async (url: string): Promise<{ error?: Error; anthropic: number }> => {
    const before = fixture.hitsOn('anthropic').length
    let error: Error | undefined
    try {
      await getURLMarkdownContent(url, new AbortController())
    } catch (err) {
      error = err as Error
    }
    return { ...(error ? { error } : {}), anthropic: fixture.hitsOn('anthropic').length - before }
  }
  seedHome(NEMOTRON)
  clearWebFetchCache()
  const anthropicPathsBefore = fixture.hitsOn('anthropic').length
  const sovereign = await fetchDuring(`https://127.0.0.1:${PORT}/fetch-me/one`)
  check('a nemotron fetch touches ZERO anthropic hosts (no preflight dial)', sovereign.anthropic === 0,
    j(fixture.hitsOn('anthropic').slice(anthropicPathsBefore).map(h => h.path)))
  check('…and its failure (the loopback TLS refusal) is NEVER a preflight verdict',
    !(sovereign.error instanceof DomainBlockedError) && !(sovereign.error instanceof DomainCheckFailedError), sovereign.error?.name)
  seedHome('claude-opus-4-8')
  clearWebFetchCache()
  const firstParty = await fetchDuring(`https://127.0.0.1:${PORT}/fetch-me/two`)
  check('an anthropic-routed fetch DOES preflight (the spy bites — exactly one policy dial)', firstParty.anthropic === 1, String(firstParty.anthropic))
  check('…at the policy path', fixture.hitsOn('anthropic').at(-1)?.path.startsWith('/api/web/domain_info?domain=127.0.0.1') === true, fixture.hitsOn('anthropic').at(-1)?.path)
  delete process.env.MERCURY_WEBFETCH_PREFLIGHT_URL
  const utilsSource = readFileSync(join(repoRoot(), 'src/tools/WebFetchTool/utils.ts'), 'utf8')
  check('the gate is the routing law in the source (the production host is hardcoded, so the anthropic arm is source-pinned)',
    /!skipPreflight && declaredRouteOf\(getMainLoopModel\(\)\) === 'anthropic'/.test(utilsSource))
  const { getWebFetchUserAgent } = await import('../../src/utils/http.js')
  const webFetchUa = getWebFetchUserAgent()
  check('the WebFetch agent presents Mercury/<version> and DISCLOSES nothing (no +url, no repo, no operator)',
    /^Mozilla\/5\.0 \(compatible; Mercury\/[^)]+\)$/.test(webFetchUa) && !webFetchUa.includes('+') && !OPERATOR_NEEDLE.test(webFetchUa), webFetchUa)
  fixture.reset()
}

section('§10 PACING — a rate limit is a WAIT: one retry, a cool-down, the ONE line with the way out, no knock inside the window')
{
  const ddgKnocks = (): Array<{ lane: string; at: number }> => fixture.hits.filter(h => h.lane === 'ddg-html' || h.lane === 'ddg-lite').map(h => ({ lane: h.lane, at: h.at }))
  fixture.modes.ddgHtml = 'anomaly'
  fixture.modes.ddgLite = 'anomaly'
  fixture.reset()
  const started = Date.now()
  let run = await runTool(NEMOTRON, { query: QUERY })
  const elapsedMs = Date.now() - started
  let line = run.error?.message ?? ''
  check('both doors challenged ⇒ ONE rate-limited line naming the challenge, the html door, the retry and the cool-down opened',
    run.output === undefined && /rate-limited this client/.test(line) && /bot challenge page/.test(line) && /the html door: rate-limited/.test(line) && /the same on one retry after \d\.\ds/.test(line) && /cooling down \d+s before the next knock/.test(line) && !line.includes('\n'), line)
  check('…naming the two key commands and the free tiers (no key stored)', line.includes('/router key brave · /router key tavily') && line.includes('free tier'), line)
  check('…and on a nemotron home NO ProviderSearch clause (the family has no native door)', !line.includes('ProviderSearch'), line)
  check('the census is html 2 (one retry) + lite 1', j(run.perLane) === j({ 'ddg-html': 2, 'ddg-lite': 1 }), j(run.perLane))
  const knocks = ddgKnocks()
  const retryGapMs = knocks.length === 3 ? knocks[2]!.at - knocks[1]!.at : -1
  check('the retry waited the jittered back-off (1.5–3 s after the lite knock) — read off the wire', retryGapMs >= 1_400 && retryGapMs <= 3_600, `${retryGapMs}ms (walk ${elapsedMs}ms)`)
  fixture.reset()
  run = await runTool(NEMOTRON, { query: QUERY }, { keepPacing: true })
  line = run.error?.message ?? ''
  check('a second call inside the window knocks NOTHING', j(run.perLane) === j({}), j(run.perLane))
  check('…and its ONE line names the seconds left on both doors, that no request was made, and the key commands',
    run.output === undefined && /rate-limited this client: cooling down after a rate limit — \d+s left before the next knock \(both doors\); no request was made/.test(line) && line.includes('/router key brave'), line)
  fixture.reset()
  run = await runTool(NEMOTRON, { query: 'a different question' }, { keepPacing: true })
  check("a different query inside the window knocks nothing either — the cool-down is the door's, not the query's", j(run.perLane) === j({}), j(run.perLane))
  check('the ledger holds one window per door, and an untouched door is open',
    pacing.coolDownRemainingMs('duckduckgo', Date.now()) > 0 && pacing.coolDownRemainingMs('duckduckgo-lite', Date.now()) > 0 && pacing.coolDownRemainingMs('brave', Date.now()) === 0)

  fixture.reset()
  run = await runTool('gpt-5.5', { query: QUERY })
  line = run.error?.message ?? ''
  check("on a gpt home the ONE line ends by naming ProviderSearch (the provider's own search) as the other door",
    run.output === undefined && /ProviderSearch \(OpenAI web search, the provider's own search\) is listed for this session — the other door\.$/.test(line) && !line.includes('\n'), line)
  check('…after the key commands, with the census html 2 + lite 1 and ZERO model lanes', line.includes('/router key brave') && line.indexOf('/router key brave') < line.indexOf('ProviderSearch (') && j(run.perLane) === j({ 'ddg-html': 2, 'ddg-lite': 1 }), j(run.perLane))

  fixture.reset()
  fixture.modes.ddgHtml = 'anomaly'
  fixture.modes.ddgLite = 'poison'
  run = await runTool(NEMOTRON, { query: QUERY })
  line = run.error?.message ?? ''
  check('html 202 + lite poison: the line leads with the lite parse fact and carries the html rate limit, its retry and its cool-down',
    run.output === undefined && /shape Mercury does not recognise/.test(line) && /the html door: rate-limited/.test(line) && /one retry after/.test(line) && /cooling down \d+s/.test(line), line)
  fixture.reset()
  fixture.modes.ddgLite = 'results'
  run = await runTool(NEMOTRON, { query: QUERY }, { keepPacing: true })
  check('inside the html cool-down the lite door answers WITHOUT an html knock — census exactly {ddg-lite:1}',
    run.output?.via === 'duckduckgo-lite' && j(run.perLane) === j({ 'ddg-lite': 1 }), j({ via: run.output?.via, lanes: run.perLane, error: run.error?.message }))
  check("…and the result carries the html door's cool-down as a note, in the model text too",
    (run.output?.notes ?? []).some(n => /DuckDuckGo rate-limited this client: cooling down after a rate limit — \d+s left; not knocked/.test(n)) && run.output !== undefined && modelText(run.output).includes('Note: DuckDuckGo rate-limited this client: cooling down'), j(run.output?.notes))
  fixture.modes.ddgHtml = 'results'
  fixture.modes.ddgLite = 'results'

  {
    pacing.resetSearchPacing()
    const anomalyHtml = readFileSync(join(repoRoot(), 'scripts/search/fixtures/ddg-html-anomaly-202.html'), 'utf8')
    const anomalyLite = readFileSync(join(repoRoot(), 'scripts/search/fixtures/ddg-lite-anomaly-202.html'), 'utf8')
    const resultsHtml = readFileSync(join(repoRoot(), 'scripts/search/fixtures/ddg-html-results.html'), 'utf8')
    let knocked = 0
    const refuseTwice = (async (url: string | URL) => {
      knocked++
      const html = String(url).includes('/ddg/html')
      if (html && knocked >= 3) return new Response(resultsHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      return new Response(html ? anomalyHtml : anomalyLite, { status: 202, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch
    const sleeps: number[] = []
    const frozen = { now: () => 0, random: () => 0.5, sleep: async (ms: number) => { sleeps.push(ms) } }
    const landed = await keylessSearch({ query: QUERY }, { fetchImpl: refuseTwice, clock: frozen })
    check('the retry that LANDS answers via the html door after exactly one back-off, with both refusals as notes',
      landed.ok && landed.via === 'duckduckgo' && knocked === 3 && j(sleeps) === j([2_250]) && (landed.notes ?? []).length === 2 && /answered on one retry after 2\.[23]s/.test(landed.notes?.[0] ?? '') && /DuckDuckGo \(lite\) rate-limited/.test(landed.notes?.[1] ?? ''),
      j({ ok: landed.ok, knocked, sleeps, tail: landed.ok ? landed.notes : landed }))
    check("…and an answer clears the door's streak (no cool-down after a landed retry)", pacing.coolDownRemainingMs('duckduckgo', 0) === 0 && pacing.coolDownRemainingMs('duckduckgo-lite', 0) === 0)
    knocked = 0
    const poisonBoth = (async () => {
      knocked++
      return new Response('<html><body><div class="totally-new-shape"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch
    const poisoned = await keylessSearch({ query: QUERY }, { fetchImpl: poisonBoth, clock: frozen })
    check('a changed page shape on both doors is NOT retried (two knocks, no second sleep) and opens no cool-down',
      !poisoned.ok && poisoned.kind === 'parse-failed' && knocked === 2 && sleeps.length === 1 && pacing.coolDownRemainingMs('duckduckgo', 0) === 0, j({ knocked, sleeps, kind: poisoned.ok ? 'ok' : poisoned.kind }))
    pacing.resetSearchPacing()
    const controller = new AbortController()
    const alwaysChallenged = (async (url: string | URL) => new Response(String(url).includes('/ddg/html') ? anomalyHtml : anomalyLite, { status: 202, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const cancelStarted = Date.now()
    setTimeout(() => controller.abort(), 120)
    const cancelled = await keylessSearch({ query: QUERY, signal: controller.signal }, { fetchImpl: alwaysChallenged })
    const cancelMs = Date.now() - cancelStarted
    check("the operator's cancel during the back-off settles ABORTED at once — never a wait to the end of the back-off, never relabelled",
      !cancelled.ok && cancelled.kind === 'aborted' && cancelMs < 1_200, j({ kind: cancelled.ok ? 'ok' : cancelled.kind, cancelMs }))
    pacing.resetSearchPacing()
  }
  fixture.reset()
}

section("§11 THE SESSION CACHE — the same query answers with ZERO knocks and says so; the hint rides once; the owner's laws")
{
  fixture.reset()
  let run = await runTool(NEMOTRON, { query: QUERY })
  const first = run.output
  const groupOf = (output: ToolOutput | undefined): string => {
    const head = output?.results[0]
    return head !== undefined && typeof head !== 'string' ? head.tool_use_id : ''
  }
  const hitsOf = (output: ToolOutput | undefined): string => {
    const head = output?.results[0]
    return head !== undefined && typeof head !== 'string' ? j(head.content) : ''
  }
  check("a fresh process's first keyless answer carries the key-door hint (both commands, the free tiers)", first?.hint === KEYED_DOOR_REMEDY && first.hint.includes('/router key brave') && first.hint.includes('/router key tavily') && first.hint.includes('free tier'), j(first?.hint))
  check('…its group id is minted fresh (via-N)', /^duckduckgo-\d+$/.test(groupOf(first)), groupOf(first))
  fixture.reset()
  run = await runTool(NEMOTRON, { query: QUERY }, { keepPacing: true })
  const second = run.output
  check('the same query again knocks NOTHING', j(run.perLane) === j({}), j(run.perLane))
  check('…answered from the cache: cached=true, via/tier kept, the note names the door and the cache',
    second?.cached === true && second.via === 'duckduckgo' && second.tier === 'keyless' && (second.notes ?? []).some(n => /answered from this session's search cache — the same query landed via DuckDuckGo within the last 10 minutes; no door was knocked/.test(n)),
    j({ cached: second?.cached, via: second?.via, notes: second?.notes, error: run.error?.message }))
  check('…the same hits, under a FRESH group id', hitsOf(second) !== '' && hitsOf(second) === hitsOf(first) && groupOf(second) !== groupOf(first) && /^duckduckgo-\d+$/.test(groupOf(second)), j([groupOf(first), groupOf(second)]))
  check('…and NO hint the second time (once per process): the model text names the cache and carries no Hint line',
    second?.hint === undefined && second !== undefined && modelText(second).includes("Note: answered from this session's search cache") && !modelText(second).includes('Hint ('), second ? modelText(second).slice(0, 300) : '')
  check("the cached output still parses under the tool's schema and round-trips",
    (WebSearchTool as { outputSchema: { safeParse: (v: unknown) => { success: boolean } } }).outputSchema.safeParse(second).success === true && j(JSON.parse(j(second))) === j(second))
  fixture.reset()
  run = await runTool(NEMOTRON, { query: QUERY, blocked_domains: ['blocked.example.net'] }, { keepPacing: true })
  check('the same words with a domain filter is a different search — it knocks', j(run.perLane) === j({ 'ddg-html': 1 }) && run.output?.cached === undefined, j(run.perLane))
  fixture.reset()
  run = await runTool(NEMOTRON, { query: 'a different question' }, { keepPacing: true })
  check('a different query knocks', j(run.perLane) === j({ 'ddg-html': 1 }), j(run.perLane))
  fixture.reset()
  process.env.BRAVE_API_KEY = 'brave-fixture-key-XYZ'
  run = await runTool(NEMOTRON, { query: QUERY })
  check('a keyed answer carries NO hint (a key is stored)', run.output?.via === 'brave' && run.output.hint === undefined, j(run.output?.hint))
  fixture.reset()
  run = await runTool(NEMOTRON, { query: QUERY }, { keepPacing: true })
  check('…and is cached like any other: the same query again, zero knocks, via brave kept, the note naming Brave Search',
    j(run.perLane) === j({}) && run.output?.cached === true && run.output.via === 'brave' && (run.output.notes ?? []).some(n => n.includes('landed via Brave Search')), j({ lanes: run.perLane, notes: run.output?.notes }))
  delete process.env.BRAVE_API_KEY

  pacing.resetSearchPacing()
  const req = { query: 'ttl' }
  const answer = { via: 'duckduckgo' as const, tier: 'keyless' as const, hits: [{ title: 't', url: 'https://x.org/' }], queries: ['ttl'] }
  pacing.rememberSearch(req, answer, 1_000)
  check('the TTL: inside ten minutes the cache answers, one millisecond past it does not',
    pacing.takeCachedSearch(req, 1_000 + pacing.SEARCH_CACHE_TTL_MS)?.via === 'duckduckgo' && pacing.takeCachedSearch(req, 1_000 + pacing.SEARCH_CACHE_TTL_MS + 1) === undefined)
  for (let i = 0; i < pacing.SEARCH_CACHE_ENTRIES + 6; i++) pacing.rememberSearch({ query: `q${i}` }, answer, 2_000)
  check('the bound: 64 entries, the least recently used out first',
    pacing.takeCachedSearch({ query: 'q0' }, 2_000) === undefined && pacing.takeCachedSearch({ query: 'q5' }, 2_000) === undefined && pacing.takeCachedSearch({ query: 'q6' }, 2_000) !== undefined && pacing.takeCachedSearch({ query: `q${pacing.SEARCH_CACHE_ENTRIES + 5}` }, 2_000) !== undefined)
  pacing.rememberSearch({ query: 'fresh' }, answer, 2_000)
  check('a hit refreshes recency: q6, just taken, survives the next eviction; q7 goes', pacing.takeCachedSearch({ query: 'q6' }, 2_000) !== undefined && pacing.takeCachedSearch({ query: 'q7' }, 2_000) === undefined)
  check('the identity: the query trimmed, the domain lists order-free and case-free, both lists part of it',
    pacing.searchCacheKey({ query: ' a ', allowedDomains: ['B.com', 'a.com'] }) === pacing.searchCacheKey({ query: 'a', allowedDomains: ['a.com', 'b.com'] }) && pacing.searchCacheKey({ query: 'a' }) !== pacing.searchCacheKey({ query: 'a', blockedDomains: ['x.org'] }))
  const half = () => 0.5
  check('the window law: 30 s, doubling per repeat, capped at ten minutes, ±25 % jitter',
    pacing.coolDownWindowMs(1, half) === 30_000 && pacing.coolDownWindowMs(2, half) === 60_000 && pacing.coolDownWindowMs(3, half) === 120_000 && pacing.coolDownWindowMs(9, half) === 600_000 && pacing.coolDownWindowMs(1, () => 0) === 22_500 && pacing.coolDownWindowMs(1, () => 0.9999) <= 37_500 && pacing.coolDownWindowMs(1, () => 0.9999) > 37_000)
  const clockAt = (t: number) => ({ now: () => t, random: half })
  pacing.resetSearchPacing()
  const w1 = pacing.noteRateLimited('duckduckgo', clockAt(0))
  const w2 = pacing.noteRateLimited('duckduckgo', clockAt(w1))
  const inside = pacing.coolDownRemainingMs('duckduckgo', w1 + 1_000)
  const otherDoor = pacing.coolDownRemainingMs('duckduckgo-lite', w1)
  pacing.noteAnswered('duckduckgo')
  check('the ledger: a refusal opens the window, a repeat inside the streak doubles it, another door is untouched, an answer clears it',
    w1 === 30_000 && w2 === 60_000 && inside === 59_000 && otherDoor === 0 && pacing.coolDownRemainingMs('duckduckgo', w1) === 0, j([w1, w2, inside, otherDoor]))
  const w3 = pacing.noteRateLimited('brave', clockAt(0))
  const w4 = pacing.noteRateLimited('brave', clockAt(2 * pacing.COOL_DOWN_CAP_MS + 1))
  check('a streak long expired decays: a refusal past the decay window opens the base window again', w3 === 30_000 && w4 === 30_000, j([w3, w4]))
  check('secondsLeftLabel rounds UP and speaks minutes', pacing.secondsLeftLabel(27_400) === '28s' && pacing.secondsLeftLabel(250_000) === '4m 10s' && pacing.secondsLeftLabel(600_000) === '10m' && pacing.secondsLeftLabel(1) === '1s')
  check('the retry back-off spans 1.5–3 s', pacing.retryBackoffMs(() => 0) === 1_500 && pacing.retryBackoffMs(() => 1) === 3_000)
  pacing.resetSearchPacing()
  fixture.reset()
}

section("§12 KEYED PACING — a Brave 429 falls through with its note and opens Brave's cool-down; the next call skips Brave without a knock")
{
  process.env.BRAVE_API_KEY = 'brave-fixture-key-XYZ'
  fixture.modes.brave = 'http-429'
  fixture.reset()
  let run = await runTool(NEMOTRON, { query: QUERY })
  check('a keyed 429 falls through to keyless with its rate-limit note — census {brave:1, ddg-html:1}',
    run.output?.via === 'duckduckgo' && (run.output.notes ?? []).some(n => /Brave Search rate-limited this client: HTTP 429/.test(n)) && j(run.perLane) === j({ brave: 1, 'ddg-html': 1 }), j({ via: run.output?.via, notes: run.output?.notes, lanes: run.perLane, error: run.error?.message }))
  check('…and no key hint (a key is stored; the hint is for the keyless-only walk)', run.output?.hint === undefined)
  fixture.reset()
  run = await runTool(NEMOTRON, { query: 'a second question' }, { keepPacing: true })
  check("the next call inside Brave's cool-down skips Brave WITHOUT a knock — census exactly {ddg-html:1}, the note naming the seconds left",
    j(run.perLane) === j({ 'ddg-html': 1 }) && (run.output?.notes ?? []).some(n => /Brave Search rate-limited this client: cooling down after a rate limit — \d+s left; not knocked/.test(n)), j({ lanes: run.perLane, notes: run.output?.notes }))
  fixture.modes.brave = 'results'
  fixture.reset()
  run = await runTool(NEMOTRON, { query: 'a third question' })
  check("a fresh process knocks Brave again, and an answer leaves its door open", run.output?.via === 'brave' && pacing.coolDownRemainingMs('brave', Date.now()) === 0, j(run.output?.via))
  delete process.env.BRAVE_API_KEY
  fixture.reset()
}

section("§13 THE BUILT BUNDLE — a headless gpt session on dist/mercury.mjs: the operator's walk, twice, read off the wire")
{
  const DIST = join(repoRoot(), 'dist', 'mercury.mjs')
  const nodeBin = typeof Bun !== 'undefined' ? Bun.which('node') : process.execPath
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
  } else if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    type Body = { tools?: Array<{ name?: string }>; input?: Array<Record<string, unknown>> }
    const openaiBodies = (): Body[] => fixture.hitsOn('openai').map(h => { try { return JSON.parse(h.body) as Body } catch { return {} } })
    const toolResults = (): string[] => [...new Set(openaiBodies().flatMap(body => (body.input ?? []).filter(i => i.type === 'function_call_output').map(i => (typeof i.output === 'string' ? i.output : j(i.output)))))]
    const censusNow = (): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const h of fixture.hits) out[h.lane] = (out[h.lane] ?? 0) + 1
      return out
    }
    const ddgKnocks = (): Array<{ lane: string; at: number }> => fixture.hits.filter(h => h.lane === 'ddg-html' || h.lane === 'ddg-lite').map(h => ({ lane: h.lane, at: h.at }))
    function headless(prompt: string): Promise<{ exit: number | null; stdout: string; stderr: string }> {
      const homeDir = mkdtempSync(join(scratch, 'bundle-home-'))
      const cwd = mkdtempSync(join(scratch, 'bundle-cwd-'))
      const env: Record<string, string> = {
        HOME: homeDir,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'dumb',
        MERCURY_CONFIG_DIR: join(homeDir, '.mercury'),
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_DAEMON_DIR: join(homeDir, 'daemon'),
        MERCURY_TEAMS_DIR: join(homeDir, 'teams'),
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_TOOL_SEARCH: '0',
        OPENAI_API_KEY: 'fixture-openai-key',
        ...fixture.env,
      }
      return new Promise(resolve => {
        const child = spawn(nodeBin, [DIST, '-p', prompt, '--model', 'gpt-5.5', '--output-format', 'stream-json', '--allowed-tools', 'WebSearch', 'ProviderSearch'], { cwd, env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolve({ exit, stdout, stderr })
        })
      })
    }
    const ask = { name: 'WebSearch', input: { query: QUERY } }

    fixture.modes.ddgHtml = 'results'
    fixture.modes.ddgLite = 'results'
    fixture.reset()
    fixture.script = [{ call: ask }, { call: ask }, { final: 'J1-DONE' }]
    let r = await headless('search the web for a terminal harness')
    check('journey 1 (the doors answer): the shipped bundle runs the gpt session to its final text', r.exit === 0 && r.stdout.includes('J1-DONE'), `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
    let results = toolResults()
    check('…two WebSearch results reached the wire', results.length === 2, j(results.map(t => t.slice(0, 120))))
    check('…the first answers keyless with the plain via line and the key hint ONCE',
      (results[0] ?? '').includes('Searched via DuckDuckGo (keyless).') && (results[0] ?? '').includes(`Hint (tell the user once): ${KEYED_DOOR_REMEDY}.`) && (results[0] ?? '').includes('Links: ['), (results[0] ?? '').slice(0, 300))
    check('…the second is the cache: the note, the links, NO hint',
      (results[1] ?? '').includes("Note: answered from this session's search cache") && (results[1] ?? '').includes('Links: [') && !(results[1] ?? '').includes('Hint ('), (results[1] ?? '').slice(0, 300))
    let census = censusNow()
    check('…the census: ONE ddg-html knock for two searches, three model turns, zero on the spy and the keyed doors',
      census['ddg-html'] === 1 && census['ddg-lite'] === undefined && census['openai'] === 3 && census['anthropic'] === undefined && census['brave'] === undefined && census['tavily'] === undefined, j(census))

    fixture.modes.ddgHtml = 'anomaly'
    fixture.modes.ddgLite = 'anomaly'
    fixture.reset()
    fixture.script = [{ call: ask }, { call: ask }, { final: 'J2-DONE' }]
    r = await headless('search the web for a terminal harness')
    check('journey 2 (both doors challenged): the session runs to its final text', r.exit === 0 && r.stdout.includes('J2-DONE'), `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
    results = toolResults()
    check('…two distinct tool results', results.length === 2, j(results))
    const firstLine = results[0] ?? ''
    const secondLine = results[1] ?? ''
    check('…the first is the ONE line: the challenge on both doors, one retry, the cool-down opened, the key commands, the ProviderSearch door',
      /rate-limited this client/.test(firstLine) && /bot challenge page/.test(firstLine) && /the same on one retry after \d\.\ds/.test(firstLine) && /cooling down \d+s before the next knock/.test(firstLine) && firstLine.includes('/router key brave · /router key tavily') && /ProviderSearch \(OpenAI web search, the provider's own search\) is listed for this session — the other door\./.test(firstLine) && !firstLine.replace(/\[tool error\] |<\/?tool_use_error>/g, '').trim().includes('\n'),
      firstLine)
    check('…the second, inside the window, names the seconds left, that no request was made, and the ProviderSearch door',
      /cooling down after a rate limit — \d+s left before the next knock \(both doors\); no request was made/.test(secondLine) && secondLine.includes('ProviderSearch ('), secondLine)
    census = censusNow()
    check('…the wire: html 2 (one retry) + lite 1 for TWO searches — the second knocked nothing', census['ddg-html'] === 2 && census['ddg-lite'] === 1 && census['openai'] === 3, j(census))
    const k = ddgKnocks()
    const gap = k.length === 3 ? k[2]!.at - k[1]!.at : -1
    check('…and the retry waited the back-off on the wire (1.5–3 s)', gap >= 1_400 && gap <= 3_600, `${gap}ms`)
    fixture.script = null
    fixture.modes.ddgHtml = 'results'
    fixture.modes.ddgLite = 'results'
    fixture.reset()
  }
}

await fixture.close()
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
clearTimeout(guard)
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ WEBSEARCH DOORS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} WEBSEARCH DOORS FAILURE(S)`)
process.exit(1)
