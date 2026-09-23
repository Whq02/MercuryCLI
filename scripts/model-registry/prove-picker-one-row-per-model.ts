#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-one-row-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_CONSOLE_MODEL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_AUTOPILOT_MODELS',
  'NODE_ENV',
]) {
  delete process.env[key]
}
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
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_ZAI_API_BASE',
]) {
  process.env[base] = dead
}
const FIXTURE_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_API_KEY = FIXTURE_KEY
;(await import('../../src/utils/config.js')).enableConfigs()

const {
  ANTHROPIC_MODEL_GROUP,
  focusedOptionSupports1m,
  getModelOptions,
  isProviderActionRow,
  stripContext1m,
  withContext1m,
} = await import('../../src/utils/model/modelOptions.ts')
type ModelOption = import('../../src/utils/model/modelOptions.ts').ModelOption
const { parseUserSpecifiedModel, renderModelName } = await import('../../src/utils/model/model.ts')
const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
const { getModelStrings } = await import('../../src/utils/model/modelStrings.ts')
const { getAgentModelPickerRows } = await import('../../src/utils/model/agentModelPicker.ts')
const { composeSubModelRegistry } = await import('../../src/utils/model/subModelSlots.ts')
const { clearOAuthTokenCache, isClaudeAISubscriber, isMaxSubscriber } = await import('../../src/utils/auth.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const modelRows = (options: ModelOption[]): ModelOption[] =>
  options.filter(o => !isProviderActionRow(o.value) && !o.value.startsWith('__'))
const anthropicRows = (options: ModelOption[]): ModelOption[] =>
  modelRows(options).filter(o => o.group === undefined || o.group === ANTHROPIC_MODEL_GROUP)
const resolvedIdOf = (value: string): string => stripContext1m(parseUserSpecifiedModel(stripContext1m(value)))
const strings = getModelStrings()
const SUFFIX_1M_GENERATIONS = ['opus48', 'opus47', 'opus46'] as const

function pinOneRowPerModel(tag: string, options: ModelOption[]): void {
  const rows = modelRows(options)
  const values = rows.map(o => o.value)
  check(`[${tag}] no row's label ends in "(1M context)"`, rows.every(o => !o.label.endsWith('(1M context)')), rows.filter(o => o.label.endsWith('(1M context)')).map(o => o.value).join(','))
  check(`[${tag}] no row id carries [1m], in any family's list`, rows.every(o => !/\[1m\]/i.test(o.value)), values.filter(v => /\[1m\]/i.test(v)).join(','))
  const ids = anthropicRows(options).map(o => resolvedIdOf(o.value))
  check(`[${tag}] the Anthropic group lists each model once`, ids.length > 0 && new Set(ids).size === ids.length, ids.join(','))
  const labels = anthropicRows(options).map(o => o.label)
  check(`[${tag}] no display name repeats in the Anthropic group`, labels.length > 0 && new Set(labels).size === labels.length, labels.join(' · '))
  for (const key of SUFFIX_1M_GENERATIONS) {
    const id = strings[key]
    check(`[${tag}] ${renderModelName(id)} is one row, on its bare id ${id}`, values.filter(v => v === id).length === 1 && !values.includes(`${id}[1m]`), values.join(','))
  }
  const agentRows = getAgentModelPickerRows(options)
  check(`[${tag}] the agent picker's projection carries no [1m] row either`, agentRows.length === options.length + 1 && agentRows.every(r => !/\[1m\]/i.test(r.value)), agentRows.filter(r => /\[1m\]/i.test(r.value)).map(r => r.value).join(','))
}

section('§1 the standard shape (an API key): one row per model, both credential faces')
for (const credentialed of [true, false]) {
  const tag = `anthropic ${credentialed ? 'in' : 'out'}`
  pinOneRowPerModel(tag, getModelOptions({ anthropicCredentialed: () => credentialed }))
}

section('§2 the window is the toggle: each previous generation with a suffix window offers both states on its one row')
for (const key of SUFFIX_1M_GENERATIONS) {
  const id = strings[key]
  check(`${renderModelName(id)}: the row offers the c toggle`, focusedOptionSupports1m(id))
  check(`${renderModelName(id)}: the two windows the toggle switches between resolve as 200k and 1M`, getContextWindowForModel(id) === 200_000 && getContextWindowForModel(withContext1m(id)) === 1_000_000, `${getContextWindowForModel(id)} / ${getContextWindowForModel(withContext1m(id))}`)
  check(`${renderModelName(id)}: the [1m] id still resolves as a value, with its rider`, parseUserSpecifiedModel(`${id}[1m]`) === `${id}[1m]` && renderModelName(`${id}[1m]`).endsWith('(1M context)'), parseUserSpecifiedModel(`${id}[1m]`))
}

section('§3 the premium shape (a Max subscription): the same one row per model')
{
  delete process.env.ANTHROPIC_API_KEY
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token-000000000001',
        refreshToken: 'fixture-refresh-token-00000000001',
        expiresAt: 4102444800000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }),
  )
  clearOAuthTokenCache()
  check('the staged credential reads as a Max subscription (the premium tier composes)', isClaudeAISubscriber() && isMaxSubscriber())
  pinOneRowPerModel('max subscription', getModelOptions({ anthropicCredentialed: () => true }))
  rmSync(join(home, '.credentials.json'), { force: true })
  clearOAuthTokenCache()
  process.env.ANTHROPIC_API_KEY = FIXTURE_KEY
}

section('§4 the sub-model picker derives from the same rows: one entry per model')
{
  const options = getModelOptions({ anthropicCredentialed: () => true })
  const presences = [{ id: 'anthropic', available: true, credentialed: true, credentialLabel: 'Anthropic API key' }] as never
  const registry = composeSubModelRegistry({ options: () => options, presences: () => presences })
  const anthropic = registry.entries.filter(e => e.kind === 'model' && e.source === 'anthropic').map(e => e.modelId)
  check('the Anthropic entries are one per model, none with a [1m] rider', anthropic.length > 0 && new Set(anthropic).size === anthropic.length && anthropic.every(id => !/\[1m\]/i.test(id)), anthropic.join(','))
  check('the entries match the picker rows model for model', new Set(anthropic).size === new Set(anthropicRows(options).map(o => resolvedIdOf(o.value))).size, `${anthropic.length} entries / ${anthropicRows(options).length} rows`)
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-picker-one-row-per-model: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
