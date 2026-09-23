#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-live-rows-'))
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
  'MERCURY_DEFAULT_HAIKU_MODEL',
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
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

const { ANTHROPIC_MODEL_GROUP, ANTHROPIC_CONNECT_OPTION_VALUE, getModelOptions, isProviderActionRow } = await import('../../src/utils/model/modelOptions.ts')
type ModelOption = import('../../src/utils/model/modelOptions.ts').ModelOption
type LiveRow = import('../../src/services/providers/anthropic/anthropicCatalogue.ts').AnthropicLiveRow
const { CANONICAL_MODEL_IDS } = await import('../../src/utils/model/configs.ts')
const { parseUserSpecifiedModel, renderModelName } = await import('../../src/utils/model/model.ts')
const { composeSubModelRegistry } = await import('../../src/utils/model/subModelSlots.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const DOOR = 'Anthropic API key'
const live = (ids: Array<string | { id: string; displayName?: string; doors?: string[] }>): LiveRow[] =>
  ids.map(entry => (typeof entry === 'string' ? { id: entry, doors: [DOOR] } : { id: entry.id, doors: entry.doors ?? [DOOR], ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}) }))
const anthropicRows = (options: ModelOption[]): ModelOption[] =>
  options.filter(o => (o.group === undefined || o.group === ANTHROPIC_MODEL_GROUP) && !isProviderActionRow(o.value) && !o.value.startsWith('__'))
const values = (options: ModelOption[]): string[] => anthropicRows(options).map(o => o.value)
const compose = (rows: LiveRow[], credentialed = true): ModelOption[] =>
  getModelOptions({ anthropicCredentialed: () => credentialed, anthropicLiveRows: () => rows })
const show = (options: ModelOption[]): string => JSON.stringify(anthropicRows(options).map(o => [o.value, o.label, o.unavailable ?? null]))

section('§1 the static list stands: an empty union, and a union of exactly the table\'s ids, compose byte-identically')
const baseline = compose([])
const baselineJson = JSON.stringify(baseline)
check('the empty union composes the static rows (a non-empty Anthropic section)', values(baseline).length >= 9, show(baseline))
check('a union equal to the table\'s own ids changes nothing (byte-identical options)', JSON.stringify(compose(live([...CANONICAL_MODEL_IDS]))) === baselineJson, show(compose(live([...CANONICAL_MODEL_IDS]))))
check('a live id the table knows changes nothing: a dated snapshot of a declared generation, the mirror id, a retired dated row', JSON.stringify(compose(live(['claude-opus-5-20260401', 'claude-mythos-5', 'claude-opus-4-1-20250805', 'claude-sonnet-5', 'Claude-Opus-5-5']))) === baselineJson, show(compose(live(['claude-opus-5-20260401', 'claude-mythos-5']))))
check('the injected reads bundle with no live read composes the same rows as the empty union', JSON.stringify(getModelOptions({ anthropicCredentialed: () => true })) === baselineJson)
check('the section ends Sonnet 5 · Opus 5.5 as before', values(baseline).slice(-2).join(',') === 'claude-sonnet-5,claude-opus-5-5', values(baseline).join(','))

section('§2 an undeclared generation lands as ONE raw row at the end of its family\'s block, selectable, under its raw id')
{
  const options = compose(live([{ id: 'claude-opus-5-7', displayName: 'Claude Opus 5.7' }]))
  const rows = anthropicRows(options)
  const raw = rows.filter(o => o.value === 'claude-opus-5-7')
  check('one raw row', raw.length === 1, show(options))
  check('value and label are the raw id; no description; selectable', raw[0]?.value === 'claude-opus-5-7' && raw[0].label === 'claude-opus-5-7' && raw[0].description === '' && raw[0].unavailable === undefined && raw[0].group === undefined, JSON.stringify(raw[0]))
  check('it sits at the end of the opus block: right after Opus 5.5, last in the section', values(options).at(-1) === 'claude-opus-5-7' && values(options).at(-2) === 'claude-opus-5-5', values(options).join(','))
  check('every static row keeps its place and words', JSON.stringify(rows.filter(o => o.value !== 'claude-opus-5-7')) === JSON.stringify(anthropicRows(baseline)))
  check('the model-facing description names the door, the vendor name and the family whose defaults serve it', raw[0]?.descriptionForModel === 'claude-opus-5-7 — listed live by the Anthropic API key (the vendor names it "Claude Opus 5.7"); not in the built-in table, so it is served under its raw id with the opus family\'s defaults.', raw[0]?.descriptionForModel)
  check('the display owner renders the raw id (no invented name)', renderModelName('claude-opus-5-7') === 'claude-opus-5-7' && parseUserSpecifiedModel('claude-opus-5-7') === 'claude-opus-5-7')
  const twoDoors = compose(live([{ id: 'claude-opus-5-7', doors: ['Claude subscription', 'Anthropic API key'] }]))
  check('a row two doors list names both', anthropicRows(twoDoors).find(o => o.value === 'claude-opus-5-7')?.descriptionForModel?.includes('listed live by the Claude subscription and Anthropic API key') === true)
}

section('§3 every family block, the mirror word and an unknown family')
{
  const options = compose(live(['claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5', 'claude-opus-6', 'claude-mythos-5-2', 'claude-zephyr-1', 'claude-opus-5-7']))
  const v = values(options)
  const at = (id: string): number => v.indexOf(id)
  check('seven raw rows, one each', ['claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5', 'claude-opus-6', 'claude-mythos-5-2', 'claude-zephyr-1', 'claude-opus-5-7'].every(id => v.filter(x => x === id).length === 1), v.join(','))
  check('the sonnet row follows Sonnet 5, before Opus 5.5', at('claude-sonnet-5-5') === at('claude-sonnet-5') + 1 && at('claude-sonnet-5-5') < at('claude-opus-5-5'), v.join(','))
  check('the fable rows follow Fable 5 in list order (the mirror word lands in the fable block)', at('claude-fable-5-2') === at('claude-fable-5') + 1 && at('claude-mythos-5-2') === at('claude-fable-5-2') + 1, v.join(','))
  check('the haiku row follows the haiku row', at('claude-haiku-5') === at('haiku') + 1, v.join(','))
  check('the opus rows follow Opus 5.5 in list order', at('claude-opus-6') === at('claude-opus-5-5') + 1 && at('claude-opus-5-7') === at('claude-opus-6') + 1, v.join(','))
  check('an id of a family the table does not declare lands at the end of the section', v.at(-1) === 'claude-zephyr-1', v.join(','))
  check('the unknown family\'s description says no family declares it', anthropicRows(options).find(o => o.value === 'claude-zephyr-1')?.descriptionForModel === 'claude-zephyr-1 — listed live by the Anthropic API key; not in the built-in table, so it is served under its raw id; no built-in family declares it, so the generic first-party defaults apply.', anthropicRows(options).find(o => o.value === 'claude-zephyr-1')?.descriptionForModel)
  check('the other groups are untouched', JSON.stringify(options.filter(o => o.group !== undefined)) === JSON.stringify(baseline.filter(o => o.group !== undefined)))
}

section('§4 one model, one row: a live id that repeats, differs in case, or names an alias-resolved model never doubles')
{
  const options = compose(live(['claude-opus-5-7', 'Claude-Opus-5-7', 'claude-opus-5-7', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']))
  const resolved = anthropicRows(options).map(o => parseUserSpecifiedModel(o.value).toLowerCase())
  check('each model once', new Set(resolved).size === resolved.length && resolved.filter(id => id === 'claude-opus-5-7').length === 1, resolved.join(','))
  check('no display name repeats', new Set(anthropicRows(options).map(o => o.label)).size === anthropicRows(options).length)
  const foreign = compose(live(['gpt-4o', 'anthropic/claude-opus-5-7', 'llama-3']))
  check('an id outside the first-party id space never joins the Anthropic section (a proxy base listing other vendors)', JSON.stringify(foreign) === baselineJson, show(foreign))
}

section('§5 the not-signed-in projection marks the raw rows unavailable exactly like the static ones')
{
  const options = compose(live(['claude-opus-5-7']), false)
  const rows = anthropicRows(options)
  const reason = rows.find(o => o.value === 'claude-opus-5-5')?.unavailable
  check('the sign-in action row leads the Anthropic section', options.find(o => o.group === undefined)?.value === ANTHROPIC_CONNECT_OPTION_VALUE, options.filter(o => o.group === undefined).map(o => o.value).slice(0, 3).join(','))
  check('the raw row carries the same not-signed-in reason as the static rows', reason !== undefined && rows.every(o => o.unavailable === reason), show(options))
}

section('§6 the sub-model registry lists the raw row as an Anthropic model')
{
  const options = compose(live(['claude-opus-5-7']))
  const presences = [{ id: 'anthropic', available: true, credentialed: true, credentialLabel: DOOR }] as never
  const registry = composeSubModelRegistry({ options: () => options, presences: () => presences })
  const ids = registry.entries.filter(e => e.kind === 'model' && e.source === 'anthropic').map(e => e.modelId)
  check('the raw id is an entry once', ids.filter(id => id === 'claude-opus-5-7').length === 1, ids.join(','))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-picker-live-rows: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
