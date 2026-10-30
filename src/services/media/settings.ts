import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getInitialSettings, getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { readHostRecord } from '../host/store.js'
import { LLM_HOST_WORDS } from '../../commands/llmhost/words.js'

export type MediaKind = 'image' | 'video'
export type MediaSettings = { enabled?: boolean; root?: string; host?: string; imageModel?: string; videoModel?: string; serverPath?: string }
export type MediaConfig = { imageModel?: string; videoModel?: string; outputs?: string; logs?: string; jobCap?: number; ports?: { image?: number; video?: number }; nice?: number; deadlines?: Record<string, number> }
type MediaConfigModule = {
  readMediaConfig: (root: string) => MediaConfig | Promise<MediaConfig>
  writeMediaConfig: (root: string, patch: MediaConfig) => unknown | Promise<unknown>
}
const MEDIA_EXTENSION_NAME = 'mercury-media'
export const MEDIA_EXTENSION_ID = 'mercury-media@mercury'
export const MEDIA_SERVER_NAME = 'ext:mercury-media:engine'

export function readMediaSettings(): MediaSettings {
  const settings = getInitialSettings().media ?? {}
  const trusted = getSettingsForSource('userSettings')?.media
  return { ...settings, enabled: getSettingsForSource('localSettings')?.media?.enabled ?? trusted?.enabled ?? false, host: getSettingsForSource('localSettings')?.media?.host ?? trusted?.host, serverPath: trusted?.serverPath }
}

export function mediaRoot(settings: MediaSettings = readMediaSettings()): string {
  const path = settings.root?.trim() || join(getMercuryHome(), 'media')
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error('Media folder must be an absolute path.')
  if (settings.host && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(settings.host)) throw new Error('Media setup returned an unreadable response.')
  return settings.host ? join(resolve(expanded), 'hosts', settings.host) : resolve(expanded)
}

export async function mediaBundleRoot(): Promise<string> {
  const { bundledRoster } = await import('../../extensions/bundled/index.js')
  const entry = bundledRoster().find(item => item.name === MEDIA_EXTENSION_NAME)
  if (!entry) throw new Error('Media extension is missing. Reinstall Mercury.')
  return entry.root
}

export async function mediaServerPath(settings: MediaSettings = readMediaSettings()): Promise<string> {
  if (settings.serverPath) {
    if (!isAbsolute(settings.serverPath)) throw new Error('media.serverPath must be an absolute path.')
    return settings.serverPath
  }
  return join(await mediaBundleRoot(), 'server', 'server.js')
}

export async function mediaConfigModule(settings: MediaSettings = readMediaSettings()): Promise<MediaConfigModule> {
  const file = join(dirname(await mediaServerPath(settings)), 'config.js')
  const module = await import(pathToFileURL(file).href) as MediaConfigModule
  if (typeof module.readMediaConfig !== 'function' || typeof module.writeMediaConfig !== 'function') throw new Error('Media config reader is missing. Reinstall Mercury.')
  if (settings.host) return {
    readMediaConfig: async root => ({ ...await module.readMediaConfig(root), ...await (await import('./host.js')).readMediaHostDefaults(settings) }),
    writeMediaConfig: async (root, patch) => {
      const slots = { ...(patch.imageModel !== undefined ? { imageModel: patch.imageModel } : {}), ...(patch.videoModel !== undefined ? { videoModel: patch.videoModel } : {}) }
      if (Object.keys(slots).length) await (await import('./host.js')).setMediaHostDefaults(settings, slots)
      return module.writeMediaConfig(root, patch)
    },
  }
  return module
}

type MediaWorkflowMapping = { node: string; type: string; fields?: Record<string, unknown>; note?: string }
type MediaWorkflowPlan = { format: 'ui' | 'api'; request: Record<string, unknown>; mapping: MediaWorkflowMapping[]; skipped: MediaWorkflowMapping[]; overrides: string[] }
type MediaWorkflowModule = {
  parseWorkflow: (text: string) => unknown
  planWorkflow: (graph: unknown, catalogue: { models: unknown[]; files: unknown[] }, options: { dir: string; overrides?: Record<string, unknown>; registries?: { loras?: Record<string, unknown>; embeddings?: Record<string, unknown> } }) => MediaWorkflowPlan
  mergeWorkflowRequest: (plan: MediaWorkflowPlan, input: Record<string, unknown>) => Record<string, unknown>
  referenceDimensions: (path: string, multiple: number) => { width: number; height: number }
}

export async function mediaWorkflowModule(settings: MediaSettings = readMediaSettings()): Promise<MediaWorkflowModule> {
  const file = join(dirname(await mediaServerPath(settings)), 'workflow.js')
  const module = await import(pathToFileURL(file).href) as MediaWorkflowModule
  if (typeof module.parseWorkflow !== 'function' || typeof module.planWorkflow !== 'function' || typeof module.mergeWorkflowRequest !== 'function' || typeof module.referenceDimensions !== 'function') throw new Error('Media workflow reader is missing. Reinstall Mercury.')
  return module
}

export function mediaEnvironment(settings: MediaSettings = readMediaSettings()): Record<string, string> {
  if (settings.serverPath && !isAbsolute(settings.serverPath)) throw new Error('media.serverPath must be an absolute path.')
  const root = mediaRoot(settings)
  const remote = settings.host ? join(getMercuryHome(), 'host', 'media', settings.host) : undefined
  return { MEDIA_ROOT: root, ...(remote ? { MEDIA_REMOTE_STATE: join(remote, 'connection.json'), MEDIA_REMOTE_ACTIVITY: join(remote, 'activity.json'), MEDIA_REMOTE_ID: settings.host! } : {}) }
}

export async function saveMediaSettings(patch: MediaSettings): Promise<void> {
  const before = readMediaSettings()
  const next = { ...before, ...patch }
  const root = mediaRoot(next)
  if (patch.host) (await import('./host.js')).requireMediaHost(patch.host)
  if (patch.imageModel !== undefined || patch.videoModel !== undefined) {
    const { readMediaCatalogue } = await import('./catalogue.js')
    const catalogue = await readMediaCatalogue(next)
    for (const kind of ['image', 'video'] as const) {
      const model = patch[kind === 'image' ? 'imageModel' : 'videoModel']
      if (model !== undefined && !catalogue.models.some(row => row.id === model && row.kind === kind && !row.control && !row.upscaler)) throw new Error(`Choose a ${kind} model from /imagesetup.`)
    }
  }
  const slots: MediaConfig = {
    ...(patch.imageModel !== undefined ? { imageModel: patch.imageModel } : {}),
    ...(patch.videoModel !== undefined ? { videoModel: patch.videoModel } : {}),
  }
  if (Object.keys(slots).length) await (await mediaConfigModule(next)).writeMediaConfig(root, slots)
  const { imageModel: _image, videoModel: _video, ...stored } = patch
  if (Object.keys(stored).length) {
    const source = stored.serverPath !== undefined ? 'userSettings' : getSettingsForSource('localSettings')?.media ? 'localSettings' : 'userSettings'
    const { error } = updateSettingsForSource(source, { media: stored })
    if (error) throw error
  }
}

export function mediaHealth(settings: MediaSettings = readMediaSettings()): { status: 'off' | 'ok' | 'warn'; evidence: string; fix?: string } {
  if (settings.imageModel !== undefined || settings.videoModel !== undefined) return { status: 'warn', evidence: `Default media models live in ${join(mediaRoot(settings), 'config.json')} · /config`, fix: 'Remove media.imageModel and media.videoModel from Mercury settings; choose the slots in /config.' }
  if (!settings.enabled) return { status: 'off', evidence: 'off' }
  try {
    const root = mediaRoot(settings)
    if (settings.host) {
      const host = readHostRecord(settings.host)
      if (!host || host.status === 'TERMINATED') return { status: 'warn', evidence: LLM_HOST_WORDS.terminatedPod, fix: '/llmhost' }
      if (host.status === 'EXITED' || host.jobState === 'stopped') return { status: 'warn', evidence: LLM_HOST_WORDS.stoppedDisk, fix: '/llmhost' }
      const saved = JSON.parse(readFileSync(join(root, 'host.json'), 'utf8')) as { installed: boolean; location: string }
      return saved.installed ? { status: 'ok', evidence: saved.location } : { status: 'warn', evidence: 'Media runtime missing · /imagesetup', fix: '/imagesetup' }
    }
    if (!existsSync(root)) return { status: 'warn', evidence: 'Media folder missing · /imagesetup', fix: '/imagesetup' }
    const record = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) as { binary?: string; server?: string }
    const binary = record.binary ?? record.server
    if (!binary || !existsSync(isAbsolute(binary) ? binary : join(root, binary))) throw new Error('runtime missing')
    return { status: 'ok', evidence: root }
  } catch {
    return { status: 'warn', evidence: 'Media runtime missing · /imagesetup', fix: '/imagesetup' }
  }
}
