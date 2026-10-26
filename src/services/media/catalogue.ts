import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod/v4'
import { mediaBundleRoot, mediaRoot, readMediaSettings, type MediaSettings } from './settings.js'

const positive = z.number().int().positive()
const FileSchema = z.object({ path: z.string().min(1), bytes: positive, repo: z.string().optional(), source: z.string().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).passthrough()
const ModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i), kind: z.enum(['image', 'video']), license: z.string().trim().min(1),
  recipe: z.string().optional(), steps: positive, multiple: positive,
  width: positive.optional(), height: positive.optional(), fps: positive.optional(), frames: positive.optional(),
  residentBytes: positive.optional(), peakBytes: positive.optional(), peakMetalBytes: positive.optional(), secondsPerImage: z.number().finite().nonnegative().optional(),
  licenseNotice: z.string().optional(), paramsBackend: z.string().optional(),
  slots: z.record(z.string(), z.string()).refine(slots => Object.keys(slots).length > 0),
}).passthrough()
const CatalogueSchema = z.object({
  runtime: z.object({ tag: z.string(), asset: z.string(), bytes: positive, sha256: z.string().regex(/^[a-f0-9]{64}$/i) }).passthrough(),
  models: z.array(ModelSchema), files: z.array(FileSchema),
}).passthrough()
export type MediaModel = z.infer<typeof ModelSchema>
type MediaFile = z.infer<typeof FileSchema>
export type MediaCatalogue = z.infer<typeof CatalogueSchema>

export function modelFilePath(root: string, path: string): string {
  const models = resolve(root, 'models')
  const full = resolve(models, path)
  const rel = relative(models, full)
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Model file must stay in the models folder.')
  return full
}

export function parseMediaCatalogue(bundled: unknown, custom?: unknown): MediaCatalogue {
  const raw = CatalogueSchema.extend({ models: z.array(ModelSchema.extend({ license: z.string().default('Apache-2.0') })) }).parse(bundled)
  const base: MediaCatalogue = raw
  if (custom !== undefined) {
    const extra = z.object({ models: z.array(ModelSchema.extend({ recipe: z.string().trim().min(1) })).default([]), files: z.array(FileSchema).default([]) }).parse(custom)
    base.models = [...new Map([...base.models, ...extra.models].map(row => [row.id, row])).values()]
    base.files = [...new Map([...base.files, ...extra.files].map(row => [row.path, row])).values()]
  }
  for (const file of base.files) modelFilePath(resolve('media'), file.path)
  for (const model of base.models) for (const path of Object.values(model.slots)) {
    modelFilePath(resolve('media'), path)
    if (!base.files.some(file => file.path === path)) throw new Error(`Missing component in catalogue: ${path}`)
  }
  return base
}

export async function readMediaCatalogue(settings: MediaSettings = readMediaSettings()): Promise<MediaCatalogue> {
  const beside = settings.serverPath ? join(dirname(settings.serverPath), 'catalog.json') : undefined
  const file = settings.serverPath ? (beside && existsSync(beside) ? beside : join(dirname(settings.serverPath), '..', 'catalog.json')) : join(await mediaBundleRoot(), 'server', 'catalog.json')
  const local = join(mediaRoot(settings), 'catalog.json')
  return parseMediaCatalogue(JSON.parse(readFileSync(file, 'utf8')), existsSync(local) ? JSON.parse(readFileSync(local, 'utf8')) : undefined)
}

export function mediaModelFiles(catalogue: MediaCatalogue, model: MediaModel): MediaFile[] {
  return [...new Set(Object.values(model.slots))].map(path => {
    const file = catalogue.files.find(row => row.path === path)
    if (!file) throw new Error(`Missing component in catalogue: ${path}`)
    return file
  })
}

export function mediaPartialBytes(root: string, file: MediaFile): number {
  try { const stat = statSync(`${modelFilePath(root, file.path)}.part`); return stat.isFile() ? Math.min(file.bytes, stat.size) : 0 } catch { return 0 }
}

export function mediaFileInstalled(root: string, file: MediaFile): boolean {
  try { const stat = statSync(modelFilePath(root, file.path)); return stat.isFile() && stat.size === file.bytes } catch { return false }
}
