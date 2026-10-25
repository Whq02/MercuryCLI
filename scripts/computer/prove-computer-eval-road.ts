#!/usr/bin/env bun
import { check, finish, section } from './computerProofKit.ts'
import { ownerOf, resultOf, toolContext, toolResultTurn, toolUseTurn, withScreenshot } from './computerToolKit.ts'

delete process.env.NODE_ENV
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.ts')
const { evalKernelManager } = await import('../../src/services/eval/kernelManager.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const retention = await import('../../src/services/desktop/screenshotRetention.ts')
const { buildOpenaiResponsesRequest } = await import('../../src/services/providers/openai/responsesBridge.ts')
type ToolUseContext = import('../../src/Tool.ts').ToolUseContext
type Message = import('../../src/types/message.ts').Message
type Block = Record<string, unknown>

const allow = (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow' as const, updatedInput: input })) as never

function resultBlocks(message: Message): Block[] {
  const content = (message as { message: { content: unknown } }).message.content
  const block = Array.isArray(content) ? (content as Block[]).find(b => b.type === 'tool_result') : undefined
  return Array.isArray(block?.content) ? (block.content as Block[]) : []
}
const imageOf = (blocks: Block[]): Block | undefined => blocks.find(b => b.type === 'image')
const textOf = (blocks: Block[]): string => blocks.filter(b => b.type === 'text').map(b => String(b.text)).join('\n')

interface Cell {
  context: ToolUseContext
  output: Record<string, unknown>
  block: Block
  messages: Message[]
  value: string
}

async function cell(base: ToolUseContext, toolUseId: string, code: string): Promise<Cell> {
  const input = { language: 'js', code }
  const context = { ...base, toolUseId, options: { ...base.options, tools: [ComputerTool, EvalTool] } } as ToolUseContext
  const parent = toolUseTurn(toolUseId, 'Eval', input)
  const answer = (await EvalTool.call(input as never, context, allow, parent as never, undefined)) as unknown as { data: Record<string, unknown> }
  const block = EvalTool.mapToolResultToToolResultBlockParam(answer.data as never, toolUseId) as Block
  const messages = [...base.messages, parent, toolResultTurn(block)]
  const value = typeof block.content === 'string' ? block.content : textOf(block.content as Block[])
  return { context: { ...base, messages } as ToolUseContext, output: answer.data, block, messages, value }
}

const act = async (context: ToolUseContext, toolUseId: string, input: Record<string, unknown>): Promise<{ verdict: { behavior: string; message?: string }; result: string; outcome: string; messages: Message[] }> => {
  const verdict = (await ComputerTool.checkPermissions(input as never, context)) as { behavior: string; message?: string }
  if (verdict.behavior === 'deny') return { verdict, result: verdict.message ?? '', outcome: 'denied', messages: context.messages }
  const parent = toolUseTurn(toolUseId, 'Computer', input)
  const answer = await ComputerTool.call(input as never, context, allow, parent as never)
  const out = resultOf(answer)
  const block = ComputerTool.mapToolResultToToolResultBlockParam(answer.data as never, toolUseId)
  return { verdict, result: out.result, outcome: out.outcome, messages: [...context.messages, parent, toolResultTurn(block)] }
}

resetDesktopDriverForTest()
const seed = toolContext()
const appState = { ...(seed.getAppState() as object), sessionHooks: new Map() }
const base = { ...seed, getAppState: () => appState } as unknown as ToolUseContext
const owner = ownerOf(base)
session.forgetDesktopOwner(owner)

try {
  section('§1 the observed road: screenshot → act → an act wrapped in Eval with capture → act')
  const opening = await withScreenshot(ComputerTool as never, base, 'toolu_road_shot')
  check('the direct screenshot succeeds and its image is in the conversation', opening.outcome === 'succeeded' && retention.screenshotVisibleInContext(opening.messages, 'toolu_road_shot'), opening.result)
  const first = await act(opening.context, 'toolu_road_click_1', { action: 'click', x: 812, y: 300, capture: false })
  check('the direct act lands', first.outcome === 'succeeded' && first.result.includes('click (812, 300)'), first.result)
  const before = session.screenOf(owner)
  const wrapped = await cell({ ...opening.context, messages: first.messages } as ToolUseContext, 'toolu_road_eval_1', "const r = await tool.Computer({ action: 'click', x: 812, y: 300, capture: true })\nr")
  check('the wrapped act ran inside the cell', wrapped.output.status === 'ok' && String(wrapped.output.resultRepr ?? '').includes('click (812, 300)'), JSON.stringify({ status: wrapped.output.status, error: wrapped.output.error, repr: wrapped.output.resultRepr, notes: wrapped.output.annotations }).slice(0, 600))
  const map = session.screenOf(owner)
  check('the capture inside the cell is the last screenshot', map !== null && map !== before && typeof map.capturedAt === 'number' && (before === null || map.capturedAt >= before.capturedAt), JSON.stringify(map))
  const blocks = Array.isArray(wrapped.block.content) ? (wrapped.block.content as Block[]) : []
  const image = imageOf(blocks)
  check("the cell's result carries the screenshot as an image block", image !== undefined && (image.source as Block | undefined)?.type === 'base64' && String((image.source as Block | undefined)?.media_type).startsWith('image/'), JSON.stringify(wrapped.block).slice(0, 300))
  check('the last screenshot is keyed to the id the model sees — the Eval call', map?.toolUseId === 'toolu_road_eval_1', String(map?.toolUseId))
  check('the screenshot is visible in the conversation under that id', retention.screenshotVisibleInContext(wrapped.messages, 'toolu_road_eval_1'))
  check("the cell's value names no transcript-only image", !wrapped.value.includes('[image result') && !wrapped.value.includes('binary does not cross the bridge'), wrapped.value.slice(0, 300))
  check("the cell's value says where the screenshot went", wrapped.value.includes("[screenshot attached to this cell's result]"), wrapped.value.slice(0, 300))

  section('§2 the next act is not refused — direct or wrapped')
  const direct = await act(wrapped.context, 'toolu_road_click_2', { action: 'click', x: 400, y: 200, capture: false })
  check('a direct act after the wrapped capture is not refused', direct.verdict.behavior !== 'deny' && direct.outcome === 'succeeded', `${direct.verdict.behavior}: ${direct.result}`)
  check('in particular not for a screenshot gone from the conversation', !direct.result.includes('no longer in the conversation'), direct.result)
  const again = await cell({ ...wrapped.context, messages: direct.messages } as ToolUseContext, 'toolu_road_eval_2', "const r2 = await tool.Computer({ action: 'move', x: 100, y: 100 })\nr2")
  check('a wrapped act after the wrapped capture is not refused either', again.output.status === 'ok' && String(again.output.resultRepr ?? '').includes('move (100, 100)') && !JSON.stringify(again.output).includes('no longer in the conversation'), JSON.stringify({ status: again.output.status, error: again.output.error, repr: again.output.resultRepr }).slice(0, 600))
  check('a wrapped act without capture attaches no image and leaves the last screenshot where it was', !Array.isArray(again.block.content) && session.screenOf(owner)?.toolUseId === 'toolu_road_eval_1', JSON.stringify(again.block).slice(0, 200))

  section('§3 a wrapped screenshot is the same road')
  const shot = await cell({ ...again.context, messages: again.messages } as ToolUseContext, 'toolu_road_eval_shot', "const s = await tool.Computer({ action: 'screenshot', full: true })\ns")
  const shotBlocks = Array.isArray(shot.block.content) ? (shot.block.content as Block[]) : []
  check('the wrapped screenshot rides in the cell result as an image', imageOf(shotBlocks) !== undefined && String(shot.output.resultRepr ?? '').includes('screenshot: '), JSON.stringify(shot.output.resultRepr ?? shot.output.error).slice(0, 300))
  check('the last screenshot is keyed to that cell', session.screenOf(owner)?.toolUseId === 'toolu_road_eval_shot', String(session.screenOf(owner)?.toolUseId))
  const after = await act(shot.context, 'toolu_road_click_3', { action: 'click', x: 10, y: 10, capture: false })
  check('the act after it is not refused', after.verdict.behavior !== 'deny' && after.outcome === 'succeeded', `${after.verdict.behavior}: ${after.result}`)

  section('§4 the screenshot in a cell result keeps the retention contract')
  const evalResult = wrapped.messages[wrapped.messages.length - 1]!
  const path = session.screenshotPathForToolUse('toolu_road_eval_1')
  check('the registry knows the file under the Eval id', path !== null && path.endsWith('.png'), String(path))
  const projected = retention.projectForTranscript(evalResult)
  const projectedBlocks = resultBlocks(projected)
  check('the transcript projection stubs the image naming the file', projected !== evalResult && imageOf(projectedBlocks) === undefined && projectedBlocks.some(b => b.type === 'text' && String(b.text) === retention.screenshotStubText(path ?? '')), JSON.stringify(projectedBlocks).slice(0, 400))
  const rehydrated = retention.rehydrateScreenshots([projected])
  check('a resume rehydrates the image from the file', imageOf(resultBlocks(rehydrated[0]!)) !== undefined)
  const crowded: Message[] = [...wrapped.messages]
  for (let i = 0; i < 12; i++) {
    const id = `toolu_road_pad_${i}`
    session.noteScreenshot(owner, id, `/shots/${i}.png`)
    crowded.push(toolUseTurn(id, 'Computer', { action: 'screenshot' }), toolResultTurn({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `screenshot: /shots/${i}.png — display 1` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }))
  }
  const retired = retention.retireOlderScreenshots(crowded)
  const retiredEval = retired.messages[wrapped.messages.length - 1]!
  check('the wire window counts it as a screenshot: with twelve newer ones it is retired to the earlier-screenshot line naming its file', resultBlocks(retiredEval).some(b => b.type === 'text' && String(b.text) === retention.earlierScreenshotText(path ?? '')) && imageOf(resultBlocks(retiredEval)) === undefined && retention.screenshotVisibleInContext(retired.messages, 'toolu_road_pad_11'), JSON.stringify({ firstEdited: retired.firstEdited, blocks: resultBlocks(retiredEval) }).slice(0, 400))

  section('§5 the GPT wire shape of the cell result')
  const assistant = (wrapped.messages[wrapped.messages.length - 2] as { message: { content: unknown } }).message.content
  const user = (evalResult as { message: { content: unknown } }).message.content
  const request = buildOpenaiResponsesRequest({ model: 'gpt-5', instructions: 'x', messages: [{ role: 'assistant', content: assistant as never }, { role: 'user', content: user as never }], tools: [], imagesSupported: true })
  const output = (request.input as Block[]).find(i => i.type === 'function_call_output') as { call_id?: unknown; output?: unknown } | undefined
  const parts = Array.isArray(output?.output) ? (output.output as Block[]) : []
  check('the Responses bridge carries the cell result as input_text then input_image under the Eval call id', output?.call_id === 'toolu_road_eval_1' && parts.length === 2 && parts[0]?.type === 'input_text' && parts[1]?.type === 'input_image' && String(parts[1]?.image_url).startsWith('data:image/'), JSON.stringify(output).slice(0, 300))
} finally {
  await evalKernelManager.disposeAll()
  session.forgetDesktopOwner(owner)
}

check('no kernel left behind', evalKernelManager.kernelCount() === 0)
finish('prove-computer-eval-road')
