;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

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

const {
  resolveSearchDoorPlan,
  liveSearchDoorReads,
  nativeSearchFamilyOf,
  describeSearchDoorPlan,
  searchDoorFact,
  walkFailureLine,
  parseSearchBackendOverride,
  searchDoorLabel,
  SEARCH_BACKEND_OVERRIDES,
} = await import('../../src/services/search/searchDoor.js')
const { searchFailure } = await import('../../src/services/search/searchContract.js')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.js')

type Reads = Parameters<typeof resolveSearchDoorPlan>[0]
const doorsOf = (reads: Reads): string[] => resolveSearchDoorPlan(reads).doors.map(d => (d.kind === 'keyed' ? `keyed:${d.backend}` : d.kind))

const FAMILY_IDS: Record<string, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-5.5',
  zai: 'glm-5.2',
  moonshot: 'kimi-k3',
  deepseek: 'deepseek-v4-pro',
  gemini: 'gemini-3-pro',
  openrouter: 'openrouter/nvidia/nemotron-nano-9b-v2:free',
  huggingface: 'huggingface/Qwen/Qwen3',
  local: 'local/qwen3-coder',
  'openai-compat': 'compat/my-endpoint',
}

section('§1 the model-chooses registration law — the ProviderSearch gate per family')
{
  for (const [family, id] of Object.entries(FAMILY_IDS)) {
    check(`premise: ${id} routes to ${family}`, declaredRouteOf(id) === family, declaredRouteOf(id))
    const native = nativeSearchFamilyOf(id)
    const expectNative = family === 'anthropic' || family === 'openai'
    check(`${family}: ProviderSearch is ${expectNative ? 'LISTED (its own family)' : 'NOT listed'}`, expectNative ? native === family : native === undefined, String(native))
  }
  check('the health fact names native search first only for the session family',
    searchDoorFact('claude-opus-4-8', {}).startsWith('WebSearch: Anthropic web search (native, session account)') &&
      searchDoorFact('glm-5.2', {}).startsWith('WebSearch: '),
    searchDoorFact('claude-opus-4-8', {}))
}

section('§2 the explicit-key plan remains deterministic when no session model or query is supplied')
{
  check('no keys · keyless on · no instance ⇒ scraping alone', j(doorsOf({ keylessAllowed: true })) === j(['keyless']))
  check('no keys · keyless on · an instance configured ⇒ metasearch then scraping', j(doorsOf({ keylessAllowed: true, metasearchInstances: 1 })) === j(['metasearch', 'keyless']))
  check('both keys · keyless on ⇒ Brave → Tavily → keyless (Brave before Tavily)',
    j(doorsOf({ braveKey: 'stored', tavilyKey: 'env', keylessAllowed: true })) === j(['keyed:brave', 'keyed:tavily', 'keyless']))
  check('tavily only · keyless off · an instance configured ⇒ Tavily then metasearch', j(doorsOf({ tavilyKey: 'stored', keylessAllowed: false, metasearchInstances: 1 })) === j(['keyed:tavily', 'metasearch']))
  check('tavily only · keyless off · no instance ⇒ Tavily alone', j(doorsOf({ tavilyKey: 'stored', keylessAllowed: false })) === j(['keyed:tavily']))
  const closedAll = resolveSearchDoorPlan({ keylessAllowed: false })
  check('no keys, no instance and the keyless door off ⇒ no door; every closed source named, the missing instance included',
    closedAll.doors.length === 0 && closedAll.closed.length === 3 && closedAll.closed.some(c => c.includes('DuckDuckGo page scraping is off') && c.includes('/config') && c.includes('MERCURY_SEARCH_KEYLESS=0')) && closedAll.closed.some(c => c.includes('BRAVE_API_KEY')) && closedAll.closed.some(c => c.includes('no metasearch instance configured; MERCURY_SEARCH_SEARXNG_INSTANCES')),
    j(closedAll.closed))
  delete process.env.MERCURY_SEARCH_KEYLESS
  const fresh = resolveSearchDoorPlan(liveSearchDoorReads({}))
  check('a fresh process with no pin and no saved choice walks the keyless door and names no DuckDuckGo absence (on by default)',
    j(fresh.doors.map(d => d.kind)) === j(['keyless']) && !fresh.closed.some(c => c.includes('DuckDuckGo')), j(fresh))
  process.env.MERCURY_SEARCH_KEYLESS = '0'
  const pinnedOff = resolveSearchDoorPlan(liveSearchDoorReads({}))
  delete process.env.MERCURY_SEARCH_KEYLESS
  check('…and MERCURY_SEARCH_KEYLESS=0 removes the door and names the absence with both off doors',
    pinnedOff.doors.length === 0 && pinnedOff.closed.some(c => c.includes('DuckDuckGo page scraping is off') && c.includes('MERCURY_SEARCH_KEYLESS=0')), j(pinnedOff))

  let nonVendored = 0
  for (const braveKey of [undefined, 'stored'] as const) {
    for (const tavilyKey of [undefined, 'env'] as const) {
      for (const keylessAllowed of [true, false]) {
        for (const backendOverride of [undefined, 'auto', 'brave', 'tavily', 'duckduckgo', 'native', 'bing']) {
          const plan = resolveSearchDoorPlan({ ...(braveKey ? { braveKey } : {}), ...(tavilyKey ? { tavilyKey } : {}), keylessAllowed, ...(backendOverride !== undefined ? { backendOverride } : {}) })
          for (const door of plan.doors) {
            if (door.kind !== 'keyed' && door.kind !== 'keyless' && door.kind !== 'metasearch') nonVendored++
          }
        }
      }
    }
  }
  check('across every key state × keyless × override: the walk contains ONLY keyed/keyless doors', nonVendored === 0, String(nonVendored))
}

section("§3 the override names ONE vendored door — 'native' is not a backend word")
{
  check("override parsing: unset ⇒ 'auto'; junk names itself; the vocabulary has no 'native'",
    parseSearchBackendOverride(undefined) === 'auto' && j(parseSearchBackendOverride('bing')) === j({ invalid: 'bing' }) && !(SEARCH_BACKEND_OVERRIDES as readonly string[]).includes('native'))
  const nativeWord = resolveSearchDoorPlan({ braveKey: 'env', keylessAllowed: true, backendOverride: 'native' })
  check("backend=native ⇒ no door, the line lists what the flag takes (the provider's search is a tool, not a backend)",
    nativeWord.doors.length === 0 && nativeWord.closed[0]?.includes('auto · brave · tavily · duckduckgo') === true, j(nativeWord.closed))
  const braveOnly = resolveSearchDoorPlan({ braveKey: 'env', tavilyKey: 'env', keylessAllowed: true, backendOverride: 'brave' })
  check('backend=brave with a key ⇒ exactly the Brave door', j(braveOnly.doors.map(searchDoorLabel)) === j(['Brave Search (keyed, env key)']), j(braveOnly.doors))
  const braveMissing = resolveSearchDoorPlan({ keylessAllowed: true, backendOverride: 'brave' })
  check('backend=brave with NO key ⇒ no door, the absence naming the key doors', braveMissing.doors.length === 0 && braveMissing.closed[0]?.includes('BRAVE_API_KEY') === true, j(braveMissing.closed))
  const ddgOff = resolveSearchDoorPlan({ keylessAllowed: false, backendOverride: 'duckduckgo' })
  check('backend=duckduckgo with the keyless door off ⇒ no door, both facts on the line', ddgOff.doors.length === 0 && ddgOff.closed[0]?.includes('MERCURY_SEARCH_KEYLESS=0') === true, j(ddgOff.closed))
  const tavilyForced = resolveSearchDoorPlan({ braveKey: 'env', tavilyKey: 'stored', keylessAllowed: true, backendOverride: 'tavily' })
  check('backend=tavily with both keys ⇒ exactly the Tavily door', j(doorsOfPlan(tavilyForced)) === j(['keyed:tavily']), j(tavilyForced.doors))
  function doorsOfPlan(plan: ReturnType<typeof resolveSearchDoorPlan>): string[] {
    return plan.doors.map(d => (d.kind === 'keyed' ? `keyed:${d.backend}` : d.kind))
  }
}

section('§4 the composed lines')
{
  const plan = resolveSearchDoorPlan({ braveKey: 'stored', keylessAllowed: true })
  const line = walkFailureLine(
    [searchFailure('key-refused', 'brave', 'HTTP 401'), searchFailure('rate-limited', 'duckduckgo-lite', 'HTTP 202 with the bot challenge page')],
    plan,
  )
  check('the walk line leads with the LAST door\'s fact and carries the earlier one', line.startsWith('No source answered; try another wording or another source.') && line.includes('DuckDuckGo (lite) rate-limited this client') && line.includes('Brave Search refused the stored key'), line)
  check('…and without a native family it names no ProviderSearch door and stays ONE line', !line.includes('ProviderSearch') && !line.includes('\n'), line)
  const nativeLine = walkFailureLine([searchFailure('rate-limited', 'duckduckgo-lite', 'HTTP 202 with the bot challenge page')], resolveSearchDoorPlan({ keylessAllowed: true }), { nativeFamily: 'openai' })
  check("a failed cascade never tells the model to repeat its native rung",
    !nativeLine.includes("ProviderSearch") && nativeLine.includes('BRAVE_API_KEY · TAVILY_API_KEY') && nativeLine.includes('free tier') && !nativeLine.includes('\n'), nativeLine)
  const empty = walkFailureLine([], resolveSearchDoorPlan({ keylessAllowed: false }))
  check('an empty plan\'s line is the no-backend sentence naming every absence', empty.includes('No source answered') && empty.includes('MERCURY_SEARCH_KEYLESS=0'), empty)
  const emptyNative = walkFailureLine([], resolveSearchDoorPlan({ keylessAllowed: false }), { nativeFamily: 'anthropic' })
  check('…the native-family failure carries the same actionable sentence', emptyNative.includes('No source answered') && !emptyNative.includes('ProviderSearch'), emptyNative)
  const described = describeSearchDoorPlan(resolveSearchDoorPlan({ tavilyKey: 'stored', keylessAllowed: true, metasearchInstances: 1 }))
  check('describeSearchDoorPlan reads as the walk', described.startsWith('Tavily (keyed, stored key) → SearXNG (public JSON API) → DuckDuckGo (keyless)'), described)
  const withoutInstance = describeSearchDoorPlan(resolveSearchDoorPlan({ tavilyKey: 'stored', keylessAllowed: true }))
  check('…and without an instance the walk skips SearXNG and names the absence', withoutInstance.startsWith('Tavily (keyed, stored key) → DuckDuckGo (keyless)') && withoutInstance.includes('no metasearch instance configured'), withoutInstance)
}

section('§5 native provider attribution')
{
  const { nativeBackendIdFor } = await import('../../src/services/search/nativeSearch.js')
  check('Anthropic search identifies its provider', nativeBackendIdFor('anthropic') === 'anthropic-native')
  check('OpenAI search identifies its provider', nativeBackendIdFor('openai') === 'openai-native')
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ SEARCH DOOR LAW GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SEARCH DOOR FAILURE(S)`)
process.exit(1)
