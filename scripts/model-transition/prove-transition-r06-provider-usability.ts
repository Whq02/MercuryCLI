#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }



const { resolveProviderUsability } = await import(
  '../../src/models/roads/providerUsability.ts'
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
  check('no credential ⇒ unusable with the /login blocker', none.usable === false && none.credential === 'none' && none.blockers.some(b => b.includes('/login')), `got ${JSON.stringify(none)}; the anthropic entry of resolveProviderUsability in src/models/roads/providerUsability.ts must add a blocker naming /login when no credential exists`)
  check('no credential ⇒ limit is unknown (never a phantom limits read)', none.limit === 'unknown', `got limit ${none.limit}; resolveProviderUsability in src/models/roads/providerUsability.ts must not read the limit without a credential`)

  const sub = resolveProviderUsability(reads({ anthropicSubscriber: () => true })).anthropic
  check('subscriber OAuth + allowed ⇒ usable, delegation uncapped', sub.usable === true && sub.credential === 'oauth' && sub.delegationCapped === false, `got ${JSON.stringify(sub)}; check the anthropic entry of resolveProviderUsability in src/models/roads/providerUsability.ts`)

  const warn = resolveProviderUsability(
    reads({ anthropicSubscriber: () => true, anthropicLimitStatus: () => 'allowed_warning' }),
  ).anthropic
  check('allowed_warning ⇒ still usable (preemptive, not a block)', warn.usable === true && warn.limit === 'allowed_warning', `got ${JSON.stringify(warn)}; the anthropic entry of resolveProviderUsability in src/models/roads/providerUsability.ts must keep an allowed_warning window usable`)

  const capped = resolveProviderUsability(
    reads({ anthropicApiKey: () => 'sk-x', anthropicLimitStatus: () => 'rejected' }),
  ).anthropic
  check('a rejected window stays information without capping delegation', capped.usable === true && capped.delegationCapped === false && capped.limitBlocker?.includes('usage window') === true && capped.blockers.length === 0, `got ${JSON.stringify(capped)}; a rejected window in resolveProviderUsability (src/models/roads/providerUsability.ts) belongs in limitBlocker and not in blockers or delegationCapped`)
}

section('§B openai — the composed seat owner speaks through')
{
  const noAccount = resolveProviderUsability(
    reads({ gptSeat: () => ({ state: 'disabled', why: 'no-account', reason: 'no OpenAI account — /logins' }) }),
  ).openai
  check('no account ⇒ unusable, credential none + the /logins blocker', noAccount.usable === false && noAccount.credential === 'none' && noAccount.blockers[0]?.includes('/logins'), `got ${JSON.stringify(noAccount)}; the openai entry of resolveProviderUsability in src/models/roads/providerUsability.ts must pass through the gptSeat reason`)

  const ready = resolveProviderUsability(
    reads({ gptSeat: () => ({ state: 'ready' }) }),
  ).openai
  check('ready seat ⇒ usable, zero blockers', ready.usable === true && ready.blockers.length === 0, `got ${JSON.stringify(ready)}; the openai entry of resolveProviderUsability in src/models/roads/providerUsability.ts must be usable with no blockers when gptSeat is ready`)
}

section('§C zai — key truth alone (the gate retired)')
{
  const none = resolveProviderUsability(reads()).zai
  check('no key ⇒ ONE typed blocker naming the /logins route', none.usable === false && none.blockers.length === 1 && none.blockers[0] === 'no Z.AI API key — /logins zai (or ZAI_API_KEY)', `got ${JSON.stringify(none)}; change the zai blocker in resolveProviderUsability in src/models/roads/providerUsability.ts`)
  const keyed = resolveProviderUsability(reads({ zaiKeyPresent: () => true })).zai
  check('keyed ⇒ usable', keyed.usable === true && keyed.credential === 'api-key', `got ${JSON.stringify(keyed)}; the zai entry of resolveProviderUsability in src/models/roads/providerUsability.ts must be usable with credential api-key when zaiKeyPresent is true`)
}



section('§F usage-aware dispatch (lane FG E) — the delegation verdict is honest and pure')
{
  const { delegationDispatchBlocker } = await import(
    '../../src/models/roads/providerUsability.ts'
  )
  const mapOf = (over: Partial<NonNullable<Reads>> = {}) => resolveProviderUsability(reads(over))

  check(
    'anthropic usable + allowed ⇒ dispatch proceeds (null verdict)',
    delegationDispatchBlocker('anthropic', mapOf({ anthropicSubscriber: () => true })) === null,
    'delegationDispatchBlocker in src/models/roads/providerUsability.ts must return null for a usable anthropic lane',
  )
  const capped = delegationDispatchBlocker(
    'anthropic',
    mapOf({ anthropicSubscriber: () => true, anthropicLimitStatus: () => 'rejected' }),
  )
  check(
    'rejected window never refuses dispatch',
    capped === null,
    `${String(capped)}; delegationDispatchBlocker in src/models/roads/providerUsability.ts must return null for a rejected window`,
  )
  check(
    'the selected lane remains selected',
    capped === null,
    'delegationDispatchBlocker in src/models/roads/providerUsability.ts must return null for the selected lane',
  )
  const cappedWithGpt = delegationDispatchBlocker(
    'anthropic',
    mapOf({
      anthropicSubscriber: () => true,
      anthropicLimitStatus: () => 'rejected',
      gptSeat: () => ({ state: 'ready' }),
    }),
  )
  check(
    'another ready lane never changes the selected lane dispatch',
    cappedWithGpt === null,
    `${String(cappedWithGpt)}; delegationDispatchBlocker in src/models/roads/providerUsability.ts must judge only the selected lane`,
  )
  check(
    'allowed_warning ⇒ dispatch proceeds (warnings never cap delegation)',
    delegationDispatchBlocker(
      'anthropic',
      mapOf({ anthropicSubscriber: () => true, anthropicLimitStatus: () => 'allowed_warning' }),
    ) === null,
    'delegationDispatchBlocker in src/models/roads/providerUsability.ts must return null on allowed_warning',
  )
  check(
    'openai seat down ⇒ preflight does NOT refuse (per-request refusal owns it)',
    delegationDispatchBlocker('openai', mapOf()) === null,
    'delegationDispatchBlocker in src/models/roads/providerUsability.ts must return null for an openai lane whose seat is down',
  )
  check(
    'anthropic credential-none ⇒ preflight does NOT refuse (fail-fast at the call; fixture rigs stay served)',
    delegationDispatchBlocker('anthropic', mapOf()) === null,
    'delegationDispatchBlocker in src/models/roads/providerUsability.ts must return null for an anthropic lane with no credential',
  )
}

console.log(failures === 0 ? '\n ✅ SUBSTRATE — ONE usability resolver, honest, first consumer live' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
