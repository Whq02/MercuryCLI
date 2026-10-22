import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { VideoProviderRefusal } from './minimax.js'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { setTimeout as delay } from 'node:timers/promises'
import { createVideoProvider, videoProviderSelection } from './registry.js'
import type { VideoInput, VideoJob, VideoOutput, VideoRole, VideoStatus } from './types.js'

const MEDIA: Record<string, { type: 'image' | 'video' | 'audio'; mime: string; max: number }> = {
  '.jpg': { type: 'image', mime: 'image/jpeg', max: 30 },
  '.jpeg': { type: 'image', mime: 'image/jpeg', max: 30 },
  '.png': { type: 'image', mime: 'image/png', max: 30 },
  '.webp': { type: 'image', mime: 'image/webp', max: 30 },
  '.heic': { type: 'image', mime: 'image/heic', max: 30 },
  '.heif': { type: 'image', mime: 'image/heif', max: 30 },
  '.mp4': { type: 'video', mime: 'video/mp4', max: 50 },
  '.mov': { type: 'video', mime: 'video/mp4', max: 50 },
  '.mp3': { type: 'audio', mime: 'audio/mp3', max: 15 },
  '.wav': { type: 'audio', mime: 'audio/wav', max: 15 },
}

export async function projectVideoPath(project: string, value: string): Promise<string> {
  const root = await realpath(project)
  const target = resolve(root, value)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Video paths must stay inside the project folder.')
  let cursor = root
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Video paths must not pass through symbolic links.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return target
}

export async function prepareVideo(input: VideoInput, project: string): Promise<{
  selection: ReturnType<typeof videoProviderSelection>
  outputDir: string
  references: Array<{ path: string; role: VideoRole; media: typeof MEDIA[string] }>
  job: VideoJob
}> {
  const selection = videoProviderSelection(input.provider)
  const outputDir = await projectVideoPath(project, input.outputDir ?? 'videos')
  try {
    if (!(await lstat(outputDir)).isDirectory()) throw new Error('Video outputDir must be a directory.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const references = await Promise.all((input.references ?? []).map(async reference => {
    const path = await projectVideoPath(project, reference.path)
    const media = MEDIA[extname(path).toLowerCase()]
    if (!media) throw new Error(`Video reference format is not supported: ${extname(path) || '(no extension)'}.`)
    const stat = await lstat(path)
    if (!stat.isFile()) throw new Error(`Video reference is not a regular file: ${reference.path}`)
    if (stat.size > media.max * 1024 * 1024) throw new Error(`MiniMax ${media.type} reference exceeds its documented ${media.max} MB limit: ${reference.path}`)
    const role = reference.role ?? `reference_${media.type}` as VideoRole
    if (media.type === 'image' ? !['first_frame', 'last_frame', 'reference_image'].includes(role) : role !== `reference_${media.type}`) {
      throw new Error(`Video reference role ${role} does not match ${reference.path}.`)
    }
    return { path, role, media }
  }))
  const frameMode = references.some(reference => ['first_frame', 'last_frame'].includes(reference.role))
  if (frameMode && references.some(reference => reference.role.startsWith('reference_'))) throw new Error('MiniMax cannot mix first/last frames with reference image, video or audio inputs.')
  for (const [role, max] of [['first_frame', 1], ['last_frame', 1], ['reference_image', 9], ['reference_video', 3], ['reference_audio', 3]] as const) {
    if (references.filter(reference => reference.role === role).length > max) throw new Error(`MiniMax accepts at most ${max} ${role} inputs.`)
  }
  if (references.length > 12) throw new Error('MiniMax accepts at most 12 reference files per request.')
  if (input.aspect && input.ratio && input.aspect !== input.ratio) throw new Error('Video aspect and ratio must agree when both are supplied.')
  const ratio = input.ratio ?? input.aspect ?? (references.length ? 'adaptive' : '16:9')
  if (!references.length && ratio === 'adaptive') throw new Error('MiniMax text-to-video needs a concrete aspect ratio, not adaptive.')
  if (frameMode && ratio !== 'adaptive') throw new Error('MiniMax first/last-frame generation uses the image aspect; use aspect: adaptive.')
  const duration = input.duration ?? 5
  const resolution = input.resolution ?? '768P'
  const extra = input.extra?.prompt_expansion_mode === undefined ? undefined : input.extra
  if (selection.model === 'MiniMax-H3' && resolution === '480P') throw new Error('MiniMax-H3 supports 768P or 2K.')
  if (selection.model === 'MiniMax-H3-Max' && (duration < 5 || resolution === '2K')) throw new Error('MiniMax-H3-Max supports 5–15 seconds and 480P or 768P.')
  if (extra && selection.model === 'MiniMax-H3') throw new Error('MiniMax documents extra.prompt_expansion_mode for MiniMax-H3-Max only.')
  return {
    selection, outputDir, references,
    job: { model: selection.model, content: [{ type: 'text', text: input.prompt }], duration, resolution, ratio,
      ...(extra ? { extra } : {}), ...(input.callback_url ? { callback_url: input.callback_url } : {}) },
  }
}

async function frameGrab(path: string, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolveFrame, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true, env: subprocessEnv() })
    const chunks: Buffer[] = []
    let error = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1000) })
    child.once('error', reject)
    child.once('close', code => {
      const bytes = Buffer.concat(chunks)
      if (code === 0 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) resolveFrame(bytes)
      else reject(new Error(error.trim() || `ffmpeg exited ${code} without a PNG frame`))
    })
  })
}

async function saveNewFile(project: string, path: string, bytes: Uint8Array): Promise<void> {
  await projectVideoPath(project, path)
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { await file.writeFile(bytes) } catch (error) {
    await file.close()
    await projectVideoPath(project, path)
    await unlink(path)
    throw error
  } finally { await file.close() }
}

export async function generateVideo(input: VideoInput, project: string, parentSignal: AbortSignal): Promise<VideoOutput> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Video deadline reached')), (input.timeoutSeconds ?? 1200) * 1000)
  timeout.unref?.()
  const abort = (): void => controller.abort(parentSignal.reason)
  if (parentSignal.aborted) abort()
  else parentSignal.addEventListener('abort', abort, { once: true })
  const signal = controller.signal
  let jobId: string | undefined
  let submitting = false
  let remoteTerminal = false
  try {
    signal.throwIfAborted()
    const plan = await prepareVideo(input, project)
    for (const reference of plan.references) {
      await projectVideoPath(project, reference.path)
      const file = await open(reference.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      try { bytes = await file.readFile({ signal }) } finally { await file.close() }
      if (bytes.length > reference.media.max * 1024 * 1024) throw new Error(`MiniMax ${reference.media.type} reference exceeds its documented ${reference.media.max} MB limit.`)
      const type = `${reference.media.type}_url`
      plan.job.content.push({ type, [type]: { url: `data:${reference.media.mime};base64,${bytes.toString('base64')}` }, role: reference.role })
    }
    if (Buffer.byteLength(JSON.stringify(plan.job)) > 64 * 1024 * 1024) throw new Error('MiniMax video request exceeds the documented 64 MB limit after Base64 encoding; use smaller project reference files.')
    signal.throwIfAborted()
    const provider = createVideoProvider(plan.selection)
    submitting = true
    jobId = await provider.create(plan.job, signal)
    let task: VideoStatus
    do {
      await delay(provider.pollIntervalMs, undefined, { signal })
      task = await provider.status(jobId, signal)
    } while (task.state === 'queued' || task.state === 'running')
    remoteTerminal = true
    if (task.state !== 'succeeded') return { outcome: 'failed', result: task.error ?? `MiniMax video task ${task.state}.`, jobId }
    const bytes = await provider.fetch(jobId, signal)
    await projectVideoPath(project, plan.outputDir)
    await mkdir(plan.outputDir, { recursive: true })
    const path = join(plan.outputDir, `video-${randomUUID()}.mp4`)
    await saveNewFile(project, path, bytes)
    const lines = [`Video saved: ${path}`, `Duration: ${task.duration ?? plan.job.duration}s`, `MiniMax job: ${jobId}`]
    const usage = task.usage
    lines.push(usage && Object.keys(usage).length ? `MiniMax usage: ${Object.entries(usage).map(([name, value]) => `${name}=${value}`).join(', ')}; monetary charge not reported by the API.` : 'MiniMax did not report usage or a monetary charge.')
    let framePath: string | undefined
    try {
      const png = await frameGrab(path, signal)
      framePath = join(dirname(path), `${path.slice(dirname(path).length + 1, -4)}.png`)
      await saveNewFile(project, framePath, png)
      lines.push(`Frame at 1s: ${framePath}`)
    } catch (error) {
      framePath = undefined
      const note = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg is not installed' : (error as Error).message.replace(/\s+/g, ' ')
      lines.push(`Frame grab skipped — ${note}; the MP4 is saved.`)
    }
    return { outcome: 'succeeded', result: lines.join('\n'), jobId, path, framePath, duration: task.duration ?? plan.job.duration, usage }
  } catch (error) {
    const message = signal.aborted ? (parentSignal.aborted ? 'Video cancelled locally' : 'Video deadline reached') : (error as Error).message
    const uncertain = submitting && !remoteTerminal && !(error instanceof VideoProviderRefusal && !jobId)
    const pending = jobId && !remoteTerminal ? `\nMiniMax job ${jobId} may still be running; stopping this call does not cancel the vendor job. Do not submit it again automatically.` : jobId ? `\nMiniMax job: ${jobId}` : uncertain ? '\nThe create request may have reached MiniMax; do not resubmit automatically.' : ''
    return { outcome: uncertain ? 'indeterminate' : 'failed', result: `${message}${pending}`, ...(jobId ? { jobId } : {}) }
  } finally {
    clearTimeout(timeout)
    parentSignal.removeEventListener('abort', abort)
  }
}
