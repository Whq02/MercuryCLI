import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'image-estimate-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_LOCAL_BASE_URL
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { estimateContextTokens } = await import('../../src/services/compact/microCompact.ts')
const { estimateRequestTokens } = await import('../../src/services/providers/streamIdleBudget.ts')
const { localPreComposeEstimate, localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { contextFill } = await import('../../src/utils/tokens.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
type Message = import('../../src/types/message.ts').Message
const messages: Message[] = []
for (let i = 0; i < 9; i++) {
  messages.push(createAssistantMessage({ content: [{ type: 'tool_use', id: `shot-${i}`, name: 'Browser', input: { op: 'screenshot' } }] }))
  messages.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `shot-${i}`, content: [{ type: 'text', text: `screenshot: /captures/${i}.png (https://example.test, 1280x800)` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(170_000) } }] }] }))
}
try {
  for (const vision of [false, true]) {
    const model = `local/fixture-${vision}`
    process.env.MERCURY_MODEL = model
    await refreshLocalDiscovery({ force: true, env: { MERCURY_LOCAL_PROBE_TARGETS: 'llamacpp=http://127.0.0.1:1' }, fetchImpl: (async (url: string) => Response.json(url.endsWith('/props') ? { modalities: { vision }, default_generation_settings: { n_ctx: 262144 } } : url.endsWith('/v1/models') ? { data: [{ id: `fixture-${vision}`, meta: {} }] } : {})) as typeof fetch })
    const wire = { model, messages: mapMessagesToZai('', messages.map(row => (row as { message: unknown }).message) as never, { imagesSupported: vision }) }
    const meter = (estimateContextTokens as (rows: Message[], model: string) => number)(messages, model)
    const guard = (estimateRequestTokens as (body: unknown, model: string) => number)(wire, model)
    const precompose = localPreComposeEstimate({ messages, systemPrompt: asSystemPrompt([]), tools: [], model } as never)
    const screen = contextFill(messages, model)
    console.log(JSON.stringify({ vision, meter, guard, precompose, screen: screen.tokens }))
    assert.equal(meter, guard, 'meter and composed guard count the same content')
    assert.equal(precompose, guard, 'precompose does not count stored image bytes or transcript metadata')
    assert.equal(screen.tokens, guard, 'screen estimate follows the selected model')
    assert.ok(guard < (vision ? 19000 : 1000), 'base64 is never text tokens')
    const profile = localLaneProfileFor(localRecordFor(model)!)
    assert.equal(profile.requestFitRefusal?.({ estTokens: guard, requestBytes: JSON.stringify(wire).length, toolCount: 0, wireModel: model }), undefined)
    const schemas = Array.from({ length: 13 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: 'fixture tool '.repeat(30), parameters: { type: 'object', properties: { path: { type: 'string' } } } } }))
    const { requestGaugeFixed, estimateRequestGauge } = await import('../../src/services/run/requestGauge.ts')
    const fixed = requestGaugeFixed(schemas)
    const fullMeter = estimateRequestGauge(messages, fixed, { ratio: 1, samples: 0, residuals: [] }, model)
    const fullGuard = (estimateRequestTokens as (body: unknown, model: string) => number)({ ...wire, tools: schemas }, model)
    assert.ok(Math.abs(fullMeter - fullGuard) <= fullGuard * 0.03, '13 tool schemas use the existing rough-rate tolerance')
    assert.ok(fullGuard > guard, 'tool schemas are counted')
    if (vision) {
      const stripped = wire.messages.map(row => 'content' in row && Array.isArray(row.content) ? { ...row, content: row.content.filter(part => part.type !== 'image_url') } : row)
      const noImages = (estimateRequestTokens as (body: unknown, model: string) => number)({ ...wire, messages: stripped }, model)
      assert.equal(guard - noImages, 9 * 2000, 'delivered images use the existing media-token estimate; removed blocks cost zero')
    } else {
      assert.equal(JSON.stringify(wire).includes('[image]'), true, 'the codec placeholder is present and counted')
    }
  }
  console.log('Image-aware meter, precompose, composed guard and stripped-block checks passed')
} finally {
  rmSync(home, { recursive: true, force: true })
}
