#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-r02-entry.ts —
//  provider-neutral entry + OpenAI-only boot honesty.
//
//    §A the ONE provider station — the first-run walk mounts the /logins
//       card ITSELF (ConsoleOAuthFlow) as its sign-in station: walk-rows ≡
//       /logins-rows by construction (both derive from THE row owner,
//       loginFamilyRows.ts — a family added there appears in both or this
//       section reddens), the "sign in later" row is present with its
//       honest caveat, every owner family is nameable (/logins <family>),
//       and the walk carries NO hand-rolled row list, NO second sign-in
//       station, and NO Anthropic-only connectivity pre-gate
//    §B never a new credential store — the entry components persist no
//       tokens; the owner flows do
//    §C second boot never re-gates — hasCompletedOnboarding is the law
//    §D the typed credentialless fallback: a default-resolved
//       Anthropic-route model with no Anthropic credential lands on the
//       qualified GPT default when the lane is live; stays put (typed
//       refusal downstream) when it is not; NEVER overrides an operator-
//       specified model
//    §E the OpenAI-only boot honesty notice — capability-derived from THE
//       resolver, naming the delegation non-goal; seeded as a boot note
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const onboarding = readFileSync(join(ROOT, 'src/components/Onboarding.tsx'), 'utf8')

section('§A the ONE provider station — the /logins card mounted in the walk')
{
  const { loginFamilyRows, SIGN_IN_LATER_ROW } = await import('../../src/components/loginFamilyRows.ts')
  const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
  const card = readFileSync(join(ROOT, 'src/components/ConsoleOAuthFlow.tsx'), 'utf8')

  const families = loginFamilyRows({ engineLegs: true })
  check('the owner carries the full nine-family catalogue', families.length === 9, `families=${families.length}`)
  check(
    'every owner family is nameable — /logins <family> resolves each row value',
    families.every(row => parseFamilyFocus(row.value) === row.value),
    JSON.stringify(families.map(row => [row.value, parseFamilyFocus(row.value)])),
  )
  check(
    'the /logins card derives rows AND count from the owner (never a hand copy)',
    card.includes('loginFamilyRows({ engineLegs: onOpenaiDone !== undefined })') &&
      card.includes('visibleOptionCount={idleRows.length}'),
  )
  check(
    "the walk's provider station IS the /logins card — same component, engine settlement live",
    /'provider'/.test(onboarding) &&
      /<ConsoleOAuthFlow/.test(onboarding) &&
      /onOpenaiDone=\{result =>/.test(onboarding),
    'walk-rows ≡ /logins-rows holds by construction only while the walk mounts the card',
  )
  check(
    'the walk hand-rolls NO row list beside the card (the drift class stays dead)',
    !/ProviderChoice/.test(onboarding) &&
      !/OpenRouter|DeepSeek|Hugging Face/.test(onboarding) &&
      !/beginOpenaiBrowserConnect|resolveProviderUsability/.test(onboarding),
  )
  check(
    "ONE station, not two: no second sign-in step id survives ('oauth' retired)",
    !/'oauth'/.test(onboarding),
  )
  check(
    'the "sign in later" row is offered (onSkip seam) and settles into the walk',
    /onSkip=\{onSkip\}/.test(onboarding) && /onSkip=\{advance\}/.test(onboarding) &&
      card.includes('...(onSkip !== undefined ? [SIGN_IN_LATER_ROW] : [])'),
  )
  check(
    'the later row carries its honest caveat: running turns needs a sign-in',
    /sign in later/i.test(SIGN_IN_LATER_ROW.label) &&
      /running turns needs a sign-in/.test(SIGN_IN_LATER_ROW.label),
    SIGN_IN_LATER_ROW.label,
  )
  check(
    'esc topology: catalogue esc backs a station; a pending-leg esc abandons to the catalogue',
    /onCancel=\{onBack\}/.test(onboarding) && /onAbandonLeg=\{\(\) => setEpoch/.test(onboarding),
  )
  check(
    'an engine leg settling WITHOUT a credential returns to the catalogue with the receipt painted',
    /setNote\(result\.receipt\)/.test(onboarding) && /setEpoch\(current => current \+ 1\)/.test(onboarding),
  )
  check(
    'the key/env route rides the EXISTING approval step, conditional as before',
    /ApproveApiKey/.test(onboarding) && /'api-key'/.test(onboarding),
  )
  check(
    'no Anthropic-only connectivity pre-gate: the walk opens for every family and for "later"',
    !/PreflightStep|preflightChecks/.test(onboarding),
  )
  check(
    'no arming ceremony rides any route (engines are default-on)',
    !/MERCURY_ENGINES/.test(onboarding),
  )
}

section('§B never a new credential store')
{
  check(
    'the entry component persists no tokens itself (owner flows do)',
    !/writeFileSync|appendFileSync|saveOauthTokens|keychain/i.test(onboarding),
  )
}

section('§C second boot never re-gates')
{
  const helpers = readFileSync(join(ROOT, 'src/interactiveHelpers.tsx'), 'utf8')
  check(
    'the mount condition is the completed-onboarding law',
    /!config\.theme \|\| !config\.hasCompletedOnboarding/.test(helpers),
  )
  check(
    'completeOnboarding writes the standing flag',
    /hasCompletedOnboarding: true/.test(
      readFileSync(join(ROOT, 'src/interactiveHelpers.tsx'), 'utf8'),
    ),
  )
}

section('§D the typed credentialless fallback — the computed default')
{
  const { evaluateComputedDefault } = await import('../../src/utils/model/computedDefault.ts')
  type Verdict = { usable: true; setting: string; row: string; why: string } | { usable: false; why: string }
  const usable = (setting: string): Verdict => ({ usable: true, setting, row: setting, why: 'usable' })
  const REG = ['anthropic', 'openai', 'zai', 'openrouter', 'gemini', 'moonshot', 'deepseek', 'openai-compat', 'huggingface', 'local']
  const T = 1_788_298_400_000
  const decide = (credentials: Array<{ family: string; at: number | null }>, rows: Record<string, Verdict>) =>
    evaluateComputedDefault({
      credentials,
      registryOrder: REG,
      laneRow: family => rows[family] ?? { usable: false, why: 'no selectable row' },
      keyless: { setting: 'claude-sonnet-4-5', why: 'no provider is signed in yet' },
    })
  check(
    'a first-party credential alone ⇒ the default stays home (its own newest usable row)',
    decide([{ family: 'anthropic', at: T }], { anthropic: usable('claude-sonnet-4-5') }).setting === 'claude-sonnet-4-5',
  )
  check(
    'credentialless at home + a live GPT lane ⇒ the qualified GPT row',
    decide([{ family: 'openai', at: T }], { openai: usable('gpt-5.6-sol') }).setting === 'gpt-5.6-sol',
  )
  const nothing = decide([], {})
  check(
    'no credential anywhere ⇒ NO default: the keyless placeholder stays put, named (typed refusal downstream, never silent)',
    nothing.source === 'keyless' && nothing.setting === 'claude-sonnet-4-5' && nothing.provider === null && nothing.row === 'no sign-in yet',
  )
  const gatedGpt = decide([{ family: 'openai', at: T + 1 }, { family: 'anthropic', at: T }], { openai: { usable: false, why: 'GPT-5.6: not served by the connected source' }, anthropic: usable('claude-sonnet-4-5') })
  check(
    'a gated GPT row is never chosen — the default falls through to the earlier sign-in, named',
    gatedGpt.setting === 'claude-sonnet-4-5' && gatedGpt.source === 'fallthrough' && gatedGpt.why.includes('Skipped: openai'),
  )
  const model = readFileSync(join(ROOT, 'src/utils/model/model.ts'), 'utf8')
  check(
    'the wiring resolves the DEFAULT through the computed default only (operator picks untouched)',
    /fromDefault \? getDefaultMainLoopModel\(\) : parseUserSpecifiedModel\(setting\)/.test(model) &&
      /export function getDefaultMainLoopModelSetting\(\): string \{\s*return computedDefault\(\)\.setting/.test(model),
  )
}

section('§E the no-Anthropic boot honesty notice — every family alike')
{
  const { nonAnthropicBootNotice } = await import(
    '../../src/services/providers/providerUsability.ts'
  )
  const u = (over: Record<string, unknown>) =>
    ({
      anthropic: { provider: 'anthropic', credential: 'none', limit: 'unknown', usable: false, blockers: ['x'] },
      openai: { provider: 'openai', credential: 'oauth', limit: 'unknown', usable: true, blockers: [] },
      zai: { provider: 'zai', credential: 'none', limit: 'unknown', usable: false, blockers: ['x'] },
      ...over,
    }) as never
  const notice = nonAnthropicBootNotice(u({}))
  check('openai-only ⇒ the notice fires, naming OpenAI as the working lane', typeof notice === 'string' && /OpenAI is the working lane/.test(notice ?? ''))
  check(
    'the notice names the dormant Claude-ACCOUNT surfaces and never claims subagents stay Claude-backed (they ride the session family)',
    Boolean(notice && /usage windows/.test(notice) && /subagents and workflows run on the session/.test(notice) && !/non-goal/.test(notice)),
    String(notice),
  )
  check(
    'a Claude credential silences it',
    nonAnthropicBootNotice(
      u({ anthropic: { provider: 'anthropic', credential: 'oauth', limit: 'allowed', usable: true, blockers: [] } }),
    ) === null,
  )
  check(
    'no usable engine lane silences it (nothing to boot onto)',
    nonAnthropicBootNotice(
      u({ openai: { provider: 'openai', credential: 'none', limit: 'unknown', usable: false, blockers: ['x'] } }),
    ) === null,
  )
  const openrouterOnly = nonAnthropicBootNotice(
    u({
      openai: { provider: 'openai', credential: 'none', limit: 'unknown', usable: false, blockers: ['x'] },
      openrouter: { provider: 'openrouter', credential: 'api-key', limit: 'unknown', usable: true, blockers: [] },
    }),
  )
  check('an OpenRouter-only boot gets the SAME honesty (no family-specific silence)', typeof openrouterOnly === 'string' && /OpenRouter is the working lane/.test(openrouterOnly ?? ''), String(openrouterOnly))
  const two = nonAnthropicBootNotice(
    u({ gemini: { provider: 'gemini', credential: 'oauth', limit: 'unknown', usable: true, blockers: [] } }),
  )
  check('several usable lanes are all named', typeof two === 'string' && /OpenAI, Gemini are the working lanes/.test(two ?? ''), String(two))
  const helpers = readFileSync(join(ROOT, 'src/interactiveHelpers.tsx'), 'utf8')
  check('the notice is seeded as a boot note at entry', /nonAnthropicBootNotice/.test(helpers) && /addBootNote\('info', notice\)/.test(helpers))
}

console.log(
  failures === 0
    ? '\n ✅ — provider-neutral entry over the existing owners + boot honesty'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
