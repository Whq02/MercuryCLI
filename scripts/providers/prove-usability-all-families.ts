#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-usability-all-families.ts — readiness verdicts for
//  ALL TEN provider families from the ONE resolver, hermetic (injected read
//  bundles — the settled precedent; no live store, no login, no network).
//
//    §A every family × {ready, no-credential}: the verdict flips on its
//       OWNING read and the blocker names the family's own remedy verbatim
//    §B anthropic's third axis: the capped window (limit=rejected) blocks
//       AND caps delegation (degradation honesty)
//    §C local's reachability truth rides the discovery cache: present ⇒
//       ready/keyless with NO login; absent ⇒ the start-a-server remedy
//    §D blocker strings are per-family SPECIFIC — no two families share a
//       blocker, and none reads like a generic "unavailable"
//    §E the surfaces read THIS answer: the /logins readiness block and the
//       transition preview resolve through resolveProviderUsability
//       (structural: source pins)
//
//  Run: ~/.bun/bin/bun run scripts/providers/prove-usability-all-families.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const { resolveProviderUsability } = await import(
  '../../src/services/providers/providerUsability.ts'
)
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads
type ProviderId = import('../../src/services/providers/providerUsability.ts').ProviderId

/** The all-absent baseline: no credential anywhere, every lane dark. */
const NONE: Reads = {
  anthropicApiKey: () => null,
  anthropicSubscriber: () => false,
  anthropicBearerToken: () => false,
  anthropicLimitStatus: () => 'allowed',
  gptSeat: () => ({ state: 'disabled', reason: 'no OpenAI account is signed in', why: 'no-account' }),
  zaiKeyPresent: () => false,
  moonshotAccount: () => undefined,
  deepseekKeyPresent: () => false,
  compatConfigured: () => false,
  huggingfaceAccount: () => undefined,
  localServerPresent: () => false,
  openrouterKeyPresent: () => false,
  geminiAccount: () => undefined,
}

/** Per-family: the ONE read that makes it ready. */
const READY_OVERRIDES: Record<ProviderId, Partial<Reads>> = {
  anthropic: { anthropicSubscriber: () => true },
  openai: { gptSeat: () => ({ state: 'ready' }) },
  zai: { zaiKeyPresent: () => true },
  moonshot: { moonshotAccount: () => ({ kind: 'kimi-oauth' }) },
  deepseek: { deepseekKeyPresent: () => true },
  'openai-compat': { compatConfigured: () => true },
  openrouter: { openrouterKeyPresent: () => true },
  gemini: { geminiAccount: () => ({ kind: 'oauth' }) },
  huggingface: { huggingfaceAccount: () => ({ kind: 'api-key' }) },
  local: { localServerPresent: () => true },
}

/** The remedy each family's blocker must name (its OWN spelling). */
const BLOCKER_MARKS: Record<ProviderId, string> = {
  anthropic: 'no Anthropic credential',
  openai: 'no OpenAI account',
  zai: 'ZAI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'openai-compat': 'MERCURY_COMPAT_BASE_URL',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  huggingface: 'HF_TOKEN',
  local: 'MERCURY_LOCAL_BASE_URL',
}

const FAMILIES = Object.keys(READY_OVERRIDES) as ProviderId[]

// ============================================================================
section('§A every family × {ready, no-credential} — the verdict flips on its owning read')
// ============================================================================
{
  const dark = resolveProviderUsability(NONE)
  for (const family of FAMILIES) {
    const lane = dark[family]
    check(
      `${family}: no credential ⇒ not usable, blocker names the remedy`,
      !lane.usable && lane.credential === 'none' && (lane.blockers[0] ?? '').includes(BLOCKER_MARKS[family]),
      `usable=${lane.usable} credential=${lane.credential} blocker=${JSON.stringify(lane.blockers[0])}`,
    )
  }
  for (const family of FAMILIES) {
    const map = resolveProviderUsability({ ...NONE, ...READY_OVERRIDES[family] })
    const lane = map[family]
    const others = FAMILIES.filter(f => f !== family)
    check(
      `${family}: its owning read ⇒ usable with zero blockers (and ONLY it flips)`,
      lane.usable && lane.blockers.length === 0 && others.every(f => !map[f].usable),
      `usable=${lane.usable} blockers=${JSON.stringify(lane.blockers)} leaked=${others.filter(f => map[f].usable).join(',')}`,
    )
  }
}

// ============================================================================
section('§B anthropic capped window — blocks work AND caps delegation')
// ============================================================================
{
  const capped = resolveProviderUsability({
    ...NONE,
    anthropicSubscriber: () => true,
    anthropicLimitStatus: () => 'rejected',
  }).anthropic
  check('a rejected window makes the lane unusable with the window blocker', !capped.usable && capped.blockers.some(b => b.includes('usage window')), JSON.stringify(capped.blockers))
  check('degradation honesty: delegation is capped with the window', capped.delegationCapped === true)
  const warning = resolveProviderUsability({
    ...NONE,
    anthropicSubscriber: () => true,
    anthropicLimitStatus: () => 'allowed_warning',
  }).anthropic
  check('a warning-level window stays usable (warn-rest, block-correctness)', warning.usable && warning.limit === 'allowed_warning')
}

// ============================================================================
section('§C local — keyless readiness from the discovery cache, never a login')
// ============================================================================
{
  const up = resolveProviderUsability({ ...NONE, localServerPresent: () => true }).local
  check('a discovered server ⇒ ready, credential=keyless (nothing to sign into)', up.usable && up.credential === 'keyless')
  const down = resolveProviderUsability(NONE).local
  check('no server ⇒ the remedy names starting one or pinning the base', !down.usable && (down.blockers[0] ?? '').includes('start Ollama'), JSON.stringify(down.blockers))
}

// ============================================================================
section('§D blocker specificity — no two families share a blocker, none generic')
// ============================================================================
{
  const dark = resolveProviderUsability(NONE)
  const blockers = FAMILIES.map(f => dark[f].blockers[0] ?? '')
  const unique = new Set(blockers)
  check('ten families, ten distinct blocker strings', unique.size === FAMILIES.length, `${unique.size}/${FAMILIES.length}`)
  check('no blocker is a bare generic ("unavailable"/"error")', blockers.every(b => b.length > 12 && !/^unavailable$|^error$/i.test(b)))
}

// ============================================================================
section('§F engine-lane usage truth — observed limit latches flip the limit axis')
// ============================================================================
{
  const { delegationDispatchBlocker } = await import(
    '../../src/services/providers/providerUsability.ts'
  )
  const latchable = [
    ['openai', 'openaiLimitWindow'],
    ['openrouter', 'openrouterLimitWindow'],
    ['gemini', 'geminiLimitWindow'],
    ['huggingface', 'huggingfaceLimitWindow'],
  ] as const
  for (const [family, read] of latchable) {
    const limited = resolveProviderUsability({
      ...NONE,
      ...READY_OVERRIDES[family],
      [read]: () => ({ state: 'limited' as const }),
    })[family]
    check(
      `${family}: an observed live limit ⇒ rejected + the window blocker`,
      !limited.usable && limited.limit === 'rejected' && limited.blockers.some(b => b.includes('usage window is reached')),
      JSON.stringify({ usable: limited.usable, limit: limited.limit, blockers: limited.blockers }),
    )
    const clear = resolveProviderUsability({
      ...NONE,
      ...READY_OVERRIDES[family],
      [read]: () => ({ state: 'clear' as const }),
    })[family]
    check(
      `${family}: a clear latch stays UNKNOWN (no invented headroom) and usable`,
      clear.usable && clear.limit === 'unknown',
      JSON.stringify({ usable: clear.usable, limit: clear.limit }),
    )
  }
  {
    // The HF billing observation: a wire-refused 402 makes the row honest
    // (not usable, the top-up blocker) — 'ready' over a credit-dead wire is
    // a lie; a clear observation changes nothing.
    const exhausted = resolveProviderUsability({
      ...NONE,
      ...READY_OVERRIDES.huggingface,
      huggingfaceBillingState: () => ({ state: 'credit-exhausted' as const }),
    }).huggingface
    check(
      'huggingface: an observed 402 ⇒ not usable + the credits blocker',
      !exhausted.usable && exhausted.blockers.some(b => b.includes('credits exhausted')),
      JSON.stringify({ usable: exhausted.usable, blockers: exhausted.blockers }),
    )
    const clearBilling = resolveProviderUsability({
      ...NONE,
      ...READY_OVERRIDES.huggingface,
      huggingfaceBillingState: () => ({ state: 'clear' as const }),
    }).huggingface
    check(
      'huggingface: a clear billing observation leaves the row untouched',
      clearBilling.usable && !clearBilling.blockers.some(b => b.includes('credits exhausted')),
      JSON.stringify({ usable: clearBilling.usable }),
    )
  }
  {
    // The SAME billing law for every other lane (laneBillingState): a
    // wire-refused billing fault makes the lane not usable with the lane's
    // own remedy; a clear observation changes nothing; the observation
    // never leaks across lanes; an uncredentialed lane never doubles up.
    const billingLanes = FAMILIES.filter(f => f !== 'anthropic' && f !== 'huggingface')
    for (const family of billingLanes) {
      const refused = resolveProviderUsability({
        ...NONE,
        ...READY_OVERRIDES[family],
        laneBillingState: lane =>
          lane === family
            ? { state: 'credit-exhausted' as const, detail: 'http-402: insufficient balance', remedy: `top up the ${family} account.` }
            : { state: 'clear' as const },
      })
      const lane = refused[family]
      check(
        `${family}: a wire-refused billing fault ⇒ not usable + the lane's own remedy in the blocker`,
        !lane.usable &&
          lane.blockers.some(b => b.includes('refused the last turn for billing') && b.includes(`top up the ${family} account.`) && b.includes('http-402')),
        JSON.stringify({ usable: lane.usable, blockers: lane.blockers }),
      )
      const others = billingLanes.filter(f => f !== family)
      check(
        `${family}: the observation never leaks onto another lane`,
        others.every(f => !refused[f].blockers.some(b => b.includes('refused the last turn for billing'))),
      )
      const clear = resolveProviderUsability({
        ...NONE,
        ...READY_OVERRIDES[family],
        laneBillingState: () => ({ state: 'clear' as const }),
      })[family]
      check(`${family}: a clear billing observation leaves the row usable`, clear.usable && clear.blockers.length === 0)
    }
    const dark = resolveProviderUsability({
      ...NONE,
      laneBillingState: () => ({ state: 'credit-exhausted' as const, detail: 'x', remedy: 'y' }),
    })
    check(
      'an uncredentialed lane keeps ONE blocker (the credential) — no billing blocker piles on',
      billingLanes.every(f => dark[f].blockers.length === 1),
      JSON.stringify(billingLanes.map(f => [f, dark[f].blockers.length])),
    )
  }
  const cappedMap = resolveProviderUsability({
    ...NONE,
    ...READY_OVERRIDES.openai,
    openaiLimitWindow: () => ({ state: 'limited' as const }),
  })
  const refusal = delegationDispatchBlocker('openai', cappedMap)
  check(
    'a rejected engine window refuses DELEGATED dispatch typed (never silent reroute)',
    typeof refusal === 'string' && refusal.includes('cannot take delegated work') && refusal.includes('never silently rerouted'),
    String(refusal),
  )
  check(
    'an uncapped engine lane takes delegated work (no refusal invented)',
    delegationDispatchBlocker('openai', resolveProviderUsability({ ...NONE, ...READY_OVERRIDES.openai })) === null,
  )
}

// ============================================================================
section('§E the surfaces read the ONE answer (structural source pins)')
// ============================================================================
{
  const logins = readFileSync(join(ROOT, 'src/components/ConsoleOAuthFlow.tsx'), 'utf8')
  check('/logins renders the readiness block from resolveProviderUsability', logins.includes('resolveProviderUsability') && logins.includes('ProviderReadinessBlock'))
  check('/logins renders blockers VERBATIM (blockers[0], not a rewrite)', logins.includes('lane.blockers[0]'))
  for (const pickSite of [
    'src/commands/model/model.tsx',
    'src/commands/model/mercuryModel.tsx',
    'src/components/PromptInput/PromptInput.tsx',
  ]) {
    const source = readFileSync(join(ROOT, pickSite), 'utf8')
    check(
      `pick site reads the resolver: ${pickSite.split('/').at(-1)}`,
      source.includes('resolveProviderUsability') || source.includes('usabilityForRoute'),
      `${pickSite} does not reference the resolver`,
    )
  }
}

// ============================================================================
section("§H the compat slot's credential word comes from ITS OWN resolver (FC-075)")
// ============================================================================
{
  const keyless = resolveProviderUsability({
    ...NONE,
    compatAccount: () => ({ kind: 'keyless' as const }),
  })['openai-compat']
  check(
    "a keyless endpoint reads 'keyless' on the readiness lane (was: the key lane's default 'api-key')",
    keyless.usable && keyless.credential === 'keyless',
    `usable=${keyless.usable} credential=${keyless.credential}`,
  )
  const keyed = resolveProviderUsability({
    ...NONE,
    compatAccount: () => ({ kind: 'api-key' as const }),
  })['openai-compat']
  check("a keyed endpoint reads 'api-key'", keyed.usable && keyed.credential === 'api-key')
  const legacyFixture = resolveProviderUsability({
    ...NONE,
    compatConfigured: () => true,
  })['openai-compat']
  check(
    'the presence-only fixture keeps the historical shape (fallback compat)',
    legacyFixture.usable && legacyFixture.credential === 'api-key',
  )
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
