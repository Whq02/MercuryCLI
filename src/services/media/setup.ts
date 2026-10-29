import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { gbWords, gibWords } from '../localServer/localServerMemory.js'
import { resolveSetupIo } from '../localSetup/setupIo.js'
import { stripTerminalControls } from '../../utils/stringUtils.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { mediaCheckpointFile, mediaCheckpointInstalled, mediaFileInstalled, mediaModelFiles, mediaModelJoined, mediaPartialBytes, readMediaCatalogue, type MediaCatalogue, type MediaModel } from './catalogue.js'
import { mediaConfigModule, mediaEnvironment, mediaHealth, mediaRoot, mediaServerPath, readMediaSettings, type MediaConfig, type MediaSettings } from './settings.js'

type MediaFit = { residentBytes: number; peakMetalBytes: number; fits: boolean; diskFits: boolean }
type MediaRow = { model: MediaModel; installed: boolean; bytes: number; pullBytes: number; fit: MediaFit; words: string }
type MediaRuntimeChoice = { variant: string; binary: string; words: string; bytes: number; args: string[] }
export type MediaSnapshot = { root: string; runtimeInstalled: boolean; runtime?: MediaRuntimeChoice; catalogue: MediaCatalogue; config: MediaConfig; totalMemoryBytes: number; usableMemoryBytes: number; freeBytes: number; rows: MediaRow[] }
const GiB = 1024 ** 3
const RUNTIME_WORDS: Record<string, string> = { metal: 'Metal', vulkan: 'Vulkan', cuda12: 'CUDA 12', cpu: 'CPU', rocm: 'ROCm' }

export function mediaRuntimeChoice(catalogue: MediaCatalogue, platform: string = process.platform, arch: string = process.arch, gpu?: 'nvidia' | 'amd'): MediaRuntimeChoice | undefined {
  const variants = catalogue.runtime.platforms[`${platform}-${arch}`]
  if (!variants?.length) return undefined
  const chosen = (gpu === 'nvidia' ? variants.find(row => row.variant === 'cuda12') : undefined) ?? variants[0]!
  return { variant: chosen.variant, binary: chosen.binary, words: RUNTIME_WORDS[chosen.variant] ?? chosen.variant, bytes: chosen.files.reduce((n, file) => n + file.bytes, 0), args: ['pull-runtime', '--variant', chosen.variant] }
}

export function mediaRuntimeRowWords(snapshot: Pick<MediaSnapshot, 'runtime' | 'runtimeInstalled'>): string {
  const name = snapshot.runtime ? `stable-diffusion.cpp (${snapshot.runtime.words})` : 'stable-diffusion.cpp'
  const state = snapshot.runtimeInstalled ? 'installed' : snapshot.runtime ? `pull ${mediaSizeWords(snapshot.runtime.bytes)}` : ''
  return [name, state, 'MIT'].filter(part => part !== '').join(' · ')
}

export function mediaSizeWords(bytes: number): string {
  if (bytes >= 1e9) return gbWords(bytes)
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${Math.round(bytes)} B`
}

function fitMediaRecipeOn(model: MediaModel, catalogue: MediaCatalogue, machine: { totalMemoryBytes: number; usableMemoryBytes: number }, diskBytes: number, freeBytes: number): MediaFit {
  const files = mediaModelFiles(catalogue, model)
  const size = (slots: string[]) => Object.entries(model.slots).filter(([key]) => slots.includes(key)).reduce((n, [, path]) => n + (files.find(file => file.path === path)?.bytes ?? 0), 0)
  const encoder = size(['llm', 'llm_vision', 't5xxl', 'clip_l', 'clip_g'])
  const vae = size(['vae', 'audio_vae'])
  const diffusion = Math.max(0, ...Object.entries(model.slots).filter(([key]) => key.includes('diffusion')).map(([, path]) => files.find(file => file.path === path)?.bytes ?? 0))
  const workspace = (model.kind === 'image' ? 1.5 : model.slots.audio_vae ? 4.5 : 3.5) * GiB
  const residentBytes = model.residentBytes ?? (model.paramsBackend?.includes('te=disk') ? diffusion + vae : files.reduce((n, file) => n + file.bytes, 0)) + Math.max(workspace, 2 * GiB)
  const peakMetalBytes = model.peakMetalBytes ?? Math.max(encoder, diffusion + workspace, vae + 2 * GiB)
  return { residentBytes, peakMetalBytes, fits: (model.peakBytes ?? residentBytes) <= Math.max(0, machine.totalMemoryBytes - 8 * GiB) && peakMetalBytes <= machine.usableMemoryBytes, diskFits: diskBytes <= freeBytes }
}

export function mediaRows(catalogue: MediaCatalogue, root: string, machine: { totalMemoryBytes: number; usableMemoryBytes: number }, freeBytes: number, installed = mediaFileInstalled, checkpointInstalled = mediaCheckpointInstalled): MediaRow[] {
  return catalogue.models.map(model => {
    const files = mediaModelFiles(catalogue, model)
    const bytes = files.reduce((n, file) => n + file.bytes, 0)
    const joined = mediaModelJoined(catalogue, model)
    const whole = checkpointInstalled(root, catalogue, model)
    const missing = whole ? [] : files.filter(file => !installed(root, file))
    const complete = whole || (!joined && missing.length === 0)
    const pullBytes = complete ? 0 : missing.reduce((n, file) => n + file.bytes - mediaPartialBytes(root, file), 0)
    const joinBytes = joined && !whole ? mediaCheckpointFile(model).bytes ?? bytes : 0
    const fit = fitMediaRecipeOn(model, catalogue, machine, pullBytes + joinBytes, freeBytes)
    const words = [complete ? 'installed' : `pull ${gbWords(pullBytes)}`, `${gbWords(bytes)} disk`, ...(joinBytes > 0 ? [`${gbWords(pullBytes + joinBytes)} during the download`] : []), `${gibWords(model.peakBytes ?? fit.residentBytes)} memory`, model.secondsPerImage === undefined ? `— s/${model.kind === 'video' ? 'clip' : 'image'}` : `${Math.round(model.secondsPerImage * 10) / 10} s/${model.kind === 'video' ? 'clip' : 'image'}`, !fit.diskFits ? 'needs disk space' : fit.fits ? 'fits' : 'needs more memory'].join(' · ')
    return { model, installed: complete, bytes, pullBytes, fit, words }
  })
}

function freeDisk(root: string): number {
  let current = root
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current)
  const stat = statfsSync(current)
  return stat.bavail * stat.bsize
}

export async function readMediaSnapshot(settings: MediaSettings = readMediaSettings()): Promise<MediaSnapshot> {
  const root = mediaRoot(settings)
  const [catalogue, config, truth] = await Promise.all([
    readMediaCatalogue(settings),
    mediaConfigModule(settings).then(module => module.readMediaConfig(root)),
    resolveSetupIo().readTruth(),
  ])
  const freeBytes = freeDisk(root)
  const runtime = mediaRuntimeChoice(catalogue, process.platform, process.arch, truth.machine.gpu)
  return { root, runtimeInstalled: mediaRuntimeInstalled(catalogue, root, runtime), ...(runtime ? { runtime } : {}), catalogue, config, totalMemoryBytes: truth.machine.totalMemoryBytes, usableMemoryBytes: truth.machine.usableMemoryBytes, freeBytes, rows: mediaRows(catalogue, root, truth.machine, freeBytes) }
}

export function mediaRuntimeInstalled(catalogue: MediaCatalogue, root: string, runtime: MediaRuntimeChoice | undefined, record = runtimeRecord(root), health = mediaHealth({ root, enabled: true }).status): boolean {
  if (health !== 'ok' || record?.tag !== catalogue.runtime.tag) return false
  if (!runtime) return true
  const installed = record.variant ?? catalogue.runtime.platforms[`${process.platform}-${process.arch}`]?.[0]?.variant
  return installed === runtime.variant
}

export type MediaPullPlan = { args: string[]; title: string; bytes: number; license: string; source: string; root: string }
export type MediaProgress = { event: 'progress' | 'done' | 'error' | 'cancelled'; file?: string; bytes?: number; total?: number; message?: string; [key: string]: unknown }
type MediaSetupRunner = (args: string[], onProgress: (event: MediaProgress) => void, signal?: AbortSignal) => Promise<void>

function mediaLicenseWords(model: MediaModel): string {
  if (model.licenseNotice) return model.licenseNotice
  if (model.license.startsWith('MiniMax H3 Community')) return `${model.license} · Separate licence required in the US, EU, UK and South Korea. Commercial use in applicable territories requires MiniMax H3 attribution; above US$20 million yearly revenue requires written authorisation. https://platform.minimax.io/h3-license`
  return model.license
}

export function mediaPullPlan(snapshot: MediaSnapshot, id?: string): MediaPullPlan {
  if (id === undefined) return { args: snapshot.runtime?.args ?? ['pull-runtime'], title: 'stable-diffusion.cpp', bytes: snapshot.runtime?.bytes ?? 0, license: 'MIT', source: 'github.com/leejet/stable-diffusion.cpp', root: snapshot.root }
  const row = snapshot.rows.find(row => row.model.id === id)
  if (!row) throw new Error('Choose a model from the catalogue.')
  const files = mediaModelFiles(snapshot.catalogue, row.model)
  if (files.some(file => !file.repo || !file.source || !file.sha256)) throw new Error('Add local model files to the models folder, then reopen /imagesetup.')
  return { args: ['pull-model', id], title: id, bytes: row.pullBytes, license: mediaLicenseWords(row.model), source: [...new Set(files.map(file => `huggingface.co/${file.repo}`))].join(', '), root: snapshot.root }
}

export async function pullMedia(plan: MediaPullPlan, consent: (plan: MediaPullPlan) => Promise<boolean>, run: MediaSetupRunner, onProgress: (event: MediaProgress) => void, signal?: AbortSignal): Promise<boolean> {
  if (!await consent(plan)) return false
  signal?.throwIfAborted()
  await run(plan.args, onProgress, signal)
  return true
}

export class MediaSetupPaused extends Error {
  constructor(public progress: MediaProgress) {
    super(`Download paused${typeof progress.bytes === 'number' ? ` · ${mediaSizeWords(progress.bytes)} kept` : ''} · p resumes`)
  }
}

export async function runMediaSetup(args: string[], onProgress: (event: MediaProgress) => void, signal?: AbortSignal, settings: MediaSettings = readMediaSettings()): Promise<void> {
  signal?.throwIfAborted()
  const setup = join(dirname(await mediaServerPath(settings)), 'setup.js')
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [setup, ...args], { env: { ...subprocessEnv(), ...mediaEnvironment(settings) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let error: string | undefined
    let done = false
    let paused: MediaProgress | undefined
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => {
      child.kill('SIGTERM')
      timer ??= setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Download did not return a pause result. Reopen /imagesetup.')) }, 2000)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const cleanup = (): void => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      try {
        const value = JSON.parse(line) as MediaProgress
        if (value.event === 'done') done = true
        else if (value.event === 'cancelled') paused = value
        else if (value.event === 'error') error = value.message ?? 'Media download failed.'
        else if (value.event !== 'progress') return
        onProgress(value)
      } catch { error = 'Media setup returned an unreadable response.' }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096) })
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', code => {
      cleanup()
      lines.close()
      if (paused) {
        if (typeof paused.file === 'string') {
          const rel = relative(mediaRoot(settings), paused.file)
          if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')) {
            for (const file of [`${paused.file}.part`, paused.file]) {
              try { const stat = statSync(file); if (stat.isFile()) { paused.bytes = stat.size; break } } catch {}
            }
          }
        }
        paused.bytes ??= 0
        reject(new MediaSetupPaused(paused))
      } else if (code === 0 && done && !error) resolve()
      else reject(new Error(stripTerminalControls(error ?? stderr.trim() ?? '') || `Media setup exited ${code ?? 'without a result'}.`))
    })
  })
}

export function mediaProgressWords(event: MediaProgress): string {
  if (event.event === 'progress') return `${stripTerminalControls(event.file ?? 'Download')} · ${mediaSizeWords(Number(event.bytes ?? 0))} / ${mediaSizeWords(Number(event.total ?? 0))}`
  return event.event === 'error' ? stripTerminalControls(event.message ?? 'Download failed.') : ''
}

function runtimeRecord(root: string): { tag?: string; variant?: string } | undefined {
  try {
    const record = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) as { tag?: unknown; variant?: unknown }
    return { ...(typeof record.tag === 'string' ? { tag: record.tag } : {}), ...(typeof record.variant === 'string' ? { variant: record.variant } : {}) }
  } catch { return undefined }
}
