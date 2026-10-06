#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const source = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const { modelReceivesImageBlocks } = await import('../../src/utils/model/capabilities.ts')
const { glmTakesImages } = await import('../../src/services/providers/zai/glmPins.ts')
const { imagesSupportedForCompatModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { buildZaiChatRequest, imageRefusalWords, requestCarriesImage } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { classifyImageRefusalFault, providerRefusedImage } = await import('../../src/services/api/mediaRefusal.ts')
const { stripImagesRefusedByStamp } = await import('../../src/utils/messages/apiPlan.ts')
const { createAssistantAPIErrorMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')

const ZAI_WORDS = "messages.content.type is invalid, allowed values: ['text']"
const ZAI_FAULT = { code: '1210', status: 400, message: ZAI_WORDS }
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64')
const RESULT_LINE = 'screenshot: /shots/1.png — display 1'
const assistantTurn = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_1', name: 'Browser', input: { action: 'screenshot' } }] }
const resultTurn = {
  role: 'user' as const,
  content: [
    {
      type: 'tool_result' as const,
      tool_use_id: 'call_1',
      content: [
        { type: 'text' as const, text: RESULT_LINE },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: PNG_B64 } },
      ],
    },
  ],
}
const partsOf = (request: { messages: readonly unknown[] }): string[] =>
  (request.messages as Array<{ content?: unknown }>).flatMap(row =>
    Array.isArray(row.content) ? (row.content as Array<{ type?: string }>).map(part => String(part.type)) : [],
  )

section('§1 the Z.AI route declares images only for a GLM vision id; the text models answer false')
for (const id of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air']) {
  check(`${id} receives no image blocks`, modelReceivesImageBlocks(id) === false && glmTakesImages(id) === false)
}
for (const id of ['glm-4.6v', 'glm-4.5v', 'GLM-4.6V', 'glm-4.1v-thinking-flash']) {
  check(`${id} is the vision family and receives image blocks`, modelReceivesImageBlocks(id) === true && glmTakesImages(id) === true)
}
check('the compat gate follows the route (glm-5.3 → no images, glm-4.6v → images)', imagesSupportedForCompatModel('glm-5.3') === false && imagesSupportedForCompatModel('glm-4.6v') === true)

section('§2 a tool result with a screenshot goes to a text GLM as words — no image_url part on the wire')
{
  const request = buildZaiChatRequest({ model: 'glm-5.3', messages: [assistantTurn as never, resultTurn as never], imagesSupported: imagesSupportedForCompatModel('glm-5.3') })
  const parts = partsOf(request)
  const rows = request.messages as Array<{ role?: string; content?: unknown }>
  const tool = rows.find(row => row.role === 'tool') as { content?: unknown } | undefined
  check('no image_url part leaves for glm-5.3', !parts.includes('image_url') && !requestCarriesImage(request.messages), parts.join(','))
  check('the tool row keeps the text line and names the image it could not carry', typeof tool?.content === 'string' && tool.content.includes(RESULT_LINE) && tool.content.includes('[image]'), JSON.stringify(tool))
  const vision = buildZaiChatRequest({ model: 'glm-4.6v', messages: [assistantTurn as never, resultTurn as never], imagesSupported: imagesSupportedForCompatModel('glm-4.6v') })
  check('the vision model still gets the image_url part', partsOf(vision).includes('image_url'), partsOf(vision).join(','))
}

section("§3 Z.AI's refusal wording is read as an image refusal, so the recovery road fires")
{
  check("'content.type is invalid, allowed values: [text]' names an image refusal", providerRefusedImage(ZAI_WORDS))
  check('the older wordings still do', providerRefusedImage('this model does not support image input') && providerRefusedImage('invalid modality: vision'))
  check('a plain parameter error does not', !providerRefusedImage('messages[0].role is invalid, allowed values: [user, assistant]') && !providerRefusedImage('temperature must be between 0 and 1'))
  const carried = buildZaiChatRequest({ model: 'glm-5.3', messages: [assistantTurn as never, resultTurn as never] })
  check('a request that carried an image + the Z.AI words → the refusal words for the row', imageRefusalWords(carried, ZAI_FAULT) === `1210: ${ZAI_WORDS}`, String(imageRefusalWords(carried, ZAI_FAULT)))
  const textOnly = buildZaiChatRequest({ model: 'glm-5.3', messages: [assistantTurn as never, resultTurn as never], imagesSupported: false })
  check('a request that carried no image is never read as an image refusal', imageRefusalWords(textOnly, ZAI_FAULT) === null)
  const typed = classifyImageRefusalFault(ZAI_FAULT, true)
  check('the typed refusal names the image block type', typed !== null && typed.blockTypes.includes('image'), JSON.stringify(typed))
}

section('§4 the refusal row the Z.AI and compat roads yield carries the typed media refusal, and the plan strips the refused image by it')
{
  const zai = source('src/services/providers/zai/zaiCallModel.ts')
  const compat = source('src/services/providers/openaicompat/compatChatCallModel.ts')
  for (const [name, text] of [['zai', zai], ['compat', compat]] as const) {
    const at = text.indexOf('noteImageRefusal(modelId, refusedImage)')
    const window = at < 0 ? '' : text.slice(at, at + 900)
    check(`${name}: the refusal row is stamped mediaRefusal with the image block type`, window.includes("{ blockTypes: ['image'], detail: refusedImage }"), window.slice(0, 200))
  }
  const refusalRow = createAssistantAPIErrorMessage({ content: 'API Error: refused', error: 'unknown', mediaRefusal: { blockTypes: ['image'], detail: ZAI_WORDS } })
  const withImage = createUserMessage({ content: resultTurn.content as never })
  const after = stripImagesRefusedByStamp([withImage, refusalRow])
  const first = after[0] as { message: { content: unknown } }
  const remaining = Array.isArray(first.message.content)
    ? (first.message.content as Array<{ type?: string; content?: unknown }>).flatMap(block => (Array.isArray(block.content) ? (block.content as Array<{ type?: string }>).map(part => String(part.type)) : [String(block.type)]))
    : []
  check('the next plan strips the refused image behind the stamped row and keeps the text', !remaining.includes('image') && remaining.includes('text'), remaining.join(','))
}

console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
