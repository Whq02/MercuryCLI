import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'openai-session-default-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { GPT_DISPLAY_PINS, gptDisplayPin } = await import('../../src/models/facts/pins/gptPins.js')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.js')
const { computedDefault, resetComputedDefaultMemo } = await import('../../src/models/catalogue/computedDefault.js')
const { openaiSessionDefault } = await import('../../src/models/catalogue/providerFrontier.js')
const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.js')
const { resolveModelPricing } = await import('../../src/models/usage/modelCost.js')
const { recordSignIn } = await import('../../src/models/sign-in/account-ledger/signInLedger.js')

const sol = 'gpt-6.2-sol'
const astra = 'gpt-6.2-astra'
const failures: string[] = []
let checks = 0
async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  checks++
  try { await run(); console.log(`PASS ${label}`) } catch (e) { failures.push(label); console.error(`FAIL ${label}: ${String(e)}`) }
}
async function startsOn(ids: string[]): Promise<{ setting: string; provider: string | null; source: string; why: string }> {
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: (async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
  resetComputedDefaultMemo()
  const decision = computedDefault()
  return { setting: decision.setting, provider: decision.provider, source: decision.source, why: decision.why }
}
const theSolOfTheNewestRelease: Array<[string, string[], string]> = [
  ['both 6.2 models, Astra first on the list', [astra, sol, 'gpt-6.1-sol'], sol],
  ['both 6.2 models, last on the list', ['gpt-6.1-sol', 'gpt-5.5', astra, sol], sol],
  ['neither 6.2 model, GPT-6.1 Sol first', ['gpt-6.1-sol', 'gpt-5.5'], 'gpt-6.1-sol'],
  ['neither 6.2 model, GPT-5.5 first', ['gpt-5.5', 'gpt-6.1-sol', 'gpt-6-astra'], 'gpt-6.1-sol'],
  ['neither 6.2 model, GPT-5.4 nano first', ['gpt-5.4-nano', 'gpt-5.5-pro', 'gpt-6.1-sol'], 'gpt-6.1-sol'],
  ['GPT-6 the newest release served, GPT-5.5 first', ['gpt-5.5', 'gpt-6-astra', 'gpt-6-sol'], 'gpt-6-sol'],
  ['GPT-5.6 the newest release served, GPT-5.4 first', ['gpt-5.4', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.5'], 'gpt-5.6-sol'],
]
const theReleaseWithoutItsSol: Array<[string, string[], string]> = [
  ['6.2 with Astra and not Sol', ['gpt-6.1-sol', astra, 'gpt-5.5'], astra],
  ['6.1 with Terra and not Sol, GPT-5.4 first', ['gpt-5.4', 'gpt-6.1-terra', 'gpt-6-sol'], 'gpt-6.1-terra'],
  ['5.6 with Luna and Terra, Luna first on the list', ['gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.6-terra'], 'gpt-5.6-terra'],
  ['5.5 alone, its Pro first on the list', ['gpt-5.4', 'gpt-5.5-pro', 'gpt-5.5'], 'gpt-5.5'],
]
const aSpecialRowIsPassedOver: Array<[string, string[], string]> = [
  ['a Cyber row is the newest release served', ['gpt-5.5', 'gpt-5.6-cyber'], 'gpt-5.5'],
  ['a Pro row is the newest release served', ['gpt-5.4', 'gpt-5.5-pro'], 'gpt-5.4'],
  ['the newest release is served by its Cyber row alone and GPT-5.4 is first on the list', ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-cyber'], 'gpt-5.5'],
  ['a release served by its Pro and its Mini, Pro first on the list and in the table', ['gpt-5.4-pro', 'gpt-5.4-mini'], 'gpt-5.4-mini'],
]
try {
  process.env.OPENAI_API_KEY = 'fixture-key-not-real'
  recordSignIn('openai', 'subscription')
  for (const [name, list, want] of theSolOfTheNewestRelease) await check(`a new session after an OpenAI sign-in starts on the Sol of the newest release the list serves: ${name} (${list.join(', ')}) starts on ${want}`, async () => {
    const got = await startsOn(list)
    assert.deepEqual([got.setting, got.provider, got.source], [want, 'openai', 'sign-in'])
  })
  for (const [name, list, want] of theReleaseWithoutItsSol) await check(`where the list serves that release and not its Sol, the release's first served row in the pin table's order: ${name} (${list.join(', ')}) starts on ${want}`, async () => {
    const got = await startsOn(list)
    assert.deepEqual([got.setting, got.provider, got.source], [want, 'openai', 'sign-in'])
  })
  await check("the list's first row only when the list serves no row the build knows: gpt-9.8-vega, gpt-9.9-nova starts on gpt-9.8-vega", async () => {
    const got = await startsOn(['gpt-9.8-vega', 'gpt-9.9-nova'])
    assert.deepEqual([got.setting, got.provider, got.source], ['gpt-9.8-vega', 'openai', 'sign-in'])
    assert.ok(got.why.endsWith("; the first row this sign-in can use (the catalogue's own order)"), got.why)
  })
  await check('a row the build does not know never outranks one it knows: gpt-9.9-nova, gpt-6.1-sol starts on gpt-6.1-sol', async () => {
    assert.equal((await startsOn(['gpt-9.9-nova', 'gpt-6.1-sol'])).setting, 'gpt-6.1-sol')
  })
  for (const [name, list, want] of aSpecialRowIsPassedOver) await check(`a row the table marks specialised or premium is never the default while the list serves a general one: ${name} (${list.join(', ')}) starts on ${want}`, async () => {
    const got = await startsOn(list)
    assert.deepEqual([got.setting, got.provider, got.source], [want, 'openai', 'sign-in'])
    assert.ok(got.why.endsWith(`; the newest row this sign-in can use (the recorded release, ${gptDisplayPin(want)!.observedAt})`), got.why)
  })
  await check("a list that serves special rows only starts on the list's own first row: gpt-5.5-pro, gpt-5.6-cyber starts on gpt-5.5-pro and gpt-5.6-cyber, gpt-5.4-pro on gpt-5.6-cyber", async () => {
    const first = await startsOn(['gpt-5.5-pro', 'gpt-5.6-cyber'])
    assert.deepEqual([first.setting, first.provider, first.source], ['gpt-5.5-pro', 'openai', 'sign-in'])
    assert.ok(first.why.endsWith("; the first row this sign-in can use (the catalogue's own order)"), first.why)
    assert.equal((await startsOn(['gpt-5.6-cyber', 'gpt-5.4-pro'])).setting, 'gpt-5.6-cyber')
  })
  await check('the mark is a fact on the row: the table marks its two Cyber rows specialised and its two Pro rows premium, and no other row', () => {
    assert.deepEqual(GPT_DISPLAY_PINS.filter(pin => pin.variantKind !== undefined).map(pin => [pin.id, pin.variantKind]), [['gpt-5.6-cyber', 'specialised'], ['gpt-5.5-pro', 'premium'], ['gpt-5.5-cyber-preview', 'specialised'], ['gpt-5.4-pro', 'premium']])
  })
  await check('the picker still offers every row: a Cyber and a Pro row are listed and selectable beside the default', async () => {
    assert.equal((await startsOn(['gpt-5.5', 'gpt-5.6-cyber', 'gpt-5.5-pro'])).setting, 'gpt-5.5')
    const rows = getModelOptions()
    for (const id of ['gpt-5.6-cyber', 'gpt-5.5-pro']) {
      const row = rows.find(option => option.value === id)
      assert.ok(row, id)
      assert.equal(row.unavailable, undefined, id)
    }
  })
  await check('a row carries the status its page states: GPT-5.4 nano ("Status: Deprecated" on its model page) and GPT-5.5 Cyber, under the id gpt-5.5-cyber-preview the deprecations page names, are marked deprecated, and no other row', () => {
    assert.deepEqual(GPT_DISPLAY_PINS.filter(pin => pin.status !== undefined).map(pin => [pin.id, pin.status, pin.statusSource ?? pin.source]), [['gpt-5.5-cyber-preview', 'deprecated', 'https://developers.openai.com/api/docs/deprecations'], ['gpt-5.4-nano', 'deprecated', 'https://developers.openai.com/api/docs/models/gpt-5.4-nano.md']])
    assert.equal(gptDisplayPin('gpt-5.5-cyber'), undefined)
  })
  await check("a deprecated row is passed over by the default as a special one is: a list of GPT-5.4 nano alone starts on it as the list's first row and the reason line says so", async () => {
    const alone = await startsOn(['gpt-5.4-nano'])
    assert.deepEqual([alone.setting, alone.provider, alone.source], ['gpt-5.4-nano', 'openai', 'sign-in'])
    assert.ok(alone.why.endsWith("; the first row this sign-in can use (the catalogue's own order)"), alone.why)
    assert.equal(alone.why.includes('recorded release'), false, alone.why)
  })
  await check("a list that serves a deprecated row and nothing the default may start on starts on the list's own first row, whichever row that is: gpt-9.9-nova, gpt-5.4-nano on gpt-9.9-nova; gpt-5.4-nano, gpt-9.9-nova and gpt-5.4-nano, gpt-5.5-pro on gpt-5.4-nano", async () => {
    assert.equal((await startsOn(['gpt-9.9-nova', 'gpt-5.4-nano'])).setting, 'gpt-9.9-nova')
    for (const list of [['gpt-5.4-nano', 'gpt-9.9-nova'], ['gpt-5.4-nano', 'gpt-5.5-pro']]) {
      const got = await startsOn(list)
      assert.equal(got.setting, 'gpt-5.4-nano', list.join(', '))
      assert.ok(got.why.endsWith("; the first row this sign-in can use (the catalogue's own order)"), got.why)
    }
  })
  await check('a list that serves a general row beside the deprecated one starts on the general row, and the picker still lists the deprecated row as selectable: gpt-5.4-nano, gpt-5.4-mini starts on gpt-5.4-mini', async () => {
    const got = await startsOn(['gpt-5.4-nano', 'gpt-5.4-mini'])
    assert.equal(got.setting, 'gpt-5.4-mini')
    const row = getModelOptions().find(option => option.value === 'gpt-5.4-nano')
    assert.ok(row, 'src/models/facts/modelOptions.ts getModelOptions missing deprecated gpt-5.4-nano row')
    assert.equal(row.unavailable, undefined)
  })
  await check('the reason line is true of the row it stands on: the recorded release and that row\'s own date, on Sol, on Astra and on GPT-5.5 alike, and the word frontier is on none', async () => {
    const dateOf = (id: string): string => gptDisplayPin(id)!.observedAt
    for (const [list, row] of [[[astra, sol], sol], [[astra, 'gpt-6.1-sol'], astra], [['gpt-5.4', 'gpt-5.5'], 'gpt-5.5']] as Array<[string[], string]>) {
      const got = await startsOn(list)
      assert.equal(got.setting, row)
      assert.ok(got.why.endsWith(`; the newest row this sign-in can use (the recorded release, ${dateOf(row)})`), got.why)
      assert.equal(got.why.includes('frontier'), false, got.why)
    }
    assert.equal(dateOf('gpt-5.5'), '2026-10-25')
  })
  await check('Astra is seated, listed and selectable beside the default', async () => {
    await startsOn([astra, sol])
    const rows = getModelOptions()
    for (const id of [astra, sol]) {
      const row = rows.find(option => option.value === id)
      assert.ok(row, id)
      assert.equal(row.unavailable, undefined, id)
    }
  })
  await check('the rule is one function over the served ids: the Sol of the newest release that serves a general row, else that release\'s first general row in table order, else nothing', () => {
    assert.equal(openaiSessionDefault([astra, sol])?.modelId, sol)
    assert.equal(openaiSessionDefault([astra])?.modelId, astra)
    assert.equal(openaiSessionDefault(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5'])?.modelId, 'gpt-5.6-terra')
    assert.equal(openaiSessionDefault(['gpt-5.5', 'gpt-6.1-sol', 'gpt-6-astra'])?.modelId, 'gpt-6.1-sol')
    assert.equal(openaiSessionDefault(['gpt-5.5', 'gpt-5.6-cyber'])?.modelId, 'gpt-5.5')
    assert.equal(openaiSessionDefault(['gpt-5.4', 'gpt-5.5-pro'])?.modelId, 'gpt-5.4')
    assert.equal(openaiSessionDefault(['gpt-5.5-pro', 'gpt-5.6-cyber']), undefined)
    assert.equal(openaiSessionDefault(['gpt-5.4-nano']), undefined)
    assert.equal(openaiSessionDefault(['gpt-5.4-nano', 'gpt-5.5-cyber-preview']), undefined)
    assert.equal(openaiSessionDefault(['gpt-5.4-nano', 'gpt-5.4-mini'])?.modelId, 'gpt-5.4-mini')
    assert.equal(openaiSessionDefault(['whisper-1', 'gpt-9.9-nova']), undefined)
    assert.equal(openaiSessionDefault([]), undefined)
    assert.deepEqual(GPT_DISPLAY_PINS.slice(0, 2).map(pin => pin.id), [sol, astra])
  })
  await check('the default costs what the default before it cost: $2 a million input tokens and $10 output, where Astra is $8 and $40', () => {
    const solCosts = resolveModelPricing(sol).costs
    const before = resolveModelPricing('gpt-6.1-sol').costs
    const astraCosts = resolveModelPricing(astra).costs
    assert.deepEqual([solCosts.inputTokens, solCosts.outputTokens], [2, 10])
    assert.deepEqual([before.inputTokens, before.outputTokens], [2, 10])
    assert.deepEqual([astraCosts.inputTokens, astraCosts.outputTokens], [8, 40])
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; the rule: the Sol of the newest release that serves a general row, then that release's first general row in the pin table's order, then the list's first row when it serves no general row the build knows`)
process.exit(failures.length ? 1 : 0)
