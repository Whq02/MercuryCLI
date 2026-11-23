#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  'MERCURY_MODEL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_CUSTOM_MODEL_OPTION',
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
  'MERCURY_ZAI_API_BASE',
  'MERCURY_XAI_API_BASE',
  'MERCURY_META_API_BASE',
  'MERCURY_MISTRAL_API_BASE',
  'MERCURY_ZEN_API_BASE',
  'MERCURY_NOUS_API_BASE',
]) {
  process.env[base] = dead
}

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { SIGN_IN_LEDGER_FILE, readSignInLedger, readSignInRecord, recordSignIn, signInLedgerEpoch } = await import(
  '../../src/models/sign-in/account-ledger/signInLedger.ts'
)
const {
  CHOOSE_A_MODEL_ID,
  CHOOSE_A_MODEL_WORDS,
  NO_SIGN_IN_REASON,
  NO_SIGN_IN_ROW,
  NO_USABLE_ROW,
  computedDefault,
  describeComputedDefault,
  describeComputedDefaultLabel,
  describeComputedDefaultRow,
  evaluateComputedDefault,
  formatSignInTime,
  mostRecentSignInFamily,
  orderCredentials,
  resetComputedDefaultMemo,
} = await import('../../src/models/catalogue/computedDefault.ts')
type ComputedDefaultFacts = import('../../src/models/catalogue/computedDefault.ts').ComputedDefaultFacts
type LaneRowVerdict = import('../../src/models/catalogue/computedDefault.ts').LaneRowVerdict
const { getDefaultEngineModelSetting, getEngineModel, parseUserSpecifiedModel, renderDefaultModelLabel, renderModelChip, renderModelName } =
  await import('../../src/models/catalogue/engineModel.ts')
const { setEngineModelOverride } = await import('../../src/boot/process-state/processState.ts')
const { recognizeModelId } = await import('../../src/models/roads/idSpaces.ts')
const { getModelOptions, keyLanePins } = await import('../../src/models/catalogue/modelOptions.ts')
const { declaredRouteOf, providerDisplayName } = await import('../../src/models/roads/routeLaw.ts')
const { storeZaiApiKeyLogin } = await import('../../src/models/roads/zai/zaiLogin.ts')
const { writeStoredDeepseekApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const { switchDefaultProvider } = await import('../../src/models/facts/defaultProviderRung.ts')
const { clearAuthScope, setAuthScope } = await import('../../src/platform/environment/envUtils.ts')

let failures = 0
const defaultHint = 'change the sign-in ledger in src/models/sign-in/account-ledger/signInLedger.ts (section 1), or orderCredentials, evaluateComputedDefault and the describe functions in src/models/catalogue/computedDefault.ts (sections 2 and 3), or the live chain they feed through src/models/catalogue/engineModel.ts and src/models/facts/defaultProviderRung.ts (sections 4 and 5)'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? ` — ${defaultHint}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

console.log('============================================================')
console.log(' computed default — the newest usable row of the provider of the most recent sign-in')
console.log('============================================================')

const T0 = 1_788_298_400_000

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

  const a = evaluateComputedDefault(base)
  check('row 1: the most recent sign-in decides the provider', a.provider === 'openai' && a.source === 'sign-in' && a.setting === 'gpt-5.5' && a.row === 'GPT-5.5', JSON.stringify(a))
  check('row 1: the chosen credential is the first considered, timed, with its recency words', a.chosen === a.considered[0] && a.chosen?.timed === true && a.chosen.recency === 'the most recent sign-in (subscription sign-in, 2026-09-01 21:33 UTC)', a.chosen?.recency)
  check('row 1: every credential is considered, in recency order, each with a verdict', families(a.considered) === 'openai,anthropic' && a.considered.every(c => c.verdict !== undefined))
  check('row 1: the why names the row, the provider, the recency and the gating words', a.why === 'GPT-5.5 — OpenAI, the most recent sign-in (subscription sign-in, 2026-09-01 21:33 UTC); the newest row this sign-in can use (the recorded frontier, 2026-08-30)', a.why)

  const b = evaluateComputedDefault({ ...base, laneRow: family => (family === 'openai' ? gated('GPT-5.5: not served by the connected ChatGPT subscription') : laneRow(family)) })
  check('row 2: a most recent sign-in without a usable row falls through to the next', b.provider === 'anthropic' && b.source === 'fallthrough' && b.setting === 'claude-fable-5[1m]', JSON.stringify(b))
  check('row 2: the skipped sign-in is named with its reason', b.why.includes('Skipped: OpenAI (the most recent sign-in (subscription sign-in, 2026-09-01 21:33 UTC)) — GPT-5.5: not served by the connected ChatGPT subscription'), b.why)
  check('row 2: the chosen credential is the second considered', b.chosen === b.considered[1] && b.considered[0]?.verdict.usable === false)

  const c = evaluateComputedDefault(facts({ laneRow }))
  check('row 3: no sign-in ⇒ keyless — no provider, the "no sign-in yet" row, the placeholder setting, the keyless words', c.source === 'keyless' && c.setting === KEYLESS.setting && c.provider === null && c.row === NO_SIGN_IN_ROW && c.chosen === null && c.considered.length === 0 && c.why === KEYLESS.why, JSON.stringify(c))

  const d = evaluateComputedDefault({ ...base, laneRow: family => gated(`${family} offers nothing yet`) })
  check('row 4: every sign-in unusable ⇒ keyless with each reason, the "no usable row yet" row and the logins door', d.source === 'keyless' && d.setting === KEYLESS.setting && d.provider === null && d.row === NO_USABLE_ROW && d.why === 'no signed-in provider has a usable model (OpenAI: openai offers nothing yet; Anthropic: anthropic offers nothing yet); name a model by id with /model, or sign in with /logins', d.why)

  const e = evaluateComputedDefault(facts({ credentials: [{ family: 'anthropic', at: null, label: 'Claude subscription (max)' }, { family: 'openrouter', at: null, label: 'OpenRouter (stored key)' }], recordedDefaultProvider: 'openrouter', laneRow: family => (family === 'openrouter' ? usable('openrouter/qwen/qwen3-coder', 'Qwen3 Coder', "the first row this sign-in can use (the catalogue's own order)") : laneRow(family)) }))
  check('row 5: untimed credentials keep the recorded default provider', e.provider === 'openrouter' && e.source === 'sign-in' && e.chosen?.timed === false, JSON.stringify(e))
  check('row 5: …and the recency words say so', e.chosen?.recency === 'the recorded default provider, sign-in time not recorded (OpenRouter (stored key))', e.chosen?.recency)
  check('row 5: the other untimed credential is labelled untimed too', e.considered[1]?.recency === 'sign-in time not recorded (Claude subscription (max))', e.considered[1]?.recency)

  const f = evaluateComputedDefault({ ...base, credentials: [...base.credentials, { family: 'zai', at: T0 + 3000, kind: 'operator-switch' }] })
  check('row 6: a newer sign-in moves the default to its family', f.provider === 'zai' && f.setting === 'glm-5.3' && families(f.considered) === 'zai,openai,anthropic', families(f.considered))
  check("row 6: the operator's /defaultprovider word reads as its own kind", f.chosen?.recency === 'the most recent sign-in (/defaultprovider switch, 2026-09-01 21:33 UTC)', f.chosen?.recency)

  check('row 7a: the default description names the model, provider and source', describeComputedDefaultRow(a, providerDisplayName) === 'Default (GPT-5.5 — OpenAI, the most recent sign-in)', describeComputedDefaultRow(a, providerDisplayName))
  check('row 7b: …a fallthrough says so', describeComputedDefaultRow(b, providerDisplayName) === 'Default (Fable 5 (1M context) — Anthropic, the most recent sign-in with a usable row)', describeComputedDefaultRow(b, providerDisplayName))
  check('row 7c: …a keyless answer names no provider — the logins door with no sign-in, each sign-in\'s gate then the door when sign-ins exist', describeComputedDefaultRow(c, providerDisplayName) === `Default (${NO_SIGN_IN_REASON})` && describeComputedDefaultRow(d, providerDisplayName) === `Default (${d.why})`, describeComputedDefaultRow(d, providerDisplayName))
  check('row 7d: …a legacy lane names the recorded default provider', describeComputedDefaultRow(e, providerDisplayName) === 'Default (Qwen3 Coder — OpenRouter, the recorded default provider)', describeComputedDefaultRow(e, providerDisplayName))
  for (const [tag, decision] of [['a', a], ['b', b], ['c', c], ['d', d], ['e', e]] as const) {
    check(`row 7e: the row grammar /^Default \\(.+\\)$/ holds (${tag})`, /^Default \(.+\)$/.test(describeComputedDefaultRow(decision, providerDisplayName)))
  }
  check('row 7f: the terse line names row · provider · recency · gating', describeComputedDefault(a, providerDisplayName) === 'GPT-5.5 · OpenAI · the most recent sign-in (subscription sign-in, 2026-09-01 21:33 UTC) · the newest row this sign-in can use (the recorded frontier, 2026-08-30)', describeComputedDefault(a, providerDisplayName))
  check('row 7g: …and a keyless line says no sign-in yet', describeComputedDefault(c, providerDisplayName) === `${NO_SIGN_IN_ROW} · ${KEYLESS.why}`, describeComputedDefault(c, providerDisplayName))
  check('row 7h: the words name no provider by preference — the provider comes from the facts', describeComputedDefaultRow(f, providerDisplayName) === 'Default (GLM-5.3 — Z.AI, the most recent sign-in)', describeComputedDefaultRow(f, providerDisplayName))
  check('row 7i: the /model label puts the row first and the default word after', describeComputedDefaultLabel(a, providerDisplayName) === 'GPT-5.5 (default — OpenAI, the most recent sign-in)' && describeComputedDefaultLabel(c, providerDisplayName) === 'no sign-in yet (default — /logins signs a provider in)', describeComputedDefaultLabel(a, providerDisplayName))
}

section('§4 the live chain in a scratch home')
{
  const keyless = computedDefault()
  check('a home with no credential anywhere answers keyless — no provider, the "no sign-in yet" row', keyless.source === 'keyless' && keyless.considered.length === 0 && keyless.provider === null && keyless.row === NO_SIGN_IN_ROW, JSON.stringify(keyless.considered))
  check('…on the "choose a model" entry — the harness\'s model string, a model no provider declares', keyless.setting === CHOOSE_A_MODEL_ID && getDefaultEngineModelSetting() === keyless.setting && getEngineModel() === CHOOSE_A_MODEL_ID && recognizeModelId(keyless.setting).kind === 'unrecognised', `${keyless.setting} · ${getEngineModel()}`)
  check('…whose display name is the words every surface paints', renderModelName(CHOOSE_A_MODEL_ID) === CHOOSE_A_MODEL_WORDS && renderModelChip(CHOOSE_A_MODEL_ID) === CHOOSE_A_MODEL_WORDS && !/opus|sonnet|haiku|claude|gpt|gemini/i.test(renderModelChip(getEngineModel())), renderModelChip(getEngineModel()))
  check('a keyless home has no recommended default option', getModelOptions().every(o => typeof o.value === 'string' && o.value !== 'default' && o.label !== 'Recommended'))
  check('/model\'s label says no sign-in yet', renderDefaultModelLabel() === 'no sign-in yet (default — /logins signs a provider in)', renderDefaultModelLabel())
  check('the most recent sign-in family is none', mostRecentSignInFamily() === undefined)

  setEngineModelOverride('sonnet')
  check('an explicit choice outranks the default on the live chain', getEngineModel() === parseUserSpecifiedModel('sonnet') && getEngineModel() !== computedDefault().setting, getEngineModel())
  setEngineModelOverride(undefined)

  const outcome = await storeZaiApiKeyLogin('zai-proof-key-000000', 'general', undefined, { probeKey: async () => ({ state: 'accepted', models: 1 }) })
  check('the Z.AI key leg stores', outcome.ok && outcome.stored, outcome.receipt)
  const zaiRecord = readSignInLedger().zai
  check('…and the sign-in ledger records the family (kind api-key) in the plain home', zaiRecord !== undefined && zaiRecord.kind === 'api-key' && existsSync(join(home, SIGN_IN_LEDGER_FILE)), JSON.stringify(readSignInLedger()))
  const onZai = computedDefault()
  const zaiFrontier = keyLanePins('zai')[0]
  check('the default lands on that family at once (the ledger epoch drops the memo)', onZai.provider === 'zai' && onZai.source === 'sign-in' && onZai.chosen?.family === 'zai' && onZai.chosen.timed === true, JSON.stringify({ provider: onZai.provider, source: onZai.source, why: onZai.why }))
  check('…on its newest usable row — the recorded frontier pin, selectable in the picker', zaiFrontier !== undefined && onZai.setting === zaiFrontier.id && declaredRouteOf(onZai.setting) === 'zai' && onZai.row === zaiFrontier.displayName, `${onZai.setting} vs ${zaiFrontier?.id}`)
  check('…with the observation date and absent live list stated', onZai.chosen?.verdict.usable === true && onZai.chosen.verdict.why.includes(`observed ${zaiFrontier?.observedAt}; no live list`), onZai.chosen?.verdict.why)
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
  const zaiOptions = getModelOptions()
  const zaiRow = zaiOptions.find(o => o.value === onZai.setting)
  check('the computed default has its real selectable model row', zaiRow !== undefined && zaiRow.label === zaiFrontier?.displayName && zaiRow.unavailable === undefined, JSON.stringify(zaiRow))
  check('a signed-in home has no recommended default option', zaiOptions.every(o => typeof o.value === 'string' && o.value !== 'default' && o.label !== 'Recommended'))
  check('/model\'s label names the row, the provider and the sign-in', renderDefaultModelLabel() === `${zaiFrontier?.displayName} (default — ${providerDisplayName('zai')}, the most recent sign-in)`, renderDefaultModelLabel())
  check('the main-loop model rides the default (no explicit setting)', getEngineModel() === zaiFrontier?.id, getEngineModel())
  check('the most recent sign-in family is zai', mostRecentSignInFamily() === 'zai')

  await sleep(15)
  writeStoredDeepseekApiKey('sk-deepseek-proof-000000')
  const onDeepseek = computedDefault()
  const deepseekFrontier = keyLanePins('deepseek')[0]
  check('a later sign-in through the store writer moves the default', onDeepseek.provider === 'deepseek' && onDeepseek.source === 'sign-in' && families(onDeepseek.considered) === 'deepseek,zai', families(onDeepseek.considered))
  check('…onto that family\'s newest usable row', deepseekFrontier !== undefined && onDeepseek.setting === deepseekFrontier.id && declaredRouteOf(onDeepseek.setting) === 'deepseek', onDeepseek.setting)
  check('the earlier sign-in is still considered, as an earlier sign-in', onDeepseek.considered[1]?.recency.startsWith('an earlier sign-in (API key, '), onDeepseek.considered[1]?.recency)

  await sleep(15)
  check('an unknown family is refused by /defaultprovider', switchDefaultProvider('acme') === false)
  check('/defaultprovider records an operator switch', switchDefaultProvider('zai') === true && readSignInLedger().zai?.kind === 'operator-switch')
  const switched = computedDefault()
  check('…and the default moves back to that family, named as the switch', switched.provider === 'zai' && switched.chosen?.recency.startsWith('the most recent sign-in (/defaultprovider switch, '), switched.chosen?.recency)
  check('a switch to a family with no credential records but changes nothing until it signs in', switchDefaultProvider('openai') === true && computedDefault().provider === 'zai' && !computedDefault().considered.some(c => c.family === 'openai'))

  process.env.OPENROUTER_API_KEY = 'or-proof-key-000000'
  resetComputedDefaultMemo()
  const withEnv = computedDefault()
  const envRow = withEnv.considered.find(c => c.family === 'openrouter')
  check('an env-pinned key is considered as a credential WITHOUT a sign-in — untimed, ordered last', envRow !== undefined && envRow.timed === false && envRow.recency.startsWith('sign-in time not recorded') && withEnv.considered[withEnv.considered.length - 1] === envRow, JSON.stringify(withEnv.considered.map(c => [c.family, c.timed])))
  check('…and the default stays on the most recent timed sign-in', withEnv.provider === 'zai', withEnv.provider ?? 'null')
  delete process.env.OPENROUTER_API_KEY
  resetComputedDefaultMemo()
}

section('§4b a stored key the provider refuses is skipped by the default until that family signs in again')
{
  const { refreshZaiCatalogue } = await import('../../src/models/roads/zai/zaiCatalogue.ts')
  const { readSignInRefusal } = await import('../../src/models/roads/signInRefusal.ts')
  const refusing = (async () =>
    new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const snapshot = await refreshZaiCatalogue({ force: true, env: { ...process.env }, fetchImpl: refusing })
  const refusal = readSignInRefusal('zai')
  check(
    'a catalogue read the provider answers 401 records the stored key as refused',
    snapshot?.lastError?.includes('HTTP 401') === true && refusal !== undefined && refusal.status === 401,
    JSON.stringify({ lastError: snapshot?.lastError, refusal }),
  )
  resetComputedDefaultMemo()
  const afterRefusal = computedDefault()
  const refusedRow = afterRefusal.considered.find(c => c.family === 'zai')
  check(
    '…and the computed default skips that family, the refusal in its why, the next timed sign-in chosen',
    afterRefusal.provider === 'deepseek' && refusedRow !== undefined && refusedRow.verdict.usable === false && refusedRow.verdict.why.startsWith('key refused (HTTP 401'),
    JSON.stringify({ provider: afterRefusal.provider, why: refusedRow?.verdict.why }),
  )
  await sleep(15)
  const again = await storeZaiApiKeyLogin('zai-proof-key-000001', 'general', undefined, { probeKey: async () => ({ state: 'accepted', models: 1 }) })
  resetComputedDefaultMemo()
  check(
    'a new sign-in of that family clears the refusal and the default returns to it',
    again.ok && readSignInRefusal('zai') === undefined && computedDefault().provider === 'zai',
    JSON.stringify({ ok: again.ok, refusal: readSignInRefusal('zai'), provider: computedDefault().provider }),
  )
}

section('§5 the sign-in owners — every credential-landing site records; the refresh path never does; every consumer reads the one owner')
{
  {
    const { settingsChecks } = await import('../../src/platform/health/sections/settings.ts')
    const { computedDefault: decide, describeComputedDefault: describe } = await import('../../src/models/catalogue/computedDefault.ts')
    const { providerDisplayName: nameOf } = await import('../../src/models/roads/routeLaw.ts')
    const frontier = await settingsChecks().find(row => row.id === 'frontier')?.run()
    check("/health's Default model row projects it", frontier?.evidence.includes(describe(decide(), nameOf)) === true && frontier.link === '/model', frontier?.evidence)
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nCOMPUTED DEFAULT: ALL PASS' : `\nCOMPUTED DEFAULT: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
