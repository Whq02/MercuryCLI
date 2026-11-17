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

const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { computedDefault, resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.js')
const { providerFrontierFact, openaiFrontierRelease } = await import('../../src/utils/model/providerFrontier.js')
const { getModelOptions } = await import('../../src/utils/model/modelOptions.js')
const { resolveModelPricing } = await import('../../src/utils/modelCost.js')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.js')

const sol = 'gpt-6.2-sol'
const astra = 'gpt-6.2-astra'
const failures: string[] = []
let checks = 0
async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  checks++
  try { await run(); console.log(`PASS ${label}`) } catch (e) { failures.push(label); console.error(`FAIL ${label}: ${String(e)}`) }
}
async function startsOn(ids: string[]): Promise<{ setting: string; provider: string | null; source: string }> {
  catalogue.__resetOpenaiCatalogueForTest()
  const rows = ids.map((id, index) => ({ id, priority: index + 1 }))
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: (async () => new Response(JSON.stringify({ data: rows }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
  resetComputedDefaultMemo()
  const decision = computedDefault()
  return { setting: decision.setting, provider: decision.provider, source: decision.source }
}
try {
  process.env.OPENAI_API_KEY = 'fixture-key-not-real'
  recordSignIn('openai', 'subscription')
  await check('after an OpenAI sign-in a new session starts on GPT-6.2 Sol when the list serves it, wherever the list ranks it', async () => {
    assert.deepEqual(await startsOn([astra, sol, 'gpt-6.1-sol']), { setting: sol, provider: 'openai', source: 'sign-in' })
    assert.deepEqual(await startsOn(['gpt-6.1-sol', 'gpt-5.5', astra, sol]), { setting: sol, provider: 'openai', source: 'sign-in' })
  })
  await check('a list that serves Astra and not Sol starts on Astra, wherever the list ranks it', async () => {
    assert.deepEqual(await startsOn([astra, 'gpt-6.1-sol']), { setting: astra, provider: 'openai', source: 'sign-in' })
    assert.deepEqual(await startsOn(['gpt-6.1-sol', astra, 'gpt-5.5']), { setting: astra, provider: 'openai', source: 'sign-in' })
  })
  await check('a list that serves neither 6.2 model starts on its own first row', async () => {
    assert.deepEqual(await startsOn(['gpt-6.1-sol', 'gpt-5.5']), { setting: 'gpt-6.1-sol', provider: 'openai', source: 'sign-in' })
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
  await check('the rule sits in one place: the default is the first row of the newest release in GPT_DISPLAY_PINS that the list serves, so moving the Astra row above the Sol row turns it', () => {
    assert.deepEqual(GPT_DISPLAY_PINS.slice(0, 2).map(pin => pin.id), [sol, astra])
    assert.equal(providerFrontierFact('openai')?.modelId, sol)
    assert.deepEqual(openaiFrontierRelease(), [sol, astra])
  })
  await check("the default costs what the default before it cost: $2 a million input tokens and $10 output, where Astra is $8 and $40", () => {
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
console.log(`${checks - failures.length}/${checks} passed; the rule: after an OpenAI sign-in a new session starts on GPT-6.2 Sol when the list serves it, and a list that serves Astra and not Sol starts on Astra`)
process.exit(failures.length ? 1 : 0)
