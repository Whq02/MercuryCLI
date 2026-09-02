#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-gpt-context-window.ts
//  PROOF (the GPT context-window SOURCE-HONESTY fix — reported as
//  "Mercury pins GPT to 272k and claims 1.05M is API-key-only, but the same
//  ChatGPT subscription serves 1.05M on OpenAI's Codex CLI").
//
//  The investigation refuted the premise and found a different, real defect.
//  Live probe of a ChatGPT Plus subscription (
//  chatgpt.com/backend-api/codex/models) returned, verbatim:
//     gpt-5.6-sol    context_window=272000   max_context_window=272000
//     gpt-5.6-terra  context_window=272000   max_context_window=272000
//     gpt-5.6-luna   context_window=272000   max_context_window=272000
//     gpt-5.5        context_window=272000   max_context_window=272000
//     gpt-5.4        context_window=272000   max_context_window=1000000
//     gpt-5.4-mini   context_window=272000   max_context_window=272000
//     codex-auto-review context_window=272000 max_context_window=1000000
//  272,000 is exactly OpenAI's published long-context PRICING boundary
//  (">272K input tokens are priced at 2x input and 1.5x output"), and OpenAI's
//  own Codex CLI reads the same 272,000 from the same catalogue (openai/codex
//  issues #32806 · #31860 · #32486 · #19409). So 272k is SERVED truth — the
//  window is NOT faked upward.
//
//  What WAS wrong, and what this proves:
//    1. `max_context_window` was silently dropped by the decoder, so a row
//       whose source declares a LARGER ceiling (gpt-5.4: 1,000,000 over a
//       272,000 default) was under-reported with no mention.
//    2. liveGptContextCeiling reports that ceiling ONLY when it exceeds the
//       default — never a second number on a flat row, never a pin fallback.
//    3. The session budget still rides the DEFAULT window (conservative —
//       budgeting to a ceiling the server does not default to would overrun).
//    4. The picker row no longer claims "an API key serves 1.05M (/router
//       connect)". That was fabricated twice: the 1.05M came from the STATIC
//       display pin (an API model-page fact — the api-key catalogue is
//       id-only, so no api-key window was ever measured), and /router connect
//       signs in the SUBSCRIPTION, i.e. the 272k source itself.
//    5. The LIVE router catalogue carries the SERVED window: liveCatalogue()
//       built rows from the live source but stamped the static pin's window
//       onto them — the same fabrication class, opposite direction.
//    6. The static display pins keep the official model-page facts (they are
//       display material and never activate) — unchanged by this fix.
//
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-gpt-context-window.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' GPT context window: SOURCE truth, no invented windows')
console.log('============================================================')

const ROOT = join(import.meta.dir, '..', '..')
const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'OPENAI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_DISABLE_1M_CONTEXT',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-gpt-ctx-'))
// Ambient-state law: any accidental real fetch dies on an unroutable port.
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const {
  liveGptContextWindow,
  liveGptContextCeiling,
  gptDisplayPin,
  refreshOpenaiCatalogue,
  __resetOpenaiCatalogueForTest,
} = catalogue
const { getContextWindowForModel } = await import('../../src/utils/context.js')

// The EXACT shape the live subscription endpoint returned on.
const fixtureFetch: typeof fetch = (async () =>
  new Response(
    JSON.stringify({
      models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'low', context_window: 272000, max_context_window: 272000 },
        { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'], default_reasoning_level: 'medium', context_window: 272000, max_context_window: 272000 },
        { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 5, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 272000, max_context_window: 1000000 },
        // A row that states a default but NO ceiling at all.
        { slug: 'gpt-5.7-nova', display_name: 'GPT-5.7 Nova', visibility: 'list', priority: 6, supported_reasoning_levels: ['low', 'high'], default_reasoning_level: 'low', context_window: 272000 },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch

//
section('1 · the decoder keeps BOTH source numbers (max_context_window)')
//
{
  process.env.OPENAI_API_KEY = 'prover-key'
  __resetOpenaiCatalogueForTest()
  const snapshot = await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })
  const sol = snapshot?.models.find(m => m.id === 'gpt-5.6-sol')
  const g54 = snapshot?.models.find(m => m.id === 'gpt-5.4')
  const nova = snapshot?.models.find(m => m.id === 'gpt-5.7-nova')
  check('Sol decodes the served default window (272,000)', sol?.contextWindow === 272_000)
  check('Sol decodes its FLAT ceiling (272,000)', sol?.maxContextWindow === 272_000)
  check(
    'gpt-5.4 decodes the LARGER declared ceiling (1,000,000 over a 272,000 default)',
    g54?.contextWindow === 272_000 && g54?.maxContextWindow === 1_000_000,
    `got ctx=${g54?.contextWindow} max=${g54?.maxContextWindow}`,
  )
  check('a row stating no ceiling leaves maxContextWindow undefined (never invented)', nova?.maxContextWindow === undefined)
}

//
section('2 · liveGptContextCeiling — larger-only, never a second flat number')
//
{
  check('Sol default window = the SERVED 272,000 (not the model page 1,050,000)', liveGptContextWindow('gpt-5.6-sol') === 272_000)
  check('Sol reports NO ceiling — the source states max == default', liveGptContextCeiling('gpt-5.6-sol') === undefined)
  check('gpt-5.4 reports the declared 1,000,000 ceiling', liveGptContextCeiling('gpt-5.4') === 1_000_000)
  check('a ceiling-less row reports no ceiling', liveGptContextCeiling('gpt-5.7-nova') === undefined)
  check('an id absent from the catalogue reports neither', liveGptContextWindow('gpt-5.6-luna') === undefined && liveGptContextCeiling('gpt-5.6-luna') === undefined)
  // The anti-fabrication law: the ceiling NEVER falls back to a static pin —
  // proved against the pin's own recorded window (which the fixture serves
  // differently on purpose), never a number restated here.
  const solPinWindow = gptDisplayPin('gpt-5.6-sol')?.contextWindow
  check(
    'the ceiling never falls back to the display pin (pin recorded ≠ fixture-served, ceiling stays absent)',
    solPinWindow !== undefined &&
      solPinWindow !== liveGptContextWindow('gpt-5.6-sol') &&
      liveGptContextCeiling('gpt-5.6-sol') === undefined,
  )
}

//
section('3 · the BUDGET rides the source-DECLARED window (item C ruling)')
//
{
  // Operator ruling (item C): a declared max_context_window
  // ABOVE the served default IS the account's usable window — the budget
  // honors it. A FLAT row (no larger ceiling) keeps the served default.
  check('Sol (flat row) budgets the served 272,000', getContextWindowForModel('gpt-5.6-sol') === 272_000)
  check(
    'gpt-5.4 budgets its DECLARED 1,000,000 ceiling (the item C unclamp)',
    getContextWindowForModel('gpt-5.4') === 1_000_000,
    `got ${getContextWindowForModel('gpt-5.4')}`,
  )
  // Provider parity: the `[served]` annotation
  // — the persisted form of the /model `c` toggle's opt-down — budgets the
  // SERVED default on a ceiling-declaring row. BOTH directions: the bare id
  // stays the ceiling (above), the annotated id is the served default. This
  // is the resolver every consumer reads, so the toggle is product-wide by
  // construction (context accounting, warnings, /context).
  check(
    'gpt-5.4[served] budgets the SERVED 272,000 (the toggle opt-down, resolver-effective)',
    getContextWindowForModel('gpt-5.4[served]') === 272_000,
    `got ${getContextWindowForModel('gpt-5.4[served]')}`,
  )
  check(
    'the annotation is a no-op on a FLAT row (Sol[served] = the same served default)',
    getContextWindowForModel('gpt-5.6-sol[served]') === 272_000,
  )
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  check('the 1M kill-switch still caps a >200K served window', getContextWindowForModel('gpt-5.6-sol') === 200_000)
  check('the 1M kill-switch caps the [served] window too (272K > 200K)', getContextWindowForModel('gpt-5.4[served]') === 200_000)
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
}

//
section('4 · unfetched falls back to the PIN, unchanged')
//
{
  __resetOpenaiCatalogueForTest()
  delete process.env.OPENAI_API_KEY
  check('unfetched: no live window is claimed', liveGptContextWindow('gpt-5.6-sol') === undefined)
  check('unfetched: no live ceiling is claimed', liveGptContextCeiling('gpt-5.6-sol') === undefined)
  // MECHANISM: with no live truth the budget derives from the last-observed
  // pin — the expectation is READ from the pin (a refreshed observation can
  // never strand a stale copy here).
  check(
    'unfetched: the last-observed pin drives the budget (derived, not restated)',
    getContextWindowForModel('gpt-5.6-sol') === gptDisplayPin('gpt-5.6-sol')?.contextWindow,
  )
  check(
    'the pins are DATED records: a recorded window always rides an observedAt',
    ['gpt-5.6-sol', 'gpt-5.6-luna'].every(id => {
      const pin = gptDisplayPin(id)
      return pin?.contextWindow !== undefined && typeof pin.observedAt === 'string'
    }),
  )
}

//
section('5 · the LIVE router catalogue carries the SERVED window, not the pin')
//
{
  // Same fabrication class, second seam: liveCatalogue() built rows from the
  // live source but stamped candidate.pin.contextWindow, so a subscription
  // serving 272,000 was reported as the model page's 1,050,000.
  const providerSrc = readFileSync(join(ROOT, 'src/utils/router/providers/openai.ts'), 'utf8')
  check(
    'the live row prefers the source-served window',
    /candidate\.live\.contextWindow !== undefined\s*\n\s*\? \{ contextWindow: candidate\.live\.contextWindow \}/.test(providerSrc),
  )
  check(
    'the pin survives ONLY as the no-window-stated fallback (and only when the pin itself records a window — provider parity: lineup pins may state none)',
    /: candidate\.pin && candidate\.pin\.contextWindow !== undefined\s*\n\s*\? \{ contextWindow: candidate\.pin\.contextWindow \}/.test(providerSrc),
  )
  check(
    'the live row no longer stamps the pin unconditionally',
    !/\.\.\.\(candidate\.pin \? \{ contextWindow: candidate\.pin\.contextWindow \} : \{\}\)/.test(providerSrc),
  )
  check(
    'the STATIC pin catalogue is still allowed to render pin windows (display provenance)',
    /function staticPinCatalogue/.test(providerSrc) && /contextWindow: pin\.contextWindow/.test(providerSrc),
  )
}

//
section('6 · the picker row states only the ACTIVE source (structural)')
//
{
  const picker = readFileSync(join(ROOT, 'src/components/MercuryModelPicker.tsx'), 'utf8')
  check(
    'the fabricated "an API key serves …" claim is GONE',
    !picker.includes('an API key serves'),
  )
  check(
    'the row no longer routes the window question to /router connect (the SUBSCRIPTION verb)',
    !/serves \$\{fmtCtx\([^)]*\)\} \(\/router connect\)/.test(picker) && !picker.includes('(/router connect)'),
  )
  check(
    'the row reads the source-declared ceiling accessor',
    picker.includes('liveGptContextCeiling'),
  )
  // Provider parity: where the source declares
  // BOTH windows, `c` is a real toggle with honest copy in BOTH states —
  // each names the active window AND the other one.
  check(
    'the toggle copy names the declared-max state with the served default beside it',
    picker.includes('the source-declared max (served default '),
  )
  check(
    "the toggle copy names the served state with the declared max beside it",
    picker.includes("the source's served default (declared max "),
  )
  check(
    'both toggle states advertise the toggle (never a dead-end claim)',
    picker.includes(' · c toggles'),
  )
  check(
    'the ONE-window case keeps the source-truth notice (nothing to toggle)',
    picker.includes('set by the GPT account source') && picker.includes('not a toggle'),
  )
  check(
    'the retired always-fixed copy is GONE (a two-window row is never "not a toggle")',
    !picker.includes('(declared max; default '),
  )
  // The pin must no longer drive the comparison that produced the false claim.
  check(
    'the row no longer compares the live window against the static pin',
    !picker.includes('focusedGptWindow.pin'),
  )
}

//
section('7 · speedster 3.5.5 — the ONE typed ContextResolution (CX rows)')
//
{
  // Re-seed the live fixture (section 4 cleared the credential).
  process.env.OPENAI_API_KEY = 'prover-key'
  __resetOpenaiCatalogueForTest()
  await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })
  const { resolveContextWindow } = await import('../../src/utils/model/capabilities.js')

  // CX-01/CX-10: default mode budgets at the served window, and the number
  // every consumer reads IS the resolution's effective figure.
  const sol = resolveContextWindow('gpt-5.6-sol')
  check(
    'CX-01: default mode resolves the served 272,000 (source live-current, both catalogue numbers carried)',
    sol.effectiveWindow === 272_000 &&
      sol.source === 'live-current' &&
      sol.catalogueCurrent === 272_000 &&
      sol.requestedMode === 'default' &&
      sol.activation.kind === 'none',
    `got ${JSON.stringify(sol)}`,
  )
  check(
    'CX-10: getContextWindowForModel IS the resolution effectiveWindow (one object drives budgeting)',
    getContextWindowForModel('gpt-5.6-sol') === sol.effectiveWindow,
  )
  const g54 = resolveContextWindow('gpt-5.4')
  check(
    'CX-06 re-cut (item C): the ceiling is the BUDGET and still rides catalogueMaximum beside the served default',
    g54.catalogueMaximum === 1_000_000 && g54.effectiveWindow === 1_000_000 && g54.catalogueCurrent === 272_000,
  )
  check(
    'the static pin is carried as staticDefault beside the live truth, never as the budget',
    sol.staticDefault === gptDisplayPin('gpt-5.6-sol')?.contextWindow && sol.effectiveWindow === 272_000,
  )

  // CX-04 shape / CX-11: a maximum request resolves honestly UNAVAILABLE
  // until the CX-09/CX-13 provider-contract capture names a mechanism —
  // effective window unchanged, reason stated. Never presence-inferred.
  const solMax = resolveContextWindow('gpt-5.4', undefined, 'maximum')
  check(
    'CX-11 re-cut (item C): a maximum request beyond the declared window stays honestly unavailable — the budget is already the ceiling; nothing further is presence-inferred',
    solMax.requestedMode === 'maximum' &&
      solMax.activation.kind === 'unavailable' &&
      /CX-09\/CX-13/.test((solMax.activation as { reason: string }).reason) &&
      solMax.effectiveWindow === 1_000_000 &&
      solMax.fallbackReason !== undefined,
    `got ${JSON.stringify(solMax)}`,
  )

  // Provider parity: the `[served]` annotation resolves the
  // SERVED default on a ceiling row — with BOTH catalogue numbers still
  // carried (the honest two-window answer), the same live-current source,
  // and no phantom activation (nothing above the default was requested).
  const g54Served = resolveContextWindow('gpt-5.4[served]')
  check(
    '[served] on a ceiling row: effective = the served 272,000, both catalogue numbers carried, activation none',
    g54Served.effectiveWindow === 272_000 &&
      g54Served.source === 'live-current' &&
      g54Served.catalogueCurrent === 272_000 &&
      g54Served.catalogueMaximum === 1_000_000 &&
      g54Served.activation.kind === 'none',
    `got ${JSON.stringify(g54Served)}`,
  )
  const { normalizeModelStringForAPI } = await import('../../src/utils/model/model.js')
  const { parseGptModelId, hasGptServedWindowSuffix, withGptServedWindowSuffix, stripGptServedWindowSuffix } =
    await import('../../src/services/providers/openai/gptPins.js')
  check(
    'the annotation NEVER reaches the wire (normalizeModelStringForAPI strips it)',
    normalizeModelStringForAPI('gpt-5.4[served]') === 'gpt-5.4' &&
      normalizeModelStringForAPI('gpt-5.6-sol[SERVED]') === 'gpt-5.6-sol',
  )
  check(
    'the annotation never changes GPT identity (parseGptModelId tolerates it; canonicalId is bare)',
    parseGptModelId('gpt-5.4[served]')?.canonicalId === 'gpt-5.4' &&
      parseGptModelId('claude-opus-5') === undefined,
  )
  check(
    'the helper trio round-trips (with idempotent · strip inverse · has detects)',
    withGptServedWindowSuffix('gpt-5.4') === 'gpt-5.4[served]' &&
      withGptServedWindowSuffix('gpt-5.4[served]') === 'gpt-5.4[served]' &&
      stripGptServedWindowSuffix('gpt-5.4[served]') === 'gpt-5.4' &&
      hasGptServedWindowSuffix('gpt-5.4[served]') &&
      !hasGptServedWindowSuffix('gpt-5.4'),
  )

  // CX-14: [1m] is NOT a Sol activation path — a suffixed GPT id resolves as
  // its base id with the activation honestly unavailable (never a lying 1M).
  const solSuffixed = resolveContextWindow('gpt-5.6-sol[1m]')
  check(
    'CX-14: gpt-5.6-sol[1m] budgets the base id (272,000) with the suffix named unavailable — no unverified 1M',
    solSuffixed.effectiveWindow === 272_000 &&
      solSuffixed.activation.kind === 'unavailable' &&
      /\[1m\]/.test((solSuffixed.activation as { reason: string }).reason),
    `got ${JSON.stringify(solSuffixed)}`,
  )
  check(
    'the [1m] suffix stays a live client-side opt-in for non-GPT ids (anthropic 1M unchanged)',
    resolveContextWindow('claude-sonnet-4-5[1m]').effectiveWindow === 1_000_000 &&
      resolveContextWindow('claude-sonnet-4-5[1m]').source === 'suffix-1m',
  )

  // CX-08: an id with no live row keeps current behavior (pin arm), and an
  // unknown id falls back with the reason stated.
  const luna = resolveContextWindow('gpt-5.6-luna')
  const lunaPinWindow = gptDisplayPin('gpt-5.6-luna')?.contextWindow
  check(
    'CX-08: an id absent from the live catalogue keeps the pin behavior (static-pin source, pin-derived figure)',
    luna.source === 'static-pin' &&
      lunaPinWindow !== undefined &&
      luna.effectiveWindow === lunaPinWindow &&
      luna.staticDefault === lunaPinWindow,
  )
  const unknown = resolveContextWindow('totally-unknown-model-id')
  check(
    'the fallback arm states its reason (never a silent default)',
    unknown.source === 'fallback' && unknown.fallbackReason !== undefined && unknown.effectiveWindow > 0,
  )
  check(
    'the resolution carries the model output reserve (display-grade budgeting fact)',
    sol.outputReserve > 0,
  )
}

//
section('8 · the toggle PERSISTS on the id and re-opens true (structural)')
//
{
  // The interaction layer is React/ink — the persistence CONTRACT is pinned
  // structurally at both owners (the §6 pattern); the resolver behavior the
  // contract lands on is behavioral above (§3/§7), and the lead's 80/120
  // captures drive the real journey.
  const picker = readFileSync(join(ROOT, 'src/components/MercuryModelPicker.tsx'), 'utf8')
  check(
    'commit maps the toggle onto the id: bare = declared max, [served] = the opt-down',
    picker.includes('onSelect(context1m ? m.id : withGptServedWindowSuffix(m.id))'),
  )
  check(
    'a re-open seeds the toggle from the PERSISTED id (the [served] annotation on `current`)',
    picker.includes('hasGptServedWindowSuffix(current) && stripGptServedWindowSuffix(current) === p'),
  )
  check(
    'row identity matching strips the annotation (the current dot lands on the row)',
    picker.includes('const currentRow = stripGptServedWindowSuffix(current)'),
  )
  check(
    'the footer advertises the c toggle for BOTH toggle families (1M and served↔declared)',
    picker.includes('supports1m: focusedSupports1m || focusedGptToggle'),
  )
  const wrapper = readFileSync(join(ROOT, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check(
    'the wrapper bakes BOTH column states through the ONE resolver (column ≡ budget by construction)',
    wrapper.includes('getContextWindowForModel(withGptServedWindowSuffix(opt.value) as never, betas)'),
  )
}

//
section('9 · the /model GPT group is the FULL lineup; availability = the resolver')
//
{
  // Fixture state from §7: api-key source, live catalogue =
  // sol(flat) · terra(flat) · gpt-5.4(ceiling) · gpt-5.7-nova. The lineup
  // pins additionally carry luna · 5.5 · 5.4-mini · 5.3-codex-spark.
  const { getModelOptions } = await import('../../src/utils/model/modelOptions.js')
  const { OPENAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.js')
  const options = getModelOptions()
  const gptRows = options.filter(o => o.group === OPENAI_MODEL_GROUP)
  const byValue = new Map(gptRows.map(o => [o.value, o]))
  check(
    'every live-served id is a selectable row (sol · terra · gpt-5.4 · the unpinned 5.7-nova) — no generation gate',
    ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4', 'gpt-5.7-nova'].every(
      id => byValue.has(id) && byValue.get(id)?.unavailable === undefined,
    ),
    `gpt rows: ${gptRows.map(o => `${String(o.value)}${o.unavailable ? '(unavail)' : ''}`).join(', ')}`,
  )
  check(
    'the FULL current lineup is VISIBLE (every display pin has a row even when unavailable)',
    ['gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'].every(id =>
      byValue.has(id),
    ),
    `gpt rows: ${gptRows.map(o => String(o.value)).join(', ')}`,
  )
  // Availability is ONLY the live resolver's answer: an unserved lineup id
  // (whatever its generation — the era floor reason is absent) carries the
  // not-served reason, never a remembered verdict about the model itself.
  check(
    'a lineup id the account does not serve is unavailable with the resolver reason',
    byValue.get('gpt-5.6-luna')?.unavailable === 'not served by the connected OpenAI API key' &&
      byValue.get('gpt-5.5')?.unavailable === 'not served by the connected OpenAI API key',
    `got: ${byValue.get('gpt-5.6-luna')?.unavailable} / ${byValue.get('gpt-5.5')?.unavailable}`,
  )
  check(
    'qualified rows precede unavailable rows inside the group (selectable first)',
    gptRows.findIndex(o => o.unavailable !== undefined) >
      gptRows.findIndex(o => o.value === 'gpt-5.6-sol'),
  )
  const hidden = gptRows.some(o => o.value === 'codex-auto-review')
  check('a source-hidden id stays absent (hide means hide — not even an unavailable row)', !hidden)
}

//
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' RESULT: PASS' : ` RESULT: FAIL (${failures})`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
