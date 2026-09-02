#!/usr/bin/env bun
// ============================================================================
//  scripts/default-model/prove-computed-default.ts — the computed,
//  provider-neutral default (the operator's ruling): the newest
//  usable row of the provider of the most recent sign-in.
//
//  §1 the sign-in ledger — the one owner of "when did this family sign in":
//     a record lands atomically under the auth scope (mode 600, no secret),
//     the latest record for a family wins, a refused spelling or kind writes
//     nothing, a corrupt file reads empty and the next record repairs it,
//     malformed entries are skipped, unknown keys survive a rewrite, and the
//     store follows the auth scope like the credential stores it describes.
//  §2 the order (pure): timed sign-ins newest first (ties: the registry
//     order); untimed credentials after — the recorded default provider
//     leading, then the registry order, then anything the registry does not
//     name.
//  §3 the decision (pure, injected facts — zero ambient reads, the F6 law):
//     the most recent sign-in wins; a gated row is never chosen — a most
//     recent sign-in without a usable row falls through to the next, named;
//     no sign-in ⇒ NO default (the keyless placeholder, named "no sign-in
//     yet"); every sign-in unusable ⇒ keyless with each family's reason; a
//     legacy home (untimed credentials) keeps its recorded lane and says
//     why; the describers name the row, the provider and the source inside
//     the neutral 'Default (<name>)' grammar (prove-model-honesty §7).
//  §4 the live chain in a scratch home (the file credential plane, every
//     provider base dead, ambient credentials cleared): a keyless home
//     answers keyless, and the Recommended row, /model's label and the
//     main-loop resolution say "no sign-in yet"; an explicit choice
//     outranks the default; the real Z.AI key-leg driver records the
//     sign-in and the default lands on that family's newest usable row (its
//     recorded frontier pin) on every surface; a later key through the
//     store's own writer moves the default to the newer family; an env-
//     pinned key is a credential without a sign-in and orders after every
//     timed one, labelled; /defaultprovider is an operator switch in the
//     same ledger.
//  §5 the sign-in owners (structural, over the tracked source): every
//     credential-landing site records, the first-party refresh path never
//     does, the key store records for model families only, the first-login
//     recorder is gone from the tree, and every default consumer reads the
//     one owner.
//
//  Run: ~/.bun/bin/bun run scripts/default-model/prove-computed-default.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── the hermetic home, pinned BEFORE any owner loads ────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'computed-default-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'MERCURY_OAUTH_TOKEN',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_LOCAL_API_KEY',
  'MERCURY_MINERVA_MODEL',
  'MERCURY_CONSOLE_MODEL',
  'MERCURY_WORKER_PARENT_PID',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const dead = 'http://127.0.0.1:1'
for (const base of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
]) {
  process.env[base] = dead
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { SIGN_IN_LEDGER_FILE, readSignInLedger, readSignInRecord, recordSignIn, signInLedgerEpoch } = await import(
  '../../src/utils/accounts/signInLedger.ts'
)
const {
  NO_SIGN_IN_REASON,
  NO_SIGN_IN_ROW,
  computedDefault,
  describeComputedDefault,
  describeComputedDefaultLabel,
  describeComputedDefaultRow,
  evaluateComputedDefault,
  formatSignInTime,
  mostRecentSignInFamily,
  orderCredentials,
  resetComputedDefaultMemo,
} = await import('../../src/utils/model/computedDefault.ts')
type ComputedDefaultFacts = import('../../src/utils/model/computedDefault.ts').ComputedDefaultFacts
type LaneRowVerdict = import('../../src/utils/model/computedDefault.ts').LaneRowVerdict
const { getDefaultMainLoopModelSetting, getMainLoopModel, parseUserSpecifiedModel, renderDefaultModelLabel } =
  await import('../../src/utils/model/model.ts')
const { setMainLoopModelOverride } = await import('../../src/bootstrap/state.ts')
const { frontierOperatorDecision } = await import('../../src/utils/model/frontierPolicy.ts')
const { getModelOptions, keyLanePins } = await import('../../src/utils/model/modelOptions.ts')
const { declaredRouteOf, providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')
const { storeZaiApiKeyLogin } = await import('../../src/services/providers/zai/zaiLogin.ts')
const { writeStoredDeepseekApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { switchDefaultProvider } = await import('../../src/utils/model/defaultProviderRung.ts')
const { clearAuthScope, setAuthScope } = await import('../../src/utils/envUtils.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

console.log('============================================================')
console.log(' computed default — the newest usable row of the provider of the most recent sign-in')
console.log('============================================================')

// A fixed epoch (2026-09-01 21:33:20 UTC) so every stamp below is literal:
// 1788220800 s is 2026-09-01 00:00:00 UTC, plus 21:33:20 = 77 600 s.
const T0 = 1_788_298_400_000

// ── §1 the sign-in ledger ────────────────────────────────────────────────────
section('§1 the sign-in ledger — one owner of "when did this family sign in"')
{
  const ledgerHome = join(scratch, 'ledger')
  mkdirSync(ledgerHome, { recursive: true })
  const io = { home: ledgerHome }
  const path = join(ledgerHome, SIGN_IN_LEDGER_FILE)

  check('a blank family is refused', recordSignIn('', 'api-key', io) === false)
  check('a display-name spelling is refused', recordSignIn('Open AI', 'api-key', io) === false)
  check('a path-shaped spelling is refused', recordSignIn('../openai', 'api-key', io) === false)
  check('an unknown kind is refused', recordSignIn('openai', 'wizard' as never, io) === false)
  check('…and nothing was written', !existsSync(path))
  check('an empty ledger reads as empty', Object.keys(readSignInLedger(io)).length === 0)

  const epochBefore = signInLedgerEpoch()
  check('a record lands', recordSignIn('openai', 'subscription', { ...io, now: () => T0 }) === true)
  check('…and bumps the in-process epoch (the resolver memo re-reads at once)', signInLedgerEpoch() === epochBefore + 1)
  const first = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; signIns?: Record<string, { at?: number; kind?: string }> }
  check('the file carries version 1 and the record', first.version === 1 && first.signIns?.openai?.at === T0 && first.signIns.openai.kind === 'subscription', readFileSync(path, 'utf8'))
  if (process.platform !== 'win32') {
    check('mode 600', (statSync(path).mode & 0o777) === 0o600, (statSync(path).mode & 0o777).toString(8))
  }
  check('no secret enters the ledger (only a family, a kind, a time)', !/key|token|secret/i.test(readFileSync(path, 'utf8')))
  check('readSignInLedger answers the record', JSON.stringify(readSignInLedger(io)) === JSON.stringify({ openai: { at: T0, kind: 'subscription' } }))
  check('readSignInRecord normalises the family spelling', readSignInRecord(' OpenAI ', io)?.at === T0)
  check('an unrecorded family reads undefined', readSignInRecord('zai', io) === undefined)

  check('a later sign-in for the same family REPLACES the earlier one', recordSignIn('openai', 'api-key', { ...io, now: () => T0 + 1000 }) === true)
  const replaced = readSignInLedger(io)
  check('…one entry, the newer time and kind', Object.keys(replaced).length === 1 && replaced.openai?.at === T0 + 1000 && replaced.openai.kind === 'api-key', JSON.stringify(replaced))
  check('another family adds beside it', recordSignIn('zai', 'api-key', { ...io, now: () => T0 + 500 }) === true && Object.keys(readSignInLedger(io)).length === 2)
  check("the operator's /defaultprovider word is a kind of its own", recordSignIn('gemini', 'operator-switch', { ...io, now: () => T0 + 600 }) === true && readSignInLedger(io).gemini?.kind === 'operator-switch')

  // Unknown keys survive a rewrite; malformed entries are skipped, not thrown.
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      note: 'kept',
      signIns: {
        openai: { at: 'yesterday', kind: 'oauth' },
        zai: { at: 5, kind: 'wizard' },
        'Bad Family': { at: 7, kind: 'oauth' },
        deepseek: { at: 7, kind: 'api-key' },
        gemini: null,
      },
    }),
  )
  const filtered = readSignInLedger(io)
  check('malformed entries are skipped, the valid one stands', JSON.stringify(filtered) === JSON.stringify({ deepseek: { at: 7, kind: 'api-key' } }), JSON.stringify(filtered))
  check('a record after that keeps the unknown key', recordSignIn('moonshot', 'oauth', { ...io, now: () => T0 }) === true && (JSON.parse(readFileSync(path, 'utf8')) as { note?: string }).note === 'kept')

  writeFileSync(path, '{not json')
  check('a corrupt file reads as EMPTY — never a throw', Object.keys(readSignInLedger(io)).length === 0)
  check('…and the next record repairs it', recordSignIn('gemini', 'oauth', { ...io, now: () => T0 }) === true && readSignInLedger(io).gemini?.at === T0)
  writeFileSync(path, '[1,2,3]')
  check('an array at the top reads as EMPTY', Object.keys(readSignInLedger(io)).length === 0)

  // The auth-scope law: the ledger lives beside the credential stores.
  const scopeA = join(scratch, 'scope-a')
  const scopeB = join(scratch, 'scope-b')
  mkdirSync(scopeA, { recursive: true })
  mkdirSync(scopeB, { recursive: true })
  setAuthScope(scopeA)
  recordSignIn('zai', 'api-key')
  setAuthScope(scopeB)
  recordSignIn('gemini', 'oauth')
  clearAuthScope()
  check('the store follows the auth scope (scope A holds zai, scope B gemini, the plain home nothing)',
    existsSync(join(scopeA, SIGN_IN_LEDGER_FILE)) &&
      readSignInLedger({ home: scopeA }).zai !== undefined &&
      readSignInLedger({ home: scopeA }).gemini === undefined &&
      readSignInLedger({ home: scopeB }).gemini !== undefined &&
      !existsSync(join(home, SIGN_IN_LEDGER_FILE)))
}

// ── §2 the order ─────────────────────────────────────────────────────────────
const REGISTRY = ['anthropic', 'openai', 'zai', 'openrouter', 'gemini', 'moonshot', 'deepseek', 'openai-compat', 'huggingface', 'local'] as const
const usable = (setting: string, row: string, why = 'the newest row this sign-in can use'): LaneRowVerdict => ({ usable: true, setting, row, why })
const gated = (why: string): LaneRowVerdict => ({ usable: false, why })
const KEYLESS = { setting: 'claude-opus-5', why: 'no provider is signed in yet — /logins signs one in, and its newest usable row becomes the default' }
const facts = (over: Partial<ComputedDefaultFacts>): ComputedDefaultFacts => ({
  credentials: [],
  registryOrder: REGISTRY,
  laneRow: () => usable('x', 'X'),
  keyless: KEYLESS,
  providerName: providerDisplayName,
  ...over,
})
const families = (list: ReadonlyArray<{ family: string }>): string => list.map(c => c.family).join(',')

section('§2 the order — timed newest first, then the untimed with the recorded provider leading')
{
  const ordered = orderCredentials(facts({ credentials: [{ family: 'anthropic', at: null }, { family: 'openai', at: T0 + 2000 }, { family: 'zai', at: T0 + 1000 }] }))
  check('timed sign-ins newest first, the untimed after', families(ordered) === 'openai,zai,anthropic', families(ordered))
  const tied = orderCredentials(facts({ credentials: [{ family: 'zai', at: T0 }, { family: 'openai', at: T0 }] }))
  check('a tie on time falls to the registry order', families(tied) === 'openai,zai', families(tied))
  const untimed = orderCredentials(facts({ credentials: [{ family: 'zai', at: null }, { family: 'anthropic', at: null }, { family: 'openrouter', at: null }], recordedDefaultProvider: 'openrouter' }))
  check('among the untimed the recorded default provider leads, then the registry order', families(untimed) === 'openrouter,anthropic,zai', families(untimed))
  const stranger = orderCredentials(facts({ credentials: [{ family: 'acme', at: null }, { family: 'local', at: null }] }))
  check('a family the registry does not name orders last', families(stranger) === 'local,acme', families(stranger))
  const recordedButTimed = orderCredentials(facts({ credentials: [{ family: 'openrouter', at: null }, { family: 'openai', at: T0 }], recordedDefaultProvider: 'openrouter' }))
  check('a timed sign-in outranks the recorded provider when that one is untimed', families(recordedButTimed) === 'openai,openrouter', families(recordedButTimed))
  check('the time stamp is a deterministic UTC line', formatSignInTime(T0) === '2026-09-01 21:33 UTC', formatSignInTime(T0))
}

// ── §3 the decision ──────────────────────────────────────────────────────────
section('§3 the decision — pure over injected facts')
{
  const laneRows: Record<string, LaneRowVerdict> = {
    openai: usable('gpt-5.5', 'GPT-5.5', 'the newest row this sign-in can use (the recorded frontier, 2026-08-30)'),
    anthropic: usable('claude-fable-5[1m]', 'Fable 5 (1M context)', 'the newest row this sign-in can use (a confirmed Max 20x subscription)'),
    zai: usable('glm-5.3', 'GLM-5.3'),
  }
  const laneRow = (family: string): LaneRowVerdict => laneRows[family] ?? gated('no selectable row in the catalogue yet')
  const base = facts({
    credentials: [
      { family: 'anthropic', at: T0 + 1000, kind: 'oauth', label: 'Claude subscription (max)' },
      { family: 'openai', at: T0 + 2000, kind: 'subscription', label: 'ChatGPT plus subscription' },
    ],
    laneRow,
  })

  // row 1 — the most recent sign-in wins
  const a = evaluateComputedDefault(base)
  check('row 1: the most recent sign-in decides the provider', a.provider === 'openai' && a.source === 'sign-in' && a.setting === 'gpt-5.5' && a.row === 'GPT-5.5', JSON.stringify(a))
  check('row 1: the chosen credential is the first considered, timed, with its recency words', a.chosen === a.considered[0] && a.chosen?.timed === true && a.chosen.recency === 'the most recent sign-in (subscription sign-in, 2026-09-01 21:33 UTC)', a.chosen?.recency)
  check('row 1: every credential is considered, in recency order, each with a verdict', families(a.considered) === 'openai,anthropic' && a.considered.every(c => c.verdict !== undefined))
  check('row 1: the why names the row, the provider, the recency and the gating words', a.why === 'GPT-5.5 — OpenAI, the most recent sign-in (subscription sign-in, 2026-09-01 21:33 UTC); the newest row this sign-in can use (the recorded frontier, 2026-08-30)', a.why)

  // row 2 — a gated row is never chosen: the most recent sign-in falls through, named
  const b = evaluateComputedDefault({ ...base, laneRow: family => (family === 'openai' ? gated('GPT-5.5: not served by the connected ChatGPT subscription') : laneRow(family)) })
  check('row 2: a most recent sign-in without a usable row falls through to the next', b.provider === 'anthropic' && b.source === 'fallthrough' && b.setting === 'claude-fable-5[1m]', JSON.stringify(b))
  check('row 2: the skipped sign-in is named with its reason', b.why.includes('Skipped: OpenAI (the most recent sign-in (subscription sign-in, 2026-09-01 21:33 UTC)) — GPT-5.5: not served by the connected ChatGPT subscription'), b.why)
  check('row 2: the chosen credential is the second considered', b.chosen === b.considered[1] && b.considered[0]?.verdict.usable === false)

  // row 3 — no sign-in: NO default; the keyless placeholder, named "no sign-in yet"
  const c = evaluateComputedDefault(facts({ laneRow }))
  check('row 3: no sign-in ⇒ keyless — no provider, the "no sign-in yet" row, the placeholder setting, the keyless words', c.source === 'keyless' && c.setting === KEYLESS.setting && c.provider === null && c.row === NO_SIGN_IN_ROW && c.chosen === null && c.considered.length === 0 && c.why === KEYLESS.why, JSON.stringify(c))

  // row 4 — every sign-in unusable: keyless, with each family's reason
  const d = evaluateComputedDefault({ ...base, laneRow: family => gated(`${family} offers nothing yet`) })
  check('row 4: every sign-in unusable ⇒ keyless with each reason and the logins door', d.source === 'keyless' && d.setting === KEYLESS.setting && d.provider === null && d.row === NO_SIGN_IN_ROW && d.why === 'no sign-in offers a usable row (OpenAI: openai offers nothing yet; Anthropic: anthropic offers nothing yet) — /logins signs another provider in', d.why)

  // row 5 — a legacy home: untimed credentials keep the recorded lane, and say why
  const e = evaluateComputedDefault(facts({ credentials: [{ family: 'anthropic', at: null, label: 'Claude subscription (max)' }, { family: 'openrouter', at: null, label: 'OpenRouter (stored key)' }], recordedDefaultProvider: 'openrouter', laneRow: family => (family === 'openrouter' ? usable('openrouter/qwen/qwen3-coder', 'Qwen3 Coder', "the first row this sign-in can use (the catalogue's own order)") : laneRow(family)) }))
  check('row 5: untimed credentials keep the recorded default provider', e.provider === 'openrouter' && e.source === 'sign-in' && e.chosen?.timed === false, JSON.stringify(e))
  check('row 5: …and the recency words say so', e.chosen?.recency === 'the recorded default provider, sign-in time not recorded (OpenRouter (stored key))', e.chosen?.recency)
  check('row 5: the other untimed credential is labelled untimed too', e.considered[1]?.recency === 'sign-in time not recorded (Claude subscription (max))', e.considered[1]?.recency)

  // row 6 — a new sign-in moves the default (re-evaluated per call); the operator's switch is a sign-in of its own kind
  const f = evaluateComputedDefault({ ...base, credentials: [...base.credentials, { family: 'zai', at: T0 + 3000, kind: 'operator-switch' }] })
  check('row 6: a newer sign-in moves the default to its family', f.provider === 'zai' && f.setting === 'glm-5.3' && families(f.considered) === 'zai,openai,anthropic', families(f.considered))
  check("row 6: the operator's /defaultprovider word reads as its own kind", f.chosen?.recency === 'the most recent sign-in (/defaultprovider switch, 2026-09-01 21:33 UTC)', f.chosen?.recency)

  // row 7 — the describers
  check('row 7a: the Default row keeps the neutral grammar and names row + provider + source', describeComputedDefaultRow(a, providerDisplayName) === 'Default (GPT-5.5 — OpenAI, the most recent sign-in)', describeComputedDefaultRow(a, providerDisplayName))
  check('row 7b: …a fallthrough says so', describeComputedDefaultRow(b, providerDisplayName) === 'Default (Fable 5 (1M context) — Anthropic, the most recent sign-in with a usable row)', describeComputedDefaultRow(b, providerDisplayName))
  check('row 7c: …a keyless answer names no provider — the logins door', describeComputedDefaultRow(c, providerDisplayName) === `Default (${NO_SIGN_IN_REASON})` && describeComputedDefaultRow(d, providerDisplayName) === `Default (${NO_SIGN_IN_REASON})`, describeComputedDefaultRow(c, providerDisplayName))
  check('row 7d: …a legacy lane names the recorded default provider', describeComputedDefaultRow(e, providerDisplayName) === 'Default (Qwen3 Coder — OpenRouter, the recorded default provider)', describeComputedDefaultRow(e, providerDisplayName))
  for (const [tag, decision] of [['a', a], ['b', b], ['c', c], ['d', d], ['e', e]] as const) {
    check(`row 7e: the row grammar /^Default \\(.+\\)$/ holds (${tag})`, /^Default \(.+\)$/.test(describeComputedDefaultRow(decision, providerDisplayName)))
  }
  check('row 7f: the terse line names row · provider · recency · gating', describeComputedDefault(a, providerDisplayName) === 'GPT-5.5 · OpenAI · the most recent sign-in (subscription sign-in, 2026-09-01 21:33 UTC) · the newest row this sign-in can use (the recorded frontier, 2026-08-30)', describeComputedDefault(a, providerDisplayName))
  check('row 7g: …and a keyless line says no sign-in yet', describeComputedDefault(c, providerDisplayName) === `${NO_SIGN_IN_ROW} · ${KEYLESS.why}`, describeComputedDefault(c, providerDisplayName))
  check('row 7h: the words name no provider by preference — the provider comes from the facts', describeComputedDefaultRow(f, providerDisplayName) === 'Default (GLM-5.3 — Z.AI, the most recent sign-in)', describeComputedDefaultRow(f, providerDisplayName))
  check('row 7i: the /model label puts the row first and the default word after', describeComputedDefaultLabel(a, providerDisplayName) === 'GPT-5.5 (default — OpenAI, the most recent sign-in)' && describeComputedDefaultLabel(c, providerDisplayName) === 'no sign-in yet (default — /logins signs a provider in)', describeComputedDefaultLabel(a, providerDisplayName))
}

// ── §4 the live chain ────────────────────────────────────────────────────────
section('§4 the live chain in a scratch home')
{
  const keyless = computedDefault()
  check('a home with no credential anywhere answers keyless — no provider, the "no sign-in yet" row', keyless.source === 'keyless' && keyless.considered.length === 0 && keyless.provider === null && keyless.row === NO_SIGN_IN_ROW, JSON.stringify(keyless.considered))
  check('…on the placeholder that stands today (the first-party decision\'s setting) — the harness\'s model string', keyless.setting === frontierOperatorDecision().setting && getDefaultMainLoopModelSetting() === keyless.setting, `${keyless.setting} vs ${frontierOperatorDecision().setting}`)
  const keylessRow = getModelOptions().find(o => o.value === null)
  check('the Recommended row says no sign-in yet and points at the logins door', keylessRow?.description === `Default (${NO_SIGN_IN_REASON})`, keylessRow?.description)
  check('…and is not selectable (the neutral reason, never a family\'s)', keylessRow?.unavailable === NO_SIGN_IN_REASON, keylessRow?.unavailable)
  check('/model\'s label says no sign-in yet', renderDefaultModelLabel() === 'no sign-in yet (default — /logins signs a provider in)', renderDefaultModelLabel())
  check('the most recent sign-in family is none', mostRecentSignInFamily() === undefined)

  setMainLoopModelOverride('sonnet')
  check('an explicit choice outranks the default on the live chain', getMainLoopModel() === parseUserSpecifiedModel('sonnet') && getMainLoopModel() !== computedDefault().setting, getMainLoopModel())
  setMainLoopModelOverride(undefined)

  // The real Z.AI key-leg driver (no network, no key-check endpoint): the
  // store's writer records the sign-in.
  const outcome = storeZaiApiKeyLogin('zai-proof-key-000000', 'general')
  check('the Z.AI key leg stores', outcome.ok && outcome.stored, outcome.receipt)
  const zaiRecord = readSignInLedger().zai
  check('…and the sign-in ledger records the family (kind api-key) in the plain home', zaiRecord !== undefined && zaiRecord.kind === 'api-key' && existsSync(join(home, SIGN_IN_LEDGER_FILE)), JSON.stringify(readSignInLedger()))
  const onZai = computedDefault()
  const zaiFrontier = keyLanePins('zai')[0]
  check('the default lands on that family at once (the ledger epoch drops the memo)', onZai.provider === 'zai' && onZai.source === 'sign-in' && onZai.chosen?.family === 'zai' && onZai.chosen.timed === true, JSON.stringify({ provider: onZai.provider, source: onZai.source, why: onZai.why }))
  check('…on its newest usable row — the recorded frontier pin, selectable in the picker', zaiFrontier !== undefined && onZai.setting === zaiFrontier.id && declaredRouteOf(onZai.setting) === 'zai' && onZai.row === zaiFrontier.displayName, `${onZai.setting} vs ${zaiFrontier?.id}`)
  check('…with the gating words naming the recorded frontier', onZai.chosen?.verdict.usable === true && onZai.chosen.verdict.why.startsWith('the newest row this sign-in can use (the recorded frontier'), onZai.chosen?.verdict.why)
  // The resolver puts nothing on the wire: a key-lane default answers from
  // its pin table without composing the picker (a composition kicks the
  // catalogue lanes' refreshes and the local discovery probes — the s5
  // backends fixture saw its request body overwritten by such a probe).
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async (...args: unknown[]) => {
    fetches += 1
    return realFetch(...(args as Parameters<typeof fetch>))
  }) as typeof fetch
  try {
    resetComputedDefaultMemo()
    computedDefault()
    await sleep(30)
  } finally {
    globalThis.fetch = realFetch
  }
  check('a key-lane default puts nothing on the wire (no picker composition, no probe, no catalogue kick)', fetches === 0, `${fetches} fetch call(s)`)
  const zaiRow = getModelOptions().find(o => o.value === null)
  check('the Recommended row names the row and the provider', zaiRow?.description === `Default (${zaiFrontier?.displayName} — ${providerDisplayName('zai')}, the most recent sign-in)`, zaiRow?.description)
  check('…and is selectable although the first-party family is not signed in (the default is another family\'s)', zaiRow?.unavailable === undefined, zaiRow?.unavailable)
  check('/model\'s label names the row, the provider and the sign-in', renderDefaultModelLabel() === `${zaiFrontier?.displayName} (default — ${providerDisplayName('zai')}, the most recent sign-in)`, renderDefaultModelLabel())
  check('the main-loop model rides the default (no explicit setting)', getMainLoopModel() === zaiFrontier?.id, getMainLoopModel())
  check('the most recent sign-in family is zai', mostRecentSignInFamily() === 'zai')

  // A later key through the store's own writer (the /router key road)
  // moves the default to the newer family.
  await sleep(15)
  writeStoredDeepseekApiKey('sk-deepseek-proof-000000')
  const onDeepseek = computedDefault()
  const deepseekFrontier = keyLanePins('deepseek')[0]
  check('a later sign-in through the store writer moves the default', onDeepseek.provider === 'deepseek' && onDeepseek.source === 'sign-in' && families(onDeepseek.considered) === 'deepseek,zai', families(onDeepseek.considered))
  check('…onto that family\'s newest usable row', deepseekFrontier !== undefined && onDeepseek.setting === deepseekFrontier.id && declaredRouteOf(onDeepseek.setting) === 'deepseek', onDeepseek.setting)
  check('the earlier sign-in is still considered, as an earlier sign-in', onDeepseek.considered[1]?.recency.startsWith('an earlier sign-in (API key, '), onDeepseek.considered[1]?.recency)

  // /defaultprovider: the operator's word is a sign-in of its own kind.
  await sleep(15)
  check('an unknown family is refused by /defaultprovider', switchDefaultProvider('acme') === false)
  check('/defaultprovider records an operator switch', switchDefaultProvider('zai') === true && readSignInLedger().zai?.kind === 'operator-switch')
  const switched = computedDefault()
  check('…and the default moves back to that family, named as the switch', switched.provider === 'zai' && switched.chosen?.recency.startsWith('the most recent sign-in (/defaultprovider switch, '), switched.chosen?.recency)
  check('a switch to a family with no credential records but changes nothing until it signs in', switchDefaultProvider('openai') === true && computedDefault().provider === 'zai' && !computedDefault().considered.some(c => c.family === 'openai'))

  // An env-pinned key is a credential without a sign-in: untimed, after.
  process.env.OPENROUTER_API_KEY = 'or-proof-key-000000'
  resetComputedDefaultMemo() // an env pin lands without a ledger record — the proof drops the memo itself
  const withEnv = computedDefault()
  const envRow = withEnv.considered.find(c => c.family === 'openrouter')
  check('an env-pinned key is considered as a credential WITHOUT a sign-in — untimed, ordered last', envRow !== undefined && envRow.timed === false && envRow.recency.startsWith('sign-in time not recorded') && withEnv.considered[withEnv.considered.length - 1] === envRow, JSON.stringify(withEnv.considered.map(c => [c.family, c.timed])))
  check('…and the default stays on the most recent timed sign-in', withEnv.provider === 'zai', withEnv.provider ?? 'null')
  delete process.env.OPENROUTER_API_KEY
  resetComputedDefaultMemo()
}

// ── §5 the sign-in owners and the default consumers ─────────────────────────
section('§5 the sign-in owners — every credential-landing site records; the refresh path never does; every consumer reads the one owner')
{
  const src = (rel: string): string => readFileSync(join(import.meta.dir, '../../src', rel), 'utf8')
  const count = (text: string, needle: string): number => text.split(needle).length - 1
  const secrets = src('utils/router/providerSecrets.ts')
  check('the key store records the Z.AI and OpenAI key writes', secrets.includes("recordSignIn('zai', 'api-key')") && secrets.includes("recordSignIn('openai', 'api-key')"))
  check('…and the generic key writer records through the field→family map', secrets.includes("recordSignIn(family, 'api-key')"))
  const map = secrets.slice(secrets.indexOf('const KEY_FIELD_FAMILY'), secrets.indexOf('function writeStoredKey'))
  check('the map names the seven generic model-key fields and no web-search key', ['moonshot', 'deepseek', 'openai-compat', 'openrouter', 'gemini', 'huggingface', 'local'].every(f => map.includes(`'${f}'`)) && !/brave|tavily/i.test(map))
  check('the OpenAI subscription records on both connect roads (browser + device)', count(src('services/providers/openai/openaiAccounts.ts'), "recordSignIn('openai', 'subscription')") === 2)
  check('the Gemini OAuth connect records once', count(src('services/providers/gemini/geminiAccounts.ts'), "recordSignIn('gemini', 'oauth')") === 1)
  check('the OpenRouter mint records once', count(src('services/providers/openrouter/openrouterAccounts.ts'), "recordSignIn('openrouter', 'oauth')") === 1)
  check('the Kimi device sign-in records once', count(src('services/providers/moonshot/moonshotLogin.ts'), "recordSignIn('moonshot', 'oauth')") === 1)
  check('the Hugging Face device sign-in records on both arms (landed, landed-after-cancel)', count(src('services/providers/huggingface/huggingfaceLogin.ts'), "recordSignIn('huggingface', 'oauth')") === 2)
  const machine = src('components/mercury-ui/screens/anthropicLoginModel.ts')
  check('the Anthropic machine records the arm that landed, after the save and the mint — and no first-login record', machine.includes("deps.recordSignIn(deps.usesClaudeAiAuth(tokens.scopes) ? 'oauth' : 'api-key')") && machine.includes("recordSignIn: kind => recordSignInLedger('anthropic', kind)") && !machine.includes('recordFirstLogin'))
  check('the headless auth door records after its save and mint', src('cli/handlers/auth.ts').includes("recordSignIn('anthropic', shouldUseClaudeAIAuth(tokens.scopes) ? 'oauth' : 'api-key')"))
  check('the scoped reauth records inside its scope bracket', src('utils/accounts/scopedReauth.ts').includes("recordSignIn('anthropic', 'oauth')"))
  check('the first-party token owner (the refresh path) never records', !src('utils/auth.ts').includes('recordSignIn('))
  for (const rel of ['services/providers/openai/openaiAccounts.ts', 'services/providers/gemini/geminiAccounts.ts', 'services/providers/moonshot/moonshotAccounts.ts', 'services/providers/huggingface/huggingfaceAccounts.ts']) {
    const text = src(rel)
    const refreshWrites = count(text, 'lastRefreshMs: now()')
    check(`the refresh writer in ${rel.split('/').pop()} records nothing (its ${refreshWrites} refresh write${refreshWrites === 1 ? '' : 's'} sit apart from the record calls)`, !/lastRefreshMs: now\(\)[^]{0,200}recordSignIn\(/.test(text))
  }
  const skin = src('components/ConsoleOAuthFlow.tsx')
  check('the /logins card records nothing itself — no first-login record, no ledger call (the drivers record)', !skin.includes('recordFirstLoginDefaultProvider') && !skin.includes('recordSignIn'))
  check('the first-login recorder is gone from the tree (src)', !/recordFirstLoginDefaultProvider/.test([src('utils/model/defaultProviderRung.ts'), skin, machine].join('\n')))
  const rung = src('utils/model/defaultProviderRung.ts')
  check('/defaultprovider writes the ledger only — no config write', rung.includes("recordSignIn(family, 'operator-switch', io)") && !rung.includes('saveGlobalConfig'))
  const model = src('utils/model/model.ts')
  const between = (s: string, a: string, b: string): string => {
    const i = s.indexOf(a)
    const j = s.indexOf(b, i)
    return i >= 0 && j > i ? s.slice(i, j) : ''
  }
  check('the session default projects the one computed default (model.ts)', between(model, 'export function getDefaultMainLoopModelSetting', '\n}').includes('computedDefault()') && !model.includes('credentiallessGptDefault') && !model.includes('applyDefaultProviderRung'))
  check('the /model Default-row description and label project it', between(model, 'export function getDefaultModelDescription', '\n}').includes('computedDefault()') && between(model, 'export function renderDefaultModelLabel', '\n}').includes('computedDefault()'))
  check('the Recommended row projects it (modelOptions)', between(src('utils/model/modelOptions.ts'), 'function defaultRow', '\n}').includes('describeComputedDefaultRow(computedDefault()'))
  check("the doctor's Default model row projects it", between(src('utils/healthReport.ts'), "id: 'frontier'", 'link:').includes('computedDefault()'))
  const resolver = src('utils/model/computedDefault.ts')
  check('the key lanes answer from their pin tables before any picker composition (no probe rides a default resolution)', resolver.includes("if (KEY_LANES.has(family)) return keyLaneRow(") && resolver.indexOf('KEY_LANES.has(family)') < resolver.indexOf('rows = livePickerRows()') && between(resolver, 'function keyLaneRow', '\n}').includes('keyLanePins(family)[0]'))
  check('the boot face chip says no sign-in yet on a keyless default', src('components/BootSplashScreen.tsx').includes("computedDefault().source === 'keyless'") && src('components/BootSplashScreen.tsx').includes('noSignIn ? NO_SIGN_IN_ROW : renderModelChip(mainModel)'))
  const face = src('components/BootLoginsScreen.tsx')
  check('the logins card and the Boot face focus the most recent sign-in\'s row; the face\'s summary reads it from its facts (a pure composer never reads the machine)', skin.includes('loginFamilyFocusFor(mostRecentSignInFamily())') && count(face, 'loginFamilyFocusFor(mostRecentSignInFamily())') === 1 && face.includes('loginFamilyFocusFor(facts.defaultFamily)') && face.includes('const defaultFamily = mostRecentSignInFamily();'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nCOMPUTED DEFAULT: ALL PASS' : `\nCOMPUTED DEFAULT: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
