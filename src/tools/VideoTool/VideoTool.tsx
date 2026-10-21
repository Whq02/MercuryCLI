import React from 'react'
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getEngineModel } from '../../utils/model/model.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { readImageWithTokenBudget } from '../FileReadTool/FileReadTool.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { generateVideo, prepareVideo, projectVideoPath } from '../../services/video/generate.js'
import { videoToolEnabled } from '../../services/video/registry.js'
import type { VideoInput, VideoOutput } from '../../services/video/types.js'
import { VIDEO_PROMPT } from './prompt.js'
import { VideoToolResult } from './VideoToolResult.js'

const aspect = () => z.enum(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
const inputSchema = lazySchema(() => z.strictObject({
  prompt: z.string().trim().min(1).max(7000).describe('The video to generate; sent to the configured billable provider'),
  provider: z.string().optional().describe('The configured videoProvider entry; required when there is more than one'),
  references: z.array(z.strictObject({
    path: z.string().min(1),
    role: z.enum(['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']).optional(),
  })).optional().describe('Project-local images, clips or audio to send; omitted roles select the matching reference role'),
  duration: z.number().int().min(4).max(15).optional().describe('Seconds of generated video, default 5; H3-Max needs at least 5'),
  aspect: aspect().optional().describe('Output aspect; default 16:9 for text, adaptive with references'),
  ratio: aspect().optional().describe('MiniMax spelling of aspect; both must agree if supplied'),
  resolution: z.enum(['480P', '768P', '2K']).optional().describe('MiniMax resolution; default 768P'),
  extra: z.strictObject({ prompt_expansion_mode: z.enum(['disabled', 'balanced', 'quality']).optional() }).optional(),
  callback_url: z.url().optional().describe('MiniMax callback URL; task updates are also sent to this address'),
  outputDir: z.string().min(1).optional().describe('Destination directory inside the project; default videos/'),
  timeoutSeconds: z.number().int().min(1).max(2_147_483).optional().describe('Local deadline, default 1200 seconds; stopping locally does not cancel the vendor job'),
}))

type Output = VideoOutput & { inlinePath?: string; inlineMediaType?: string }

export const VideoTool = buildTool({
  name: 'Video',
  inputSchema: inputSchema(),
  searchHint: 'generate AI video from prompt images clips audio MiniMax H3 save MP4 frame',
  shouldDefer: true,
  maxResultSizeChars: 20_000,
  capability: {
    intents: ['generate a video from a prompt', 'animate an image with a video generator', 'create a video using image video or audio references'],
    units: ['video-generation'],
    class: 'mutation',
    evidence: ['artifact', 'change'],
    conditions: ['a configured videoProvider and its MiniMax sign-in'],
    cancellation: 'cooperative',
    latency: 'long-running',
    proof: 'scripts/tools/prove-video-tool.ts',
  },
  async description() { return 'Generate a billable video through the configured provider and save the MP4 and optional preview frame inside the project' },
  async prompt() { return VIDEO_PROMPT },
  isEnabled: videoToolEnabled,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isOpenWorld: () => true,
  interruptBehavior: () => 'cancel',
  async validateInput(input: VideoInput) {
    try { await prepareVideo(input, getCwd()); return { result: true as const } }
    catch (error) { return { result: false as const, message: (error as Error).message } }
  },
  async checkPermissions(input: VideoInput) {
    try {
      const plan = await prepareVideo(input, getCwd())
      return {
        behavior: 'ask' as const,
        message: `Generate a billable video with ${plan.selection.name} (${plan.selection.model}) at ${plan.selection.baseUrl}?\nPrompt: ${input.prompt}\nSend references: ${plan.references.map(reference => `${reference.path} (${reference.role})`).join(', ') || 'none'}\nOutput: ${plan.job.duration}s, ${plan.job.resolution}, ${plan.job.ratio} → ${plan.outputDir}${input.callback_url ? `\nSend task callbacks to: ${input.callback_url}` : ''}`,
        updatedInput: { ...input, provider: plan.selection.name },
      }
    } catch (error) {
      return { behavior: 'deny' as const, message: (error as Error).message, decisionReason: { type: 'other' as const, reason: (error as Error).message } }
    }
  },
  async call(input: VideoInput, context: ToolUseContext) {
    const startedAt = Date.now()
    const project = getCwd()
    const data: Output = await generateVideo(input, project, context.abortController.signal)
    if (data.framePath && modelReceivesImageBlocks(context.options.engineModel)) {
      try {
        const image = await readImageWithTokenBudget(data.framePath)
        data.inlinePath = `${data.framePath}.inline`
        data.inlineMediaType = image.file.type
        await projectVideoPath(project, data.inlinePath)
        writeFileSync(data.inlinePath, Buffer.from(image.file.base64, 'base64'), { flag: 'wx', mode: 0o600 })
      } catch {
        delete data.inlinePath
        delete data.inlineMediaType
        data.result += '\nPreview could not be prepared for the model; open the saved frame.'
      }
    }
    return { data, effect: {
      operation: 'video.generate', outcome: data.outcome,
      changedPaths: [data.path, data.framePath, data.inlinePath].filter((path): path is string => !!path),
      evidence: data.result, startedAt, completedAt: Date.now(),
      details: { jobId: data.jobId, duration: data.duration, usage: data.usage },
    } }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    if (output.inlinePath && modelReceivesImageBlocks(getEngineModel())) {
      try {
        return { type: 'tool_result' as const, tool_use_id: toolUseId, content: [
          { type: 'text' as const, text: output.result },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: (output.inlineMediaType ?? 'image/png') as 'image/png', data: readFileSync(output.inlinePath).toString('base64') } },
        ] }
      } catch { }
    }
    return { type: 'tool_result' as const, tool_use_id: toolUseId, content: output.result, is_error: output.outcome !== 'succeeded' }
  },
  renderToolUseMessage(input: Partial<VideoInput>) { return input.prompt ?? 'Generate video' },
  renderToolUseErrorMessage(result: Parameters<typeof FallbackToolUseErrorMessage>[0]['result'], options: { verbose: boolean }) { return <FallbackToolUseErrorMessage result={result} verbose={options.verbose} /> },
  renderToolResultMessage(output: Output) { return <VideoToolResult output={output} /> },
  extractSearchText(output: Output) { return output.result },
})
