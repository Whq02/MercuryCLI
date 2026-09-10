#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, freshSignal, scratchDir, section } from './computerProofKit.ts'
import { toolContext } from './computerToolKit.ts'

const scratch = scratchDir('wire-shapes')
type Body = Record<string, unknown>
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')

const captured: Array<{ body: Body }> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      try {
        captured.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body })
      } catch {
        captured.push({ body: {} })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse())
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { modelReceivesImageBlocks } = await import('../../src/utils/model/capabilities.ts')
const { buildOpenaiResponsesRequest } = await import('../../src/services/providers/openai/responsesBridge.ts')
const openaiCallModel = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')
const { pngDimensions } = await import('../../src/services/desktop/fakeDesktopDriver.ts')
type Message = import('../../src/types/message.ts').Message

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0])
const shot = join(scratch, 'shot.png')
writeFileSync(shot, PNG)
const RESULT_LINE = `screenshot: ${shot} — display 1 (2×2 px of 1×1 pt) · cursor (0, 0) · frontmost TextEdit`

section('§a the Anthropic tool_result block and the tools term')
{
  const block = ComputerTool.mapToolResultToToolResultBlockParam({ action: 'screenshot', result: RESULT_LINE, outcome: 'succeeded', imagePath: shot } as never, 'toolu_wire') as { tool_use_id: string; type: string; content: Array<Record<string, unknown>> }
  check('the block is a tool_result for the id', block.tool_use_id === 'toolu_wire' && block.type === 'tool_result')
  check('content[0] is the text line', block.content[0]?.type === 'text' && block.content[0]?.text === RESULT_LINE, JSON.stringify(block.content[0]))
  const image = block.content[1] as { type?: string; source?: { type?: string; media_type?: string; data?: string } } | undefined
  check("content[1] is an image block, base64, image/png", image?.type === 'image' && image.source?.type === 'base64' && image.source.media_type === 'image/png' && typeof image.source.data === 'string', JSON.stringify(image).slice(0, 200))
  check('the image bytes are the file\'s', image?.source?.data !== undefined && pngDimensions(Buffer.from(image.source.data, 'base64'))?.width === 2)
  const history: Message[] = [createUserMessage({ content: 'take a screenshot' }) as Message]
  const before = captured.length
  let threw: unknown
  try {
    for await (const item of routedCallModel({
      messages: history as never,
      systemPrompt: ['fixture system prompt'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [ComputerTool] as never,
      signal: freshSignal(),
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'claude-opus-5',
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'high',
      } as never,
    })) {
      void item
    }
  } catch (error) {
    threw = error
  }
  const body = captured.slice(before).at(-1)?.body ?? {}
  check('the request reached the loopback', captured.length > before && threw === undefined, String(threw ?? ''))
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? []
  const computer = tools.filter(t => t.name === 'Computer')
  check('the tools term carries exactly one definition named Computer', computer.length === 1, JSON.stringify(tools.map(t => `${String(t.name)}:${String(t.type ?? 'plain')}`)))
  check('that definition is a plain JSON tool with an input schema', computer[0] !== undefined && typeof computer[0].input_schema === 'object' && (computer[0].type === undefined || computer[0].type === 'custom'), JSON.stringify(computer[0]).slice(0, 200))
  check('no definition of a provider-native computer-use type rides', !tools.some(t => typeof t.type === 'string' && /^computer/.test(t.type)), JSON.stringify(tools.map(t => t.type)))
}

section('§b the Responses bridge carries the image as input_image and degrades honestly')
{
  const assistant = createAssistantMessage({ content: [{ type: 'tool_use', id: 'call_1', name: 'Computer', input: { action: 'screenshot' } }] as never })
  const user = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: RESULT_LINE }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] }] as never })
  const rows = [
    { role: 'assistant' as const, content: (assistant as { message: { content: unknown } }).message.content as never },
    { role: 'user' as const, content: (user as { message: { content: unknown } }).message.content as never },
  ]
  const withImages = buildOpenaiResponsesRequest({ model: 'gpt-5', instructions: 'x', messages: rows, tools: [], imagesSupported: true })
  const outputItem = (withImages.input as Array<Record<string, unknown>>).find(i => i.type === 'function_call_output') as { output?: unknown } | undefined
  const parts = Array.isArray(outputItem?.output) ? (outputItem.output as Array<Record<string, unknown>>) : []
  check('with images: the output is an array of input_text then input_image with a data URL', parts.length === 2 && parts[0]?.type === 'input_text' && parts[1]?.type === 'input_image' && String(parts[1]?.image_url).startsWith('data:image/png;base64,'), JSON.stringify(outputItem).slice(0, 300))
  const without = buildOpenaiResponsesRequest({ model: 'gpt-5', instructions: 'x', messages: rows, tools: [], imagesSupported: false })
  const degraded = (without.input as Array<Record<string, unknown>>).find(i => i.type === 'function_call_output') as { output?: unknown } | undefined
  check("without images: the output is a string ending in '[image]'", typeof degraded?.output === 'string' && degraded.output.endsWith('[image]'), JSON.stringify(degraded).slice(0, 300))
  const predicate = (openaiCallModel as { imagesSupportedForModel?: (...args: never[]) => boolean }).imagesSupportedForModel
  check('imagesSupportedForModel is a named export of the openai call model', typeof predicate === 'function')
  if (typeof predicate === 'function') {
    const declared = predicate({ live: { inputModalities: ['text', 'image'] } } as never)
    const textOnly = predicate({ live: { inputModalities: ['text'] } } as never)
    const absent = predicate(undefined as never)
    check('a catalogue with image answers true, text-only false, an absent list stays permissive', declared === true && textOnly === false && absent === true, JSON.stringify({ declared, textOnly, absent }))
  }
}

section('§c the chat-completions codec carries the image in a user message after the tool message')
{
  const assistant = createAssistantMessage({ content: [{ type: 'tool_use', id: 'call_1', name: 'Computer', input: { action: 'screenshot' } }] as never })
  const user = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: RESULT_LINE }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] }] as never })
  const params = [
    { role: 'assistant' as const, content: (assistant as { message: { content: unknown } }).message.content as never },
    { role: 'user' as const, content: (user as { message: { content: unknown } }).message.content as never },
  ]
  const rows = mapMessagesToZai(undefined, params) as Array<Record<string, unknown>>
  const toolRow = rows.findIndex(r => r.role === 'tool')
  check('the tool row carries the text line and no image marker', toolRow >= 0 && rows[toolRow]?.content === RESULT_LINE, JSON.stringify(rows[toolRow]))
  const next = rows[toolRow + 1] as { role?: string; content?: unknown } | undefined
  const contentParts = Array.isArray(next?.content) ? (next.content as Array<Record<string, unknown>>) : []
  const imagePart = contentParts.find(p => p.type === 'image_url') as { image_url?: unknown } | undefined
  const url = typeof imagePart?.image_url === 'string' ? imagePart.image_url : (imagePart?.image_url as { url?: string } | undefined)?.url
  check('a user row follows with an image_url part carrying the PNG data URL', next?.role === 'user' && typeof url === 'string' && url.startsWith('data:image/png;base64,'), JSON.stringify(next).slice(0, 300))
  check('the tool row precedes the user row directly', toolRow >= 0 && rows[toolRow + 1] === next)
}

section('§d the route matrix of modelReceivesImageBlocks')
{
  const matrix: Array<[string, string, boolean | null]> = [
    ['anthropic', 'claude-opus-5', true],
    ['openai', 'gpt-5', true],
    ['gemini', 'gemini-2.5-pro', true],
    ['deepseek', 'deepseek-chat', true],
    ['moonshot', 'kimi-k2', true],
    ['zai', 'glm-4.5', true],
    ['openai-compat', 'compat/fixture', null],
    ['openrouter', 'openrouter/org/model', null],
    ['huggingface', 'huggingface/org/model', null],
    ['local', 'local/model', null],
  ]
  for (const [route, model, expected] of matrix) {
    const answer = modelReceivesImageBlocks(model)
    if (expected === null) check(`${route} (${model}) answers a boolean the catalogue decides`, typeof answer === 'boolean', String(answer))
    else check(`${route} (${model}) answers ${expected}`, answer === expected, String(answer))
  }
  check('an unrecognised id answers true, absence false', modelReceivesImageBlocks('stranger-1') === true && modelReceivesImageBlocks('') === false)
}

section('§e the refusal on a text-only route names the route\'s display name')
{
  const context = toolContext({ model: 'compat/fixture' })
  const verdict = await ComputerTool.validateInput!({ action: 'screenshot' } as never, context)
  if (modelReceivesImageBlocks('compat/fixture')) {
    check('the compat slot is admitted to the tool (the wire teaches)', verdict.result === true, JSON.stringify(verdict))
  } else {
    check("a text-only model is refused naming the route's display name", verdict.result === false && verdict.message.includes(providerDisplayName('openai-compat')) && verdict.message.includes('/model'), JSON.stringify(verdict))
  }
}

section('§f the latch: a provider refusal of the image parks the model until another is asked for')
{
  const { noteImageRefusal, imageRefusedFor, clearImageRefusal } = await import('../../src/services/desktop/desktopSession.ts')
  clearImageRefusal()
  check('nothing is latched at the start', imageRefusedFor('glm-4.5') === null)
  noteImageRefusal('glm-4.5', 'images are not supported by this model')
  check('the latched model reads its words back', imageRefusedFor('glm-4.5') === 'images are not supported by this model')
  const verdict = await ComputerTool.validateInput!({ action: 'screenshot' } as never, toolContext({ model: 'glm-4.5' }))
  check('validateInput refuses the latched model naming the route, the words and /model', verdict.result === false && verdict.message.includes('refused the image') && verdict.message.includes(providerDisplayName('zai')) && verdict.message.includes('images are not supported by this model') && verdict.message.includes('/model'), JSON.stringify(verdict))
  check('asking about another model clears the latch', imageRefusedFor('claude-opus-5') === null && imageRefusedFor('glm-4.5') === null)
  const cleared = await ComputerTool.validateInput!({ action: 'screenshot' } as never, toolContext({ model: 'glm-4.5' }))
  check('the model drives again once the latch is cleared', cleared.result === true, JSON.stringify(cleared))
  clearImageRefusal()
}

server.close()
finish('prove-computer-wire-shapes')
