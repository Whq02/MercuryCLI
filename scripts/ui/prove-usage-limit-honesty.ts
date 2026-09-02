#!/usr/bin/env bun
// ============================================================================
//  prove-usage-limit-honesty — a refusal says WHICH pool is dry, WHICH model
//  hit it, and the cheapest fix first.
//
//  The incident this closes: a session came back "usage limit" on an account
//  that still had usage. The refusal named no pool, so there was nothing to
//  act on, and the guidance jumped straight to another provider.
//
//    §1 THE POOL — every claim names its window, and a claim-less rejection
//       still names one instead of "your limit".
//    §2 THE MODEL — the request's model rides the line, so "Fable limit"
//       means something to someone who did not pick Fable.
//    §3 THE IN-FAMILY FIX — the separate per-model pools are offered for the
//       per-model windows, and deliberately NOT for the shared ones.
//    §4 LIVE REMEDIES ONLY — the owner and the row name registered slash
//       commands only (no ghost or retired names), and the row's decision
//       table offers the account switch to a subscriber, nothing otherwise.
//    §5 THE ORDER at the row surface: pool and in-family fix, then the
//       account remedy, and the other provider LAST.
//    §6 the row still renders as a rate-limit row (the prefix contract).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-usage-limit-honesty.ts
// ============================================================================
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' usage limit honesty — which pool, which model, cheapest fix')
console.log('============================================================')

const msgs = await import('../../src/services/rateLimitMessages.js')
const upsell = await import('../../src/components/messages/RateLimitMessage.js')

type Limits = import('../../src/services/claudeAiLimits.js').ClaudeAILimits
const RESETS = Math.floor(Date.now() / 1000) + 3600
const rejected = (extra: Partial<Limits> = {}): Limits => ({
  status: 'rejected',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
  resetsAt: RESETS,
  ...extra,
})
const textFor = (limits: Limits, model: string): string => msgs.getRateLimitErrorMessage(limits, model) ?? ''

//
section('§1 — the pool that is dry is named, claim or no claim')
//
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
  // The branch the operator actually hit: a rejected overage on top of a
  // closed window used to answer with the pool-less generic — no pool at all.
  const overage = textFor(rejected({ rateLimitType: 'seven_day_fable', overageStatus: 'rejected' }), 'claude-fable-5')
  check('a rejected overage names the window underneath it', overage.includes('Fable limit'), overage)
  check('…and never the pool-less generic', !/usage limit is reached/.test(overage), overage)
}

//
section('§2 — the model that hit the wall')
//
{
  const text = textFor(rejected({ rateLimitType: 'seven_day_fable' }), 'claude-fable-5')
  check('the marketing name rides the refusal', /on Fable 5/.test(text), text)
  const unknown = textFor(rejected({ rateLimitType: 'five_hour' }), 'some-vendor/some-model')
  check('an id the registry does not know rides verbatim', /on some-vendor\/some-model/.test(unknown), unknown)
  const none = textFor(rejected({ rateLimitType: 'five_hour' }), '')
  check('no model in hand ⇒ no model claimed', !/ on /.test(none), none)
}

//
section('§3 — the in-family fix, and where it would be a lie')
//
{
  for (const claim of ['seven_day_fable', 'seven_day_opus'] as const) {
    const text = textFor(rejected({ rateLimitType: claim }), 'claude-fable-5')
    check(`${claim} offers the same-account switch`, /other Claude model pools are separate/.test(text) && text.includes('/model'), text)
  }
  // The 5h and overall weekly windows are shared across models — "switch
  // models" there would send the operator somewhere just as dry.
  for (const claim of ['five_hour', 'seven_day'] as const) {
    const text = textFor(rejected({ rateLimitType: claim }), 'claude-fable-5')
    check(`${claim} offers NO model switch (the window is shared)`, !/other Claude model pools/.test(text), text)
  }
  const src = readFileSync(join(import.meta.dir, '../../src/services/rateLimitMessages.ts'), 'utf8')
  check(
    'the in-family clause is scoped to the per-model windows at the owner',
    /claim === 'seven_day_opus' \|\| claim === 'seven_day_sonnet' \|\| claim === 'seven_day_fable'/.test(src),
  )
}

//
section('§4 — every remedy names a live command')
//
{
  const src = readFileSync(join(import.meta.dir, '../../src/services/rateLimitMessages.ts'), 'utf8')
  const row = readFileSync(join(import.meta.dir, '../../src/components/messages/RateLimitMessage.tsx'), 'utf8')
  // The registered slash names: every `name: '…'` declaration under src/commands.
  const registered = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry)) {
        for (const m of readFileSync(full, 'utf8').matchAll(/\bname:\s*'([^']+)'/g)) registered.add(m[1]!)
      }
    }
  }
  walk(join(import.meta.dir, '../../src/commands'))
  const named = (text: string): string[] =>
    [...text.matchAll(/(?:^|[\s"'`(])\/([a-z][a-z0-9-]*)/g)].map(m => m[1]!)
  const ghosts = [...new Set([...named(src), ...named(row)])].filter(n => !registered.has(n))
  check('every /command the owner and the row name is a registered slash command', ghosts.length === 0, ghosts.join(', '))
  // Nothing is provisioned in this scratch account, and the owner carries no
  // plan pointer of its own on any account.
  const text = textFor(rejected({ rateLimitType: 'seven_day_fable' }), 'claude-fable-5')
  check('a refusal carries no plan pointer', !/\/(extra-usage|upgrade)\b/.test(text), text)
  check('the error path has no plan clause (the row surface owns the account remedy)', !/errorUpsellClause/.test(src))
  check('the warning clause names where the plan is raised, not a slash command', /raise your Claude plan limits at claude\.ai/.test(src))

  // The interactive row's own decision table — pure and exported, so the
  // armed case is provable without an account.
  const armed = upsell.getUpsellMessage({ shouldShowUpsell: true })
  check('the row offers the account switch (/logins) to a subscriber', String(armed).includes('/logins'), String(armed))
  check('…and nothing to a non-subscriber', upsell.getUpsellMessage({ shouldShowUpsell: false }) === null)
}

//
section('§5 — the order at the row: pool + in-family, then plan, then elsewhere')
//
{
  // The order law moved WITH the composition (FN-016 R9): remedies are
  // composed once at row creation (composeAnthropicWallRemedies), so the
  // order is proven on the composer's OUTPUT; the renderer paints the
  // refusal head first and the baked remedy lines dim behind it.
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
  const row = readFileSync(join(import.meta.dir, '../../src/components/messages/RateLimitMessage.tsx'), 'utf8')
  const headAt = row.indexOf('<Text color="error">{head}</Text>')
  const remediesAt = row.indexOf('dimColor')
  check('the renderer paints the refusal head first, the baked remedies dim behind', headAt >= 0 && remediesAt > headAt, `${headAt} vs ${remediesAt}`)
}

//
section('§6 — the row still renders as a rate-limit row')
//
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
  /* scratch */
}
console.log(
  failures === 0
    ? '\n✅ prove-usage-limit-honesty — all checks pass'
    : '\n❌ prove-usage-limit-honesty — check(s) failed',
)
process.exit(failures)
