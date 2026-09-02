#!/usr/bin/env bun
// ============================================================================
//  scripts/search/prove-websearch-doors.ts — the REAL WebSearchTool driven
//  through every door against ONE loopback fixture (lib/searchFixture.ts —
//  every endpoint the estate can reach pinned to 127.0.0.1; never live
//  network). The Anthropic lane doubles as the FIRST-PARTY SPY: outside §1
//  any hit there is a cross-account leak.
//
//    §1 NATIVE-ANTHROPIC (the ProviderSearch tool — the model-chooses law):
//       an anthropic session's ProviderSearch runs on its own wire — one
//       POST at /v1/messages carrying web_search_20250305 with the call's
//       domain filter and max_uses; hits + commentary fold; via says so; no
//       other lane touched. AND the vendored WebSearch on the SAME home
//       answers KEYLESS with zero anthropic hits — the vendored tool never
//       dials a provider account.
//    §2 NATIVE-OPENAI + THE REGISTRATION CENSUS — a gpt session's
//       ProviderSearch runs on ITS own wire: one POST at
//       /openai/v1/responses carrying the hosted web_search tool with
//       filters.allowed_domains; the web_search_call + url_citation answer
//       folds to hits; ZERO anthropic hits (the 2026-08 leak's exact shape,
//       dead). Census: an anthropic/openai home lists BOTH tools with
//       distinguishable prompts; a nemotron/local home lists the vendored
//       one alone.
//    §3 THE SOVEREIGN HOME (the cross-account POISON, the neutral-home
//       class): a keyless nemotron:free home searches → the DuckDuckGo
//       fixture answers, ZERO requests reach the anthropic or openai lanes,
//       zero model calls anywhere — a local/offline model reads plain JSON.
//    §4 KEYED — a planted Brave key rides X-Subscription-Token (Tavily:
//       Bearer); Brave wins the order; MERCURY_SEARCH_BACKEND redirects;
//       the key VALUE never appears in the output, the model-facing text,
//       or the notes.
//    §5 TYPED FAILURES — the captured 202 challenge reads rate-limited; a
//       changed page shape reads parse-failed; a keyed 401 falls through
//       with its note; a failing ProviderSearch THROWS its typed line
//       naming the vendored alternative and dials NO other lane (the
//       model's fallback is choosing WebSearch — no harness fallthrough);
//       keyless off + no keys throws the no-backend line naming the key
//       door.
//    §6 A LOCAL MODEL — local/qwen3-coder searches keyless; plain JSON.
//    §7 SCHEMA — the output parses under the tool's own zod schema, the
//       results union round-trips JSON, a pre-door persisted output (no
//       via) still renders; the model-facing text keeps Links + REMINDER.
//    §8 KEY AT REST — the stored key writes mode 600 into the engines'
//       secret store, resolves as 'stored', env wins, and the walk sends
//       exactly the stored value.
//
//  Run:  ~/.bun/bin/bun run scripts/search/prove-websearch-doors.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The negative user-agent needle: the private-host words plus the account
// name read at runtime, so the prover asserts "no operator identity rides
// the agent" on every machine without spelling any handle.
const accountName = (() => { try { return userInfo().username } catch { return '' } })()
const OPERATOR_NEEDLE = new RegExp(
  ['github', 'hermes', 'tempest', ...(accountName ? [accountName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] : [])].join('|'),
  'i',
)

/** The repo root by package.json walk — valid from the source file under
 *  bun AND from the node bundle's own location (scripts/search/). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir)
    if (up === dir) return process.cwd()
    dir = up
  }
  return dir
}

// ── hermetic env BEFORE any src import ──────────────────────────────────────
// The VCR arms on NODE_ENV=test alone; the per-lane request COUNTS below are
// the proof the wire was real.
delete process.env.NODE_ENV
delete process.env.CI
for (const key of [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_MODEL_OPTION',
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

function seedHome(model: string): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model }))
  resetSettingsCache()
  // The model ALSO seeds through the ANTHROPIC_MODEL env pin — the retired
  // router-families prover's proven pattern, and the only seed that is
  // immune to module identity: THE NODE-BUNDLE FINDING:
  // bun's bundler emitted TWO instances of
  // src/bootstrap/state.ts in this prover's node bundle (the assignment
  // body twice, two chunks bannered with the same file), so a prover-side
  // settings reset / override write did not reach the copy the engine
  // read and the census saw a stale model. Under bun (unbundled, the
  // pool's runtime) module identity holds and either seed works. Env is
  // process-global — every copy reads it live; WHERE the setting comes
  // from is not under test here.
  process.env.ANTHROPIC_MODEL = model
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

async function runSearchTool(tool: SearchToolLike, model: string, input: Record<string, unknown>): Promise<{ output?: ToolOutput; error?: Error; perLane: Record<string, number> }> {
  seedHome(model)
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
const runTool = (model: string, input: Record<string, unknown>) => runSearchTool(WebSearchTool, model, input)
const runProvider = (model: string, input: Record<string, unknown>) => runSearchTool(ProviderSearchTool, model, input)

const modelText = (output: ToolOutput, tool: SearchToolLike = WebSearchTool): string => {
  const block = tool.mapToolResultToToolResultBlockParam(output as never, 'toolu_doors_1') as { content: string }
  return block.content
}

const QUERY = 'terminal harness for software development'
const NEMOTRON = 'openrouter/nvidia/nemotron-nano-9b-v2:free'

// ---------------------------------------------------------------------------
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
  // THE NEW LAW's other half: the vendored WebSearch on the SAME anthropic
  // home never dials the provider — it answers keyless (no keys stored).
  const vendored = await runTool('claude-opus-4-8', { query: QUERY })
  check('the vendored WebSearch on an anthropic home answers KEYLESS with ZERO anthropic hits',
    vendored.output?.via === 'duckduckgo' && (vendored.perLane['anthropic'] ?? 0) === 0 && (vendored.perLane['ddg-html'] ?? 0) === 1, j({ via: vendored.output?.via, lanes: vendored.perLane }))
  delete process.env.ANTHROPIC_API_KEY
  fixture.reset()
}

// ---------------------------------------------------------------------------
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
  // THE REGISTRATION CENSUS (the model-chooses law): a native family's home
  // lists BOTH tools; a family without a native construct lists the
  // vendored one alone; the prompts carry the distinction the model
  // chooses by.
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

// ---------------------------------------------------------------------------
section('§3 THE SOVEREIGN HOME — the cross-account poison: keyless nemotron:free, zero first-party requests')
{
  const run = await runTool(NEMOTRON, { query: QUERY })
  check('the tool call resolves with NO credential anywhere', run.output !== undefined && run.error === undefined, (run.error?.stack ?? '').slice(0, 400))
  // The census is an EXACT equality map — any unexpected hit
  // on ANY pinned lane fails, not just the named zeros (the spy's limit —
  // unpinned families have no base here — is stated in the fixture header).
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
  check('the model-facing text is plain JSON links + the keyless via line naming the key remedy',
    run.output !== undefined && modelText(run.output).includes('Links: [') && modelText(run.output).includes('via DuckDuckGo (keyless — add a Brave or Tavily key'), run.output ? modelText(run.output).slice(0, 260) : '')
  fixture.reset()
}

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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
  // Door level: a RECOGNISED page carrying a numeric entity
  // above the Unicode range settles as a normal TYPED result with the
  // literal kept — never an untyped RangeError escaping the walk.
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

// ---------------------------------------------------------------------------
section('§6 A LOCAL MODEL — local/qwen3-coder reads plain JSON, zero model calls')
{
  const run = await runTool('local/qwen3-coder', { query: QUERY })
  check('the local session searches keyless', run.output?.via === 'duckduckgo' && run.output?.tier === 'keyless', j(run.output?.via))
  check("the local session's census is EXACTLY one ddg-html POST — zero on every model lane and every keyed door", j(run.perLane) === j({ 'ddg-html': 1 }), j(run.perLane))
  check('the result is plain data a local model reads (title/url/snippet strings only)',
    (run.output?.results ?? []).every(e => typeof e !== 'string' && e.content.every(h => typeof h.title === 'string' && typeof h.url === 'string')), j(run.output?.results).slice(0, 200))
  fixture.reset()
}

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
section('§9 THE WEBFETCH PREFLIGHT — first-party policy only for the first party')
{
  // The preflight host is hardcoded api.anthropic.com (not the base-URL
  // override), so the SEAM points it at the spy; the fetch leg itself
  // fails TLS against the plain-HTTP loopback — that throw is expected and
  // is NOT a preflight verdict. Nemotron leg FIRST: the allowed-verdict
  // cache would otherwise mask a buggy second dial.
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
  // The WebFetch UA follows the same no-disclosure ruling as the search UA
  // (granted): version only — no +url, no repo, no operator.
  const { getWebFetchUserAgent } = await import('../../src/utils/http.js')
  const webFetchUa = getWebFetchUserAgent()
  check('the WebFetch agent presents Mercury/<version> and DISCLOSES nothing (no +url, no repo, no operator)',
    /^Mozilla\/5\.0 \(compatible; Mercury\/[^)]+\)$/.test(webFetchUa) && !webFetchUa.includes('+') && !OPERATOR_NEEDLE.test(webFetchUa), webFetchUa)
  fixture.reset()
}

await fixture.close()
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
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
