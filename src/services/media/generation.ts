import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { Tool } from '../../Tool.js'
import { createAssistantMessage } from '../../utils/messages/factories.js'
import { getCwd } from '../../utils/cwd.js'
import { readMediaCatalogue, type MediaCatalogue } from './catalogue.js'
import { mediaConfigModule, mediaRoot, mediaWorkflowModule, readMediaSettings, MEDIA_SERVER_NAME, type MediaConfig, type MediaKind, type MediaSettings } from './settings.js'

export function mediaGenerationKind(tool: Pick<Tool, 'mcpInfo'>): MediaKind | undefined {
  if (tool.mcpInfo?.serverName !== MEDIA_SERVER_NAME) return undefined
  return tool.mcpInfo.toolName === 'image_generate' ? 'image' : tool.mcpInfo.toolName === 'video_generate' ? 'video' : undefined
}

export function mediaGenerationDetails(kind: MediaKind, input: Record<string, unknown>, catalogue: MediaCatalogue, config: MediaConfig, cwd: string): string {
  const slot = kind === 'image' ? 'imageModel' : 'videoModel'
  const id = typeof input.model === 'string' ? input.model : config[slot]
  const model = catalogue.models.find(row => row.id === id && row.kind === kind && !row.control && !row.upscaler)
  if (!model) throw new Error(`Choose the ${kind} model in /imagesetup.`)
  const minimax = (model.recipe ?? model.id) === 'minimax-h3-fl2va'
  const width = input.width ?? model.width ?? (kind === 'image' ? 1024 : minimax ? 864 : 1280)
  const height = input.height ?? model.height ?? (kind === 'image' ? 1024 : minimax ? 480 : 704)
  const output = config.outputs ?? join(typeof input.cwd === 'string' ? input.cwd : cwd, 'media')
  const length = kind === 'video' ? ` · ${input.seconds !== undefined ? `${input.seconds} s` : `${input.frames ?? model.frames ?? (minimax ? 56 : 49)} frames`} · ${input.fps ?? model.fps ?? 24} fps` : ''
  const reference = input.reference_image ?? input.image
  const downsize = Number(input.downsize ?? model.downsize ?? 1)
  const upscale = Number(input.upscale ?? 1)
  const saved = kind === 'image' && (downsize > 1 || upscale > 1) ? ` · saved at ${Math.floor(Number(width) / downsize) * upscale}×${Math.floor(Number(height) / downsize) * upscale}` : ''
  const workflow = typeof input.workflow === 'string' ? [`Workflow: ${input.workflow}${input.dry === true ? ' · dry run' : ''}`] : []
  return [`${model.id}${input.model === undefined ? ` · default ${kind}` : ''}`, `${width}×${height} · ${input.steps ?? model.steps} steps${length}${saved}`, `Output: ${output}`, ...workflow, ...(typeof reference === 'string' ? [`Reference: ${reference}${kind === 'image' ? ` · strength ${input.strength ?? 0.75}${typeof input.mask === 'string' ? ` · mask ${input.mask}` : ''}` : ''}`] : []), ...(typeof input.prompt === 'string' ? [`Prompt: ${input.prompt}`] : [])].join('\n')
}

function readRegistry(root: string, name: string): Record<string, unknown> | undefined {
  const file = join(root, name)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : undefined
}

export async function readMediaWorkflowRequest(input: Record<string, unknown>, catalogue: MediaCatalogue, cwd: string, settings: MediaSettings = readMediaSettings()): Promise<Record<string, unknown>> {
  if (typeof input.workflow !== 'string') return input
  const path = resolve(cwd, input.workflow)
  const module = await mediaWorkflowModule(settings)
  const root = mediaRoot(settings)
  const plan = module.planWorkflow(module.parseWorkflow(readFileSync(path, 'utf8')), catalogue, { dir: dirname(path), overrides: input, registries: { loras: readRegistry(root, 'loras.json'), embeddings: readRegistry(root, 'embeddings.json') } })
  const request = module.mergeWorkflowRequest(plan, input)
  if (typeof request.reference_image === 'string' && (request.width === undefined || request.height === undefined)) {
    const size = module.referenceDimensions(request.reference_image, catalogue.models.find(row => row.id === request.model)?.multiple ?? 64)
    request.width ??= size.width
    request.height ??= size.height
  }
  return { ...request, workflow: path, ...(input.dry === true ? { dry: true } : {}), ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}) }
}

export async function readMediaGenerationDetails(kind: MediaKind, input: Record<string, unknown>, cwd: string): Promise<string> {
  const settings = readMediaSettings()
  const [catalogue, config] = await Promise.all([readMediaCatalogue(settings), mediaConfigModule(settings).then(module => module.readMediaConfig(mediaRoot(settings)))])
  const request = kind === 'image' ? await readMediaWorkflowRequest(input, catalogue, typeof input.cwd === 'string' ? input.cwd : cwd, settings) : input
  return mediaGenerationDetails(kind, request, catalogue, config, cwd)
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
