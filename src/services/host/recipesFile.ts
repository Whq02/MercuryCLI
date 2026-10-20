import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import shippedRecipesFile from '../../../assets/host/recipes.json' with { type: 'json' }
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEssentialTrafficOnly, isProofShapeRun } from '../../utils/privacyLevel.js'
import { PUBLIC_HOME_SLUG } from '../privateChannel/channelCore.js'
import { HOST_RECIPES, type HostRecipe } from './recipes.js'
import { hostDirectory } from './store.js'

export const SHIPPED_HOST_RECIPES_PATH = 'assets/host/recipes.json'
export const HOST_RECIPES_URL = `https://raw.githubusercontent.com/${PUBLIC_HOME_SLUG}/main/${SHIPPED_HOST_RECIPES_PATH}`
export const HOST_RECIPES_FILE_VERSION = 1
export const HOST_RECIPES_PUBLISHED_AT = '2026-10-20'
export const HOST_RECIPES_FETCH_TTL_MS = 6 * 60 * 60 * 1000
export const HOST_RECIPES_FETCH_TIMEOUT_MS = 5_000

export const hostRecipeVerifiedSchema = z.object({
  by: z.enum(['measured', 'documented', 'community', 'unverified']),
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().min(1).optional(),
  source: z.string().regex(/^https:\/\/\S+$/),
}).refine(value => value.by !== 'measured' || Boolean(value.on), {
  message: 'measured recipe requires verified.on',
})

export const hostRecipeSchema: z.ZodType<HostRecipe> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  model: z.string().min(1),
  gpu: z.string().min(1),
  count: z.number().int().positive(),
  vramGb: z.number().positive(),
  diskGb: z.number().positive(),
  image: z.string().min(1),
  cuda: z.string().min(1),
  flags: z.array(z.string()),
  source: z.string().regex(/^https:\/\/\S+$/),
  verification: z.string().min(1),
  verified: hostRecipeVerifiedSchema,
  pythonInstall: z.string().optional(),
  context: z.number().int().positive().optional(),
  contextPerSlot: z.number().int().positive().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  files: z.record(z.string(), z.string()).optional(),
  engine: z.enum(['llamacpp']).optional(),
  imageSource: z.string().regex(/^https:\/\/\S+$/).optional(),
  install: z.string().optional(),
  weightFile: z.string().optional(),
  include: z.string().optional(),
})

export interface HostRecipesFile {
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

const sortUnverifiedLast = (recipes: readonly HostRecipe[]): HostRecipe[] =>
  [...recipes].sort((a, b) => Number(a.verified.by === 'unverified') - Number(b.verified.by === 'unverified'))

export function hostRecipesCachePath(): string {
  return join(hostDirectory(), 'recipes.json')
}

export function exportHostRecipesData(
  recipes: readonly HostRecipe[] = HOST_RECIPES,
  version = HOST_RECIPES_FILE_VERSION,
  publishedAt = HOST_RECIPES_PUBLISHED_AT,
): HostRecipesFile {
  return hostRecipesFileSchema.parse({
    version,
    publishedAt,
    recipes: [...recipes].sort((a, b) => a.id.localeCompare(b.id)),
  })
}

export function exportHostRecipesJson(
  recipes: readonly HostRecipe[] = HOST_RECIPES,
  version = HOST_RECIPES_FILE_VERSION,
  publishedAt = HOST_RECIPES_PUBLISHED_AT,
): string {
  return JSON.stringify(exportHostRecipesData(recipes, version, publishedAt), null, 2) + '\n'
}

export function parseHostRecipesDocument(
  raw: unknown,
  origin: string,
  onDrop?: (index: number, reason: string) => void,
): HostRecipesFile | undefined {
  const envelope = hostRecipesEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    logForDebugging(`Host recipes (${origin}): invalid file envelope — ${envelope.error.message}`)
    return undefined
  }
  const valid: HostRecipe[] = []
  for (const [index, entry] of envelope.data.recipes.entries()) {
    const parsed = hostRecipeSchema.safeParse(entry)
    if (!parsed.success) {
      const reason = parsed.error.issues.map(issue => (issue.path.join('.') || 'row') + ': ' + issue.message).join('; ')
      logForDebugging(`Host recipes (${origin}): dropped row ${index} — ${reason}`)
      onDrop?.(index, reason)
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

const lastFetchAttempt = new Map<string, number>()

export function resetHostRecipesFetchState(): void {
  lastFetchAttempt.clear()
}

export interface LoadHostRecipesOptions {
  url?: string
  signal?: AbortSignal
  timeoutMs?: number
  ttlMs?: number
  now?: number
  forceFetch?: boolean
  shipped?: unknown
  onDrop?: (index: number, reason: string) => void
}

export async function loadHostRecipes(options: LoadHostRecipesOptions = {}): Promise<HostRecipe[]> {
  const localPath = flagEnv('MERCURY_HOST_RECIPES_FILE')?.trim()
  if (localPath) {
    try {
      const resolved = resolve(localPath)
      const localDoc = parseHostRecipesDocument(JSON.parse(readFileSync(resolved, 'utf8')), resolved, options.onDrop)
      if (localDoc) return localDoc.recipes
    } catch (error) {
      logForDebugging('Host recipes local override (' + localPath + ') failed: ' + String(error))
    }
  }
  const compiledDoc: HostRecipesFile = {
    version: HOST_RECIPES_FILE_VERSION,
    publishedAt: HOST_RECIPES_PUBLISHED_AT,
    recipes: sortUnverifiedLast(HOST_RECIPES),
  }
  const shippedDoc = parseHostRecipesDocument(options.shipped ?? shippedRecipesFile, SHIPPED_HOST_RECIPES_PATH, options.onDrop)
  const baseDoc = shippedDoc && shippedDoc.version >= compiledDoc.version ? shippedDoc : compiledDoc

  const cachePath = hostRecipesCachePath()
  const url = options.url ?? HOST_RECIPES_URL
  const ttlMs = options.ttlMs ?? HOST_RECIPES_FETCH_TTL_MS
  const timeoutMs = options.timeoutMs ?? HOST_RECIPES_FETCH_TIMEOUT_MS
  const now = options.now ?? Date.now()

  let cacheFresh = false
  try {
    const mtimeMs = statSync(cachePath).mtimeMs
    if (now - mtimeMs >= 0 && now - mtimeMs < ttlMs) cacheFresh = true
  } catch {}

  const attemptKey = cachePath + '|' + url
  const lastAttempt = lastFetchAttempt.get(attemptKey)
  const recentlyAttempted = lastAttempt !== undefined && now - lastAttempt >= 0 && now - lastAttempt < ttlMs
  const canFetchNetwork = options.url !== undefined || (!isProofShapeRun() && !isEssentialTrafficOnly())

  let fetchedDoc: HostRecipesFile | undefined
  if (canFetchNetwork && (options.forceFetch || (!cacheFresh && !recentlyAttempted))) {
    lastFetchAttempt.set(attemptKey, now)
    const fetchSignal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'follow',
        signal: fetchSignal,
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const text = await response.text()
      const parsed = parseHostRecipesDocument(JSON.parse(text), url, options.onDrop)
      if (parsed) {
        fetchedDoc = parsed
        durableAtomicPublishSync(cachePath, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 })
      }
    } catch (error) {
      logForDebugging('Host recipes fetch (' + url + ') failed: ' + String(error))
    }
  }

  if (!fetchedDoc && existsSync(cachePath)) {
    try {
      fetchedDoc = parseHostRecipesDocument(JSON.parse(readFileSync(cachePath, 'utf8')), cachePath, options.onDrop)
    } catch (error) {
      logForDebugging('Host recipes cache (' + cachePath + ') failed: ' + String(error))
    }
  }

  if (fetchedDoc) {
    if (fetchedDoc.version < baseDoc.version) {
      logForDebugging(`Host recipes: ignoring fetched version ${fetchedDoc.version} < shipped version ${baseDoc.version}`)
      return baseDoc.recipes
    }
    return fetchedDoc.recipes
  }
  return baseDoc.recipes
}
