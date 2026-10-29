import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'hosted-image-history-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { OPENAI_IMAGE_LIMITS, GEMINI_IMAGE_LIMITS } = await import('../../src/constants/apiLimits.ts')
const sharp = (await import('sharp')).default
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).png().toBuffer()
const marker = 'image elided from this request; Read it again if needed'
function history(size: number) {
  return Array.from({ length: 300 }, (_, i) => [
    createAssistantMessage({ content: [{ type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: `/captures/${i}.png` } }] }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `read-${i}`, content: [
      { type: 'text', text: `/captures/${i}.png\nOCR companion ${i}` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.concat([png, Buffer.alloc(size, i % 256)]).toString('base64') } },
    ] }] }),
  ]).flat()
}
fixture.script(({ body }) => {
  const text = JSON.stringify(body)
  const images = (text.match(/"type":"(?:image|input_image)"|"inlineData":/g) ?? []).length
  const elided = text.split(marker).length - 1
  return { text: images + elided === 300 ? 'reader complete' : 'reader would reread an unaccounted image' }
})
async function send(model: string, messages: ReturnType<typeof history>) {
  const before = fixture.captured.length
  let answer = ''
  for await (const row of routedCallModel({ messages, systemPrompt: asSystemPrompt(['fixture image reader']), thinkingConfig: { type: 'enabled', budgetTokens: 1024 }, tools: [], signal: new AbortController().signal, options: { model, querySource: 'sdk', agents: [], isNonInteractiveSession: true, hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false, async getToolPermissionContext() { return getEmptyToolPermissionContext() } } } as never)) {
    assert.ok(row.type !== 'assistant' || !row.isApiErrorMessage, JSON.stringify(row))
    if (row.type === 'assistant') for (const part of row.message.content) if (part.type === 'text') answer += part.text
  }
  assert.ok(answer.includes('reader complete'), answer)
  const captured = fixture.captured[before]
  assert.ok(captured, 'request reached the hosted stand-in')
  return captured.body
}
try {
  const small = history(0)
  const original = JSON.stringify(small)
  const body = await send('claude-opus-5-5', small)
  assert.equal((JSON.stringify(body).match(/"type":"image"/g) ?? []).length, 300, 'a fitting long-context request keeps all 300 images')
  assert.equal(JSON.stringify(small), original)
  const large = history(350_000)
  const crowded = await send('claude-opus-5-5', large)
  const wire = JSON.stringify(crowded)
  assert.ok(wire.includes(marker), 'every elided image has a visible marker')
  assert.ok(Buffer.byteLength(wire) <= 128 * 1024 * 1024)
  assert.ok(wire.includes(Buffer.concat([png, Buffer.alloc(350_000, 299 % 256)]).toString('base64')), 'newest image stays intact')
  for (let i = 0; i < 300; i++) assert.ok(wire.includes(`OCR companion ${i}`))
  const gemini = JSON.stringify(await send('gemini-3-pro', history(80_000)))
  assert.ok(gemini.includes(marker))
  assert.ok(Buffer.byteLength(gemini) <= GEMINI_IMAGE_LIMITS.maxRequestBytes)
  await send('gpt-5.6-sol', small)
  const openaiBudget = OPENAI_IMAGE_LIMITS.maxRequestBytes
  try {
    OPENAI_IMAGE_LIMITS.maxRequestBytes = 2 * 1024 * 1024
    const openai = JSON.stringify(await send('gpt-5.6-sol', history(8_000)))
    assert.ok(openai.includes(marker))
    assert.ok(Buffer.byteLength(openai) <= OPENAI_IMAGE_LIMITS.maxRequestBytes)
  } finally { OPENAI_IMAGE_LIMITS.maxRequestBytes = openaiBudget }
  const { fitWireImages } = await import('../../src/utils/messages/imageRequestFit.ts')
  for (const [dialect, limits] of [['openai', OPENAI_IMAGE_LIMITS], ['gemini', GEMINI_IMAGE_LIMITS]] as const) {
    const payload = dialect === 'openai'
      ? { input: small.filter(row => row.type === 'user').map((row: any) => ({ type: 'function_call_output', call_id: row.message.content[0].tool_use_id, output: [{ type: 'input_text', text: row.message.content[0].content[0].text }, { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` }] })) }
      : { contents: small.filter(row => row.type === 'user').map((row: any) => ({ role: 'user', parts: [{ text: row.message.content[0].content[0].text }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] })) }
    const before = JSON.stringify(payload)
    const fitted = fitWireImages(payload, { ...limits, maxRequestBytes: Buffer.byteLength(before) - 10_000 })
    assert.ok(fitted.removed > 0)
    assert.ok(JSON.stringify(fitted.request).includes(marker))
    assert.ok(fitted.bytes <= Buffer.byteLength(before) - 10_000)
    assert.equal(JSON.stringify(payload), before)
    assert.equal(fitWireImages(payload, limits).removed, 0, 'a fitting request is not capped')
  }
  console.log('PASS hosted image history: 300 fitting images, oldest-first byte fitting, explicit markers, OCR text, newest pixels and unchanged transcript')
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}
