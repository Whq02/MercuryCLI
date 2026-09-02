#!/usr/bin/env bun
// ============================================================================
//  scripts/search/prove-search-door.ts — THE LAWS OF THE TWO DOOR SETS:
//
//    §1 the MODEL-CHOOSES registration law (the operator's addendum):
//       nativeSearchFamilyOf answers exactly for anthropic/openai main
//       models — the ProviderSearch tool's listing gate; every other family
//       gets the vendored tool alone.
//    §2 the VENDORED walk (a pure table): keyed (Brave, then Tavily) →
//       keyless; family-INDEPENDENT by construction — and the cross-account
//       law is now a TYPE: SearchDoor has no native kind, so the vendored
//       walk cannot express a provider-account door at all.
//    §3 the override names ONE vendored door — a door that cannot open is
//       the typed absence, never a fallback; 'native' is NOT a backend word
//       (the provider's search is a tool the model chooses, not a harness
//       backend).
//    §4 the composed lines.
//    §5 the native leg's family clamp: the small-fast tier is
//       admitted only when its route IS the door's family — a cross-family
//       utility pin falls back to the session's own main model.
//
//  Pure over injected reads — no env, no store, no network.
//  Run:  ~/.bun/bin/bun run scripts/search/prove-search-door.ts
// ============================================================================
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

/** One id per family the routing law declares (the neutral-home prover's spellings). */
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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
  // The cross-account law BY TYPE: the door union has no native kind, so a
  // walk over any reads whatsoever can only ever name keyed/keyless doors.
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
section('§4 the composed lines')
{
  const plan = resolveSearchDoorPlan({ braveKey: 'stored', keylessAllowed: true })
  const line = walkFailureLine(
    [searchFailure('key-refused', 'brave', 'HTTP 401'), searchFailure('rate-limited', 'duckduckgo-lite', 'HTTP 202 with the bot challenge page')],
    plan,
  )
  check('the walk line leads with the LAST door\'s fact and carries the earlier one', line.startsWith('DuckDuckGo (lite) rate-limited this client') && line.includes('earlier: Brave Search refused the stored key'), line)
  const empty = walkFailureLine([], resolveSearchDoorPlan({ keylessAllowed: false }))
  check('an empty plan\'s line is the no-backend sentence naming every absence', empty.includes('no open door') && empty.includes('MERCURY_SEARCH_KEYLESS=0'), empty)
  const described = describeSearchDoorPlan(resolveSearchDoorPlan({ tavilyKey: 'stored', keylessAllowed: true }))
  check('describeSearchDoorPlan reads as the walk', described.startsWith('Tavily (keyed, stored key) → DuckDuckGo (keyless)'), described)
}

// ---------------------------------------------------------------------------
section("§5 the native leg's family clamp — the small-fast tier never crosses families")
{
  const { nativeSearchLegModel } = await import('../../src/services/search/nativeSearch.js')
  const HAIKU = 'claude-haiku-4-5-20251001'
  const GPT_MINI = 'gpt-5.5-mini'
  check(`premise: ${HAIKU} routes to anthropic`, declaredRouteOf(HAIKU) === 'anthropic', declaredRouteOf(HAIKU))
  check(`premise: ${GPT_MINI} routes to openai`, declaredRouteOf(GPT_MINI) === 'openai', declaredRouteOf(GPT_MINI))
  const own = nativeSearchLegModel('anthropic', FAMILY_IDS.anthropic!, HAIKU)
  check('an anthropic small-fast id rides the anthropic leg', own.small === true && own.model === HAIKU, j(own))
  const crossed = nativeSearchLegModel('anthropic', FAMILY_IDS.anthropic!, FAMILY_IDS.openrouter!)
  check("a CROSS-FAMILY small-fast pin falls to the session's own main model — never another family's account (the original leak's class)",
    crossed.small === false && crossed.model === FAMILY_IDS.anthropic!, j(crossed))
  const crossedToAnthropic = nativeSearchLegModel('openai', FAMILY_IDS.openai!, HAIKU)
  check('…in BOTH directions (an anthropic id never rides the openai leg)',
    crossedToAnthropic.small === false && crossedToAnthropic.model === FAMILY_IDS.openai!, j(crossedToAnthropic))
  const gateOff = nativeSearchLegModel('openai', FAMILY_IDS.openai!, undefined)
  check('gate off ⇒ the main model, plainly', gateOff.small === false && gateOff.model === FAMILY_IDS.openai!, j(gateOff))
  const openaiSmall = nativeSearchLegModel('openai', FAMILY_IDS.openai!, GPT_MINI)
  check('an openai mini rides the openai leg', openaiSmall.small === true && openaiSmall.model === GPT_MINI, j(openaiSmall))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ SEARCH DOOR LAW GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SEARCH DOOR FAILURE(S)`)
process.exit(1)
