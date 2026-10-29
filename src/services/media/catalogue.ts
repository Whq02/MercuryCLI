import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod/v4'
import { mediaBundleRoot, mediaRoot, readMediaSettings, type MediaSettings } from './settings.js'

const positive = z.number().int().positive()
const FileSchema = z.object({ path: z.string().min(1), bytes: positive, repo: z.string().optional(), source: z.string().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).passthrough()
const ModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i), kind: z.enum(['image', 'video']), license: z.string().trim().min(1),
  recipe: z.string().optional(), steps: positive, multiple: positive,
  control: z.object({ family: z.enum(['sd1', 'sdxl']), kind: z.string().regex(/^[a-z][a-z0-9-]*$/) }).optional(),
  upscaler: z.object({ scale: z.number().int().min(2) }).optional(),
  width: positive.optional(), height: positive.optional(), fps: positive.optional(), frames: positive.optional(), downsize: positive.optional(),
  residentBytes: positive.optional(), peakBytes: positive.optional(), peakMetalBytes: positive.optional(), secondsPerImage: z.number().finite().nonnegative().optional(),
  licenseNotice: z.string().optional(), paramsBackend: z.string().optional(),
  checkpoint: z.object({ bytes: positive.optional() }).passthrough().optional(),
  slots: z.record(z.string(), z.string()).refine(slots => Object.keys(slots).length > 0),
}).passthrough()
const digest = z.string().regex(/^[a-f0-9]{64}$/i)
const RuntimeFileSchema = z.object({ asset: z.string().regex(/^[A-Za-z0-9._-]+\.zip$/), bytes: positive, sha256: digest }).passthrough()
const RuntimeVariantSchema = z.object({ variant: z.string().regex(/^[a-z0-9]+$/), binary: z.string().regex(/^[A-Za-z0-9._-]+$/), files: z.array(RuntimeFileSchema), source: z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), fallback: z.string().regex(/^[a-z0-9]+$/) }).optional() }).passthrough().refine(row => row.files.length > 0 || row.source !== undefined)
const recipeId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)
const RuntimeTableSchema = z.object({ tag: z.string().min(1), families: z.array(recipeId).default([]), componentFamilies: z.array(recipeId).default([]), platforms: z.record(z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/), z.array(RuntimeVariantSchema).min(1)) }).passthrough()
const RuntimeRowSchema = z.object({ tag: z.string().min(1), asset: z.string().min(1), bytes: positive, sha256: digest }).passthrough()
  .transform((row): z.infer<typeof RuntimeTableSchema> => ({ tag: row.tag, families: [], componentFamilies: [], platforms: { 'darwin-arm64': [{ variant: 'metal', binary: 'sd-server', files: [{ asset: row.asset, bytes: row.bytes, sha256: row.sha256 }] }] } }))
const RuntimeSchema = z.union([RuntimeTableSchema, RuntimeRowSchema])
const RecipeSchema = z.object({ id: recipeId, slots: z.array(z.object({ id: z.string().min(1), required: z.boolean() }).passthrough()).min(1), checkpoint: z.object({ recipe: z.string().min(1), layout: z.string().min(1) }).passthrough().optional() }).passthrough()
const CatalogueSchema = z.object({
  runtime: RuntimeSchema,
  models: z.array(ModelSchema), files: z.array(FileSchema), recipes: z.array(RecipeSchema).default([]),
}).passthrough()
export type MediaModel = z.infer<typeof ModelSchema>
type MediaFile = z.infer<typeof FileSchema>
type MediaRuntimeVariant = z.infer<typeof RuntimeVariantSchema>
type MediaRuntimeTable = z.infer<typeof RuntimeTableSchema>
export type MediaCatalogue = z.infer<typeof CatalogueSchema>

export function modelFilePath(root: string, path: string): string {
  const models = resolve(root, 'models')
  const full = resolve(models, path)
  const rel = relative(models, full)
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Model file must stay in the models folder.')
  return full
}

export function mediaModelSupported(catalogue: Pick<MediaCatalogue, 'recipes' | 'runtime'>, model: Pick<MediaModel, 'id' | 'recipe'>): boolean {
  const family = catalogue.recipes.find(recipe => recipe.id === (model.recipe ?? model.id))
  return !family || catalogue.runtime.families.includes(family.id)
}

export function mediaModelJoined(catalogue: Pick<MediaCatalogue, 'recipes' | 'runtime'>, model: Pick<MediaModel, 'id' | 'recipe' | 'control' | 'checkpoint'>): boolean {
  if (model.control && model.checkpoint) return true
  const family = catalogue.recipes.find(recipe => recipe.id === (model.recipe ?? model.id))
  return !!family?.checkpoint && catalogue.runtime.families.includes(family.id) && !catalogue.runtime.componentFamilies.includes(family.id)
}

export function mediaCheckpointFile(model: Pick<MediaModel, 'id' | 'checkpoint' | 'control'>): { path: string; bytes?: number } {
  return { path: `${model.control ? 'controlnet' : 'checkpoints'}/${model.id}.safetensors`, ...(model.checkpoint?.bytes === undefined ? {} : { bytes: model.checkpoint.bytes }) }
}

export function mediaCheckpointInstalled(root: string, catalogue: Pick<MediaCatalogue, 'recipes'>, model: Pick<MediaModel, 'id' | 'recipe' | 'checkpoint' | 'control'>): boolean {
  if (!(model.control && model.checkpoint) && !catalogue.recipes.find(recipe => recipe.id === (model.recipe ?? model.id))?.checkpoint) return false
  const file = mediaCheckpointFile(model)
  try { const stat = statSync(modelFilePath(root, file.path)); return stat.isFile() && (file.bytes === undefined ? stat.size > 0 : stat.size === file.bytes) } catch { return false }
}

export function parseMediaCatalogue(bundled: unknown, custom?: unknown): MediaCatalogue {
  const raw = CatalogueSchema.extend({ models: z.array(ModelSchema.extend({ license: z.string().default('Apache-2.0') })) }).parse(bundled)
  const base: MediaCatalogue = raw
  if (custom !== undefined) {
    const extra = z.object({ models: z.array(ModelSchema.extend({ recipe: z.string().trim().min(1) })).default([]), files: z.array(FileSchema).default([]), recipes: z.array(RecipeSchema).default([]), runtime: z.object({ families: z.array(recipeId).default([]), componentFamilies: z.array(recipeId).default([]) }).passthrough().default({ families: [], componentFamilies: [] }) }).parse(custom)
    base.models = [...new Map([...base.models, ...extra.models].map(row => [row.id, row])).values()]
    base.files = [...new Map([...base.files, ...extra.files].map(row => [row.path, row])).values()]
    base.recipes = [...new Map([...base.recipes, ...extra.recipes].map(row => [row.id, row])).values()]
    base.runtime = { ...base.runtime, families: [...new Set([...base.runtime.families, ...extra.runtime.families, ...extra.runtime.componentFamilies])], componentFamilies: [...new Set([...base.runtime.componentFamilies, ...extra.runtime.componentFamilies])] }
  }
  for (const file of base.files) modelFilePath(resolve('media'), file.path)
  for (const model of base.models) for (const path of Object.values(model.slots)) {
    modelFilePath(resolve('media'), path)
    if (!base.files.some(file => file.path === path)) throw new Error(`Missing component in catalogue: ${path}`)
  }
  base.models = base.models.filter(model => mediaModelSupported(base, model))
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
