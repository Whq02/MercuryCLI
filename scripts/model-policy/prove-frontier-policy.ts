#!/usr/bin/env bun
// ============================================================================
//  scripts/model-policy/prove-frontier-policy.ts — §3/§8/§9
//
//  The frontier-operator decision matrix, driven through the PURE core
//  (evaluateFrontierDecision) with INJECTED facts — zero ambient reads (the
//  F6 law: a proof never depends on the calibration machine's subscription,
//  settings, or keychain). Plus the ambient-safe identity laws on the live
//  chain: session-override > env precedence, best ≡ default ≡ the decision,
//  and isFableAvailable as a projection.
//
//  Run: ~/.bun/bin/bun run scripts/model-policy/prove-frontier-policy.ts
// ============================================================================
import {
  evaluateFrontierDecision,
  frontierOperatorDecision,
  describeFrontierDecision,
  FRONTIER_MAX_20X_TIER,
  type FrontierFacts,
} from '../../src/utils/model/frontierPolicy.js'
import {
  getBestModel,
  getDefaultMainLoopModel,
  getDefaultMainLoopModelSetting,
  getMainLoopModel,
  getUserSpecifiedModelSetting,
  isFableAvailable,
  parseUserSpecifiedModel,
} from '../../src/utils/model/model.js'
import { setMainLoopModelOverride } from '../../src/bootstrap/state.js'
import { restoreConversationModelFromMessages } from '../../src/utils/sessionRestore.js'
import { computedDefault } from '../../src/utils/model/computedDefault.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

/** The eligible Max-20x baseline; each row perturbs one axis. */
const base = (): FrontierFacts => ({
  fableEnvPin: false,
  fableId: 'claude-fable-5',
  allowlistPresent: false,
  allowlistNamesFable: false,
  allowlistPermits: () => true,
  claudeAiSubscriber: true,
  maxSubscriber: true,
  rateLimitTier: FRONTIER_MAX_20X_TIER,
  oneMDisabled: false,
  opusFallbackSetting: 'claude-opus-4-8[1m]',
})

console.log('============================================================')
console.log(' frontier-operator decision matrix (pure core)')
console.log('============================================================')

console.log('\n§3 launch matrix')
{
  const d = evaluateFrontierDecision(base())
  check(
    'row 1: confirmed Max 20x → Fable 5 [1m] frontier default',
    d.source === 'frontier' && d.setting === 'claude-fable-5[1m]' && d.code === 'eligible-max-20x' && d.winner?.rank === 100,
    JSON.stringify(d),
  )
  check('row 1 describe line (the first-party family\'s gating words)', describeFrontierDecision(d) === 'first-party frontier · Max 20x', describeFrontierDecision(d))
}
{
  const d = evaluateFrontierDecision({ ...base(), fableEnvPin: true, fableId: 'my-custom-fable-id' })
  check(
    'row 2: ANTHROPIC_DEFAULT_FABLE_MODEL pin resolves VERBATIM (no suffix growth)',
    d.source === 'frontier' && d.setting === 'my-custom-fable-id' && d.code === 'eligible-env-pin',
  )
  const d2 = evaluateFrontierDecision({
    ...base(),
    fableEnvPin: true,
    claudeAiSubscriber: false,
    maxSubscriber: false,
    rateLimitTier: null,
  })
  check('row 2b: the pin is an explicit signal — eligible without subscription facts', d2.source === 'frontier' && d2.code === 'eligible-env-pin')
}
{
  const excl = evaluateFrontierDecision({
    ...base(),
    allowlistPresent: true,
    allowlistPermits: () => false,
  })
  check(
    'row 3a: availableModels PRESENT-and-excluding is a REAL exclusion → Opus fallback + honest reason',
    excl.source === 'fallback' && excl.setting === 'claude-opus-4-8[1m]' && excl.code === 'allowlist-excluded',
  )
  const abs = evaluateFrontierDecision(base())
  check('row 3b: availableModels ABSENT is never exclusion', abs.source === 'frontier')
  const opt = evaluateFrontierDecision({
    ...base(),
    claudeAiSubscriber: true,
    maxSubscriber: false,
    rateLimitTier: null,
    allowlistPresent: true,
    allowlistNamesFable: true,
  })
  check('row 3c: a local allowlist NAMING fable is an explicit opt-in signal', opt.source === 'frontier' && opt.code === 'eligible-allowlist')
}
{
  const rows: Array<[string, Partial<FrontierFacts>, string]> = [
    ['Max 5x tier', { rateLimitTier: 'default_claude_max_5x' }, 'not-20x'],
    ['unknown tier (never guess 20x from a Max label)', { rateLimitTier: null }, 'unknown-rate-limit-tier'],
    ['Pro (not max)', { maxSubscriber: false }, 'not-max'],
    ['PAYG first-party (no subscription facts)', { claudeAiSubscriber: false, maxSubscriber: false, rateLimitTier: null }, 'not-subscriber'],
  ]
  for (const [label, patch, code] of rows) {
    const d = evaluateFrontierDecision({ ...base(), ...patch })
    check(
      `row 5: ${label} → EXACT legacy Opus default (${code})`,
      d.source === 'fallback' && d.setting === 'claude-opus-4-8[1m]' && d.code === code,
      `got ${d.source}/${d.setting}/${d.code}`,
    )
  }
  // (Rows 5b/5c — the third-party-provider fallback arms — retired with the
  // gateway estate, FrontierFacts does not carry a provider
  // axis.)
}
{
  const d = evaluateFrontierDecision({ ...base(), oneMDisabled: true })
  check('1M kill-switch: frontier winner drops the [1m] suffix', d.source === 'frontier' && d.setting === 'claude-fable-5')
}

console.log('\n§9.2 the collapsed candidate order — one built-in candidate, no registration table')
{
  const d = evaluateFrontierDecision(base())
  check(
    'the decision carries exactly the built-in candidate (no anticipatory registrations)',
    d.candidates.length === 1 && d.candidates[0]?.family === 'fable' && d.candidates[0]?.rank === 100,
    d.candidates.map(c => `${c.rank}:${c.code}`).join(' '),
  )
  check(
    "the winner's setting rides the [1m] suffix (Fable 5's 1M is API-granted on the suffix)",
    d.setting === 'claude-fable-5[1m]',
    d.setting,
  )
  const dKill = evaluateFrontierDecision({ ...base(), oneMDisabled: true })
  check('the 1M kill-switch drops the suffix from the winning setting', dKill.setting === 'claude-fable-5')
  const dFallback = evaluateFrontierDecision({ ...base(), rateLimitTier: 'default_claude_max_5x' })
  check(
    'the fallback diagnostic names the real reason',
    dFallback.source === 'fallback' && dFallback.code === 'not-20x',
  )
}

console.log('\nsuccession law: no registration seam — a later frontier arrives by operator word')
{
  const policySrc = require('fs').readFileSync(require('path').join(__dirname, '../../src/utils/model/frontierPolicy.ts'), 'utf8')
  check(
    'frontierPolicy exposes no catalog-candidate vocabulary',
    !policySrc.includes('FrontierCatalogCandidate') && !policySrc.includes('eligible-registered') && !policySrc.includes("'not-live'"),
  )
  check(
    'the env pin resolves VERBATIM (the operator-word succession rung)',
    evaluateFrontierDecision({ ...base(), fableEnvPin: true, fableId: 'claude-frontier-next' }).setting === 'claude-frontier-next',
  )
}

console.log('\nprecedence rungs (live chain — explicit inputs only, ambient-safe)')
{
  const priorEnv = process.env.ANTHROPIC_MODEL
  try {
    setMainLoopModelOverride('opus')
    check(
      'session /model override outranks the frontier default',
      /^claude-opus-/.test(getMainLoopModel()),
      getMainLoopModel(),
    )
    process.env.ANTHROPIC_MODEL = 'sonnet'
    check('session override outranks ANTHROPIC_MODEL', getUserSpecifiedModelSetting() === 'opus')
    setMainLoopModelOverride(undefined)
    check('ANTHROPIC_MODEL outranks the built-in default', getUserSpecifiedModelSetting() === 'sonnet')
  } finally {
    setMainLoopModelOverride(undefined)
    if (priorEnv === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = priorEnv
  }
}

console.log('\n§8 conversation-model retention (pure helper; ambient-safe forms)')
{
  const asst = (model: string): unknown => ({ type: 'assistant', message: { role: 'assistant', model } })
  const user = (): unknown => ({ type: 'user', message: { role: 'user', content: 'x' } })
  const defaultResolved = parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
  const defaultBase = defaultResolved.replace(/\[1m\]$/i, '')
  check(
    'a conversation that ran the CURRENT default base restores the default SETTING form',
    restoreConversationModelFromMessages([user(), asst(defaultBase)]) === defaultResolved,
  )
  check(
    'an explicitly-chosen family restores the bare API-served id verbatim (never invent [1m])',
    restoreConversationModelFromMessages([user(), asst('claude-haiku-4-5')]) === 'claude-haiku-4-5',
  )
  check(
    'the LAST assistant row wins',
    restoreConversationModelFromMessages([asst('claude-haiku-4-5'), user(), asst('claude-sonnet-4-6')]) === 'claude-sonnet-4-6',
  )
  check(
    'synthetic/error rows are skipped',
    restoreConversationModelFromMessages([asst('claude-sonnet-4-6'), asst('<synthetic>')]) === 'claude-sonnet-4-6',
  )
  // Multi-auth law: eligibility is provenance, never id spelling — served ids
  // from every provider family retain verbatim, slash-form carrier ids
  // included. The pre-rewrite claude-/gpt-/glm- prefix gate restored a
  // carrier-served session onto the default model.
  check(
    'a carrier-served session retains its slash-form id verbatim (no family gate)',
    restoreConversationModelFromMessages([user(), asst('openrouter/stealth/ox-alpha')]) ===
      'openrouter/stealth/ox-alpha',
  )
  check(
    "today's shape, forward: Ox Alpha → GPT mid-session switch retains the last served id",
    restoreConversationModelFromMessages([asst('openrouter/stealth/ox-alpha'), user(), asst('gpt-5.6-sol')]) ===
      'gpt-5.6-sol',
  )
  check(
    "today's shape, reversed: a session ENDING on the carrier retains the carrier id",
    restoreConversationModelFromMessages([asst('gpt-5.6-sol'), user(), asst('openrouter/stealth/ox-alpha')]) ===
      'openrouter/stealth/ox-alpha',
  )
  check(
    'every family retains verbatim (gemini · zai · moonshot · deepseek · o-series · local)',
    [
      'gemini-3-pro-preview',
      'glm-5.2',
      'kimi-k2.5-0127',
      'deepseek-v4',
      'o5-mini',
      'qwen3-coder:30b',
    ].every(id => restoreConversationModelFromMessages([user(), asst(id)]) === id),
  )
  check(
    'an empty-string model row is skipped, the prior served row wins',
    restoreConversationModelFromMessages([asst('glm-5.2'), asst('')]) === 'glm-5.2',
  )
  check('no assistant rows ⇒ no retention', restoreConversationModelFromMessages([user()]) === null)
  check('empty/undefined ⇒ no retention', restoreConversationModelFromMessages([]) === null && restoreConversationModelFromMessages(undefined) === null)
  try {
    setMainLoopModelOverride('opus')
    check('a live override (CLI/agent/SDK) always wins — retention declines', restoreConversationModelFromMessages([asst('claude-sonnet-4-6')]) === null)
  } finally {
    setMainLoopModelOverride(undefined)
  }
}

console.log('\nprojection identities (ambient-safe on any profile)')
{
  const d = frontierOperatorDecision()
  check('best ≡ the decision (the first-party frontier alias)', getBestModel() === d.setting)
  check("parse('best') ≡ the decision", parseUserSpecifiedModel('best') === d.setting)
  // The session default is the COMPUTED default (the provider of the most
  // recent sign-in); the decision is the first-party family's gating, which
  // the computed default reads for that lane and for the keyless placeholder.
  const computed = computedDefault()
  check('the session default ≡ the computed default', getDefaultMainLoopModelSetting() === computed.setting)
  check(
    'getDefaultMainLoopModel resolves the computed setting stably',
    getDefaultMainLoopModel() === parseUserSpecifiedModel(computed.setting),
  )
  check(
    'the first-party lane and the keyless placeholder ride the decision',
    computed.source === 'keyless' || computed.provider !== 'anthropic' || computed.setting === d.setting,
    `${computed.source}/${String(computed.provider)}/${computed.setting} vs ${d.setting}`,
  )
  check(
    'isFableAvailable ≡ the fable candidate verdict',
    isFableAvailable() === d.candidates.some(c => c.family === 'fable' && c.eligible),
  )
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ frontier-policy matrix: all checks pass')
