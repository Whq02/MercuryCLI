import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import mergeWith from 'lodash-es/mergeWith.js'
import { z } from 'zod/v4'

import { getFlagSettingsInline, getFlagSettingsPath, getOriginalCwd } from '../../boot/process-state/processState.js'
import { durableAtomicPublishSync, DurablePublishError } from '../substrate/durablePublish.js'
import { logForDebugging } from '../logs/debugLog.js'
import { getMercuryHome } from '../environment/envUtils.js'
import { errorMessage, isENOENT } from '../errors/errors.js'
import { readFileSync } from '../files/syncFileRead.js'
import { addFileGlobRuleToGitignore } from '../git/gitignore.js'
import { safeParseJSON, stripBOM } from '../storage/json.js'
import { isRecord } from '../primitives/isRecord.js'
import * as lockfile from '../storage/lockfile.js'
import { logError } from '../logs/errorLog.js'
import { foldPathCase } from '../host-os/paths.js'
import { MERCURY_PROJECT_DIR, resolveProjectConfigPath } from './projectConfig.js'
import { projectLocalPath } from '../project-local/paths.js'
import { jsonStringify } from '../logs/slowOperations.js'
import { profileCheckpoint } from '../../boot/startupProfiler.js'
import type { EditableSettingSource, SettingSource } from './settingSources.js'
import { getEnabledSettingSources } from './settingSources.js'
import { ensureLocalSettingsSchema } from './localSchema.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from './managedPath.js'
import { getHkcuSettings, getMdmSettings } from './mdm/settings.js'
import { markInternalWrite } from './internalWrites.js'
import {
  forgetLastGoodParsedFile,
  getCachedParsedFile,
  getCachedSettingsForSource,
  getLastGoodParsedFile,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedParsedFile,
  setCachedSettingsForSource,
  setLastGoodParsedFile,
  setSessionSettingsCache,
} from './settingsCache.js'
import type { SettingsJson } from './settingsSchema.js'
import { SettingsSchema } from './settingsSchema.js'
import { duplicateCompatEndpointNames } from './compatProvider.js'
import type { ValidationError, SettingsWithErrors } from './validation.js'
import { filterInvalidPermissionRules, formatZodError, unknownKeyWarnings } from './validation.js'
import { forgetHiddenCharacters, recordHiddenCharacters } from '../text/hiddenCharacterFindings.js'
import { sleepSync } from '../async/timers.js'


export function settingsMergeCustomizer(objValue: unknown, srcValue: unknown): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return [...new Set([...objValue, ...srcValue])]
  }
  return undefined
}


function cloneParsed(value: { settings: SettingsJson | null; errors: ValidationError[] }): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  return JSON.parse(JSON.stringify(value)) as { settings: SettingsJson | null; errors: ValidationError[] }
}

function parseSettingsFileUncached(filePath: string): { settings: SettingsJson | null; errors: ValidationError[] } {
  const parsed = readSettingsFileUncached(filePath)
  if (parsed.settings !== null) {
    setLastGoodParsedFile(filePath, structuredClone(parsed.settings))
    return parsed
  }
  const lastGood = getLastGoodParsedFile(filePath)
  if (lastGood === undefined || !parsed.errors.some(error => error.path === '' && error.severity === undefined)) return parsed
  return {
    settings: structuredClone(lastGood),
    errors: parsed.errors.map(error => (error.path === '' && error.severity === undefined ? { ...error, severity: 'held' as const } : error)),
  }
}

function readSettingsFileUncached(filePath: string): { settings: SettingsJson | null; errors: ValidationError[] } {
  let raw: string
  try {
    raw = readFileSync(filePath)
  } catch (error) {
    if (isENOENT(error)) {
      logForDebugging(`settings file absent: ${filePath}`)
      forgetLastGoodParsedFile(filePath)
      forgetHiddenCharacters('settings', { path: filePath })
      return { settings: null, errors: [] }
    }
    logError(error)
    return {
      settings: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: `settings file unreadable: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }
  }
  recordHiddenCharacters('settings', filePath, raw)
  if (raw.trim() === '') {
    return { settings: {} as SettingsJson, errors: [] }
  }
  const shared = safeParseJSON(stripBOM(raw), false)
  const parsed = typeof shared === 'object' && shared !== null ? (structuredClone(shared) as unknown) : shared
  const duplicates = duplicateCompatEndpointNames(raw)
  if (duplicates.length > 0 && typeof parsed === 'object' && parsed !== null) {
    delete (parsed as Record<string, unknown>).compatProvider
  }
  const warnings = [
    ...duplicates.map(name => ({ file: filePath, path: `compatProvider.${name}`, message: `duplicate endpoint name '${name}'; compatProvider was not loaded`, severity: 'warning' as const })),
    ...filterInvalidPermissionRules(parsed, filePath),
  ]
  const result = SettingsSchema().safeParse(parsed)
  if (!result.success) {
    const { settings: salvaged, issues } = salvageValidSettings(parsed, result.error)
    const zodErrors =
      salvaged !== null
        ? formatZodError({ issues }, filePath).map(record => ({ ...record, severity: 'warning' as const }))
        : formatZodError(result.error, filePath)
    return { settings: salvaged, errors: [...zodErrors, ...warnings, ...(salvaged === null ? [] : unknownKeyWarnings(salvaged, filePath))] }
  }
  return { settings: result.data as SettingsJson, errors: [...warnings, ...unknownKeyWarnings(result.data, filePath)] }
}

const SALVAGE_REMOVED: unique symbol = Symbol('settings-salvage-removed')

function pruneDeepestAlongPath(root: Record<string, unknown>, path: ReadonlyArray<PropertyKey>): { path: PropertyKey[]; arrayElement: boolean } | null {
  if (path.length === 0) return null
  const chain: Array<{ parent: Record<PropertyKey, unknown> | unknown[]; key: PropertyKey }> = []
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null) break
    const container = node as Record<PropertyKey, unknown>
    if (container[key] === SALVAGE_REMOVED) return null
    if (!(key in container)) break
    chain.push({ parent: container as Record<PropertyKey, unknown> | unknown[], key })
    node = container[key]
  }
  if (chain.length === 0) return null
  const { parent, key } = chain[chain.length - 1] as { parent: Record<PropertyKey, unknown> | unknown[]; key: PropertyKey }
  if (Array.isArray(parent)) {
    parent[key as number] = SALVAGE_REMOVED
  } else {
    delete parent[key]
  }
  return { path: chain.map(link => link.key), arrayElement: Array.isArray(parent) }
}

function originalSalvagePath(path: ReadonlyArray<PropertyKey>, removed: ReadonlyMap<string, ReadonlySet<number>>): PropertyKey[] {
  const out: PropertyKey[] = []
  for (const key of path) {
    if (typeof key !== 'number') {
      out.push(key)
      continue
    }
    const gone = removed.get(JSON.stringify(out))
    let index = key
    if (gone !== undefined) {
      let remaining = key
      index = -1
      do {
        index++
        if (!gone.has(index)) remaining--
      } while (remaining >= 0)
    }
    out.push(index)
  }
  return out
}

function sweepSalvageTombstones(node: unknown): void {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      if (node[i] === SALVAGE_REMOVED) node.splice(i, 1)
      else sweepSalvageTombstones(node[i])
    }
    return
  }
  for (const value of Object.values(node)) sweepSalvageTombstones(value)
}

type SalvageOutcome = { settings: SettingsJson | null; issues: z.core.$ZodIssue[] }

function salvageValidSettings(parsed: unknown, error: z.ZodError): SalvageOutcome {
  const voided: SalvageOutcome = { settings: null, issues: error.issues }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return voided
  const working = structuredClone(parsed) as Record<string, unknown>
  const removed = new Map<string, Set<number>>()
  const named = new Set<string>()
  const reported: z.core.$ZodIssue[] = []
  let issues = error.issues
  for (let round = 0; round < 8; round++) {
    for (const issue of issues) {
      const path = originalSalvagePath(issue.path as ReadonlyArray<PropertyKey>, removed)
      const key = `${path.join('.')}|${issue.message}`
      if (named.has(key)) continue
      named.add(key)
      reported.push({ ...issue, path })
    }
    const removedThisRound: PropertyKey[][] = []
    let prunedAny = false
    for (const issue of issues) {
      if (issue.path.length === 0) return voided
      const pruned = pruneDeepestAlongPath(working, issue.path as ReadonlyArray<PropertyKey>)
      if (pruned === null) continue
      prunedAny = true
      if (pruned.arrayElement) removedThisRound.push(originalSalvagePath(pruned.path, removed))
    }
    if (!prunedAny) return voided
    for (const path of removedThisRound) {
      const listKey = JSON.stringify(path.slice(0, -1))
      let gone = removed.get(listKey)
      if (gone === undefined) {
        gone = new Set()
        removed.set(listKey, gone)
      }
      gone.add(path[path.length - 1] as number)
    }
    sweepSalvageTombstones(working)
    const reparsed = SettingsSchema().safeParse(working)
    if (reparsed.success) return { settings: reparsed.data as SettingsJson, issues: reported.sort((a, b) => compareIssuePaths(a.path, b.path)) }
    issues = reparsed.error.issues
  }
  return voided
}

function compareIssuePaths(a: ReadonlyArray<PropertyKey>, b: ReadonlyArray<PropertyKey>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i] as PropertyKey
    const right = b[i] as PropertyKey
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'number') return left - right
    return String(left) < String(right) ? -1 : 1
  }
  return a.length - b.length
}

export function parseSettingsFile(filePath: string): { settings: SettingsJson | null; errors: ValidationError[] } {
  const cached = getCachedParsedFile(filePath)
  if (cached !== undefined) return cloneParsed(cached as ReturnType<typeof cloneParsed>)
  const parsed = parseSettingsFileUncached(filePath)
  setCachedParsedFile(filePath, parsed)
  return cloneParsed(parsed)
}

export function getSettingsFilePathForSource(source: SettingSource): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(getMercuryHome(), 'settings.json')
    case 'projectSettings':
    case 'localSettings': {
      const name = source === 'projectSettings' ? 'settings.json' : 'settings.local.json'
      return resolveProjectConfigPath(getOriginalCwd(), name) ?? join(getOriginalCwd(), MERCURY_PROJECT_DIR, name)
    }
    case 'policySettings':
      return join(getManagedFilePath(), 'managed-settings.json')
    case 'flagSettings':
      return getFlagSettingsPath()
    default:
      return undefined
  }
}

export function getRelativeSettingsFilePathForSource(source: 'projectSettings' | 'localSettings'): string {
  const absolute = getSettingsFilePathForSource(source) as string
  return relative(getOriginalCwd(), absolute)
}

export function getSettingsWriteFilePathForSource(source: SettingSource): string | undefined {
  switch (source) {
    case 'projectSettings':
      return projectLocalPath(getOriginalCwd(), 'settings.json')
    case 'localSettings':
      return projectLocalPath(getOriginalCwd(), 'settings.local.json')
    default:
      return getSettingsFilePathForSource(source)
  }
}


export function loadManagedFileSettings(): { settings: SettingsJson | null; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  let merged: SettingsJson | null = null
  const mergeIn = (settings: SettingsJson | null): void => {
    if (settings === null || Object.keys(settings).length === 0) return
    merged = merged === null ? settings : (mergeWith(merged, settings, settingsMergeCustomizer) as SettingsJson)
  }
  const baseResult = parseSettingsFile(join(getManagedFilePath(), 'managed-settings.json'))
  errors.push(...baseResult.errors)
  mergeIn(baseResult.settings)
  try {
    const entries = readdirSync(getManagedSettingsDropInDir(), { withFileTypes: true })
    const names = entries
      .filter(
        entry =>
          (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.json') && !entry.name.startsWith('.'),
      )
      .map(entry => entry.name)
      .sort()
    for (const name of names) {
      const dropIn = parseSettingsFile(join(getManagedSettingsDropInDir(), name))
      errors.push(...dropIn.errors)
      mergeIn(dropIn.settings)
    }
  } catch (error) {
    if (!isENOENT(error) && (error as { code?: string }).code !== 'ENOTDIR') {
      logError(error)
      errors.push({
        file: getManagedSettingsDropInDir(),
        path: '',
        message: `settings file unreadable: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return { settings: merged, errors }
}

type PolicySelection = {
  origin: 'device' | 'file' | 'hkcu' | null
  settings: SettingsJson | null
  errors: ValidationError[]
}

function selectPolicySettings(): PolicySelection {
  const errors: ValidationError[] = []
  const told = new Set<string>()
  const gather = (found: readonly ValidationError[]): void => {
    for (const error of found) {
      const key = JSON.stringify([error.file ?? '', error.path, error.message])
      if (told.has(key)) continue
      told.add(key)
      errors.push(error)
    }
  }
  const device = getMdmSettings()
  gather(device.errors)
  if (Object.keys(device.settings).length > 0) return { origin: 'device', settings: device.settings, errors }
  const file = loadManagedFileSettings()
  gather(file.errors)
  if (file.settings !== null) return { origin: 'file', settings: file.settings, errors }
  const hkcu = getHkcuSettings()
  gather(hkcu.errors)
  if (Object.keys(hkcu.settings).length > 0) return { origin: 'hkcu', settings: hkcu.settings, errors }
  return { origin: null, settings: null, errors }
}

export function getPolicySettingsOrigin(): 'plist' | 'hklm' | 'file' | 'hkcu' | null {
  const { origin } = selectPolicySettings()
  if (origin === 'device') return process.platform === 'win32' ? 'hklm' : 'plist'
  return origin
}

function validInlineFlagSettings(): SettingsJson | null {
  const inline = getFlagSettingsInline()
  if (inline === null) return null
  const parsed = SettingsSchema().safeParse(inline)
  return parsed.success ? parsed.data : null
}

function readSettingsForSourceUncached(source: SettingSource): SettingsJson | null {
  if (source === 'policySettings') return selectPolicySettings().settings
  const path = getSettingsFilePathForSource(source)
  const fromFile = path === undefined ? null : parseSettingsFile(path).settings
  if (source !== 'flagSettings') return fromFile
  const inline = validInlineFlagSettings()
  if (inline === null) return fromFile
  if (path === undefined) return inline
  const merged: SettingsJson = fromFile ?? {}
  mergeWith(merged, inline, settingsMergeCustomizer)
  return merged
}

export function getSettingsForSource(source: SettingSource): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) return cached
  const value = readSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, value)
  return value
}

export function getEnabledSettingsForSource(source: SettingSource): SettingsJson | null {
  return getEnabledSettingSources().includes(source) ? getSettingsForSource(source) : null
}


let mergedLoadInProgress = false

export function getSettingsWithErrors(): SettingsWithErrors {
  if (mergedLoadInProgress) return { settings: {}, errors: [] }
  const cached = getSessionSettingsCache()
  if (cached !== null) return cached as SettingsWithErrors
  mergedLoadInProgress = true
  try {
    profileCheckpoint('settings_merge_start')
    const startedAt = Date.now()
    const settings: SettingsJson = {}
    const errors: ValidationError[] = []
    const askedPaths = new Set<string>()
    for (const source of getEnabledSettingSources()) {
      if (source === 'policySettings') {
        const policy = selectPolicySettings()
        errors.push(...policy.errors)
        if (policy.settings !== null) mergeWith(settings, policy.settings, settingsMergeCustomizer)
        continue
      }
      const path = getSettingsFilePathForSource(source)
      if (path !== undefined) {
        const parsed = parseSettingsFile(path)
        const asked = foldPathCase(resolve(path))
        if (!askedPaths.has(asked)) {
          askedPaths.add(asked)
          errors.push(...parsed.errors)
        }
        if (parsed.settings !== null && Object.keys(parsed.settings).length > 0) {
          mergeWith(settings, parsed.settings, settingsMergeCustomizer)
        }
      }
      if (source !== 'flagSettings') continue
      const inline = validInlineFlagSettings()
      if (inline !== null) mergeWith(settings, inline, settingsMergeCustomizer)
    }
    const merged = { settings, errors }
    setSessionSettingsCache(merged)
    logForDebugging(`settings merged in ${Date.now() - startedAt}ms (${askedPaths.size} files, ${errors.length} errors)`)
    return merged
  } finally {
    mergedLoadInProgress = false
  }
}

export function getInitialSettings(): SettingsJson {
  return getSettingsWithErrors().settings
}

export type SettingsWithSources = {
  effective: SettingsJson
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

export function getSettingsWithSources(): SettingsWithSources {
  resetSettingsCache()
  const effective = getInitialSettings()
  const sources: SettingsWithSources['sources'] = []
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (settings !== null && Object.keys(settings).length > 0) sources.push({ source, settings })
  }
  return { effective, sources }
}

function holdsOwnKeyChain(value: unknown, names: readonly string[]): boolean {
  let node = value
  for (const name of names) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, name)) return false
    node = Reflect.get(node, name)
  }
  return true
}

export function rawSettingsContainsKey(key: string): boolean {
  const names = key.split('.')
  for (const source of getEnabledSettingSources()) {
    if (source === 'policySettings') {
      if (holdsOwnKeyChain(getSettingsForSource('policySettings'), names)) return true
      continue
    }
    const path = getSettingsFilePathForSource(source)
    if (path === undefined) continue
    let raw: string
    try {
      raw = readFileSync(path)
    } catch (error) {
      if (!isENOENT(error)) {
        logError(error)
        return true
      }
      logForDebugging(`settings file absent: ${path}`)
      continue
    }
    if (raw.trim() === '') continue
    const parsed = safeParseJSON(stripBOM(raw), false)
    if (typeof parsed !== 'object' || parsed === null) return true
    if (holdsOwnKeyChain(parsed, names)) return true
  }
  return false
}


export const OUTSIDE_CHECKOUT_SOURCES: ReadonlySet<SettingSource> = new Set([
  'userSettings',
  'flagSettings',
  'policySettings',
])

export function getApiKeyHelperFromOutsideCheckoutSources(): string | undefined {
  let helper: string | undefined
  for (const source of getEnabledSettingSources()) {
    if (!OUTSIDE_CHECKOUT_SOURCES.has(source)) continue
    const settings = getSettingsForSource(source)
    const value = settings?.credentials?.keyCommand ?? settings?.credentials?.keyCommands?.anthropic
    if (typeof value === 'string' && value) helper = value
  }
  return helper
}

export function hasSkipSovereignConsentPrompt(): boolean {
  const trustedSources: SettingSource[] = ['userSettings', 'flagSettings', 'policySettings']
  for (const source of trustedSources) {
    const settings = getSettingsForSource(source)
    if (settings?.guardrails?.sovereignConsentSeen === true) return true
  }
  return false
}

export function getApolloPreflightQuestions(): number {
  const value = getInitialSettings().apollo?.preflightQuestions
  return typeof value === 'number' && Number.isFinite(value) ? value : 7
}


function applyWriteMerge(target: Record<string, unknown>, partial: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) {
      delete target[key]
      continue
    }
    if (Array.isArray(value)) {
      target[key] = value
      continue
    }
    const existing = target[key]
    if (typeof value === 'object' && value !== null) {
      const nested = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : {}
      applyWriteMerge(nested, value as Record<string, unknown>)
      if (Object.keys(nested).length > 0 || Object.keys(value).length === 0) target[key] = nested
      else delete target[key]
      continue
    }
    target[key] = value
  }
}

function acquireSettingsWriteLock(file: string): (() => void) | null {
  try {
    let lastContention: unknown
    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        return lockfile.lockSync(file, {
          lockfilePath: `${file}.lock`,
          realpath: false,
          onCompromised: (err: Error) => {
            logForDebugging(`settings write lock compromised for ${file}: ${err}`, { level: 'error' })
          },
        })
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'ELOCKED') throw err
        lastContention = err
        sleepSync(15 * 2 ** attempt)
      }
    }
    throw lastContention
  } catch (error) {
    logForDebugging(`settings write lock unavailable for ${file}: ${String(error)} — writing lockless`, {
      level: 'error',
    })
    return null
  }
}

type SettingsPatchValue<T> = T extends readonly unknown[] | ((...args: never[]) => unknown)
  ? T | undefined
  : T extends object
    ? { [K in keyof T]?: SettingsPatchValue<T[K]> | undefined }
    : T | undefined

export type SettingsPatch = {
  [K in keyof SettingsJson]?: SettingsPatchValue<SettingsJson[K]> | undefined
}

function readSettingsWriteBase(source: EditableSettingSource, writePath: string): Record<string, unknown> | null {
  let raw = ''
  try {
    raw = readFileSync(getSettingsFilePathForSource(source) ?? writePath)
  } catch (error) {
    if (!isENOENT(error)) throw error
  }
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBOM(raw))
  } catch {
    logForDebugging(`settings write refused: ${writePath} is not parseable JSON (a file mid-edit is never overwritten)`, { level: 'error' })
    return null
  }
  if (!isRecord(parsed)) {
    logForDebugging(`settings write refused: ${writePath} does not hold a JSON object (a file mid-edit is never overwritten)`, { level: 'error' })
    return null
  }
  return parsed
}

function isReadOnlySource(source: SettingSource): boolean {
  return source === 'policySettings' || source === 'flagSettings'
}

export function updateSettingsForSource(
  source: EditableSettingSource,
  partial: SettingsPatch | ((rawBase: Record<string, unknown>) => SettingsPatch),
): { error: Error | null } {
  if (isReadOnlySource(source)) return { error: null }
  const writePath = getSettingsWriteFilePathForSource(source)
  if (writePath === undefined) return { error: null }
  const release = acquireSettingsWriteLock(writePath)
  try {
    mkdirSync(dirname(writePath), { recursive: true })
    const base = readSettingsWriteBase(source, writePath)
    if (base === null) return { error: new Error(`Invalid JSON in ${writePath} — refusing to overwrite a file mid-edit`) }
    applyWriteMerge(base, typeof partial === 'function' ? partial(structuredClone(base)) : partial)
    const schemaPath = source === 'userSettings' ? ensureLocalSettingsSchema() : null
    if (schemaPath !== null) delete base.$schema
    const stored = schemaPath === null ? base : { $schema: schemaPath, ...base }
    markInternalWrite(writePath)
    durableAtomicPublishSync(writePath, `${jsonStringify(stored, null, 2)}\n`)
    resetSettingsCache()
    if (source === 'localSettings') void addFileGlobRuleToGitignore(getRelativeSettingsFilePathForSource('localSettings'))
    return { error: null }
  } catch (error) {
    logError(error)
    if (error instanceof DurablePublishError && error.phase === 'rename') {
      logForDebugging(`Failed to update settings file ${writePath}: ${error.message}`, { level: 'error' })
      return { error: new Error(`Could not save settings: ${writePath} could not be written (${error.fsCode ?? 'write error'}); nothing was written. Close what holds the file, then try again.`, { cause: error }) }
    }
    return { error: new Error(`Failed to update settings file ${writePath}: ${errorMessage(error)}`, { cause: error }) }
  } finally {
    release?.()
  }
}

export function removeSettingsFileIfEmpty(source: EditableSettingSource): void {
  if ((source as SettingSource) === 'policySettings' || (source as SettingSource) === 'flagSettings') return
  const writePath = getSettingsWriteFilePathForSource(source)
  if (writePath === undefined) return
  try {
    let raw: string
    try {
      raw = readFileSync(writePath)
    } catch (readError) {
      if (!isENOENT(readError)) throw readError
      return
    }
    const parsed: unknown = JSON.parse(stripBOM(raw))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    if (Object.keys(parsed as Record<string, unknown>).some(key => key !== '$schema')) return
    markInternalWrite(writePath)
    unlinkSync(writePath)
    resetSettingsCache()
  } catch (error) {
    logForDebugging(`settings husk prune skipped for ${writePath}: ${errorMessage(error)}`)
  }
}
