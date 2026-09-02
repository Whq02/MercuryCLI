// ============================================================================
//  scripts/model-routing/live/smoke-image — LIVE input_image proof on gpt-5.6-sol
// A user image block
//  (base64 red square) maps to an input_image item through the production
//  bridge; the model must read it.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

const { openaiCallModel } = await import(
  '../../../src/services/providers/openai/openaiCallModel.js'
)
const { getEmptyToolPermissionContext } = await import('../../../src/Tool.ts')

const png = await sharp({
  create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 20, b: 20 } },
})
  .png()
  .toBuffer()

const minted: Array<Record<string, unknown>> = []
const params = {
  messages: [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'What single color fills this image? Answer with the color name only.' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
          },
        ],
      },
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    },
  ] as never,
  systemPrompt: ['You are Mercury. Answer tersely.'] as never,
  thinkingConfig: { type: 'enabled', budgetTokens: 4096 } as never,
  tools: [] as never,
  signal: new AbortController().signal,
  options: {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: 'gpt-5.6-sol',
    isNonInteractiveSession: true,
    querySource: 'agent:builtin:apex-image-smoke',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    effortValue: 'low',
  } as never,
}
for await (const item of openaiCallModel(params as never)) {
  if ((item as { type?: string }).type === 'assistant') minted.push(item as Record<string, unknown>)
}
const text = minted
  .flatMap(m => ((m as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? []))
  .filter(b => b.type === 'text')
  .map(b => String(b.text))
  .join(' ')
console.log(`answer: ${text.slice(0, 200)}`)
if (!/red/i.test(text)) {
  console.error('IMAGE SMOKE FAILED: the model did not read the red image')
  process.exit(1)
}
console.log('LIVE IMAGE SMOKE GREEN — input_image read on the real wire')
