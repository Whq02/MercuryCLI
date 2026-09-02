#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-r04-cap-posture.ts — R04/R05
//  substrate: the cap-survival decision core + the REVIVED fixture seam.
//
//    §A the posture matrix — decideCapAction over posture × quota; the
//       DEFAULT-OFF NO-OP LAW is total (off never offers, never switches);
//       offer fires on warning (preemptive) and rejected; auto hands off
//       unattended only on rejected, warnings stay visible offers
//    §B posture-symmetric return — off never moved; the way home fires
//       only once the HOME window is truly reset, offer/auto symmetric,
//       trigger typed 'reset'
//    §C the seam is REVIVED behind the Mercury-native arm — unarmed is
//       byte-identical folded-shut (repro-ctm-r04b's observable); armed,
//       the setter/gate layers run live and a deterministic journey
//       (allowed → warning → rejected → reset) drives end-to-end through
//       the REAL mock scenario setter + shouldProcessMockLimits
//    §D registry truth — both flags registered at their consumers
//    §G the WIDENED candidate law (CP-A) — the handoff target derives from
//       the whole readiness-checked catalogue: anthropic never a candidate;
//       only USABLE lanes with a target fact from their own owner enter;
//       OpenAI first; typed exclusions; the empty set stays quiet
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-r04-config-'))
// §E drives the REAL header→limits ingestion; the test guard routes any
// config reads at the temp home.
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_MOCK_LIMITS
delete process.env.MERCURY_CAP_FAILOVER

const {
  decideCapAction,
  decideCapReturn,
  resolveCapPosture,
  deriveCapFailoverCandidates,
  orderFamiliesBySignIn,
  observedFamilyWindow,
  laneSpendPosture,
  clearCapHandoffForFamily,
  CAP_APPROACHING_PCT,
} = await import('../../src/services/capFailover.ts')
const mock = await import('../../src/services/mockRateLimits.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the posture matrix — the default OFFERS; explicit off stays TOTAL')
{
  // FN-013 MODEL-05 (operator-accepted release-note change): the fully-
  // built handoff offer is reachable without pre-arming — unset resolves
  // 'offer', which ASKS and never switches; explicit 'off' remains the
  // fully-inert posture, byte-identical to the old default.
  check("unset flag resolves 'offer' (the offer is reachable without pre-arming)", resolveCapPosture() === 'offer')
  process.env.MERCURY_CAP_FAILOVER = 'off'
  check("explicit 'off' selects the fully-inert posture", resolveCapPosture() === 'off')
  delete process.env.MERCURY_CAP_FAILOVER
  for (const q of ['allowed', 'allowed_warning', 'rejected'] as const) {
    check(`off × ${q} ⇒ none (never switches, never offers)`, decideCapAction('off', q).kind === 'none')
  }
  check('offer × allowed ⇒ none', decideCapAction('offer', 'allowed').kind === 'none')
  const warn = decideCapAction('offer', 'allowed_warning')
  check('offer × warning ⇒ preemptive OFFER', warn.kind === 'offer' && warn.kind === 'offer' && warn.trigger === 'warning')
  const rej = decideCapAction('offer', 'rejected')
  check('offer × rejected ⇒ OFFER (never silent)', rej.kind === 'offer' && rej.trigger === 'rejected')
  const autoWarn = decideCapAction('auto', 'allowed_warning')
  check('auto × warning ⇒ still a VISIBLE offer (never silent preemption)', autoWarn.kind === 'offer')
  const autoRej = decideCapAction('auto', 'rejected')
  check('auto × rejected ⇒ unattended handoff', autoRej.kind === 'auto-handoff' && autoRej.trigger === 'rejected')
  process.env.MERCURY_CAP_FAILOVER = 'auto'
  check("the registered flag arms the posture ('auto')", resolveCapPosture() === 'auto')
  process.env.MERCURY_CAP_FAILOVER = 'bogus'
  check("an unknown value degrades to 'offer' (asks — never a surprise unattended switch)", resolveCapPosture() === 'offer')
  delete process.env.MERCURY_CAP_FAILOVER
}

section('§B posture-symmetric return — home only on an OBSERVED reset with the home credential usable')
{
  const reset = { window: 'allowed', credentialUsable: true } as const
  check('not on the failover lane ⇒ none', decideCapReturn('auto', reset, false).kind === 'none')
  check('off never moved ⇒ nothing to return', decideCapReturn('off', reset, true).kind === 'none')
  check('home still warning ⇒ stay (no thrash)', decideCapReturn('offer', { window: 'allowed_warning', credentialUsable: true }, true).kind === 'none')
  check("home 'warning' (the neutral spelling) ⇒ stay", decideCapReturn('offer', { window: 'warning', credentialUsable: true }, true).kind === 'none')
  // The operator's sighting: the home sign-out reset the limits latch to
  // its 'allowed' default, and the old decision read that as "the window
  // reset" — a card that Enter could not dismiss. Nothing observed is NOT
  // a reset, and a signed-out home is no home.
  check("'unknown' (nothing observed) is NEVER read as a reset", decideCapReturn('offer', { window: 'unknown', credentialUsable: true }, true).kind === 'none' && decideCapReturn('auto', { window: 'unknown', credentialUsable: true }, true).kind === 'none')
  check('the home credential signed out ⇒ no return offer, even on an observed reset', decideCapReturn('offer', { window: 'allowed', credentialUsable: false }, true).kind === 'none' && decideCapReturn('auto', { window: 'allowed', credentialUsable: false }, true).kind === 'none')
  const offerHome = decideCapReturn('offer', reset, true)
  check("offer ⇒ the way home is OFFERED (trigger 'reset')", offerHome.kind === 'offer' && offerHome.trigger === 'reset')
  const autoHome = decideCapReturn('auto', reset, true)
  check('auto ⇒ unattended return at the boundary', autoHome.kind === 'auto-handoff' && autoHome.trigger === 'reset')
  check("decideCapAction reads 'unknown' as nothing to do (no observation is not a wall)", decideCapAction('offer', 'unknown').kind === 'none' && decideCapAction('auto', 'unknown').kind === 'none')
  check("decideCapAction takes the neutral 'warning' spelling too", decideCapAction('offer', 'warning').kind === 'offer')
}

section('§C the seam — folded shut unarmed, LIVE armed (the r04b revival)')
{
  check('unarmed: shouldProcessMockLimits stays false (byte-identical fold)', mock.shouldProcessMockLimits() === false)
  mock.setMockRateLimitScenario('approaching-weekly-limit' as never)
  check('unarmed: the setter is inert (the folded return)', mock.shouldProcessMockLimits() === false)

  process.env.MERCURY_MOCK_LIMITS = '1'
  check('armed: the seam opens only AFTER a scenario arms it', mock.shouldProcessMockLimits() === false)
  mock.setMockRateLimitScenario('approaching-weekly-limit' as never)
  check('armed: the REAL setter runs — the gate goes live', mock.shouldProcessMockLimits() === true)
  const warnHeaders = mock.getMockHeaders()
  check(
    'the deterministic journey speaks real header vocabulary (warning leg)',
    warnHeaders !== null && JSON.stringify(warnHeaders).includes('anthropic-ratelimit-unified'),
  )
  mock.setMockRateLimitScenario('weekly-limit-reached' as never)
  const rejHeaders = mock.getMockHeaders()
  check(
    'the rejected leg drives status=rejected',
    rejHeaders?.['anthropic-ratelimit-unified-status'] === 'rejected',
    JSON.stringify(rejHeaders ?? {}),
  )
  mock.setMockRateLimitScenario('clear' as never)
  check('the reset leg clears (the way-home trigger)', mock.shouldProcessMockLimits() === false)
  delete process.env.MERCURY_MOCK_LIMITS
}

section('§D registry truth')
{
  const seam = getFlagSpec('MERCURY_MOCK_LIMITS')
  const posture = getFlagSpec('MERCURY_CAP_FAILOVER')
  check('MERCURY_MOCK_LIMITS registered at the seam', seam?.consumer === 'src/services/mockRateLimits.ts')
  check('MERCURY_CAP_FAILOVER registered at the decision core', posture?.consumer === 'src/services/capFailover.ts')
}

section('§E the full journey, both postures — warning → offer/auto → continue → reset → return')
{
  // The REAL ingestion path end-to-end: scenario → mock overlay →
  // computeNewLimitsFromHeaders → currentLimits → the decision core. This is
  // the deterministic rateLimitMocking journey ruling R04 names, driven exactly
  // as the /mock-limits command drives it.
  process.env.MERCURY_MOCK_LIMITS = '1'
  const limits = await import('../../src/services/claudeAiLimits.ts')
  const { capHandoffState, noteCapHandoff, noteCapReturn } = await import(
    '../../src/services/capFailover.ts'
  )
  const ingest = (scenario: string) => {
    // The real warning vocabulary is the early-warning THRESHOLD headers
    // (a bare allowed_warning status demotes in computeNewLimitsFromHeaders)
    // — the journey speaks it via the seam's own early-warning setter.
    if (scenario === 'warning-7d') {
      mock.setMockRateLimitScenario('clear' as never)
      mock.setMockEarlyWarning('7d', 0.92)
    } else {
      mock.setMockRateLimitScenario(scenario as never)
    }
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    limits.extractQuotaStatusFromHeaders(new globalThis.Headers())
    return limits.currentLimits
  }

  for (const posture of ['offer', 'auto'] as const) {
    noteCapReturn()
    // leg 1 — warning arrives: BOTH postures present a visible offer.
    const warn = ingest('warning-7d')
    check(`[${posture}] warning ingests as allowed_warning`, warn.status === 'allowed_warning')
    const a1 = decideCapAction(posture, warn.status as never)
    check(`[${posture}] warning ⇒ visible offer`, a1.kind === 'offer' && a1.trigger === 'warning')
    // leg 2 — the window caps: offer keeps asking; auto hands off unattended.
    const rej = ingest('weekly-limit-reached')
    check(`[${posture}] cap ingests as rejected with a reset time`, rej.status === 'rejected' && typeof rej.resetsAt === 'number')
    const a2 = decideCapAction(posture, rej.status as never)
    check(
      `[${posture}] cap ⇒ ${posture === 'auto' ? 'unattended handoff' : 'offer, never silent'}`,
      posture === 'auto' ? a2.kind === 'auto-handoff' : a2.kind === 'offer',
    )
    // the accepted handoff notes the lane AND the home family (session-
    // scoped, never persisted)
    noteCapHandoff('claude-fable-5', 'anthropic')
    check(`[${posture}] the handoff note carries the way home — model and family`, capHandoffState()?.homeModel === 'claude-fable-5' && capHandoffState()?.homeFamily === 'anthropic')
    // leg 3 — work continues on the failover lane; home still capped ⇒ stay.
    // The ONE family resolver reads the live latch: rejected, observed.
    const capped = observedFamilyWindow('anthropic')
    check(`[${posture}] the anthropic resolver reads the cap as an OBSERVED rejected window`, capped.state === 'rejected' && capped.basis === 'observed', JSON.stringify(capped))
    const stay = decideCapReturn(posture, { window: capped.state, credentialUsable: true }, true)
    check(`[${posture}] home still capped ⇒ stay on the lane`, stay.kind === 'none')
    // leg 4 — the home window resets: a real reset arrives as a WIRE
    // observation — the seam's 'normal' scenario (status allowed, a reset
    // moment stated), exactly as a reply's headers would carry it. The
    // SAME posture then speaks the way back.
    const reset = ingest('normal')
    check(`[${posture}] the reset ingests as an allowed observation`, reset.status === 'allowed')
    const cleared = observedFamilyWindow('anthropic')
    check(`[${posture}] the resolver reads the fresh allowed reply as an OBSERVED allowed window`, cleared.state === 'allowed' && cleared.basis === 'observed', JSON.stringify(cleared))
    const back = decideCapReturn(posture, { window: cleared.state, credentialUsable: true }, true)
    check(
      `[${posture}] reset ⇒ posture-symmetric return (trigger 'reset')`,
      posture === 'auto'
        ? back.kind === 'auto-handoff' && back.trigger === 'reset'
        : back.kind === 'offer' && back.trigger === 'reset',
    )
    noteCapReturn()
    check(`[${posture}] the way home clears the note`, capHandoffState() === null)
    // The contrast: the seam's 'clear' DISABLES the engine — the gate
    // closes and the record is wiped to its settled default. A wiped state
    // is 'unknown', never a reset: no observation was made.
    const wiped = ingest('clear')
    const afterWipe = observedFamilyWindow('anthropic')
    check(`[${posture}] a wiped record (the gate closed) settles to allowed but reads 'unknown' — never a reset`, wiped.status === 'allowed' && afterWipe.state === 'unknown' && afterWipe.basis === 'none', JSON.stringify(afterWipe))
    check(`[${posture}] …and no return fires on a wipe`, decideCapReturn(posture, { window: afterWipe.state, credentialUsable: true }, true).kind === 'none')
  }

  // The default-off no-op rides the SAME ingestion: a capped window changes
  // nothing under 'off'.
  const rejOff = ingest('weekly-limit-reached')
  check('[off] the same capped truth decides none', decideCapAction('off', rejOff.status as never).kind === 'none')
  ingest('clear')

  // THE OPERATOR'S SIGHTING, reproduced at the owner: the home sign-out
  // resets the latch to its settled default. The record says 'allowed'
  // because it says NOTHING — the resolver reads 'unknown', and the return
  // decision stays quiet with it.
  ingest('weekly-limit-reached')
  noteCapHandoff('claude-fable-5', 'anthropic')
  limits.resetLimitsForCredentialSwitch()
  check('after a credential switch the latch settles to its allowed default', limits.currentLimits.status === 'allowed')
  check('…but nothing has been OBSERVED (claudeWindowObserved false)', limits.claudeWindowObserved() === false)
  const afterSignOut = observedFamilyWindow('anthropic')
  check("…so the resolver reads 'unknown' (basis none) — never a reset", afterSignOut.state === 'unknown' && afterSignOut.basis === 'none', JSON.stringify(afterSignOut))
  check('…and no return card fires on it', decideCapReturn('offer', { window: afterSignOut.state, credentialUsable: true }, true).kind === 'none')
  // A sign-out of the HOME family clears the note: there is no home.
  clearCapHandoffForFamily('openai')
  check("a sign-out of ANOTHER family leaves the note standing", capHandoffState()?.homeFamily === 'anthropic')
  clearCapHandoffForFamily('anthropic')
  check('a sign-out of the HOME family clears the handoff note', capHandoffState() === null)
  ingest('normal')
  check('the next wire observation re-arms the record', limits.claudeWindowObserved() === true && observedFamilyWindow('anthropic').basis === 'observed')
  ingest('clear')
  delete process.env.MERCURY_MOCK_LIMITS
}

section('§F the arm surfaces — boot-menu posture row + the command opening')
{
  const { STARTUP_MENU, menuRowChoices } = await import('../../src/substrate/startupMenu.ts')
  const row = STARTUP_MENU.find(r => r.env === 'MERCURY_CAP_FAILOVER')
  check('the boot menu carries the cap posture row', row !== undefined)
  check("the row's default is offer (the reachable ask — nothing moves without the keypress)", row?.defaultLabel === 'offer')
  check(
    'the row cycles default(offer) → off → auto',
    JSON.stringify(menuRowChoices(row!).map(c => c.value)) === JSON.stringify([null, 'off', 'auto']),
  )
  const cmd = (await import('../../src/commands/mock-limits/index.ts')).default
  check('the /mock-limits opening exists behind the registered arm', cmd.name === 'mock-limits')
  delete process.env.MERCURY_MOCK_LIMITS
  check('unarmed builds carry no /mock-limits command', cmd.isEnabled() === false)
  process.env.MERCURY_MOCK_LIMITS = '1'
  check('the registered arm exposes it', cmd.isEnabled() === true)
  delete process.env.MERCURY_MOCK_LIMITS
}

section('§G the NEUTRAL candidate law — every other signed-in family, sign-in recency first, fence intact')
{
  const lane = (usable: boolean, blockers: string[] = []) => ({ usable, blockers })
  // Fixture map: openai + zai + local + deepseek usable; the rest blocked
  // or absent; gemini usable but recording no target fact.
  const map: Record<string, { usable: boolean; blockers: string[] }> = {
    anthropic: lane(true),
    openai: lane(true),
    zai: lane(true),
    moonshot: lane(false, ['no Kimi sign-in or Moonshot API key — /logins moonshot (or MOONSHOT_API_KEY)']),
    deepseek: lane(true),
    'openai-compat': lane(false, ['no endpoint configured — MERCURY_COMPAT_BASE_URL']),
    openrouter: lane(false, ['no OpenRouter credential — /logins (or OPENROUTER_API_KEY)']),
    gemini: lane(true), // usable but records NO target fact — must be excluded, typed
    huggingface: lane(false, ['no Hugging Face credential — /logins (or HF_TOKEN)']),
    local: lane(true),
  }
  const targets: Record<string, string | undefined> = {
    anthropic: 'claude-fable-5',
    openai: 'gpt-5.6-sol',
    zai: 'glm-4.7',
    deepseek: 'deepseek-chat-v3.4',
    local: 'local/llama-3.3-70b',
    gemini: undefined, // the no-fact family
  }
  // The sign-in ledger's recency: zai signed in last, then openai, then
  // anthropic; deepseek and local are untimed (an env pin, a keyless server).
  const signInAt: Record<string, number> = { zai: 3_000, openai: 2_000, anthropic: 1_000 }
  const at = (family: string): number | undefined => signInAt[family]

  // HOME = anthropic (the session runs on Claude): the set is every OTHER
  // family, the most recent sign-in FIRST — never a hardwired OpenAI-first.
  const fromAnthropic = deriveCapFailoverCandidates('anthropic', map, route => targets[route], at)
  check('the home family is never its own candidate', fromAnthropic.home === 'anthropic' && !fromAnthropic.candidates.some(c => c.route === 'anthropic') && !fromAnthropic.excluded.some(e => e.route === 'anthropic'))
  check(
    'sign-in recency orders the set: the most recent sign-in first, untimed credentials after every timed one (in the resolver\'s order)',
    JSON.stringify(fromAnthropic.candidates) ===
      JSON.stringify([
        { route: 'zai', model: 'glm-4.7' },
        { route: 'openai', model: 'gpt-5.6-sol' },
        { route: 'deepseek', model: 'deepseek-chat-v3.4' },
        { route: 'local', model: 'local/llama-3.3-70b' },
      ]),
    JSON.stringify(fromAnthropic.candidates),
  )
  // HOME = openai (a GPT session walls): anthropic IS a candidate now, in
  // its recency place — the neutral law has no favourite and no exclusion.
  const fromOpenai = deriveCapFailoverCandidates('openai', map, route => targets[route], at)
  check(
    'a GPT home walls ⇒ the offer names another signed-in family; anthropic enters as an ordinary candidate',
    fromOpenai.home === 'openai' &&
      !fromOpenai.candidates.some(c => c.route === 'openai') &&
      JSON.stringify(fromOpenai.candidates.map(c => c.route)) === JSON.stringify(['zai', 'anthropic', 'deepseek', 'local']),
    JSON.stringify(fromOpenai.candidates),
  )
  check('the first candidate (the lane the card offers) for a GPT home is the most recent OTHER sign-in', fromOpenai.candidates[0]?.route === 'zai' && fromOpenai.candidates[0].model === 'glm-4.7')
  // HOME = zai (the most recent sign-in itself walls): the next-most-recent
  // leads — no family is favoured by name.
  const fromZai = deriveCapFailoverCandidates('zai', map, route => targets[route], at)
  check('a Z.AI home walls ⇒ openai (the next-most-recent sign-in) leads, anthropic after it', JSON.stringify(fromZai.candidates.map(c => c.route)) === JSON.stringify(['openai', 'anthropic', 'deepseek', 'local']), JSON.stringify(fromZai.candidates))
  const gemini = fromAnthropic.excluded.find(e => e.route === 'gemini')
  check(
    'a usable lane with NO recorded target fact is excluded with the typed why (never a guessed id)',
    gemini !== undefined && gemini.why.includes('no recorded target model fact'),
    JSON.stringify(gemini),
  )
  const moonshot = fromAnthropic.excluded.find(e => e.route === 'moonshot')
  check(
    "an unusable lane is excluded carrying its OWN blockers verbatim",
    moonshot !== undefined && moonshot.why.includes('/logins moonshot'),
    JSON.stringify(moonshot),
  )
  check(
    'every non-candidate family is a TYPED exclusion (the set partitions the catalogue minus home)',
    fromAnthropic.candidates.length + fromAnthropic.excluded.length === Object.keys(map).length - 1,
    `${fromAnthropic.candidates.length}+${fromAnthropic.excluded.length} vs ${Object.keys(map).length - 1}`,
  )
  // No ledger at all: the resolver's own order stands (no hidden favourite).
  const untimed = deriveCapFailoverCandidates('anthropic', map, route => targets[route])
  check('with no sign-in times the resolver\'s own order stands', JSON.stringify(untimed.candidates.map(c => c.route)) === JSON.stringify(['openai', 'zai', 'deepseek', 'local']), JSON.stringify(untimed.candidates))
  check('orderFamiliesBySignIn is the one ordering owner (recency, then untimed, then the given order)', JSON.stringify(orderFamiliesBySignIn(['a', 'b', 'c', 'd'], f => ({ a: 5, c: 9 } as Record<string, number>)[f])) === JSON.stringify(['c', 'a', 'b', 'd']))
  // The most recent sign-in signed out: the next readiness-checked family
  // leads — never an invented target, never silence while a lane qualifies.
  const noZai = deriveCapFailoverCandidates('anthropic', { ...map, zai: lane(false, ['no Z.AI API key — /logins zai']) }, route => targets[route], at)
  check('the most recent sign-in signed out ⇒ the next family leads (openai here)', JSON.stringify(noZai.candidates[0]) === JSON.stringify({ route: 'openai', model: 'gpt-5.6-sol' }), JSON.stringify(noZai.candidates[0]))
  // NOTHING usable ⇒ the empty set — the offer/auto surfaces stay quiet.
  const none = deriveCapFailoverCandidates(
    'anthropic',
    Object.fromEntries(Object.keys(map).map(k => [k, lane(false, ['signed out'])])),
    () => undefined,
  )
  check('no usable lane ⇒ the empty candidate set (surfaces stay quiet)', none.candidates.length === 0)
  // The default-off no-op law COMPOSES: candidates existing changes nothing
  // under posture off (§A's law re-checked beside the neutral set).
  check('posture off never consumes a candidate (off × rejected ⇒ none)', decideCapAction('off', 'rejected').kind === 'none')
}

section('§H the ONE per-family window resolver — unknown is a state, a stated reset elapsed is an observed reset')
{
  const now = 1_000_000_000_000
  const clock = { now: () => now }
  const quiet = {
    ...clock,
    openaiActiveSource: () => undefined,
    openaiWall: () => null,
    openaiBands: () => [],
    openrouterWall: () => null,
    geminiWall: () => null,
    huggingfaceWall: () => null,
    laneBilling: () => ({ state: 'clear' as const }),
  }
  // anthropic
  const anthropicUnobserved = observedFamilyWindow('anthropic', { ...quiet, anthropic: () => ({ status: 'allowed', observed: false }) })
  check("anthropic: the settled default with nothing observed reads 'unknown', basis none", anthropicUnobserved.state === 'unknown' && anthropicUnobserved.basis === 'none')
  const anthropicWall = observedFamilyWindow('anthropic', { ...quiet, anthropic: () => ({ status: 'rejected', observed: true, resetsAtMs: now + 60_000, windowName: 'weekly limit' }) })
  check('anthropic: a reached window with its reset ahead reads rejected (observed), the window named', anthropicWall.state === 'rejected' && anthropicWall.basis === 'observed' && anthropicWall.windowName === 'weekly limit' && anthropicWall.resetsAtMs === now + 60_000)
  const anthropicElapsed = observedFamilyWindow('anthropic', { ...quiet, anthropic: () => ({ status: 'rejected', observed: true, resetsAtMs: now - 1, windowName: 'weekly limit' }) })
  check("anthropic: the provider's own stated reset moment passing is an OBSERVED reset (allowed, basis stated-reset-elapsed)", anthropicElapsed.state === 'allowed' && anthropicElapsed.basis === 'stated-reset-elapsed')
  const anthropicWarn = observedFamilyWindow('anthropic', { ...quiet, anthropic: () => ({ status: 'allowed_warning', observed: true, resetsAtMs: now + 5_000, windowName: 'session limit' }) })
  check("anthropic: allowed_warning reads the neutral 'warning'", anthropicWarn.state === 'warning' && anthropicWarn.windowName === 'session limit')
  const anthropicFresh = observedFamilyWindow('anthropic', { ...quiet, anthropic: () => ({ status: 'allowed', observed: true }) })
  check('anthropic: a fresh allowed observation reads allowed (observed)', anthropicFresh.state === 'allowed' && anthropicFresh.basis === 'observed')
  // openai — the per-source wall, then the bands, else unknown
  const openaiNone = observedFamilyWindow('openai', { ...quiet, openaiActiveSource: () => 'chatgpt-subscription' })
  check("openai: no wall and no bands ⇒ 'unknown' (no headroom is invented)", openaiNone.state === 'unknown')
  const openaiWalled = observedFamilyWindow('openai', { ...quiet, openaiActiveSource: () => 'chatgpt-subscription', openaiWall: () => ({ resetsAtMs: now + 90_000 }) })
  check('openai: a wall with its reset ahead reads rejected (observed)', openaiWalled.state === 'rejected' && openaiWalled.basis === 'observed' && openaiWalled.resetsAtMs === now + 90_000)
  const openaiElapsed = observedFamilyWindow('openai', { ...quiet, openaiActiveSource: () => 'chatgpt-subscription', openaiWall: () => ({ resetsAtMs: now - 1 }) })
  check('openai: an elapsed wall is an OBSERVED reset — the way home for a GPT-home session', openaiElapsed.state === 'allowed' && openaiElapsed.basis === 'stated-reset-elapsed')
  const openaiApproaching = observedFamilyWindow('openai', { ...quiet, openaiActiveSource: () => 'chatgpt-subscription', openaiBands: () => [{ usedPct: 40, windowName: '5h window' }, { usedPct: CAP_APPROACHING_PCT, windowName: 'weekly window', resetsAtMs: now + 3_600_000 }] })
  check('openai: the worst live band at the approaching threshold reads warning, the window named', openaiApproaching.state === 'warning' && openaiApproaching.windowName === 'weekly window' && openaiApproaching.resetsAtMs === now + 3_600_000)
  const openaiHeadroom = observedFamilyWindow('openai', { ...quiet, openaiActiveSource: () => 'chatgpt-subscription', openaiBands: () => [{ usedPct: 12, windowName: 'weekly window' }] })
  check('openai: bands below the threshold read allowed (observed headroom)', openaiHeadroom.state === 'allowed' && openaiHeadroom.basis === 'observed')
  const openaiStale = observedFamilyWindow('openai', { ...quiet, openaiActiveSource: () => 'chatgpt-subscription', openaiBands: () => [{ usedPct: 99, windowName: 'weekly window', resetsAtMs: now - 1 }] })
  check("openai: a band whose stated reset passed is stale, not a warning — 'unknown'", openaiStale.state === 'unknown')
  const openaiKey = observedFamilyWindow('openai', { ...quiet, openaiActiveSource: () => 'api-key', openaiBands: () => [{ usedPct: 99, windowName: 'weekly window' }] })
  check("openai: the key source reads no subscription bands — 'unknown' without its own wall", openaiKey.state === 'unknown')
  // the engine lanes
  const orWall = observedFamilyWindow('openrouter', { ...quiet, openrouterWall: () => ({ resetsAtMs: now + 10 }) })
  const gmElapsed = observedFamilyWindow('gemini', { ...quiet, geminiWall: () => ({ resetsAtMs: now - 10 }) })
  const hfWall = observedFamilyWindow('huggingface', { ...quiet, huggingfaceWall: () => ({ resetsAtMs: now + 10 }) })
  check('openrouter/gemini/huggingface read their own walls the same way (ahead ⇒ rejected; passed ⇒ observed reset)', orWall.state === 'rejected' && gmElapsed.state === 'allowed' && gmElapsed.basis === 'stated-reset-elapsed' && hfWall.state === 'rejected')
  const zaiCredit = observedFamilyWindow('zai', { ...quiet, laneBilling: family => ({ state: family === 'zai' ? 'credit-exhausted' : 'clear' }) })
  check("a lane whose wire refused for credit reads rejected (observed), window 'credits'", zaiCredit.state === 'rejected' && zaiCredit.windowName === 'credits')
  check("a lane that serves no usage signal reads 'unknown'", observedFamilyWindow('deepseek', quiet).state === 'unknown' && observedFamilyWindow('local', quiet).state === 'unknown')
  const throwing = observedFamilyWindow('anthropic', { ...quiet, anthropic: () => { throw new Error('reader down') } })
  check("a reader that throws reads 'unknown' — the resolver never throws", throwing.state === 'unknown')
  const { APPROACHING_LIMIT_PCT } = await import('../../src/services/providers/limitWarning.ts')
  check('the approaching threshold is the strip warning\'s own number', CAP_APPROACHING_PCT === APPROACHING_LIMIT_PCT)
}

section('§I the words — the card names the family; the spend posture is per family kind, never a default subscription lane')
{
  check('an OAuth credential on anthropic/openai/moonshot is a subscription lane', laneSpendPosture('anthropic', 'oauth', 'Anthropic').kind === 'subscription' && laneSpendPosture('openai', 'oauth', 'OpenAI').kind === 'subscription' && laneSpendPosture('moonshot', 'oauth', 'Moonshot').kind === 'subscription')
  check('a key is metered per token, on every family', laneSpendPosture('anthropic', 'api-key', 'Anthropic').kind === 'metered' && laneSpendPosture('openai', 'api-key', 'OpenAI').kind === 'metered' && laneSpendPosture('zai', 'api-key', 'Z.AI').words.includes('bills per token under your Z.AI account'))
  check('a local server bills nothing; an operator endpoint bills per its own terms', laneSpendPosture('local', 'keyless', 'Local models').kind === 'local' && laneSpendPosture('openai-compat', 'api-key', 'Custom endpoint').kind === 'endpoint')
  check('no credential ⇒ the honest none', laneSpendPosture('gemini', 'none', 'Gemini').kind === 'none')
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const ROOT = join(import.meta.dir, '..', '..')
  const card = readFileSync(join(ROOT, 'src/components/CapOfferCard.tsx'), 'utf8')
  check('the card title names the HOME family (window reset — return? · usage window)', card.includes('`${homeName} window reset — return?`') && card.includes('`${homeName} usage window`'))
  check('the card never spells a default subscription lane', !card.includes('Claude is your subscription lane') && !card.includes('Claude is the subscription lane') && !card.includes("'Claude window reset"))
  check('the card composes both spend lines through the ONE posture owner', card.includes("import { laneSpendPosture } from '../services/capFailover.js'") && card.includes('laneSpendPosture(homeRoute') && card.includes('laneSpendPosture(awayRoute'))
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the composer reads the home window through the ONE resolver', composer.includes('observedFamilyWindow(homeFamily)'))
  check('the composer derives the home family from the handoff note, not a hardwired family', composer.includes('liveRoute === noted.homeFamily') && !composer.includes("liveRoute === 'anthropic'"))
  check('the composer asks the neutral candidate set for the HOME family', composer.includes('liveCapFailoverTarget(homeFamily)'))
  check('the return decision carries the home credential verdict', composer.includes('credentialUsable: homeUsability.usable'))
  check('a signed-out home ends the handoff (no return card)', /homeUsability\.credential === 'none'\) \{\s*\n\s*noteCapReturn\(\)/.test(composer))
  check('the home usability is read only while parked away (never a per-keystroke walk at home)', composer.includes("onFailoverLane ? usabilityForRoute(homeFamily as CallModelRoute) : null"))
  check('an ACCEPT latches the decision key like a dismissal (a refused accept never re-fires the card)', /onAccept=\{\(\) => \{[\s\S]{0,700}?noteOfferDismissal\(offer\.key\)[\s\S]{0,600}?handleModelSelect\(offer\.targetModel\)/.test(composer))
  check('the handoff note records the home FAMILY beside the model', composer.includes('noteCapHandoff(stateNow.mainLoopModelForSession ?? stateNow.mainLoopModel, offer.homeRoute)') && composer.includes('noteCapHandoff(effective, homeFamily)'))
  check('the standing lane line names the home family, never Claude by default', composer.includes('capRoute !== capNote.homeFamily') && !composer.includes('Claude window resets'))
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  const menu = readFileSync(join(ROOT, 'src/substrate/startupMenu.ts'), 'utf8')
  check('the registry row and the /config text spell the neutral law (no favoured family, most recent sign-in first)', registry.includes('NEUTRAL across every signed-in family') && menu.includes('no favourite') && !menu.includes('OpenAI first') && !registry.includes('OpenAI first'))
  const openaiCall = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  const messages = readFileSync(join(ROOT, 'src/services/rateLimitMessages.ts'), 'utf8')
  check('the OpenAI wall row carries the cross-family lane remedy through the same composer the Anthropic row uses', openaiCall.includes("crossFamilyLaneRemedy('openai')") && messages.includes("crossFamilyLaneRemedy('anthropic'") && messages.includes('export function crossFamilyLaneRemedy('))
}

console.log(failures === 0 ? '\n ✅ SUBSTRATE — posture core + the revived journey seam + the neutral candidate law + the family window resolver' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
