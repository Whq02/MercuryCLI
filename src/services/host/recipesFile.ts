import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod/v4'
import shippedRecipesFile from '../../../assets/host/recipes.json' with { type: 'json' }
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEssentialTrafficOnly, isProofShapeRun } from '../../utils/privacyLevel.js'
import { PUBLIC_HOME_SLUG, repoSlugFromUrl } from '../privateChannel/channelCore.js'
import { HOST_RECIPES, type HostRecipe } from './recipes.js'
import { hostDirectory } from './store.js'

const packagedSlug = typeof MACRO !== 'undefined' && typeof MACRO.PACKAGE_URL === 'string' ? repoSlugFromUrl(MACRO.PACKAGE_URL) : null

export const SHIPPED_HOST_RECIPES_PATH = 'assets/host/recipes.json'
export const HOST_RECIPES_URL = `https://raw.githubusercontent.com/${packagedSlug ?? PUBLIC_HOME_SLUG}/main/${SHIPPED_HOST_RECIPES_PATH}`
export const HOST_RECIPES_FILE_VERSION = 2
const HOST_RECIPES_PUBLISHED_AT = '2026-10-22'
const HOST_RECIPES_FETCH_TTL_MS = 6 * 60 * 60 * 1000
const HOST_RECIPES_FETCH_TIMEOUT_MS = 5_000

const printable = /^[^\p{Cc}\p{Cf}]+$/u
const httpsUrl = /^https:\/\/[^\s\p{Cc}\p{Cf}]+$/u

const hostRecipeVerifiedSchema = z.object({
  by: z.enum(['measured', 'documented', 'community', 'unverified']),
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().regex(printable).optional(),
  source: z.string().regex(httpsUrl),
}).refine(value => value.by !== 'measured' || Boolean(value.on), {
  message: 'measured recipe requires verified.on',
})

export const hostWeightPathSchema = z.string().regex(/^[^\\\p{Cc}]+$/u).refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
export const hostWeightManifestSchema = z.object({
  model: z.string().regex(printable), include: z.string(), revision: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(z.object({ path: hostWeightPathSchema, size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), git: z.string().regex(/^[a-f0-9]{40}$/).optional() }).refine(file => Boolean(file.sha256 || file.git))).min(1),
}).refine(manifest => new Set(manifest.files.map(file => file.path)).size === manifest.files.length)

const hostRecipeObject = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  label: z.string().regex(printable),
  model: z.string().regex(printable),
  gpu: z.string().regex(printable),
  count: z.number().int().positive(),
  nodes: z.number().int().min(1).max(250).optional(),
  vramGb: z.number().positive(),
  diskGb: z.number().positive(),
  weightsGb: z.number().positive(),
  image: z.string().regex(printable),
  cuda: z.string().regex(printable),
  flags: z.array(z.string()),
  source: z.string().regex(httpsUrl),
  verification: z.string().regex(printable),
  verified: hostRecipeVerifiedSchema,
  efforts: z.object({ levels: z.array(z.enum(['low', 'medium', 'high', 'xhigh', 'max'])), verified: hostRecipeVerifiedSchema }).optional(),
  pythonInstall: z.string().optional(),
  context: z.number().int().positive().optional(),
  contextPerSlot: z.number().int().positive().optional(),
  kvBytesPerToken: z.object({ bytes: z.number().positive(), conversationBytes: z.number().nonnegative().optional(), maxContext: z.number().int().positive(), cacheType: z.string().regex(printable), verified: hostRecipeVerifiedSchema }).optional(),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  files: z.record(z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/), z.string()).optional(),
  engine: z.enum(['llamacpp', 'vllm']).optional(),
  imageSource: z.string().regex(httpsUrl).optional(),
  install: z.string().optional(),
  weightFile: z.string().optional(),
  chatTemplateFile: hostWeightPathSchema.refine(path => !/^[A-Za-z]:/.test(path)).optional(),
  mmproj: z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._/-]+$/).optional(),
  include: z.string().optional(),
  weightManifest: hostWeightManifestSchema.optional(),
})

export const hostRecipeSchema: z.ZodType<HostRecipe> = hostRecipeObject

const HOST_RECIPE_FIELDS = Object.keys(hostRecipeObject.shape) as (keyof HostRecipe)[]
const FETCHED_FACT_FIELDS: ReadonlySet<keyof HostRecipe> = new Set(['verified', 'verification', 'context', 'contextPerSlot', 'efforts'])

interface HostRecipesFile {
  version: number
  publishedAt: string
  recipes: HostRecipe[]
}

export const hostRecipesFileSchema: z.ZodType<HostRecipesFile> = z.object({
  version: z.number().int().nonnegative(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  recipes: z.array(hostRecipeSchema),
})

const hostRecipesEnvelopeSchema = z.object({
  version: z.number().int().nonnegative(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  recipes: z.array(z.unknown()),
})

const hostRecipesCacheSchema = z.object({
  checkedAt: z.number().int().nonnegative(),
  url: z.string(),
  document: z.unknown().optional(),
})

const sortUnverifiedLast = (recipes: readonly HostRecipe[]): HostRecipe[] =>
  [...recipes].sort((a, b) => Number(a.verified.by === 'unverified') - Number(b.verified.by === 'unverified'))

const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item)

export function hostRecipesCachePath(): string {
  return join(hostDirectory(), 'recipes.json')
}

export function exportHostRecipesJson(
  recipes: readonly HostRecipe[] = HOST_RECIPES,
  version = HOST_RECIPES_FILE_VERSION,
  publishedAt = HOST_RECIPES_PUBLISHED_AT,
): string {
  const file = hostRecipesFileSchema.parse({ version, publishedAt, recipes: [...recipes].sort((a, b) => a.id.localeCompare(b.id)) })
  return JSON.stringify(file, null, 2) + '\n'
}

function fetchedRowRefusal(row: HostRecipe, shipped: ReadonlyMap<string, HostRecipe>, seen: ReadonlySet<string>): string | undefined {
  if (seen.has(row.id)) return 'duplicate id ' + row.id
  const own = shipped.get(row.id)
  if (!own) return 'id ' + row.id + ' is not a shipped recipe; a fetched file only updates the facts of shipped recipes'
  const changed = HOST_RECIPE_FIELDS.filter(field => !FETCHED_FACT_FIELDS.has(field) && canonical(row[field]) !== canonical(own[field]))
  return changed.length ? changed.join(', ') + ' differ from the shipped recipe ' + row.id + '; commands, images and shapes change only with a Mercury release' : undefined
}

function parseHostRecipesDocument(
  raw: unknown,
  origin: string,
  onDrop?: (index: number, reason: string) => void,
  shipped?: readonly HostRecipe[],
): HostRecipesFile | undefined {
  const envelope = hostRecipesEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    logForDebugging(`Host recipes (${origin}): invalid file envelope — ${envelope.error.message}`)
    return undefined
  }
  const shippedById = shipped ? new Map(shipped.map(row => [row.id, row])) : undefined
  const seen = new Set<string>()
  const valid: HostRecipe[] = []
  for (const [index, entry] of envelope.data.recipes.entries()) {
    const parsed = hostRecipeSchema.safeParse(entry)
    const reason = !parsed.success
      ? parsed.error.issues.map(issue => (issue.path.join('.') || 'row') + ': ' + issue.message).join('; ')
      : shippedById ? fetchedRowRefusal(parsed.data, shippedById, seen) : undefined
    if (parsed.success) seen.add(parsed.data.id)
    if (reason !== undefined || !parsed.success) {
      logForDebugging(`Host recipes (${origin}): dropped row ${index} — ${reason}`)
      onDrop?.(index, reason ?? 'invalid row')
      continue
    }
    valid.push(parsed.data)
  }
  if (!valid.length) {
    logForDebugging(`Host recipes (${origin}): no valid rows`)
    return undefined
  }
  return {
    version: envelope.data.version,
    publishedAt: envelope.data.publishedAt,
    recipes: sortUnverifiedLast(valid),
  }
}

function readHostRecipesCache(path: string): z.infer<typeof hostRecipesCacheSchema> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = hostRecipesCacheSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data
    logForDebugging('Host recipes cache (' + path + ') is not a cache record: ' + parsed.error.message)
  } catch (error) {
    logForDebugging('Host recipes cache (' + path + ') failed: ' + String(error))
  }
  return undefined
}

interface HostRecipesOptions {
  url?: string
  signal?: AbortSignal
  timeoutMs?: number
  ttlMs?: number
  now?: number
  forceFetch?: boolean
  shipped?: unknown
  onDrop?: (index: number, reason: string) => void
}

const sessionRecipes = new Map<string, HostRecipe>()

export function rememberSessionHostRecipe(recipe: HostRecipe): HostRecipe {
  const row = hostRecipeSchema.parse(recipe)
  sessionRecipes.set(row.id, row)
  return row
}

export function sessionHostRecipes(): HostRecipe[] {
  return [...sessionRecipes.values()]
}

export function forgetSessionHostRecipes(): void {
  sessionRecipes.clear()
}

export function currentHostRecipes(options: HostRecipesOptions = {}): HostRecipe[] {
  const loaded = loadedHostRecipes(options)
  const session = sessionHostRecipes().filter(row => !loaded.some(own => own.id === row.id))
  return session.length ? [...loaded, ...session] : loaded
}

export function privateHostRecipesPath(): string {
  return join(hostDirectory(), 'private-recipes.json')
}

const privateRecipesChoicePath = (): string => join(hostDirectory(), 'recipes-file.json')
const privateRecipesChoiceSchema = z.object({ path: z.string().refine(isAbsolute).regex(printable) })
export interface PrivateHostRecipes { path?: string; recipes: HostRecipe[]; errors: string[] }

export function chosenPrivateHostRecipesPath(): string | undefined {
  try { return privateRecipesChoiceSchema.parse(JSON.parse(readFileSync(privateRecipesChoicePath(), 'utf8'))).path }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logForDebugging('Private recipes choice could not be read: ' + String(error)); return }
}

export function privateHostRecipesCandidates(): string[] {
  const env = flagEnv('MERCURY_HOST_RECIPES_FILE')?.trim()
  const chosen = chosenPrivateHostRecipesPath()
  return [...new Set([privateHostRecipesPath(), ...(env ? [resolve(env)] : []), ...(chosen ? [chosen] : [])])]
}

export function inspectPrivateHostRecipes(path: string, onDrop?: HostRecipesOptions['onDrop']): PrivateHostRecipes {
  const result: PrivateHostRecipes = { path, recipes: [], errors: [] }
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch (error) {
    result.errors.push(((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'File not found: ' : 'Cannot read file: ') + path)
    return result
  }
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { result.errors.push('Invalid JSON: ' + path); return result }
  const envelope = hostRecipesEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    result.errors.push(...envelope.error.issues.map(issue => 'File · ' + (issue.path.join('.') || 'document') + ': ' + issue.message))
    return result
  }
  const seen = new Set<string>()
  for (const [index, entry] of envelope.data.recipes.entries()) {
    const parsed = hostRecipeSchema.safeParse(entry)
    const id = entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string' ? entry.id.replace(/[\p{Cc}\p{Cf}]/gu, '') : undefined
    const reason = !parsed.success ? parsed.error.issues.map(issue => (issue.path.join('.') || 'recipe') + ': ' + issue.message).join('; ') : seen.has(parsed.data.id) ? 'id: duplicate ' + parsed.data.id : undefined
    if (reason) {
      result.errors.push('Row ' + (index + 1) + (id ? ' (' + id + ')' : '') + ' · ' + reason)
      onDrop?.(index, reason)
    } else if (parsed.success) { seen.add(parsed.data.id); result.recipes.push(parsed.data) }
  }
  result.recipes = sortUnverifiedLast(result.recipes)
  if (!result.recipes.length) result.errors.unshift('No valid recipes in ' + path)
  return result
}

export function currentPrivateHostRecipes(onDrop?: HostRecipesOptions['onDrop']): PrivateHostRecipes {
  const path = chosenPrivateHostRecipesPath() ?? (flagEnv('MERCURY_HOST_RECIPES_FILE')?.trim() || (existsSync(privateHostRecipesPath()) ? privateHostRecipesPath() : ''))
  return path ? inspectPrivateHostRecipes(resolve(path), onDrop) : { recipes: [], errors: [] }
}

export function validatePrivateHostRecipesPath(value: string): PrivateHostRecipes & { path: string } {
  const named = value.trim()
  const home = process.platform === 'win32' ? homedir() : process.env.HOME?.trim() || homedir()
  const path = named.startsWith('~/') || named.startsWith('~\\') ? join(home, named.slice(2)) : named
  if (!isAbsolute(path) || !printable.test(path)) throw new Error('Give an absolute file path on this computer.')
  const inspected = inspectPrivateHostRecipes(resolve(path))
  if (inspected.errors.length) throw new Error(inspected.errors.join('\n'))
  return { ...inspected, path: resolve(path) }
}

export function rememberPrivateHostRecipesFile(path: string): PrivateHostRecipes & { path: string } {
  const inspected = validatePrivateHostRecipesPath(path)
  publishAtomicSync(privateRecipesChoicePath(), JSON.stringify({ path: inspected.path }) + '\n', { mode: 0o600 })
  return inspected
}

function loadedHostRecipes(options: HostRecipesOptions): HostRecipe[] {
  const local = currentPrivateHostRecipes(options.onDrop)
  if (local.recipes.length) return local.recipes
  const compiledDoc: HostRecipesFile = { version: HOST_RECIPES_FILE_VERSION, publishedAt: HOST_RECIPES_PUBLISHED_AT, recipes: sortUnverifiedLast(HOST_RECIPES) }
  const shippedDoc = parseHostRecipesDocument(options.shipped ?? shippedRecipesFile, SHIPPED_HOST_RECIPES_PATH, options.onDrop)
  const baseDoc = shippedDoc && shippedDoc.version >= compiledDoc.version ? shippedDoc : compiledDoc
  let cachePath = ''
  let cache: z.infer<typeof hostRecipesCacheSchema> | undefined
  try {
    cachePath = hostRecipesCachePath()
    cache = readHostRecipesCache(cachePath)
  } catch (error) {
    logForDebugging('Host recipes cache unreadable: ' + String(error))
  }
  const cachedVersion = hostRecipesEnvelopeSchema.safeParse(cache?.document)
  if (!cachedVersion.success) return baseDoc.recipes
  if (cachedVersion.data.version <= baseDoc.version) {
    logForDebugging(`Host recipes: ignoring fetched version ${cachedVersion.data.version} ≤ shipped version ${baseDoc.version}`)
    return baseDoc.recipes
  }
  return parseHostRecipesDocument(cache!.document, cachePath, options.onDrop, baseDoc.recipes)?.recipes ?? baseDoc.recipes
}

const refreshing = new Map<string, Promise<void>>()

export function resetHostRecipesFetchState(): void {
  refreshing.clear()
}

async function fetchHostRecipes(url: string, cachePath: string, previous: unknown, now: number, options: HostRecipesOptions): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? HOST_RECIPES_FETCH_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let document = previous
  try {
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const fetched: unknown = JSON.parse(await response.text())
    const parsed = parseHostRecipesDocument(fetched, url, options.onDrop)
    if (!parsed) throw new Error('not a recipes file with a valid row')
    const kept = hostRecipesEnvelopeSchema.safeParse(previous)
    if (kept.success && kept.data.version > parsed.version) throw new Error(`version ${parsed.version} is older than the cached version ${kept.data.version}`)
    document = fetched
  } catch (error) {
    if (options.signal?.aborted) return
    logForDebugging('Host recipes fetch (' + url + ') failed: ' + String(error))
  }
  publishAtomicSync(cachePath, JSON.stringify({ checkedAt: now, url, ...(document === undefined ? {} : { document }) }) + '\n', { mode: 0o600 })
}

export async function refreshHostRecipes(options: HostRecipesOptions = {}): Promise<void> {
  try {
    if (options.url === undefined && (isProofShapeRun() || isEssentialTrafficOnly())) return
    const url = options.url ?? HOST_RECIPES_URL
    const cachePath = hostRecipesCachePath()
    const now = options.now ?? Date.now()
    const cache = readHostRecipesCache(cachePath)
    const age = cache && cache.url === url ? now - cache.checkedAt : undefined
    if (!options.forceFetch && age !== undefined && age >= 0 && age < (options.ttlMs ?? HOST_RECIPES_FETCH_TTL_MS)) return
    const key = cachePath + '\n' + url
    const running = refreshing.get(key)
    if (running) return await running
    const work = fetchHostRecipes(url, cachePath, cache?.document, now, options).finally(() => refreshing.delete(key))
    refreshing.set(key, work)
    await work
  } catch (error) {
    logForDebugging('Host recipes refresh failed: ' + String(error))
  }
}

export async function loadHostRecipes(options: HostRecipesOptions = {}): Promise<HostRecipe[]> {
  await refreshHostRecipes(options)
  return currentHostRecipes(options)
}

export function hostRecipeOfRecord(record: { recipe: string; recipeRow?: unknown }): HostRecipe | undefined {
  const row = hostRecipeSchema.safeParse(record.recipeRow)
  return row.success && row.data.id === record.recipe ? row.data : HOST_RECIPES.find(entry => entry.id === record.recipe)
}
