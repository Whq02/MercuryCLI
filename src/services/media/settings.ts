import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getInitialSettings, getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'
import { getMercuryHome } from '../../utils/envUtils.js'

export type MediaKind = 'image' | 'video'
export type MediaSettings = { enabled?: boolean; root?: string; imageModel?: string; videoModel?: string; serverPath?: string }
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
  return { ...settings, enabled: getSettingsForSource('localSettings')?.media?.enabled ?? trusted?.enabled ?? false, serverPath: trusted?.serverPath }
}

export function mediaRoot(settings: MediaSettings = readMediaSettings()): string {
  const path = settings.root?.trim()
  if (!path) return join(getMercuryHome(), 'media')
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error('Media folder must be an absolute path.')
  return resolve(expanded)
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
  return module
}

export function mediaEnvironment(settings: MediaSettings = readMediaSettings()): Record<string, string> {
  if (settings.serverPath && !isAbsolute(settings.serverPath)) throw new Error('media.serverPath must be an absolute path.')
  return { MEDIA_ROOT: mediaRoot(settings) }
}

export async function saveMediaSettings(patch: MediaSettings): Promise<void> {
  const before = readMediaSettings()
  const next = { ...before, ...patch }
  const root = mediaRoot(next)
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
    if (!existsSync(root)) return { status: 'warn', evidence: 'Media folder missing · /imagesetup', fix: '/imagesetup' }
    const record = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) as { binary?: string; server?: string }
    const binary = record.binary ?? record.server
    if (!binary || !existsSync(isAbsolute(binary) ? binary : join(root, binary))) throw new Error('runtime missing')
    return { status: 'ok', evidence: root }
  } catch {
    return { status: 'warn', evidence: 'Media runtime missing · /imagesetup', fix: '/imagesetup' }
  }
}
