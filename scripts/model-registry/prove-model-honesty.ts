#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

const scratch = mkdtempSync(join(tmpdir(), 'model-honesty-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_MINERVA_MODEL',
  'MERCURY_CONSOLE_MODEL',
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

const {
  ANTHROPIC_CONNECT_OPTION_VALUE,
  ANTHROPIC_MODEL_GROUP,
  OPENAI_MODEL_GROUP,
  anthropicNotSignedInReason,
  getModelOptions,
  isProviderActionRow,
  keyLaneGroupRows,
  keyConnectValue,
  GPT_CONNECT_OPTION_VALUE,
  isCatalogueDoorRow,
  resolvesToExistingOption,
} = await import('../../src/utils/model/modelOptions.ts')
const { composeSubModelRegistry } = await import('../../src/utils/model/subModelSlots.ts')
const { composeCoordinatorModelRegistry } = await import('../../src/services/concourse/coordinatorModels.ts')
const { composeWorkerModelRegistry } = await import('../../src/services/concourse/workerModels.ts')
const { anthropicCredentialPresence, providerFamilyPresences } = await import('../../src/services/providers/providerUsage.ts')
const { primeOpenaiDiscovery } = await import('../../src/utils/router/providerDiscovery.ts')
const { clearOAuthTokenCache } = await import('../../src/utils/auth.ts')
const { getMainLoopModel, getPublicModelDisplayName, parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
type ModelOption = import('../../src/utils/model/modelOptions.ts').ModelOption
type Presence = import('../../src/services/providers/providerUsage.ts').ProviderFamilyPresence

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(2, 66 - t.length))}`)
}

const OPENAI_FIXTURE_AUTH = JSON.stringify({
  version: 1,
  tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus' },
})
const ANTHROPIC_FIXTURE_CREDS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'fixture-access-token-000000000001',
    refreshToken: 'fixture-refresh-token-00000000001',
    expiresAt: 4102444800000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: null,
  },
})
const openaiFile = join(home, '.openai-auth.json')
function setOpenai(present: boolean): void {
  if (present) writeFileSync(openaiFile, OPENAI_FIXTURE_AUTH)
  else rmSync(openaiFile, { force: true })
  primeOpenaiDiscovery()
}

const anthropicRows = (options: ModelOption[]): ModelOption[] =>
  options.filter(o => o.group === undefined && !(isProviderActionRow(o.value)))
const gptModelRows = (options: ModelOption[]): ModelOption[] =>
  options.filter(o => o.group === OPENAI_MODEL_GROUP && !isProviderActionRow(o.value))
const gptActionRow = (options: ModelOption[]): ModelOption | undefined =>
  options.find(o => o.value === GPT_CONNECT_OPTION_VALUE)

console.log('============================================================')
console.log(' /model honesty — one credential truth, no family favoured')
console.log('============================================================')

section('§1 the Anthropic group carries the same law as every other family')
{
  const reason = anthropicNotSignedInReason()
  check("the reason is the attach-home owner's spelling", reason === 'not signed in — /logins anthropic', reason)
  const gated = getModelOptions({ anthropicCredentialed: () => false })
  check('absent ⇒ the sign-in action starts the Anthropic section', gated.find(o => o.group === undefined)?.value === ANTHROPIC_CONNECT_OPTION_VALUE)
  check('the sentinel is an ACTION (isProviderActionRow), never a model', isProviderActionRow(ANTHROPIC_CONNECT_OPTION_VALUE))
  const rows = anthropicRows(gated)
  check('absent ⇒ the whole Anthropic lineup visible-but-unavailable with the one reason', rows.length >= 3 && rows.every(o => o.unavailable === reason), JSON.stringify(rows.map(o => [o.value, o.unavailable])))
  check('absent ⇒ the Fable row is gated like every other row (no favoured row)', rows.find(o => typeof o.value === 'string' && /fable/i.test(o.value))?.unavailable === reason)
  const free = getModelOptions({ anthropicCredentialed: () => true })
  check('credentialed ⇒ no action row', !free.some(o => o.value === ANTHROPIC_CONNECT_OPTION_VALUE))
  check('credentialed ⇒ every Anthropic row selectable', anthropicRows(free).every(o => o.unavailable === undefined), JSON.stringify(anthropicRows(free).filter(o => o.unavailable).map(o => o.value)))
  check('the group never hides: the same Anthropic rows paint in both states', anthropicRows(free).length === rows.length, `${anthropicRows(free).length} vs ${rows.length}`)
}

section('§2 the four account states — the rows each family paints on /model')
{
  for (const anthropic of [false, true]) {
    for (const openai of [false, true]) {
      setOpenai(openai)
      const tag = `anthropic ${anthropic ? 'in' : 'out'} · openai ${openai ? 'in' : 'out'}`
      const options = getModelOptions({ anthropicCredentialed: () => anthropic })
      check(`[${tag}] every option names a model or an action, never a recommended default`, options.every(o => typeof o.value === 'string' && o.value !== 'default' && o.label !== 'Recommended'), JSON.stringify(options.filter(o => o.value === null || o.label === 'Recommended')))
      const groups = options.map(o => o.group ?? ANTHROPIC_MODEL_GROUP).filter((group, i, all) => i === 0 || group !== all[i - 1])
      const expectedGroups = [
        OPENAI_MODEL_GROUP, ANTHROPIC_MODEL_GROUP, 'Mercury — OpenRouter models',
        'Mercury — Gemini models', 'Mercury — Hugging Face models', 'Mercury — Z.AI models',
        'Mercury — Moonshot models', 'Mercury — DeepSeek models', 'Mercury — custom endpoint', 'Mercury — local models',
      ]
      check(`[${tag}] the first sections are OpenAI, Anthropic, OpenRouter`, JSON.stringify(groups.slice(0, 3)) === JSON.stringify(expectedGroups.slice(0, 3)), JSON.stringify(groups))
      check(`[${tag}] every provider section is contiguous and retains its order`, new Set(groups).size === groups.length && JSON.stringify(groups) === JSON.stringify(expectedGroups.filter(group => groups.includes(group))), JSON.stringify(groups))
      const anth = anthropicRows(options)
      check(
        `[${tag}] Anthropic rows ${anthropic ? 'selectable' : 'unavailable — not signed in — /logins anthropic'}`,
        anthropic
          ? anth.every(o => o.unavailable === undefined)
          : anth.every(o => o.unavailable === anthropicNotSignedInReason()),
        JSON.stringify(anth.map(o => [o.value, o.unavailable])),
      )
      check(`[${tag}] the Anthropic sign-in row ${anthropic ? 'absent' : 'present'}`, options.some(o => o.value === ANTHROPIC_CONNECT_OPTION_VALUE) === !anthropic)
      const gpt = gptModelRows(options)
      const action = gptActionRow(options)
      if (!openai) {
        check(`[${tag}] the GPT action row is the sign-in row`, action?.label === 'GPT — sign in', String(action?.label))
        check(`[${tag}] the sign-in row says the ruled sentence`, (action?.description ?? '').includes('connect OpenAI to browse its models'), String(action?.description))
        check(`[${tag}] signed-out ⇒ NO GPT model rows (the connect row is the whole face)`, gpt.length === 0, JSON.stringify(gpt.map(o => [o.value, o.unavailable])))
      } else {
        check(`[${tag}] the GPT action row is NOT the sign-in row (the account is present; the catalogue is pending on a dead base)`, action !== undefined && action.label !== 'GPT — sign in', String(action?.label))
        check(`[${tag}] no GPT row claims the signed-out sentence`, gpt.every(o => !(o.unavailable ?? '').includes('connect OpenAI to browse its models')))
      }
      check(`[${tag}] every key-lane family without a key stays gated (the law is symmetric)`, options.filter(o => o.unavailable === 'no API key attached').length > 0)
    }
  }
  setOpenai(false)
}

section('§3 the sub-model picker reads the catalogue’s own words onto its signed-out rows')
{
  const presencesOf = (anthropic: boolean, openai: boolean) => (): Presence[] =>
    [
      { id: 'anthropic', available: true, credentialed: anthropic, ...(anthropic ? { credentialLabel: 'Claude subscription (max)' } : {}) },
      { id: 'openai', available: openai, credentialed: openai, ...(openai ? { credentialLabel: 'ChatGPT plus subscription' } : {}) },
    ] as Presence[]
  for (const anthropic of [false, true]) {
    for (const openai of [false, true]) {
      setOpenai(openai)
      const tag = `anthropic ${anthropic ? 'in' : 'out'} · openai ${openai ? 'in' : 'out'}`
      const registry = composeSubModelRegistry({ presences: presencesOf(anthropic, openai) })
      const anth = registry.entries.filter(e => e.kind === 'model' && e.source === 'anthropic')
      check(`[${tag}] ≥1 Anthropic entry`, anth.length >= 1)
      check(
        `[${tag}] Anthropic entries ${anthropic ? 'selectable' : "signed-out with the /model row's own words"}`,
        anthropic
          ? anth.every(e => e.state === 'selectable')
          : anth.every(e => e.state === 'signed-out' && e.reason === anthropicNotSignedInReason() && e.connect?.command === '/logins anthropic'),
        JSON.stringify(anth.map(e => [e.modelId, e.state, e.reason])),
      )
      const gpt = registry.entries.filter(e => e.kind === 'model' && e.source === 'openai')
      if (!openai) {
        const connect = registry.entries.filter(e => e.kind === 'connect' && e.source === 'openai')
        check(`[${tag}] signed-out ⇒ NO GPT model entries`, gpt.length === 0, JSON.stringify(gpt.map(e => [e.modelId, e.state, e.reason])))
        check(
          `[${tag}] the ONE GPT connect entry says the ruled sentence and routes to /logins openai`,
          connect.length === 1 && connect.every(e => e.state === 'signed-out' && e.reason === 'connect OpenAI to browse its models' && e.connect?.command === '/logins openai'),
          JSON.stringify(connect.map(e => [e.modelId, e.state, e.reason])),
        )
      } else {
        check(`[${tag}] ≥1 GPT entry`, gpt.length >= 1)
        check(`[${tag}] GPT entries are not signed-out (the catalogue's own pending refusal rides instead)`, gpt.every(e => e.state !== 'signed-out'), JSON.stringify(gpt.map(e => [e.modelId, e.state, e.reason])))
      }
      const families = registry.families
      check(`[${tag}] the family header facts ride from the presences`, families.find(f => f.source === 'anthropic')?.credentialed === anthropic && families.find(f => f.source === 'openai')?.credentialed === openai)
    }
  }
  setOpenai(false)
}

section('§4 the coordinator picker agrees row by row (the presence read is threaded into the catalogue)')
{
  const presencesOf = (anthropic: boolean, openai: boolean) => (): Presence[] =>
    [
      { id: 'anthropic', available: true, credentialed: anthropic, ...(anthropic ? { credentialLabel: 'Claude subscription (max)' } : {}) },
      { id: 'openai', available: openai, credentialed: openai, ...(openai ? { credentialLabel: 'ChatGPT plus subscription' } : {}) },
    ] as Presence[]
  for (const anthropic of [false, true]) {
    const tag = `anthropic ${anthropic ? 'in' : 'out'}`
    const options = getModelOptions({ anthropicCredentialed: () => anthropic })
    const registry = await composeCoordinatorModelRegistry({ presences: presencesOf(anthropic, false) })
    const subs = composeSubModelRegistry({ presences: presencesOf(anthropic, false) })
    const anthropicIds = new Set(
      anthropicRows(options)
        .filter(o => typeof o.value === 'string')
        .map(o => parseUserSpecifiedModel(String(o.value)).replace(/\[1m]$/, '')),
    )
    check(`[${tag}] the three surfaces list the same Anthropic ids`, [...anthropicIds].every(id => registry.entries.some(e => e.modelId === id && e.source === 'anthropic') && subs.entries.some(e => e.modelId === id && e.source === 'anthropic')), [...anthropicIds].join(','))
    check(
      `[${tag}] Claude Fable 5.1 rides /model, the sub-model picker and the coordinator picker as 'Fable 5.1', no description`,
      anthropicIds.has('claude-fable-5-1') &&
        anthropicIds.has(parseUserSpecifiedModel('fable').replace(/\[1m]$/, '')) &&
        registry.entries.find(e => e.modelId === 'claude-fable-5-1')?.displayName === 'Fable 5.1' &&
        registry.entries.find(e => e.modelId === 'claude-fable-5-1')?.description === undefined &&
        subs.entries.find(e => e.modelId === 'claude-fable-5-1')?.displayName === 'Fable 5.1' &&
        subs.entries.find(e => e.modelId === 'claude-fable-5-1')?.description === undefined,
      JSON.stringify([registry.entries.find(e => e.modelId === 'claude-fable-5-1'), subs.entries.find(e => e.modelId === 'claude-fable-5-1')]),
    )
    for (const id of anthropicIds) {
      const coordinator = registry.entries.find(e => e.modelId === id)!
      const sub = subs.entries.find(e => e.modelId === id)!
      const row = anthropicRows(options).find(o => typeof o.value === 'string' && parseUserSpecifiedModel(String(o.value)).replace(/\[1m]$/, '') === id)!
      const agree = anthropic
        ? coordinator.availability === 'ready' && sub.state === 'selectable' && row.unavailable === undefined
        : coordinator.availability === 'not-signed-in' && coordinator.detail === '/logins anthropic' && sub.state === 'signed-out' && row.unavailable === anthropicNotSignedInReason()
      check(`[${tag}] ${id}: /model · sub-model · coordinator agree`, agree, JSON.stringify([row.unavailable, sub.state, coordinator.availability, coordinator.detail]))
    }
  }
}

section('§5 the REAL owner, no injection — the scrubbed home gates; a credential frees')
{
  check('the scrubbed home holds no Anthropic credential (the owner)', anthropicCredentialPresence().credentialed === false)
  const gated = getModelOptions()
  check('without a credential, every Anthropic model is unavailable and sign-in is offered first', anthropicRows(gated).every(o => o.unavailable === anthropicNotSignedInReason()) && gated.find(o => o.group === undefined)?.value === ANTHROPIC_CONNECT_OPTION_VALUE)
  const registry = await composeCoordinatorModelRegistry()
  check("the coordinator picker reads the same home 'not-signed-in — /logins anthropic'", registry.entries.filter(e => e.source === 'anthropic').every(e => e.availability === 'not-signed-in' && e.detail === '/logins anthropic'))
  const subs = composeSubModelRegistry()
  check('the sub-model picker reads the same home signed-out with the same words', subs.entries.filter(e => e.kind === 'model' && e.source === 'anthropic').every(e => e.state === 'signed-out' && e.reason === anthropicNotSignedInReason()))

  writeFileSync(join(home, '.credentials.json'), ANTHROPIC_FIXTURE_CREDS)
  clearOAuthTokenCache()
  check('a file-backed subscription credential reads present through the owner', anthropicCredentialPresence().credentialed === true && anthropicCredentialPresence().credentialLabel === 'Claude subscription (max)', JSON.stringify(anthropicCredentialPresence()))
  const free = getModelOptions()
  check('premium accounts also list only models and actions', free.every(o => typeof o.value === 'string' && o.value !== 'default' && o.label !== 'Recommended'))
  check('…and the very next read frees every Anthropic row, the action row gone', anthropicRows(free).every(o => o.unavailable === undefined) && !free.some(o => o.value === ANTHROPIC_CONNECT_OPTION_VALUE), JSON.stringify(anthropicRows(free).filter(o => o.unavailable).map(o => o.value)))
  const freed = await composeCoordinatorModelRegistry()
  check("…the coordinator picker reads 'ready' on the same read", freed.entries.filter(e => e.source === 'anthropic').every(e => e.availability === 'ready'), JSON.stringify(freed.entries.filter(e => e.source === 'anthropic').map(e => [e.modelId, e.availability])))
  check('the presence enumeration and the single-family owner are one derivation', providerFamilyPresences().find(p => (p.id as string) === 'anthropic')?.credentialLabel === anthropicCredentialPresence().credentialLabel)
  const workers = await composeWorkerModelRegistry()
  const fable51Seat = workers.entries.find(e => e.modelId === 'claude-fable-5-1')
  check(
    "the worker seat registry carries Claude Fable 5.1 as 'Fable 5.1', available on both arms, beside the family default",
    fable51Seat?.displayName === 'Fable 5.1' &&
      fable51Seat?.session.availability === 'available' &&
      fable51Seat?.crew.availability === 'available' &&
      workers.entries.some(e => e.modelId === 'claude-fable-5'),
    JSON.stringify(workers.entries.map(e => [e.modelId, e.displayName, e.session.availability, e.crew.availability])),
  )
  rmSync(join(home, '.credentials.json'), { force: true })
  clearOAuthTokenCache()
}

section('§6 the wiring (structural)')
{
  const root = join(import.meta.dir, '..', '..')
  const builder = readFileSync(join(root, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check('/model routes the Anthropic action row to /logins anthropic --return=/model', builder.includes('id === ANTHROPIC_CONNECT_OPTION_VALUE') && builder.includes("'/logins anthropic --return=/model'"))
  check('the /model group detail reads the presence owner, labelled as presence', builder.includes('anthropicCredentialPresence()') && builder.includes('· credential present') && !builder.includes("isClaudeAISubscriber()\n        ? `Claude subscription"))
  const inline = readFileSync(join(root, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the inline picker routes the sentinel to /logins anthropic', inline.includes("value === ANTHROPIC_CONNECT_OPTION_VALUE") && inline.includes("requestCommandDispatch('/logins anthropic')"))
  const options = readFileSync(join(root, 'src/utils/model/modelOptions.ts'), 'utf8')
  check('the catalogue gate reads the ONE owner (anthropicCredentialPresence)', options.includes('anthropicCredentialPresence().credentialed'))
  const coordinator = readFileSync(join(root, 'src/services/concourse/coordinatorModels.ts'), 'utf8')
  const submodels = readFileSync(join(root, 'src/utils/model/subModelSlots.ts'), 'utf8')
  check('both composers thread their presences into the catalogue', coordinator.includes("getModelOptions({ anthropicCredentialed: () => credentialed('anthropic') })") && submodels.includes("getModelOptions({ anthropicCredentialed: () => credentialed('anthropic') })"))
}

section('§7 the neutral catalog grammar — one description rule, vendor-blind, by predicate')
{
  const violations = (options: ModelOption[]): string[] => {
    const out: string[] = []
    for (const o of options) {
      if (isProviderActionRow(o.value)) continue
      if (o.description !== '') out.push(`${o.value}:${o.description}`)
    }
    return out
  }
  for (const anthropic of [false, true]) {
    for (const openai of [false, true]) {
      setOpenai(openai)
      const tag = `anthropic ${anthropic ? 'in' : 'out'} · openai ${openai ? 'in' : 'out'}`
      const bad = violations(getModelOptions({ anthropicCredentialed: () => anthropic }))
      check(`[${tag}] every model row speaks the one neutral grammar`, bad.length === 0, bad.join(' | '))
    }
  }
  setOpenai(false)
  const pins = [{ id: 'pin-1', displayName: 'Pin 1', observedAt: '2026-08-30', contextWindow: 1_000_000 }]
  for (const keyPresent of [true, false]) {
    const rows = keyLaneGroupRows({
      group: 'Mercury — fixture models',
      providerName: 'Fixture',
      connectValue: keyConnectValue('zai'),
      connectHint: 'hint',
      keyPresent,
      pins,
    })
    const bad = violations(rows)
    check(`key lane (${keyPresent ? 'credentialed' : 'absent'}): model rows empty; the window rides the typed field`, bad.length === 0 && rows.filter(r => !(typeof r.value === 'string' && isProviderActionRow(r.value))).every(r => r.statedContextWindow === 1_000_000), bad.join(' | '))
  }
}

section('§8 inline focus follows the actual model, including aliases')
{
  const path = join(import.meta.dir, '../../src/components/ModelPicker.tsx')
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'ModelPicker')
  const statements = ['options', 'focusDefault'].map(name => {
    const statement = component?.body?.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name))
    if (!statement) throw new Error(`Inline picker declaration missing: ${name}`)
    return statement.getText(source)
  }).join('\n')
  const evaluate = new Function('initial', 'getModelOptions', 'useMemo', 'isCatalogueDoorRow', 'resolvesToExistingOption', 'getPublicModelDisplayName', ts.transpileModule(`${statements}\nreturn { options, focusDefault }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
  const focus = (initial: string, options: ModelOption[]) => evaluate(initial, () => options, (read: () => unknown) => read(), isCatalogueDoorRow, resolvesToExistingOption, getPublicModelDisplayName) as { options: ModelOption[]; focusDefault: string }
  const credentials = JSON.parse(ANTHROPIC_FIXTURE_CREDS)
  credentials.claudeAiOauth.rateLimitTier = 'default_claude_max_20x'
  writeFileSync(join(home, '.credentials.json'), JSON.stringify(credentials))
  clearOAuthTokenCache()
  const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
  resetComputedDefaultMemo()
  const initial = getMainLoopModel()
  check('the unpicked fixture resolves to the Fable model', initial === parseUserSpecifiedModel('fable'), initial)
  const selected = focus(initial, getModelOptions())
  check('an unpicked model represented by an alias focuses that row, not sign-in', selected.focusDefault === 'fable' && selected.options.filter(option => resolvesToExistingOption([option], initial)).length === 1, JSON.stringify({ initial, focus: selected.focusDefault }))
  const rows: ModelOption[] = [
    { value: GPT_CONNECT_OPTION_VALUE, label: 'GPT — sign in', description: '' },
    { value: 'fable', label: 'Fable', description: '' },
    { value: 'fable[1m]', label: 'Fable 1M', description: '' },
    { value: 'gpt-6-astra', label: 'GPT-6 Astra', description: '' },
  ]
  check('a literal-valued model keeps exact focus', focus('gpt-6-astra', rows).focusDefault === 'gpt-6-astra')
  check('an exact alias stays selected', focus('fable', rows).focusDefault === 'fable')
  check('an extended-context resolved id selects the matching alias variant', focus(`${parseUserSpecifiedModel('fable')}[1m]`, rows).focusDefault === 'fable[1m]')
  const explicit = { value: initial, label: 'Explicit model', description: '' }
  check('an explicit row outranks another spelling of the same model', focus(initial, [...rows, explicit]).focusDefault === initial)
  const custom = focus('custom-example-model', rows)
  check('an off-catalogue model is appended and focused', custom.focusDefault === 'custom-example-model' && custom.options.length === rows.length + 1)
  check('a matching action is not treated as a model alias', focus(GPT_CONNECT_OPTION_VALUE, rows).focusDefault === GPT_CONNECT_OPTION_VALUE)
  rmSync(join(home, '.credentials.json'), { force: true })
  clearOAuthTokenCache()
  resetComputedDefaultMemo()
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('MODEL HONESTY: ALL GREEN')
else console.log(`❌ ${failures} MODEL-HONESTY LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
