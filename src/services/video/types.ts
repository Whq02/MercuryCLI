import { z } from 'zod/v4'

export const VideoProviderSettingsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9_-]+$/),
  z.strictObject({
    kind: z.literal('minimax'),
    baseUrl: z.url().optional(),
    model: z.string().min(1).optional(),
  }),
)

export type VideoProviderSettings = z.infer<typeof VideoProviderSettingsSchema>
export type VideoProviderConfig = VideoProviderSettings[string]
export type VideoRole = 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio'
type VideoAspect = 'adaptive' | '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16'

export interface VideoInput {
  prompt: string
  provider?: string
  references?: Array<{ path: string; role?: VideoRole }>
  duration?: number
  aspect?: VideoAspect
  ratio?: VideoAspect
  resolution?: '480P' | '768P' | '2K'
  extra?: { prompt_expansion_mode?: 'disabled' | 'balanced' | 'quality' }
  callback_url?: string
  outputDir?: string
  timeoutSeconds?: number
}

export interface VideoJob {
  model: string
  content: Array<Record<string, unknown>>
  duration: number
  resolution: string
  ratio: VideoAspect
  extra?: VideoInput['extra']
  callback_url?: string
}

export interface VideoStatus {
  id: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  duration?: number
  url?: string
  usage?: Record<string, number>
  error?: string
}

export interface VideoProvider {
  readonly pollIntervalMs: number
  create(job: VideoJob, signal: AbortSignal): Promise<string>
  status(id: string, signal: AbortSignal): Promise<VideoStatus>
  fetch(id: string, signal: AbortSignal): Promise<Uint8Array>
}

export interface VideoOutput {
  result: string
  outcome: 'succeeded' | 'failed' | 'indeterminate'
  jobId?: string
  duration?: number
  path?: string
  framePath?: string
  usage?: Record<string, number>
}
