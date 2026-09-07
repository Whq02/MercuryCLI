#!/usr/bin/env bun
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
const doorsOf = (reads: Reads): string[] => resolveSearchDoorPlan(reads).doors.map(d => (d.kind === 'keyed' ? `keyed:${d.backend}` : 'keyless'))

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
  check('the health fact names BOTH doors for a native family (model chooses) and only the vendored walk elsewhere',
    searchDoorFact('claude-opus-4-8', {}).startsWith('ProviderSearch: Anthropic web search (native — the model chooses per query) · WebSearch: ') &&
      searchDoorFact('glm-5.2', {}).startsWith('WebSearch: '),
    searchDoorFact('claude-opus-4-8', {}))
}

section('§2 the VENDORED walk — keyed → keyless, family-independent, native inexpressible by type')
{
  check('no keys · keyless on ⇒ keyless alone', j(doorsOf({ keylessAllowed: true })) === j(['keyless']))
  check('both keys · keyless on ⇒ Brave → Tavily → keyless (Brave before Tavily)',
    j(doorsOf({ braveKey: 'stored', tavilyKey: 'env', keylessAllowed: true })) === j(['keyed:brave', 'keyed:tavily', 'keyless']))
  check('tavily only · keyless off ⇒ Tavily alone', j(doorsOf({ tavilyKey: 'stored', keylessAllowed: false })) === j(['keyed:tavily']))
  const closedAll = resolveSearchDoorPlan({ keylessAllowed: false })
  check('no keys and the keyless door off ⇒ NO door, every absence named',
    closedAll.doors.length === 0 && closedAll.closed.length === 2 && closedAll.closed.some(c => c.includes('MERCURY_SEARCH_KEYLESS=0')) && closedAll.closed.some(c => c.includes('/router key brave')),
    j(closedAll.closed))
  let nonVendored = 0
  for (const braveKey of [undefined, 'stored'] as const) {
    for (const tavilyKey of [undefined, 'env'] as const) {
      for (const keylessAllowed of [true, false]) {
        for (const backendOverride of [undefined, 'auto', 'brave', 'tavily', 'duckduckgo', 'native', 'bing']) {
          const plan = resolveSearchDoorPlan({ ...(braveKey ? { braveKey } : {}), ...(tavilyKey ? { tavilyKey } : {}), keylessAllowed, ...(backendOverride !== undefined ? { backendOverride } : {}) })
          for (const door of plan.doors) {
            if (door.kind !== 'keyed' && door.kind !== 'keyless') nonVendored++
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
  check('backend=brave with NO key ⇒ no door, the absence naming the key doors', braveMissing.doors.length === 0 && braveMissing.closed[0]?.includes('/router key brave') === true, j(braveMissing.closed))
  const ddgOff = resolveSearchDoorPlan({ keylessAllowed: false, backendOverride: 'duckduckgo' })
  check('backend=duckduckgo with the keyless door off ⇒ no door, both facts on the line', ddgOff.doors.length === 0 && ddgOff.closed[0]?.includes('MERCURY_SEARCH_KEYLESS=0') === true, j(ddgOff.closed))
  const tavilyForced = resolveSearchDoorPlan({ braveKey: 'env', tavilyKey: 'stored', keylessAllowed: true, backendOverride: 'tavily' })
  check('backend=tavily with both keys ⇒ exactly the Tavily door', j(doorsOfPlan(tavilyForced)) === j(['keyed:tavily']), j(tavilyForced.doors))
  function doorsOfPlan(plan: ReturnType<typeof resolveSearchDoorPlan>): string[] {
    return plan.doors.map(d => (d.kind === 'keyed' ? `keyed:${d.backend}` : 'keyless'))
  }
}

section('§4 the composed lines')
{
  const plan = resolveSearchDoorPlan({ braveKey: 'stored', keylessAllowed: true })
  const line = walkFailureLine(
    [searchFailure('key-refused', 'brave', 'HTTP 401'), searchFailure('rate-limited', 'duckduckgo-lite', 'HTTP 202 with the bot challenge page')],
    plan,
  )
  check('the walk line leads with the LAST door\'s fact and carries the earlier one', line.startsWith('DuckDuckGo (lite) rate-limited this client') && line.includes('earlier: Brave Search refused the stored key'), line)
  check('…and without a native family it names no ProviderSearch door and stays ONE line', !line.includes('ProviderSearch') && !line.includes('\n'), line)
  const nativeLine = walkFailureLine([searchFailure('rate-limited', 'duckduckgo-lite', 'HTTP 202 with the bot challenge page')], resolveSearchDoorPlan({ keylessAllowed: true }), { nativeFamily: 'openai' })
  check("with a native family the ONE line ends by naming ProviderSearch as the other door, after the key commands",
    nativeLine.endsWith("ProviderSearch (OpenAI web search, the provider's own search) is listed for this session — the other door.") && nativeLine.includes('/router key brave · /router key tavily') && nativeLine.includes('free tier') && !nativeLine.includes('\n'), nativeLine)
  const empty = walkFailureLine([], resolveSearchDoorPlan({ keylessAllowed: false }))
  check('an empty plan\'s line is the no-backend sentence naming every absence', empty.includes('no open door') && empty.includes('MERCURY_SEARCH_KEYLESS=0'), empty)
  const emptyNative = walkFailureLine([], resolveSearchDoorPlan({ keylessAllowed: false }), { nativeFamily: 'anthropic' })
  check('…and with a native family the closed walk still names the ProviderSearch door', emptyNative.includes('ProviderSearch (Anthropic web search'), emptyNative)
  const described = describeSearchDoorPlan(resolveSearchDoorPlan({ tavilyKey: 'stored', keylessAllowed: true }))
  check('describeSearchDoorPlan reads as the walk', described.startsWith('Tavily (keyed, stored key) → DuckDuckGo (keyless)'), described)
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
