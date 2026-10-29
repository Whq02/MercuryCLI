import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { Tool } from '../../Tool.js'
import { createAssistantMessage } from '../../utils/messages/factories.js'
import { getCwd } from '../../utils/cwd.js'
import { readMediaCatalogue, type MediaCatalogue } from './catalogue.js'
import { mediaConfigModule, mediaRoot, readMediaSettings, MEDIA_SERVER_NAME, type MediaConfig, type MediaKind } from './settings.js'

export function mediaGenerationKind(tool: Pick<Tool, 'mcpInfo'>): MediaKind | undefined {
  if (tool.mcpInfo?.serverName !== MEDIA_SERVER_NAME) return undefined
  return tool.mcpInfo.toolName === 'image_generate' ? 'image' : tool.mcpInfo.toolName === 'video_generate' ? 'video' : undefined
}

export function mediaGenerationDetails(kind: MediaKind, input: Record<string, unknown>, catalogue: MediaCatalogue, config: MediaConfig, cwd: string): string {
  const slot = kind === 'image' ? 'imageModel' : 'videoModel'
  const id = typeof input.model === 'string' ? input.model : config[slot]
  const model = catalogue.models.find(row => row.id === id && row.kind === kind && !row.control)
  if (!model) throw new Error(`Choose the ${kind} model in /imagesetup.`)
  const minimax = (model.recipe ?? model.id) === 'minimax-h3-fl2va'
  const width = input.width ?? model.width ?? (kind === 'image' ? 1024 : minimax ? 864 : 1280)
  const height = input.height ?? model.height ?? (kind === 'image' ? 1024 : minimax ? 480 : 704)
  const output = config.outputs ?? join(typeof input.cwd === 'string' ? input.cwd : cwd, 'media')
  const length = kind === 'video' ? ` · ${input.seconds !== undefined ? `${input.seconds} s` : `${input.frames ?? model.frames ?? (minimax ? 56 : 49)} frames`} · ${input.fps ?? model.fps ?? 24} fps` : ''
  const reference = input.reference_image ?? input.image
  const downsize = Number(input.downsize ?? model.downsize ?? 1)
  const saved = kind === 'image' && downsize > 1 ? ` · saved at ${Math.round(Number(width) / downsize)}×${Math.round(Number(height) / downsize)}` : ''
  return [`${model.id}${input.model === undefined ? ` · default ${kind}` : ''}`, `${width}×${height} · ${input.steps ?? model.steps} steps${length}${saved}`, `Output: ${output}`, ...(typeof reference === 'string' ? [`Reference: ${reference}${kind === 'image' ? ` · strength ${input.strength ?? 0.75}${typeof input.mask === 'string' ? ` · mask ${input.mask}` : ''}` : ''}`] : []), ...(typeof input.prompt === 'string' ? [`Prompt: ${input.prompt}`] : [])].join('\n')
}

export async function readMediaGenerationDetails(kind: MediaKind, input: Record<string, unknown>, cwd: string): Promise<string> {
  const settings = readMediaSettings()
  const [catalogue, config] = await Promise.all([readMediaCatalogue(settings), mediaConfigModule(settings).then(module => module.readMediaConfig(mediaRoot(settings)))])
  return mediaGenerationDetails(kind, input, catalogue, config, cwd)
}

export type MediaTestImage = { path: string; png: Buffer }
export async function generateMediaTestImage(model: string, context: LocalJSXCommandContext, controller: AbortController, onStart?: () => void): Promise<MediaTestImage> {
  const tool = (context.options.refreshTools?.() ?? context.options.tools).find(tool => mediaGenerationKind(tool) === 'image')
  if (!tool || !context.canUseTool) throw new Error('Turn on Local media in /config, then reopen /imagesetup in a session.')
  const input = { model, prompt: 'A red apple on a wooden table, soft daylight', width: 256, height: 256, wait: true, cwd: getCwd() }
  const id = randomUUID()
  const message = createAssistantMessage({ content: [{ type: 'tool_use', id, name: tool.name, input }], isVirtual: true })
  const callContext = { ...context, abortController: controller, toolUseId: id }
  const permission = await context.canUseTool(tool, input, callContext, message, id)
  if (permission.behavior !== 'allow') throw new Error('Image cancelled.')
  controller.signal.throwIfAborted()
  onStart?.()
  const result = await tool.call(permission.updatedInput ?? input, callContext, context.canUseTool, message)
  const content = result.data as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  const image = Array.isArray(content) ? content.find(part => part.type === 'image' && part.mimeType === 'image/png' && typeof part.data === 'string') : undefined
  const text = Array.isArray(content) ? content.find(part => part.type === 'text')?.text : undefined
  if (!image?.data) throw new Error(text ?? 'No image returned.')
  const facts = text ? JSON.parse(text) as { path?: string } : {}
  if (!facts.path) throw new Error('Image output path is missing.')
  return { path: facts.path, png: Buffer.from(image.data, 'base64') }
}
