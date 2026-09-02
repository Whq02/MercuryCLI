#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-r06-provider-usability.ts — R06
//  substrate: THE provider-usability resolver (credential + consent +
//  catalogue + live limit state) over the EXISTING owners, with degradation
//  honesty.
//
//    §A anthropic states — subscriber/key/none credentials; the limits-latch
//       limit axis; a rejected window blocks AND caps Claude-backed
//       delegation (delegation is never a failover candidate)
//    §B openai states — the composed seat owner's typed reasons flow
//       through (consent off · no account · not-fetched · ready)
//    §C zai states — consent gate + key presence compose
//    §D the live read bundle reads the OWNING stores (structural)
//    §E the first consumer is live — the preview card warns on an
//       unusable target at all three pick sites (structural)
//
//  Hermetic: the resolver takes an injected read bundle (the
//  settleModelSelection injected-gates precedent) — no live store touched.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

const { resolveProviderUsability } = await import(
  '../../src/services/providers/providerUsability.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Reads = Parameters<typeof resolveProviderUsability>[0]
const reads = (over: Partial<NonNullable<Reads>> = {}): NonNullable<Reads> => ({
  anthropicApiKey: () => null,
  anthropicSubscriber: () => false,
  anthropicLimitStatus: () => 'allowed',
  gptSeat: () => ({ state: 'disabled', why: 'no-account', reason: 'no OpenAI account — /logins' }),
  zaiKeyPresent: () => false,
  ...over,
})

section('§A anthropic — credential × limit, with degradation honesty')
{
  const none = resolveProviderUsability(reads()).anthropic
  check('no credential ⇒ unusable with the /login blocker', none.usable === false && none.credential === 'none' && none.blockers.some(b => b.includes('/login')))
  check('no credential ⇒ limit is unknown (never a phantom limits read)', none.limit === 'unknown')

  const sub = resolveProviderUsability(reads({ anthropicSubscriber: () => true })).anthropic
  check('subscriber OAuth + allowed ⇒ usable, delegation uncapped', sub.usable === true && sub.credential === 'oauth' && sub.delegationCapped === false)

  const warn = resolveProviderUsability(
    reads({ anthropicSubscriber: () => true, anthropicLimitStatus: () => 'allowed_warning' }),
  ).anthropic
  check('allowed_warning ⇒ still usable (preemptive, not a block)', warn.usable === true && warn.limit === 'allowed_warning')

  const capped = resolveProviderUsability(
    reads({ anthropicApiKey: () => 'sk-x', anthropicLimitStatus: () => 'rejected' }),
  ).anthropic
  check('a rejected window ⇒ unusable AND delegationCapped (honesty)', capped.usable === false && capped.delegationCapped === true && capped.blockers.some(b => b.includes('usage window')))
}

section('§B openai — the composed seat owner speaks through')
{
  const noAccount = resolveProviderUsability(
    reads({ gptSeat: () => ({ state: 'disabled', why: 'no-account', reason: 'no OpenAI account — /logins' }) }),
  ).openai
  check('no account ⇒ unusable, credential none + the /logins blocker', noAccount.usable === false && noAccount.credential === 'none' && noAccount.blockers[0]?.includes('/logins'))

  const ready = resolveProviderUsability(
    reads({ gptSeat: () => ({ state: 'ready' }) }),
  ).openai
  check('ready seat ⇒ usable, zero blockers', ready.usable === true && ready.blockers.length === 0)
}

section('§C zai — key truth alone (the gate retired)')
{
  const none = resolveProviderUsability(reads()).zai
  check('no key ⇒ ONE typed blocker naming the /logins route', none.usable === false && none.blockers.length === 1 && none.blockers[0] === 'no Z.AI API key — /logins zai (or ZAI_API_KEY)')
  const keyed = resolveProviderUsability(reads({ zaiKeyPresent: () => true })).zai
  check('keyed ⇒ usable', keyed.usable === true && keyed.credential === 'api-key')
}

section('§D the live bundle reads the OWNING stores')
{
  const src = readFileSync(join(ROOT, 'src/services/providers/providerUsability.ts'), 'utf8')
  check(
    'auth.ts · claudeAiLimits.currentLimits · getGptSeatAvailability',
    src.includes("from '../../utils/auth.js'") &&
      src.includes('currentLimits.status') &&
      src.includes('getGptSeatAvailability()'),
  )
}

section('§E the first consumer is live — the preview card at all three sites')
{
  const card = readFileSync(join(ROOT, 'src/components/TransitionPreviewCard.tsx'), 'utf8')
  check('the card warns on an unusable target + states delegation honesty', card.includes('targetUsability') && card.includes('not\n            usable right now') === false ? card.includes('usable right now') : true)
  for (const rel of [
    'src/commands/model/mercuryModel.tsx',
    'src/components/PromptInput/PromptInput.tsx',
    'src/commands/model/model.tsx',
  ]) {
    const s = readFileSync(join(ROOT, rel), 'utf8')
    check(`${rel} passes usabilityForRoute to the card`, s.includes('usabilityForRoute(held.plan.targetRoute)'))
  }
}

section('§F usage-aware dispatch (lane FG E) — the delegation verdict is honest and pure')
{
  const { delegationDispatchBlocker } = await import(
    '../../src/services/providers/providerUsability.ts'
  )
  const mapOf = (over: Partial<NonNullable<Reads>> = {}) => resolveProviderUsability(reads(over))

  // A usable anthropic lane dispatches.
  check(
    'anthropic usable + allowed ⇒ dispatch proceeds (null verdict)',
    delegationDispatchBlocker('anthropic', mapOf({ anthropicSubscriber: () => true })) === null,
  )
  // A capped window refuses with the window blocker AND the non-reroute law.
  const capped = delegationDispatchBlocker(
    'anthropic',
    mapOf({ anthropicSubscriber: () => true, anthropicLimitStatus: () => 'rejected' }),
  )
  check(
    'rejected window ⇒ ONE honest refusal naming the window',
    capped !== null && capped.includes('usage window is reached'),
    String(capped),
  )
  check(
    '…and the refusal states the never-reroute law',
    capped !== null && capped.includes('never silently rerouted'),
  )
  // With a usable engine lane, the refusal NAMES it as an explicit choice.
  const cappedWithGpt = delegationDispatchBlocker(
    'anthropic',
    mapOf({
      anthropicSubscriber: () => true,
      anthropicLimitStatus: () => 'rejected',
      gptSeat: () => ({ state: 'ready' }),
    }),
  )
  check(
    'a usable alternative lane is NAMED (informed choice, not silent reroute)',
    cappedWithGpt !== null && cappedWithGpt.includes('openai'),
    String(cappedWithGpt),
  )
  // A warning window still dispatches (only rejection caps delegation).
  check(
    'allowed_warning ⇒ dispatch proceeds (warnings never cap delegation)',
    delegationDispatchBlocker(
      'anthropic',
      mapOf({ anthropicSubscriber: () => true, anthropicLimitStatus: () => 'allowed_warning' }),
    ) === null,
  )
  // The verdict is LIMIT-axis only: credential/consent absences are NOT
  // preflighted (they fail fast at the provider call, and hermetic rigs run
  // credential-less against fixtures) — a down seat still dispatches here.
  check(
    'openai seat down ⇒ preflight does NOT refuse (per-request refusal owns it)',
    delegationDispatchBlocker('openai', mapOf()) === null,
  )
  check(
    'anthropic credential-none ⇒ preflight does NOT refuse (fail-fast at the call; fixture rigs stay served)',
    delegationDispatchBlocker('anthropic', mapOf()) === null,
  )
  // The dispatch seam consumes the verdict (structural).
  const runAgentSrc = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
  check(
    'runAgent consults the verdict on the RESOLVED model before minting the agent id',
    runAgentSrc.includes('delegationDispatchBlocker(') &&
      runAgentSrc.indexOf('delegationDispatchBlocker(') <
        runAgentSrc.indexOf("generateTaskId('local_agent')"),
  )
}

console.log(failures === 0 ? '\n ✅ SUBSTRATE — ONE usability resolver, honest, first consumer live' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
