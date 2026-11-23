#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = '', hint = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'default-provider-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_DEEPSEEK_API_BASE = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' default provider — the most recent sign-in; /defaultprovider is a ledger sign-in')
console.log('============================================================')

const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { configuredDefaultProvider, knownDefaultProviderFamilies, switchDefaultProvider } = await import(
  '../../src/models/facts/defaultProviderRung.ts'
)
const { SIGN_IN_LEDGER_FILE, readSignInLedger } = await import('../../src/models/sign-in/account-ledger/signInLedger.ts')
const { computedDefault, orderCredentials, resetComputedDefaultMemo } = await import(
  '../../src/models/catalogue/computedDefault.ts'
)
const { isGlobalConfigKey } = await import('../../src/platform/config/schema.ts')

const configFile = join(home, '.mercury.json')
const readStored = (): string | undefined => {
  try {
    return (JSON.parse(readFileSync(configFile, 'utf8')) as { defaultProvider?: string })
      .defaultProvider
  } catch {
    return undefined
  }
}
const ledgerFile = join(home, SIGN_IN_LEDGER_FILE)

section('§1 — the registered field')
{
  check("isGlobalConfigKey('defaultProvider')", isGlobalConfigKey('defaultProvider'), '', 'add defaultProvider to GLOBAL_CONFIG_KEYS in src/platform/config/schema.ts')
  check(
    'the recognised family list is the router vocabulary',
    knownDefaultProviderFamilies().includes('openrouter') &&
      knownDefaultProviderFamilies().includes('anthropic') &&
      knownDefaultProviderFamilies().includes('openai-compat'),
    '',
    'knownDefaultProviderFamilies in src/models/facts/defaultProviderRung.ts must list openrouter, anthropic and openai-compat',
  )
}

section('§2 — /defaultprovider is a sign-in of its own kind in the ledger')
{
  check('a fresh home has no legacy record and no ledger', configuredDefaultProvider() === undefined && !existsSync(ledgerFile), '', 'configuredDefaultProvider in src/models/facts/defaultProviderRung.ts must read no record in a fresh home, and nothing may create the sign-in ledger file')
  check('an unknown family is refused, nothing written', switchDefaultProvider('not-a-family') === false && !existsSync(ledgerFile), '', 'switchDefaultProvider in src/models/facts/defaultProviderRung.ts must refuse a family outside knownDefaultProviderFamilies before writing the ledger')
  check('the switch records an operator-switch sign-in', switchDefaultProvider('openrouter') === true && readSignInLedger().openrouter?.kind === 'operator-switch', '', 'switchDefaultProvider in src/models/facts/defaultProviderRung.ts must record an operator-switch sign-in through src/models/sign-in/account-ledger/signInLedger.ts')
  check('…and writes NOTHING to the config (no legacy writer remains)', readStored() === undefined && configuredDefaultProvider() === undefined, '', 'switchDefaultProvider in src/models/facts/defaultProviderRung.ts must not write defaultProvider into the config file')
  check('a second switch supersedes the first (the latest wins, no first-login law)', switchDefaultProvider('gemini') === true && readSignInLedger().gemini?.kind === 'operator-switch' && readSignInLedger().openrouter !== undefined, '', 'switchDefaultProvider in src/models/facts/defaultProviderRung.ts must append an operator-switch record and keep earlier ledger records')
}

section('§3 — set, never heal-repainted')
{
  saveGlobalConfig(config => ({ ...config, defaultProvider: 'acme-cloud' }) as never)
  const before = readFileSync(configFile, 'utf8')
  check("an unknown stored spelling reads as UNSET ('acme-cloud')", configuredDefaultProvider() === undefined, '', 'configuredDefaultProvider in src/models/facts/defaultProviderRung.ts must return undefined for a family outside knownDefaultProviderFamilies')
  resetComputedDefaultMemo()
  const decision = computedDefault()
  check('…and the resolver reads it as no tiebreak at all', !decision.considered.some(c => c.recency.startsWith('the recorded default provider')), '', 'computedDefault in src/models/catalogue/computedDefault.ts must not use an unrecognised stored provider as a tiebreak')
  const after = readFileSync(configFile, 'utf8')
  check('…while the stored bytes stay byte-identical (no heal-repaint)', before === after, '', 'reading the default provider (configuredDefaultProvider, computedDefault) must never rewrite the config file')
  check('…the raw value is still on disk', readStored() === 'acme-cloud', '', 'nothing may clear or rewrite the stored defaultProvider value on read')
}

section('§4 — the legacy record is the untimed tiebreak (pure)')
{
  const REG = ['anthropic', 'openai', 'zai', 'openrouter', 'gemini', 'moonshot', 'deepseek', 'openai-compat', 'huggingface', 'local']
  const led = orderCredentials({ credentials: [{ family: 'openrouter', at: null }, { family: 'deepseek', at: null }], recordedDefaultProvider: 'deepseek', registryOrder: REG })
  check('among untimed credentials the recorded provider leads (deepseek before openrouter, against the registry order)', led.map(c => c.family).join(',') === 'deepseek,openrouter', led.map(c => c.family).join(','), 'orderCredentials in src/models/catalogue/computedDefault.ts must put the recordedDefaultProvider first among untimed credentials')
  const unled = orderCredentials({ credentials: [{ family: 'openrouter', at: null }, { family: 'deepseek', at: null }], registryOrder: REG })
  check('without the record the registry order stands (openrouter before deepseek)', unled.map(c => c.family).join(',') === 'openrouter,deepseek', '', 'orderCredentials in src/models/catalogue/computedDefault.ts must keep registryOrder when no recordedDefaultProvider is given')
  const timed = orderCredentials({ credentials: [{ family: 'openrouter', at: 1_788_298_400_000 }, { family: 'deepseek', at: null }], recordedDefaultProvider: 'deepseek', registryOrder: REG })
  check('any timed sign-in outranks the recorded provider', timed.map(c => c.family).join(',') === 'openrouter,deepseek', '', 'orderCredentials in src/models/catalogue/computedDefault.ts must rank a credential with a sign-in time above the recordedDefaultProvider')
}

section('§5 — the live wiring (a legacy home: config deepseek + two env keys, no ledger)')
{
  const model = await import('../../src/models/catalogue/engineModel.ts')
  const { keyLanePins } = await import('../../src/models/catalogue/modelOptions.ts')
  const { providerDisplayName } = await import('../../src/models/roads/routeLaw.ts')
  rmSync(ledgerFile, { force: true })
  saveGlobalConfig(config => ({ ...config, defaultProvider: 'deepseek' }) as never)
  process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-key-123'
  process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key-123'
  resetComputedDefaultMemo()
  const deepseekPin = keyLanePins('deepseek')[0]?.id
  const withKey = model.getDefaultEngineModelSetting()
  check(
    'the legacy record leads the two untimed env keys: the default setting resolves the DeepSeek frontier pin',
    deepseekPin !== undefined && withKey === deepseekPin,
    `${withKey} vs ${String(deepseekPin)}`,
    'getDefaultEngineModelSetting in src/models/catalogue/engineModel.ts must follow computedDefault (src/models/catalogue/computedDefault.ts) to the recorded provider frontier pin',
  )
  const legacy = computedDefault()
  check('…named as the recorded default provider with no recorded time', legacy.provider === 'deepseek' && legacy.chosen?.timed === false && legacy.chosen.recency.startsWith('the recorded default provider, sign-in time not recorded'), legacy.chosen?.recency, 'computedDefault in src/models/catalogue/computedDefault.ts must describe the legacy record as the recorded default provider, sign-in time not recorded')
  const resolvedModel = model.getEngineModel()
  check('…and the main-loop resolution rides it (no explicit setting present)', resolvedModel === deepseekPin, resolvedModel, 'getEngineModel in src/models/catalogue/engineModel.ts must resolve through the computed default when no explicit setting is present')

  check('/defaultprovider openrouter records the operator switch', switchDefaultProvider('openrouter') === true, '', 'switchDefaultProvider in src/models/facts/defaultProviderRung.ts must accept openrouter and record the switch')
  const moved = computedDefault()
  check(
    'the switch is the most recent sign-in — OpenRouter is considered first; its live catalogue unreachable here, it offers no usable row and the default falls through to DeepSeek, named',
    moved.considered[0]?.family === 'openrouter' && moved.considered[0].verdict.usable === false && moved.provider === 'deepseek' && moved.source === 'fallthrough' && moved.why.includes(`Skipped: ${providerDisplayName('openrouter')}`),
    JSON.stringify({ first: moved.considered[0]?.family, provider: moved.provider, source: moved.source, why: moved.why }),
    'computedDefault in src/models/catalogue/computedDefault.ts must consider the newest sign-in first and, when it offers no usable row, fall through to the next provider and name the skipped one',
  )

  delete process.env.DEEPSEEK_API_KEY
  resetComputedDefaultMemo()
  const withoutKey = computedDefault()
  check(
    'the DeepSeek credential gone and OpenRouter unusable ⇒ no default stands (keyless, named), the config untouched',
    withoutKey.source === 'keyless' && withoutKey.provider === null && withoutKey.why.startsWith('no signed-in provider has a usable model') && configuredDefaultProvider() === 'deepseek',
    withoutKey.why,
    'computedDefault in src/models/catalogue/computedDefault.ts must report keyless with no provider when no signed-in provider has a usable model, and must not touch the stored config',
  )
  delete process.env.OPENROUTER_API_KEY
  resetComputedDefaultMemo()
  saveGlobalConfig(config => {
    const next = { ...config } as Record<string, unknown>
    delete next.defaultProvider
    return next as never
  })
  check('premise for the next proof: the config carries no record now', (getGlobalConfig() as { defaultProvider?: string }).defaultProvider === undefined, '', 'the saveGlobalConfig call above must remove defaultProvider from the config')
}

section('§6 — the command vocabulary')
{
  const { parseDefaultProviderWord } = await import(
    '../../src/commands/defaultprovider/defaultprovider.tsx'
  )
  const rows: Array<[string, string | undefined]> = [
    ['claude', 'anthropic'],
    ['gpt', 'openai'],
    ['openrouter', 'openrouter'],
    ['google', 'gemini'],
    ['hf', 'huggingface'],
    ['kimi', 'moonshot'],
    ['glm', 'zai'],
    ['deepseek', 'deepseek'],
    ['grok', 'xai'],
    ['x.ai', 'xai'],
    ['meta', 'meta'],
    ['muse', 'meta'],
    ['custom', 'openai-compat'],
    ['local', 'local'],
    ['acme', undefined],
  ]
  for (const [word, family] of rows) {
    check(`'${word}' → ${family ?? 'refused'}`, parseDefaultProviderWord(word) === family, `got ${String(parseDefaultProviderWord(word))}`, 'fix the word table of parseDefaultProviderWord in src/commands/defaultprovider/defaultprovider.tsx')
  }
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(
  failures === 0
    ? '\n✅ prove-default-provider — all checks pass'
    : '\n❌ prove-default-provider — check(s) failed',
)
process.exit(failures)
