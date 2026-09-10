#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

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
const { buildZaiChatRequest } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { buildOpenaiResponsesRequest } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { classifyModelRoute } = await import('../../src/services/providers/idSpaces.ts')

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64')
const RESULT_LINE = 'screenshot: /shots/1.png — display 1 (1600×1000 px of 1440×900 pt) · cursor (10, 10) · frontmost TextEdit'
const assistantTurn = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_1', name: 'Computer', input: { action: 'screenshot' } }] }
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

interface RouteRow {
  route: string
  model: string
  callModel: string
  images: boolean | null
}

const ROWS: RouteRow[] = [
  { route: 'anthropic', model: 'claude-opus-5', callModel: 'src/services/providers/anthropic/streamCore.ts', images: true },
  { route: 'openai', model: 'gpt-5', callModel: 'src/services/providers/openai/openaiCallModel.ts', images: true },
  { route: 'openai-compat', model: 'compat/fixture', callModel: 'src/services/providers/openaicompat/compatCallModel.ts', images: null },
  { route: 'openrouter', model: 'openrouter/org/model', callModel: 'src/services/providers/openrouter/openrouterCallModel.ts', images: null },
  { route: 'gemini', model: 'gemini-2.5-pro', callModel: 'src/services/providers/gemini/geminiCallModel.ts', images: true },
  { route: 'deepseek', model: 'deepseek-chat', callModel: 'src/services/providers/deepseek/deepseekCallModel.ts', images: true },
  { route: 'moonshot', model: 'kimi-k2', callModel: 'src/services/providers/moonshot/moonshotCallModel.ts', images: true },
  { route: 'zai', model: 'glm-4.5', callModel: 'src/services/providers/zai/zaiCallModel.ts', images: true },
  { route: 'huggingface', model: 'huggingface/org/model', callModel: 'src/services/providers/huggingface/huggingfaceCallModel.ts', images: null },
  { route: 'local', model: 'local/model', callModel: 'src/services/providers/local/localCallModel.ts', images: null },
]

section('§1 every route id classifies to its route')
for (const row of ROWS) {
  const verdict = classifyModelRoute(row.model)
  check(`${row.model} → ${row.route}`, verdict.kind === 'route' && verdict.route === row.route, JSON.stringify(verdict))
}

section('§2 the image-block predicate per route (the catalogue-gated four answer a boolean)')
for (const row of ROWS) {
  const answer = modelReceivesImageBlocks(row.model)
  if (row.images === null) check(`${row.route}: a boolean the catalogue decides`, typeof answer === 'boolean', String(answer))
  else check(`${row.route}: ${row.images}`, answer === row.images, String(answer))
}

section('§3 the builder each route reaches (structural)')
{
  const compatRuntime = source('src/services/providers/openaicompat/compatChatCallModel.ts')
  check('the compat runtime maps through the shared codec', compatRuntime.includes('mapMessagesToZai') || compatRuntime.includes('buildZaiChatRequest'))
  for (const row of ROWS) {
    const text = source(row.callModel)
    if (row.route === 'anthropic') check('anthropic: the tool_result rides as blocks (the media ceiling is the only edit)', text.includes('stripExcessMediaItems('))
    else if (row.route === 'openai') check('openai: the Responses request is built with the images gate', text.includes('buildOpenaiResponsesRequest(') && text.includes('imagesSupported'))
    else if (row.route === 'zai') check('zai: the chat request is built by the shared codec', text.includes('buildZaiChatRequest('))
    else check(`${row.route}: the compat runtime carries it`, text.includes('compatChatCallModel('))
  }
}

section('§4 the golden per route: the tool message keeps the text, a user message follows with the image')
for (const row of ROWS.filter(r => r.route !== 'anthropic' && r.route !== 'openai')) {
  const request = buildZaiChatRequest({ model: row.model, messages: [assistantTurn as never, resultTurn as never] })
  const rows = request.messages as Array<Record<string, unknown>>
  const toolAt = rows.findIndex(r => r.role === 'tool')
  const tool = rows[toolAt]
  const next = rows[toolAt + 1] as { role?: string; content?: unknown } | undefined
  const parts = Array.isArray(next?.content) ? (next.content as Array<Record<string, unknown>>) : []
  const image = parts.find(p => p.type === 'image_url') as { image_url?: unknown } | undefined
  const url = typeof image?.image_url === 'string' ? image.image_url : (image?.image_url as { url?: string } | undefined)?.url
  check(`${row.route}: the tool row carries the text line, no marker`, toolAt >= 0 && tool?.tool_call_id === 'call_1' && tool.content === RESULT_LINE, JSON.stringify(tool))
  check(`${row.route}: a user row follows with an image_url part carrying the PNG data URL`, next?.role === 'user' && typeof url === 'string' && url === `data:image/png;base64,${PNG_B64}`, JSON.stringify(next).slice(0, 300))
  check(`${row.route}: the request names the model`, request.model === row.model)
}

section('§5 the golden for the openai route: input_text then input_image')
{
  const request = buildOpenaiResponsesRequest({ model: 'gpt-5', instructions: 'x', messages: [assistantTurn as never, resultTurn as never], tools: [], imagesSupported: true })
  const output = (request.input as Array<Record<string, unknown>>).find(i => i.type === 'function_call_output') as { call_id?: string; output?: unknown } | undefined
  const parts = Array.isArray(output?.output) ? (output.output as Array<Record<string, unknown>>) : []
  check('the function_call_output pairs the call id', output?.call_id === 'call_1')
  check('the output is [input_text, input_image] with the data URL', parts.length === 2 && parts[0]?.type === 'input_text' && parts[0]?.text === RESULT_LINE && parts[1]?.type === 'input_image' && parts[1]?.image_url === `data:image/png;base64,${PNG_B64}`, JSON.stringify(parts).slice(0, 300))
  const degraded = buildOpenaiResponsesRequest({ model: 'gpt-5', instructions: 'x', messages: [assistantTurn as never, resultTurn as never], tools: [], imagesSupported: false })
  const plain = (degraded.input as Array<Record<string, unknown>>).find(i => i.type === 'function_call_output') as { output?: unknown } | undefined
  check("a text-only catalogue degrades the image to the visible marker '[image]'", plain?.output === `${RESULT_LINE}[image]`, JSON.stringify(plain))
}

section('§6 the golden for the anthropic route: the block rides untouched')
{
  const params = source('src/services/providers/anthropic/messageParams.ts')
  check("messageParams.ts never rewrites an image block to a marker", !params.includes("'[image]'"))
}

console.log(`\nprove-image-result-shapes: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
