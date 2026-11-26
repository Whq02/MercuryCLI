import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolUseContext } from '../../kit/tool.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { imageResultBlock } from '../../browser/BrowserTool.js'
import { imageDimensionsFromHeader } from '../../../platform/images/imageProcessorJs.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../../platform/images/imageResizer.js'
import { getImageProcessor } from '../../../platform/images/imageProcessor.js'
import { modelReceivesImageBlocks } from '../../../models/facts/capabilities.js'
import {
  compatImageRefusalWords,
  compatModelImageReading,
  refreshCompatModelImageReading,
} from '../../../models/roads/openaicompat/compatProbe.js'
import { getEngineModel, normalizeModelStringForAPI } from '../../../models/catalogue/engineModel.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { getRuleByContentsForToolName } from '../../../permissions/rules/permissionDoor.js'
import type { PermissionRule, ToolPermissionContext } from '../../../permissions/rules/permissions.js'
import { classifyModelRoute, providerDisplayName } from '../../../models/roads/routeLaw.js'
import type { DesktopBounds, DesktopDriver, DesktopPoint } from '../../../integrations/desktop/driver.js'
import {
  DESKTOP_SHOTS_KEEP,
  imageRefusedFor,
  noteScreenshot,
  pruneDesktopShots,
  screenOf,
  screenshotPath,
  setScreen,
} from '../../../integrations/desktop/desktopSession.js'
import { screenshotVisibleInContext } from '../../../integrations/desktop/screenshotRetention.js'
import { COMPUTER_TOOL_NAME } from '../../../integrations/desktop/toolName.js'
import type { AssistantMessage, Message } from '../../../engine/message-shapes/message.js'
import { type ScreenMap, isPixelOutside, pointOfPixel, screenMapOfCapture, screenMapSizeWords } from '../screenMap.js'
import { type CaptureRegion, regionRefusal, sameWindow, settledCapture, windowOnDisplay } from '../fastRoad.js'
import { NO_SCREENSHOT, type Output, SCREENSHOT_GONE, SCREENSHOT_UNSEEN } from './schema.js'
import { faultText } from './act.js'
import { factsLine } from './words.js'

export type Shot =
  | { ok: true; line: string; imagePath: string; inlinePath?: string; inlineMediaType?: string; screen: ScreenMap }
  | { ok: false; aborted: boolean; text: string }

type Framed = { ok: true; point: DesktopPoint } | { ok: false; text: string }

export function framePixel(map: ScreenMap | null, messages: readonly Message[], x: number, y: number, sameMessage: ReadonlySet<string> = new Set()): Framed {
  if (map === null) return { ok: false, text: NO_SCREENSHOT }
  if (map.toolUseId !== '' && !screenshotVisibleInContext(messages, map.toolUseId)) return { ok: false, text: sameMessage.has(map.toolUseId) ? SCREENSHOT_UNSEEN : SCREENSHOT_GONE }
  const point = pointOfPixel(map, x, y)
  if (isPixelOutside(point)) {
    return {
      ok: false,
      text: `(${x}, ${y}) is outside the last screenshot (${point.imageWidth}×${point.imageHeight} px) — ${map.region ? `coordinates refer to this region (origin ${map.originX},${map.originY} pt); take a full screenshot with full:true to return` : 'take a screenshot and use its pixels'}`,
    }
  }
  return { ok: true, point }
}

export function toolUseIdsOfParent(parent: AssistantMessage | undefined): string[] {
  const content = (parent as { message?: { content?: unknown } } | undefined)?.message?.content
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    const typed = block as { type?: unknown; name?: unknown; id?: unknown }
    return typed.type === 'tool_use' && typed.name === COMPUTER_TOOL_NAME && typeof typed.id === 'string' ? [typed.id] : []
  })
}

export function toolUseIdOfParent(parent: AssistantMessage | undefined): string | null {
  return toolUseIdsOfParent(parent).at(-1) ?? null
}

export async function takeScreenshot(
  owner: OwnerKey,
  driver: DesktopDriver,
  context: ToolUseContext,
  toolUseId: string,
  wanted: number | undefined,
  label: string | undefined,
  signal: AbortSignal,
  region?: CaptureRegion,
  settleMs = 0,
  observe?: DesktopBounds,
  full = false,
  requestedScale?: number,
  publish = true,
  sameMessage: ReadonlySet<string> = new Set(),
  compareMap?: ScreenMap | null,
): Promise<Shot> {
  const displays = await driver.displays()
  if (!displays.ok) return { ok: false, aborted: false, text: faultText('screenshot', displays.error) }
  const list = displays.value.displays
  if (list.length === 0) return { ok: false, aborted: false, text: 'screenshot failed: no display is attached' }
  const map = screenOf(owner)
  if (region !== undefined) {
    const refusal = regionRefusal(region, map)
    if (refusal !== null) return { ok: false, aborted: false, text: refusal }
    const frame = framePixel(map, context.messages ?? [], region.x, region.y, sameMessage)
    if (!frame.ok) return { ok: false, aborted: false, text: frame.text }
  }
  const front = region === undefined && wanted === undefined && !full ? await driver.frontmostApplication() : null
  if (front && (!front.ok || !front.value.bounds)) return { ok: false, aborted: false, text: 'screenshot failed: the front window frame is unavailable — use full:true for the display' }
  let index = region !== undefined ? map?.display : wanted
  let window: DesktopBounds | undefined
  if (front?.ok && front.value.bounds) {
    const frames = list.map(display => ({ display, bounds: windowOnDisplay(front.value.bounds!, display) })).filter(frame => frame.bounds !== undefined).sort((a, b) => b.bounds!.width * b.bounds!.height - a.bounds!.width * a.bounds!.height)
    window = frames[0]?.bounds
    index = frames[0]?.display.index
    if (!window) return { ok: false, aborted: false, text: 'screenshot failed: the front window is outside the attached displays — use full:true' }
  }
  if (index === undefined) {
    const cursor = await driver.cursor()
    index = cursor.ok && cursor.value.display !== null ? cursor.value.display : (list.find(d => d.primary) ?? list[0]!).index
  }
  const display = list.find(d => d.index === index)
  if (display === undefined) {
    return {
      ok: false,
      aborted: false,
      text: `screenshot failed: display ${index} is not one of the displays — displays lists ${list.map(d => d.index).join(', ')}`,
    }
  }
  let captured: Awaited<ReturnType<typeof settledCapture>>
  try {
    captured = await settledCapture(driver, display, signal, settleMs, region, map, observe, window)
    if (front?.ok) {
      const after = await driver.frontmostApplication()
      if (!after.ok || !sameWindow(front.value, after.value)) return { ok: false, aborted: false, text: 'screenshot failed: the front window changed during capture — re-issue' }
    }
  } catch (error) {
    return { ok: false, aborted: signal.aborted, text: `screenshot failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const capture = captured.capture
  const factor = requestedScale ?? (window ? 0.5 : 1)
  const sharp = await getImageProcessor()
  const scaled = factor === 1 ? capture.png : await sharp(capture.png).resize(Math.max(1, Math.round(capture.width * factor)), Math.max(1, Math.round(capture.height * factor)), { fit: 'fill' }).png().toBuffer()
  const dimensions = imageDimensionsFromHeader(scaled)
  if (!dimensions) return { ok: false, aborted: false, text: 'screenshot failed: the scaled image has no readable dimensions' }
  const file = screenshotPath(label ?? `display-${display.index}`)
  writeFileSync(file, capture.png)
  pruneDesktopShots(dirname(file), DESKTOP_SHOTS_KEEP)
  let image = { width: dimensions.width, height: dimensions.height }
  let inlinePath: string | undefined
  let inlineMediaType: string | undefined
  const model = context.options?.engineModel ?? getEngineModel()
  if (modelReceivesImageBlocks(model)) {
    try {
      const resized = await maybeResizeAndDownsampleImageBuffer(scaled, scaled.length, 'png', { role: 'tool-result', model })
      const bytes = resized.buffer
      const header = imageDimensionsFromHeader(bytes)
      if (header === null) throw new Error('the inline screenshot has no readable dimensions')
      if (signal.aborted) return { ok: false, aborted: true, text: '' }
      image = { width: header.width, height: header.height }
      if (!bytes.equals(capture.png)) {
        inlinePath = `${file}.inline`
        writeFileSync(inlinePath, bytes)
        inlineMediaType = `image/${resized.mediaType}`
      }
    } catch (error) {
      return { ok: false, aborted: signal.aborted, text: `screenshot could not be prepared for the model: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const screen = screenMapOfCapture(toolUseId, capture, captured.points, image)
  if (region || window) screen.region = true
  const priorMap = compareMap !== undefined ? compareMap : map
  const changedFrame = priorMap !== null && ['displayId', 'originX', 'originY', 'pointWidth', 'pointHeight', 'imageWidth', 'imageHeight'].some(key => priorMap[key as keyof ScreenMap] !== screen[key as keyof ScreenMap])
  const scale = `scale ${(screen.imageWidth / screen.pointWidth).toFixed(3)} px/pt (native fraction ${factor}${image.width !== dimensions.width || image.height !== dimensions.height ? '; resized for the model route' : ''})`
  const frameWords = `${scale}${changedFrame ? '; frame changed: display, region or route image limits changed — previous coordinates do not apply' : ''}${region || window ? `; coordinates now refer to this ${region ? 'region' : 'window'} (origin ${screen.originX},${screen.originY} pt); full:true takes a full screenshot of the display` : ''}`
  if (publish) setScreen(owner, screen)
  noteScreenshot(owner, screen.toolUseId, file)
  const line = `screenshot: ${file} — display ${display.index} (${screenMapSizeWords(screen)}) at scale ${factor} · ${frameWords} · ${await factsLine(driver, screen)}`
  return {
    ok: true,
    line,
    imagePath: file,
    ...(inlinePath !== undefined ? { inlinePath } : {}),
    ...(inlineMediaType !== undefined ? { inlineMediaType } : {}),
    screen,
  }
}

function textOnlyRefusal(model: string, route: string | null): string {
  const where = route !== null ? `on the ${providerDisplayName(route)} route` : 'on its route'
  return `the Computer tool needs a model that receives images; ${model} ${where} receives text only in this release — switch to a model on a route that carries images (/model)`
}

function imageRefusalText(model: string, route: string | null, error: string): string {
  const where = route !== null ? providerDisplayName(route) : 'its'
  return `the model on the ${where} route refused the image: ${error} — ${model} cannot drive the screen until the route carries images; switch to a model that receives images (/model)`
}

export async function routeRefusal(model: string, signal?: AbortSignal): Promise<string | null> {
  const verdict = classifyModelRoute(model)
  const route = verdict.kind === 'route' ? verdict.route : null
  if (route === 'openai-compat') {
    await refreshCompatModelImageReading(model, signal)
    const reading = compatModelImageReading(model)
    if (reading?.supported === true) return null
    const serverRefusal = compatImageRefusalWords(model, imageRefusedFor(normalizeModelStringForAPI(model)) ?? undefined)
    if (serverRefusal !== null) return `the Computer tool needs a model that receives images; ${serverRefusal}`
  }
  if (!modelReceivesImageBlocks(model)) return textOnlyRefusal(model, route)
  if (route === 'openai') {
    const { imagesSupportedForModel } = await import('../../../models/roads/openai/openaiCallModel.js')
    if (!imagesSupportedForModel(model)) return textOnlyRefusal(model, route)
  }
  const refused = imageRefusedFor(normalizeModelStringForAPI(model))
  if (refused !== null) return imageRefusalText(model, route, refused)
  return null
}

export function ruleFor(permissionContext: ToolPermissionContext | undefined, content: string): PermissionRule | null {
  if (!permissionContext) return null
  for (const behavior of ['deny', 'ask', 'allow'] as const) {
    const rule = getRuleByContentsForToolName(permissionContext, COMPUTER_TOOL_NAME, behavior).get(content)
    if (rule) return rule
  }
  return null
}

export function ruleVerdict(permissionContext: ToolPermissionContext | undefined, content: string): 'deny' | 'ask' | 'allow' | null {
  return ruleFor(permissionContext, content)?.ruleBehavior ?? null
}

export function denied(message: string, reason: string) {
  return { behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason } }
}

export function computerResultBlock(output: Output, toolUseId: string) {
  const list = output.images
  if (!list || list.length <= 1) return imageResultBlock(output, toolUseId)
  if (!modelReceivesImageBlocks(getEngineModel())) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: `${output.result}\n(images not inlined — this model takes no image input; open the files to view them)`,
    }
  }
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } }> = [
    { type: 'text', text: output.result },
  ]
  const notes: string[] = []
  for (const image of list) {
    const filePath = image.inlinePath ?? image.imagePath
    try {
      const bytes = readFileSync(filePath)
      const mediaType = (image.inlinePath ? (image.inlineMediaType ?? 'image/png') : 'image/png') as 'image/png'
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } })
    } catch (error) {
      notes.push(`(image not inlined — could not read ${filePath} (${errorMessage(error)}))`)
    }
  }
  if (notes.length > 0) blocks[0] = { type: 'text', text: `${output.result}\n${notes.join('\n')}` }
  return {
    tool_use_id: toolUseId,
    type: 'tool_result' as const,
    content: blocks,
  }
}
