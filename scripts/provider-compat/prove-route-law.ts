#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-route-law.ts — the extended PURE routing law + the
//  permission-mode provider-neutrality fix.
//
//    1. classifyModelRoute/declaredRouteOf: every prefix family lands on its lane — glm→
//       zai · gpt→openai · kimi-/moonshot-→moonshot · deepseek-→deepseek ·
//       compat/→openai-compat · everything else→anthropic; bare class
//       aliases route; Mercury annotations ([1m]/[served]) never change a
//       route; case/whitespace tolerated.
//    2. compat namespace: isCompatModelId + stripCompatModelPrefix (the
//       prefix is dressing — the wire id is the bare vendor id).
//    3. THE SKIP-PERMS NEUTRALITY LAW: modelSupportsAutoMode answers TRUE
//       for EVERY engine-lane id (gpt/glm/kimi/deepseek/compat) — permission
//       behaviour never keys on the provider (the old gate kicked engine
//       sessions out of flow with a model warning the home lane never saw);
//       the home lane's own allowlist is unchanged (haiku still refused).
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-route-law.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hermetic home BEFORE any src import (the settings graph loads under
// capabilities); ambient keys cleared so nothing here reads the dev machine.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'route-law-proof-'))
delete process.env.OPENAI_API_KEY
delete process.env.ZAI_API_KEY
delete process.env.ANTHROPIC_API_KEY
delete process.env.MOONSHOT_API_KEY
delete process.env.DEEPSEEK_API_KEY

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const {
  classifyModelRoute,
  declaredRouteOf,
  isCompatModelId,
  stripCompatModelPrefix,
  qualifiedWireId,
  canonicalWireModelId,
  COMPAT_MODEL_PREFIX,
  PROVIDER_ID_SPACES,
} = await import('../../src/services/providers/routeLaw.ts')
const { modelSupportsAutoMode } = await import('../../src/utils/model/capabilities.ts')
const { compatDispatchModelId } = await import(
  '../../src/services/providers/openaicompat/compatChatCallModel.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

section('1 · the routing law, per family')
const routes: Array<[string | undefined, string]> = [
  ['glm', 'zai'],
  ['glm-5.3', 'zai'],
  ['glm-5.2', 'zai'],
  ['gpt', 'openai'],
  ['gpt-5.6-sol', 'openai'],
  ['kimi', 'moonshot'],
  ['kimi-k3', 'moonshot'],
  ['kimi-k2.7-code', 'moonshot'],
  ['moonshot-v1-8k', 'moonshot'],
  ['deepseek', 'deepseek'],
  ['deepseek-v4-pro', 'deepseek'],
  ['deepseek-v4-flash', 'deepseek'],
  ['compat/qwen3-32b', 'openai-compat'],
  ['compat/llama-3.3-70b-instruct', 'openai-compat'],
  // The fold-seam id spaces (recognition here; runtimes land with the
  // provider-auth lane — its picker predicates probe EXACTLY these):
  ['openrouter/auto', 'openrouter'],
  ['openrouter/qwen/qwen3-coder', 'openrouter'],
  ['openrouter/openrouter/auto', 'openrouter'],
  ['gemini-2.5-pro', 'gemini'],
  ['gemini', 'gemini'],
  ['claude-fable-5', 'anthropic'],
  ['claude-opus-4-8', 'anthropic'],
  ['opus', 'anthropic'],
]
for (const [id, want] of routes) {
  const got = declaredRouteOf(id ?? '')
  check(`route(${JSON.stringify(id)}) = ${want}`, got === want, `got ${got}`)
}
// RE-PINNED (the operator's phase-2 neutrality ruling): the ''/undefined
// rows above were the remainder-era anthropic rows — absence is a
// first-class verdict now and never classifies onto a lane.
check("route('') is ABSENCE — never a lane", classifyModelRoute('').kind === 'absence')
check('route(undefined) is ABSENCE — never a lane', classifyModelRoute(undefined).kind === 'absence')

section('2 · annotations + case never change a route')
check("route('KIMI-K3') = moonshot", declaredRouteOf('KIMI-K3') === 'moonshot')
check("route(' deepseek-v4-pro ') = deepseek", declaredRouteOf(' deepseek-v4-pro ') === 'deepseek')
check("route('glm-5.3[1m]') = zai", declaredRouteOf('glm-5.3[1m]') === 'zai')
check("route('gpt-5.6-sol[served]') = openai", declaredRouteOf('gpt-5.6-sol[served]') === 'openai')
check("route('Compat/qwen3') = openai-compat", declaredRouteOf('Compat/qwen3') === 'openai-compat')

section('3 · the compat namespace')
check('isCompatModelId(compat/x)', isCompatModelId('compat/x'))
check('!isCompatModelId(deepseek-v4-pro)', !isCompatModelId('deepseek-v4-pro'))
check(
  'strip(compat/qwen3-32b) = qwen3-32b',
  stripCompatModelPrefix('compat/qwen3-32b') === 'qwen3-32b',
)
check('strip passes non-compat ids', stripCompatModelPrefix('kimi-k3') === 'kimi-k3')
check('prefix constant is the documented spelling', COMPAT_MODEL_PREFIX === 'compat/')

section('3b · the provider-generic id-space table (the fold seam)')
check(
  'qualified namespaces are reserved words (checked before every bare prefix)',
  PROVIDER_ID_SPACES.filter(s => s.qualifiedPrefix).length >= 2,
)
check(
  'qualifiedWireId strips the openrouter namespace to the full vendor slug',
  qualifiedWireId('openrouter/qwen/qwen3-coder') === 'qwen/qwen3-coder' &&
    qualifiedWireId('openrouter/openrouter/auto') === 'openrouter/auto',
)
check('qualifiedWireId strips compat', qualifiedWireId('compat/qwen3-32b') === 'qwen3-32b')
check('qualifiedWireId passes bare ids', qualifiedWireId('kimi-k3') === 'kimi-k3')
check(
  'a bare vendor slug is NOT an openrouter id (the namespace disambiguates) — it is UNRECOGNISED and carrier-shaped, never a lane by remainder',
  (() => { const v = classifyModelRoute('qwen/qwen3-coder'); return v.kind === 'unrecognised' && v.carrierShaped })(),
)

section('3c · Mercury annotations never ride a wire (the wire-id truth law)')
// The 2026-08-21 "vendors serve bracket slugs" exception was built on a
// mis-read of this bug's own junk: the live catalogue serves NO bracket ids
// (2026-08-24 probe, 417 rows, zero '['), so [1m]/[served] inside a
// qualified namespace is always Mercury's own dressing — it heals off at
// dispatch, and what cannot heal REFUSES before the wire (canonicalWireModelId).
check(
  'a dressed qualified id still routes to openrouter (recognition is annotation-blind)',
  declaredRouteOf('openrouter/anthropic/claude-opus-5[1m]') === 'openrouter',
)
check(
  'the dispatch-side id heals the annotation off a QUALIFIED id (prefix kept)',
  compatDispatchModelId('openrouter/anthropic/claude-opus-5[1m]') ===
    'openrouter/anthropic/claude-opus-5',
)
check(
  'the healed wire slug is the vendor catalogue id, byte-exact',
  qualifiedWireId(compatDispatchModelId('openrouter/anthropic/claude-opus-5[1m]')) ===
    'anthropic/claude-opus-5',
)
check(
  'first-party ids shed the Mercury annotation at dispatch',
  compatDispatchModelId('claude-sonnet-4-5[1m]') === 'claude-sonnet-4-5',
)
check(
  'compat ids heal the annotation too (the grammar is Mercury-owned everywhere)',
  compatDispatchModelId('compat/some-model[served]') === 'compat/some-model',
)
{
  const healed = canonicalWireModelId('openrouter/anthropic/claude-fable-5[1m]')
  check(
    'the owner heals a dressed valid row to the exact live slug',
    healed.ok && healed.wireId === 'anthropic/claude-fable-5' && healed.healed === true,
  )
  const junk = canonicalWireModelId('openrouter/anthropic/openai/gpt-5.6-terra[1m]')
  check(
    "the operator's live junk REFUSES with catalogue words (never a provider 400)",
    !junk.ok && /second vendor prefix/.test(junk.ok ? '' : junk.reason) && /\/model/.test(junk.ok ? '' : junk.reason),
  )
  const auto = canonicalWireModelId('openrouter/openrouter/auto')
  check(
    "the router's own aggregate survives: openrouter/openrouter/auto wires openrouter/auto",
    auto.ok && auto.wireId === 'openrouter/auto',
  )
  const batch = canonicalWireModelId('openrouter/anthropic/claude-opus-5:batch')
  check(
    'a :variant rides the vendor slug untouched',
    batch.ok && batch.wireId === 'anthropic/claude-opus-5:batch',
  )
  const nested = canonicalWireModelId('compat/compat/qwen3-32b')
  check(
    'a self-nested compat id refuses as double composition',
    !nested.ok && /re-prefixed/.test(nested.ok ? '' : nested.reason),
  )
  const local = canonicalWireModelId('local/hf.co/org/model:tag')
  check(
    "a local server's own multi-segment name rides verbatim (named grammar)",
    local.ok && local.wireId === 'hf.co/org/model:tag',
  )
}

section('4 · THE SKIP-PERMS NEUTRALITY LAW (capabilities.ts modelSupportsAutoMode)')
for (const id of ['gpt-5.6-sol', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'deepseek-v4-pro', 'compat/qwen3-32b']) {
  check(`auto mode is provider-neutral for ${id}`, modelSupportsAutoMode(id) === true)
}
check('home-lane allowlist unchanged: fable-5 keeps auto mode', modelSupportsAutoMode('claude-fable-5') === true)
check(
  'home-lane allowlist unchanged: haiku still refused',
  modelSupportsAutoMode('claude-haiku-4-5-20251001') === false,
)

section('5 · the Hugging Face and local namespaces (qualified rows)')
check(
  'the id-space table declares both qualified namespaces',
  PROVIDER_ID_SPACES.some(s => s.route === 'huggingface' && s.qualifiedPrefix === 'huggingface/') &&
    PROVIDER_ID_SPACES.some(s => s.route === 'local' && s.qualifiedPrefix === 'local/'),
)
check('huggingface/<org>/<model> routes to huggingface', declaredRouteOf('huggingface/Qwen/Qwen3.8-2.4T-A95B') === 'huggingface')
check(
  'a :provider suffix rides inside the namespace (no sentinel collision)',
  declaredRouteOf('huggingface/openai/gpt-oss-120b:groq') === 'huggingface',
)
check('local/<model> routes to local', declaredRouteOf('local/llama3.2:latest') === 'local')
check('the Hub slug keeps its CASE through the wire strip', qualifiedWireId('huggingface/Qwen/Qwen3.8-2.4T-A95B') === 'Qwen/Qwen3.8-2.4T-A95B')
check('the suffix survives the strip verbatim', qualifiedWireId('huggingface/openai/gpt-oss-120b:cheapest') === 'openai/gpt-oss-120b:cheapest')
check('the local prefix detaches to the server model name', qualifiedWireId('local/llama3.2:latest') === 'llama3.2:latest')
check(
  'the dispatch-side id keeps a qualified Hub slug verbatim (no API normalization)',
  compatDispatchModelId('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813') === 'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813',
)
check('a bare Hub slug stays UNRECOGNISED (never a guessed family, and no lane by remainder)', classifyModelRoute('Qwen/Qwen3.8-2.4T-A95B').kind === 'unrecognised')
check('auto mode is provider-neutral for huggingface ids', modelSupportsAutoMode('huggingface/openai/gpt-oss-120b') === true)
check('auto mode is provider-neutral for local ids', modelSupportsAutoMode('local/llama3.2:latest') === true)

section('6 · the earned ride (the neutrality ruling): total classifier, admission-owned ride')
{
  // The routing law stays TOTAL — the remainder answers for absence and for
  // the earned rides alike — while the RIDE of an id no family declares is
  // homeLaneAdmission's alone: refused typed before any HTTP unless an
  // operator-owned fact (an ANTHROPIC_* model pin, a gateway base URL)
  // carries it. The classifier and the admission owner cannot disagree:
  // the door only opens on ids the classifier classes home.
  const { homeLaneAdmissionRefusal } = await import(
    '../../src/services/providers/homeLaneAdmission.ts'
  )
  const noFact = { firstPartyBaseUrl: () => true, env: {} }
  const refusal = homeLaneAdmissionRefusal('banana-brew-9', noFact)
  // RE-PINNED at the kill: the remainder-era classifier is RETIRED — the
  // stranger names itself, and only the admission owner speaks to its ride.
  check("the classifier names the stranger 'unrecognised' — no lane by remainder", classifyModelRoute('banana-brew-9').kind === 'unrecognised')
  check(
    '…while the admission owner refuses its ride, byte-stable on the sentence head',
    typeof refusal === 'string' && refusal.startsWith("'banana-brew-9' is not a model id any provider family declares ("),
    String(refusal),
  )
  check(
    '…naming both earned roads (the pin road and the gateway road)',
    typeof refusal === 'string' && /ANTHROPIC_\* model pin/.test(refusal) && /ANTHROPIC_BASE_URL/.test(refusal),
    String(refusal),
  )
  check(
    'the env-pin road: the pinned id admits AND routes home (routing joins recognition)',
    homeLaneAdmissionRefusal('ops-gateway-model', { ...noFact, env: { ANTHROPIC_MODEL: 'ops-gateway-model' } }) === null &&
      declaredRouteOf('ops-gateway-model', { ANTHROPIC_MODEL: 'ops-gateway-model' }) === 'anthropic',
  )
  check(
    'the gateway road: a re-pointed base URL admits the unknown id onto the home lane',
    homeLaneAdmissionRefusal('banana-brew-9', { ...noFact, firstPartyBaseUrl: () => false }) === null,
  )

  // The one-owner ratchet (mechanism B's consumer totality): the dispatch
  // home arm consults the admission owner BEFORE the anthropic transport,
  // and the transport's streaming entry is value-imported nowhere in src/
  // outside its own runtime, the guarded router arm, and the typed backend
  // record (whose anthropic face no live seam dispatches — the turn machine
  // rides deps.callModel = routedCallModel, pinned by prove-s5-backends).
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const ROOT = join(import.meta.dir, '..', '..')
  const routerSrc = readFileSync(join(ROOT, 'src/services/providers/callModelRouter.ts'), 'utf8')
  const admissionAt = routerSrc.indexOf('homeLaneAdmissionRefusal(params.options.model)')
  const transportAt = routerSrc.lastIndexOf('yield* queryModelWithStreaming(params)')
  check('the dispatch home arm consults homeLaneAdmissionRefusal before the transport yield', admissionAt !== -1 && transportAt !== -1 && admissionAt < transportAt)
  const VALUE_IMPORT_RE = /import\s*\{[^}]*\bqueryModelWithStreaming\b[^}]*\}\s*from/
  const allowedImporters = new Set([
    join('src', 'services', 'providers', 'callModelRouter.ts'),
    join('src', 'services', 'providers', 'primaryBackend.ts'),
  ])
  const offenders: string[] = []
  for (const entry of readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]) {
    if (!/\.(ts|tsx)$/.test(entry)) continue
    const rel = join('src', entry)
    if (rel.includes(join('services', 'providers', 'anthropic'))) continue
    if (!VALUE_IMPORT_RE.test(readFileSync(join(ROOT, rel), 'utf8'))) continue
    if (!allowedImporters.has(rel)) offenders.push(rel)
  }
  check('no src caller value-imports the streaming transport outside the censused set (no admission bypass)', offenders.length === 0, offenders.join(' · '))
}

section('7 · the honest verdict (phase 2): absence and unknownness first-class')
{
  const { classifyModelRoute, declaredRouteOf, laneLabelForVerdict } = await import(
    '../../src/services/providers/routeLaw.ts'
  )
  // Injected empty env everywhere: a host ANTHROPIC_* pin must not flip a leg.
  const empty = {}
  check(
    "'' · '   ' · undefined are ABSENCE — never any family's remainder",
    classifyModelRoute('', empty).kind === 'absence' &&
      classifyModelRoute('   ', empty).kind === 'absence' &&
      classifyModelRoute(undefined, empty).kind === 'absence',
  )
  const unknown = classifyModelRoute('banana-brew-9', empty)
  check('an id no family declares is UNRECOGNISED (bare shape)', unknown.kind === 'unrecognised' && !unknown.carrierShaped)
  const carrier = classifyModelRoute('qwen/qwen3-coder', empty)
  check('a bare vendor slug is UNRECOGNISED and carrier-shaped', carrier.kind === 'unrecognised' && carrier.carrierShaped)
  // The migration's AGREEMENT fence retired WITH the remainder-era law at
  // the kill commit (there is no old side left to agree with); the matrix
  // survives as the verdict's own totality pins — every id lands exactly
  // one kind, and the declared rows land their §1 families.
  const matrix: Array<[string | undefined, 'route' | 'unrecognised' | 'absence']> = [
    ['glm-5.2', 'route'], ['glm', 'route'], ['GLM-5.2', 'route'], ['glm-5.2[1m]', 'route'],
    ['gpt-5.6-sol', 'route'], ['gpt', 'route'], ['kimi-k3', 'route'], ['moonshot-v2', 'route'],
    ['deepseek-v4-pro', 'route'], ['gemini-3-pro', 'route'], ['Compat/qwen3', 'route'],
    ['openrouter/qwen/qwen3-coder', 'route'], ['huggingface/Qwen/Qwen3.8-2.4T-A95B', 'route'],
    ['local/llama3.2:latest', 'route'], ['claude-sonnet-5', 'route'], ['claude-opus-4-8[1m]', 'route'],
    ['us.anthropic.claude-opus-5-v1:0', 'route'], ['opus', 'route'], ['sonnet5', 'route'],
    ['banana-brew-9', 'unrecognised'], ['Qwen/Qwen3.8-2.4T-A95B', 'unrecognised'],
    [' deepseek-v4-pro ', 'route'], ['gpt-5.6-sol[served]', 'route'], ['', 'absence'], [undefined, 'absence'],
  ]
  check(
    'TOTALITY across the matrix: every id lands exactly its honest kind',
    matrix.every(([id, kind]) => classifyModelRoute(id, empty).kind === kind),
  )
  const mark = classifyModelRoute('claude-sonnet-5', empty)
  const alias = classifyModelRoute('opus', empty)
  const pinned = classifyModelRoute('ops-pinned', { ANTHROPIC_MODEL: 'ops-pinned' })
  check(
    'first-party carries its earned why (claude-mark · alias · env-pin)',
    mark.kind === 'route' && mark.route === 'anthropic' && mark.why === 'claude-mark' &&
      alias.kind === 'route' && alias.route === 'anthropic' && alias.why === 'alias' &&
      pinned.kind === 'route' && pinned.route === 'anthropic' && pinned.why === 'env-pin',
  )
  check(
    'declaredRouteOf: the family for declared, anthropic only when EARNED, null for the stranger and for absence-shaped input',
    declaredRouteOf('glm-5.2', empty) === 'zai' &&
      declaredRouteOf('claude-sonnet-5', empty) === 'anthropic' &&
      declaredRouteOf('banana-brew-9', empty) === null &&
      declaredRouteOf('qwen/qwen3-coder', empty) === null &&
      declaredRouteOf('', empty) === null,
  )
  check(
    'the lane-label grammar: family name · Unrecognised · the riding gateway label · unset',
    laneLabelForVerdict({ kind: 'route', route: 'zai' }) === 'Z.AI' &&
      laneLabelForVerdict({ kind: 'unrecognised', carrierShaped: false }) === 'Unrecognised' &&
      laneLabelForVerdict({ kind: 'unrecognised', carrierShaped: false }, { rode: true }) === 'Gateway (Anthropic-compatible)' &&
      laneLabelForVerdict({ kind: 'absence' }) === 'unset',
  )
}

section('8 · the remainder-era name stays dead (the kill ratchet)')
{
  // resolveCallModelRoute was retired at the phase-2 kill: no call and no
  // import of the name may regrow anywhere in src. Comment mentions that
  // record the retirement are lawful (the needle is call/import-shaped —
  // a comment naming the dead disease is not the disease).
  const { readFileSync: readSrc, readdirSync: walkSrc } = await import('node:fs')
  const { join: joinSrc } = await import('node:path')
  const SRC_ROOT = joinSrc(import.meta.dir, '..', '..')
  const CALL_SHAPE = /\bresolveCallModelRoute\s*\(/
  const IMPORT_SHAPE = /(?:import|require)[^\n]*\bresolveCallModelRoute\b|\bresolveCallModelRoute\b\s*,/
  const regrown: string[] = []
  for (const entry of walkSrc(joinSrc(SRC_ROOT, 'src'), { recursive: true }) as string[]) {
    if (!/\.(ts|tsx)$/.test(entry)) continue
    const text = readSrc(joinSrc(SRC_ROOT, 'src', entry), 'utf8')
    if (CALL_SHAPE.test(text) || IMPORT_SHAPE.test(text)) regrown.push(joinSrc('src', entry))
  }
  check('no src file calls or imports the retired resolveCallModelRoute', regrown.length === 0, regrown.join(' · '))
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
