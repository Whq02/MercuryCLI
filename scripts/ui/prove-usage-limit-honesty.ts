#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'usage-limit-honesty-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = scratch
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const wallFixHint = 'fix the wording in src/models/roads/anthropic/rateLimitMessages.ts (getRateLimitErrorMessage, composeAnthropicWallRemedies, getUpsellMessage, isRateLimitErrorMessage), the function the failing label names'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${wallFixHint}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' usage limit honesty — which pool, which model, cheapest fix')
console.log('============================================================')

const msgs = await import('../../src/models/roads/anthropic/rateLimitMessages.js')
const upsell = await import('../../src/screen/messages/RateLimitMessage.js')

type Limits = import('../../src/models/roads/anthropic/anthropicLimits.js').AnthropicLimits
const RESETS = Math.floor(Date.now() / 1000) + 3600
const rejected = (extra: Partial<Limits> = {}): Limits => ({
  status: 'rejected',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
  resetsAt: RESETS,
  ...extra,
})
const textFor = (limits: Limits, model: string): string => msgs.getRateLimitErrorMessage(limits, model) ?? ''

section('§1 — the pool that is dry is named, claim or no claim')
{
  for (const [claim, name] of [
    ['seven_day_fable', 'Fable limit'],
    ['seven_day_opus', 'Opus limit'],
    ['seven_day', 'weekly limit'],
    ['five_hour', 'session limit'],
  ] as const) {
    const text = textFor(rejected({ rateLimitType: claim }), 'claude-fable-5')
    check(`${claim} names "${name}"`, text.includes(name), text)
  }
  const noClaim = textFor(rejected(), 'claude-fable-5')
  check('a claim-less rejection still names a window', /this account's usage limit is reached/.test(noClaim), noClaim)
  const overage = textFor(rejected({ rateLimitType: 'seven_day_fable', overageStatus: 'rejected' }), 'claude-fable-5')
  check('a rejected overage names the window underneath it', overage.includes('Fable limit'), overage)
  check('…and never the pool-less generic', !/usage limit is reached/.test(overage), overage)
}

section('§2 — the model that hit the wall')
{
  const text = textFor(rejected({ rateLimitType: 'seven_day_fable' }), 'claude-fable-5')
  check('the marketing name rides the refusal', /on Fable 5/.test(text), text)
  const unknown = textFor(rejected({ rateLimitType: 'five_hour' }), 'some-vendor/some-model')
  check('an id the registry does not know rides verbatim', /on some-vendor\/some-model/.test(unknown), unknown)
  const none = textFor(rejected({ rateLimitType: 'five_hour' }), '')
  check('no model in hand ⇒ no model claimed', !/ on /.test(none), none)
}

section('§3 — the in-family fix, and where it would be a lie')
{
  for (const claim of ['seven_day_fable', 'seven_day_opus'] as const) {
    const text = textFor(rejected({ rateLimitType: claim }), 'claude-fable-5')
    check(`${claim} offers the same-account switch`, /other Claude model pools are separate/.test(text) && text.includes('/model'), text)
  }
  for (const claim of ['five_hour', 'seven_day'] as const) {
    const text = textFor(rejected({ rateLimitType: claim }), 'claude-fable-5')
    check(`${claim} offers NO model switch (the window is shared)`, !/other Claude model pools/.test(text), text)
  }
}

section('§4 — every remedy names a live command')
{
  const text = textFor(rejected({ rateLimitType: 'seven_day_fable' }), 'claude-fable-5')
  check('a refusal carries no plan pointer', !/\/upgrade\b/.test(text), text)

  const armed = upsell.getUpsellMessage({ shouldShowUpsell: true })
  check('the row offers the account switch (/logins) to a subscriber', String(armed).includes('/logins'), String(armed))
  check('…and nothing to a non-subscriber', upsell.getUpsellMessage({ shouldShowUpsell: false }) === null)
}

section('§5 — the order at the row: pool + in-family, then plan, then elsewhere')
{
  const composed = msgs.composeAnthropicWallRemedies({
    slotAppendix: () => 'The other slot is signed in — the wall card offers the switch in one key.',
    upsellEligible: () => true,
    laneTarget: () => ({ route: 'openai', name: 'OpenAI' }),
  })
  const slotAt = composed.indexOf('wall card offers')
  const planAt = composed.indexOf('/logins')
  const laneAt = composed.indexOf('lane is usable now')
  check('the slot remedy (in-family fix) rides first', slotAt >= 0 && planAt > slotAt, `${slotAt} vs ${planAt}`)
  check('the plan remedy rides behind it', planAt > slotAt, `${slotAt} vs ${planAt}`)
  check('the other provider rides LAST, never first', laneAt > planAt, `${planAt} vs ${laneAt}`)
}

section('§6 — the row still renders as a rate-limit row')
{
  for (const claim of ['seven_day_fable', 'five_hour', 'seven_day'] as const) {
    const text = textFor(rejected({ rateLimitType: claim }), 'claude-opus-5')
    check(`${claim}: the prefix contract holds`, msgs.isRateLimitErrorMessage(text), text)
  }
  const outOfCredits = textFor(
    rejected({ rateLimitType: 'seven_day_fable', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }),
    'claude-fable-5',
  )
  check('out-of-credits keeps its own frame', msgs.isRateLimitErrorMessage(outOfCredits) && outOfCredits.startsWith("Anthropic says this account's extra usage is used up"), outOfCredits)
  check('…and still names the model', /on Fable 5/.test(outOfCredits), outOfCredits)
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(
  failures === 0
    ? '\n✅ prove-usage-limit-honesty — all checks pass'
    : '\n❌ prove-usage-limit-honesty — check(s) failed',
)
process.exit(failures)
