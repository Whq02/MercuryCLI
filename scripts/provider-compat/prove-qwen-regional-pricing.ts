;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const parent = process.env.MERCURY_CONFIG_DIR
assert.ok(parent)
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'qwen-regions-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['MERCURY_HOME', 'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL', 'DASHSCOPE_WORKSPACE_ID', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM']) delete process.env[key]
const oldKey = 'proof-key-qwen-old-not-a-real-key'
const freshKey = 'proof-key-qwen-new-not-a-real-key'
const keyPath = join(home, 'key.txt')
writeFileSync(keyPath, oldKey)
let rotate = false
const requests: Array<{ region: string; key: string | null; model: string }> = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
  const [region, path] = new URL(req.url).pathname.slice(1).split('/')
  if (path === 'models') return Response.json({ data: [{ id: 'qwen3.8-max' }, { id: 'qwen3.7-plus' }] })
  if (path === 'chat') {
    const body = await req.json() as { model: string }
    const key = req.headers.get('authorization')
    requests.push({ region: region!, key, model: body.model })
    if (rotate && key === `Bearer ${oldKey}`) {
      rotate = false
      writeFileSync(keyPath, freshKey)
      return Response.json({ error: { message: 'expired key' } }, { status: 401 })
    }
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: { content: 'served' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response('not found', { status: 404 })
} })
const seam = `http://127.0.0.1:${server.port}`
process.env.MERCURY_QWEN_API_BASE = seam
process.env.DASHSCOPE_WORKSPACE_ID = 'fixture'
process.env.DASHSCOPE_API_KEY = oldKey
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getModelCosts, resolveModelPricing, getModelPricingString, calculateUSDCost } = await import('../../src/utils/modelCost.ts')
const { refreshQwenCatalogue, __resetQwenCatalogueForTest } = await import('../../src/services/providers/qwen/qwenCatalogue.ts')
const { rememberQwenBoundBase, qwenBoundBase } = await import('../../src/services/providers/qwen/qwenAccounts.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  try { assert.deepEqual(actual, expected); console.log(`PASS ${label}`) }
  catch { failures++; console.error(`FAIL ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`) }
}
async function send(model = 'qwen3.8-max') {
  const rows: any[] = []
  for await (const row of routedCallModel({ messages: [createUserMessage({ content: 'Hello.' })], systemPrompt: asSystemPrompt(['Fixture.']), thinkingConfig: { type: 'enabled', budgetTokens: 10000 }, tools: [], signal: new AbortController().signal, options: { model, effortValue: 'max', querySource: 'user', isNonInteractiveSession: true, getToolPermissionContext: async () => ({ mode: 'default' }) } as never })) rows.push(row)
  return rows.some(row => row.type === 'assistant' && !row.isApiErrorMessage)
}
try {
  for (const region of ['singapore', 'beijing', 'workspace-frankfurt', 'hongkong', 'workspace-tokyo']) {
    process.env.DASHSCOPE_BASE_URL = `${seam}/${region}`
    await refreshQwenCatalogue({ force: true })
    const costs = getModelCosts('qwen3.8-max')
    check(`${region} standard rates`, [costs.inputTokens, costs.outputTokens], region === 'singapore' ? [2, 6] : [1.65, 4.951])
    check(`${region} standard display`, getModelPricingString('qwen3.8-max'), region === 'singapore' ? '$2/$6 per Mtok' : '$1.65/$4.95 per Mtok')
    check(`${region} sends without a pricing gate`, await send(), true)
    check(`${region} keeps endpoint and wire id`, [requests.at(-1)?.region, requests.at(-1)?.model], [region, 'qwen3.8-max'])
    await refreshQwenCatalogue({ force: true })
    check(`${region} refresh retains standard rate`, getModelCosts('qwen3.8-max').inputTokens, region === 'singapore' ? 2 : 1.65)
    if (region !== 'singapore') check(`${region} unknown cache rates keep total unpriced`, resolveModelPricing('qwen3.8-max').basis, 'unpriced')
  }
  for (const region of ['singapore', 'beijing', 'workspace-frankfurt']) {
    process.env.DASHSCOPE_BASE_URL = `${seam}/${region}`
    for (const tokens of [255999, 256000, 256001]) {
      const prices = getModelCosts('qwen3.7-plus', { promptTokens: tokens })
      const low = tokens <= 256000
      const expected = region === 'singapore' ? low ? [0.4, 1.6] : [1.2, 4.8] : low ? [0.276, 1.101] : [0.826, 3.301]
      check(`${region} plus tier at ${tokens}`, [prices.inputTokens, prices.outputTokens], expected)
    }
    for (const tokens of [31999, 32000, 32001, 255999, 256000, 256001]) {
      const prices = getModelCosts('qwen3.7-flash', { promptTokens: tokens })
      const index = tokens <= 32000 ? 0 : tokens <= 256000 ? 1 : 2
      check(`${region} flash tier at ${tokens}`, [prices.inputTokens, prices.outputTokens], (region === 'singapore' ? [[0.03, 0.13], [0.1, 0.4], [0.2, 0.8]] : [[0.028, 0.110], [0.083, 0.330], [0.165, 0.660]])[index])
    }
  }
  process.env.DASHSCOPE_BASE_URL = `${seam}/beijing`
  check('regional cached reads use documented implicit ratio', getModelCosts('qwen3.7-plus').promptCacheReadTokens, 0.276 * 0.2)
  check('independent regional input/output accounting', calculateUSDCost('qwen3.7-plus', { input_tokens: 1000, output_tokens: 2000 }), (1000 * 0.276 + 2000 * 1.101) / 1e6)
  for (const endpoint of ['qwencloud', 'qwencloud-token-plan', 'coding-intl', 'token-plan-cn', 'workspace-virginia', 'unknown']) {
    process.env.DASHSCOPE_BASE_URL = `${seam}/${endpoint}`
    check(`${endpoint} unestablished pricing`, resolveModelPricing('qwen3.8-max').basis, 'unpriced')
    check(`${endpoint} no guessed price row`, getModelPricingString('qwen3.8-max'), undefined)
  }
  process.env.DASHSCOPE_BASE_URL = 'https://fixture.eu-central-1.maas.aliyuncs.com/compatible-mode/v1'
  delete process.env.DASHSCOPE_WORKSPACE_ID
  check('saved workspace URL retains region without workspace env', getModelCosts('qwen3.8-max').inputTokens, 1.65)
  process.env.DASHSCOPE_WORKSPACE_ID = 'fixture'
  delete process.env.DASHSCOPE_BASE_URL
  delete process.env.DASHSCOPE_API_KEY
  const command = `"${process.execPath}" -e "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))" "${keyPath}"`
  assert.equal(updateSettingsForSource('userSettings', { credentials: { keyCommands: { qwen: command } } }).error, null)
  rememberQwenBoundBase(oldKey, `${seam}/beijing`)
  __resetQwenCatalogueForTest()
  await refreshQwenCatalogue({ force: true })
  rotate = true
  const before = requests.length
  check('key-command refresh request settles', await send('qwen3.7-plus'), true)
  check('refreshed key stays on Beijing endpoint', requests.slice(before).map(row => [row.region, row.key]), [['beijing', `Bearer ${oldKey}`], ['beijing', `Bearer ${freshKey}`]])
  check('fresh key remains bound for pricing and next turn', qwenBoundBase(), `${seam}/beijing`)
  check('fresh key retains region price', getModelCosts('qwen3.7-plus').inputTokens, 0.276)
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
