import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import mergeWith from 'lodash-es/mergeWith.js'
import { z } from 'zod/v4'

import { getFlagSettingsInline, getFlagSettingsPath, getOriginalCwd } from '../../bootstrap/state.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../debug.js'
import { RETIRED_SETTINGS_KEYS, rewriteRetiredSettingsSpellings } from '../../migrations/migrateSettingsSpellings.js'
import { getMercuryHome } from '../envUtils.js'
import { errorMessage, isENOENT } from '../errors.js'
import { readFileSync } from '../fileRead.js'
import { addFileGlobRuleToGitignore } from '../git/gitignore.js'
import { safeParseJSON, stripBOM } from '../json.js'
import * as lockfile from '../lockfile.js'
import { logError } from '../log.js'
import { MERCURY_PROJECT_DIR, resolveProjectConfigPath } from '../projectConfig.js'
import { adoptiveProjectPath } from '../projectStoreAdoption.js'
import { jsonStringify } from '../slowOperations.js'
import { profileCheckpoint } from '../startupProfiler.js'
import type { EditableSettingSource, SettingSource } from './constants.js'
import { getEnabledSettingSources } from './constants.js'
import { ensureLocalSettingsSchema } from './localSchema.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from './managedPath.js'
import { getHkcuSettings, getMdmSettings } from './mdm/settings.js'
import { markInternalWrite } from './internalWrites.js'
import {
  getCachedParsedFile,
  getCachedSettingsForSource,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedParsedFile,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settingsCache.js'
import type { SettingsJson } from './types.js'
import { SettingsSchema } from './types.js'
import type { ValidationError, SettingsWithErrors } from './validation.js'
import { filterInvalidPermissionRules, formatZodError } from './validation.js'


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

function adoptLegacySupercodeSpelling(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const record = parsed as Record<string, unknown>
  if (!('ultracodeEffort' in record)) return
  if (record['supercodeEffort'] === undefined) record['supercodeEffort'] = record['ultracodeEffort']
  delete record['ultracodeEffort']
}

function adoptRetiredExcludesSpelling(parsed: unknown, filePath: string): ValidationError[] {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const record = parsed as Record<string, unknown>
  if (!('claudeMdExcludes' in record)) return []
  const legacy = record['claudeMdExcludes']
  if (Array.isArray(legacy) && record['instructionExcludes'] === undefined) {
    record['instructionExcludes'] = legacy
  }
  delete record['claudeMdExcludes']
  return [
    {
      file: filePath,
      path: 'claudeMdExcludes',
      message:
        "'claudeMdExcludes' was renamed 'instructionExcludes' — the legacy value was adopted for this run; rename the key so the setting stops depending on the adoption",
      suggestion: "rename the key to 'instructionExcludes'",
    },
  ]
}

function publishRewrittenSpellings(filePath: string, rewritten: unknown): ValidationError[] {
  try {
    markInternalWrite(filePath)
    durableAtomicPublishSync(filePath, `${jsonStringify(rewritten, null, 2)}\n`)
    logForDebugging(`settings: rewrote retired spellings in ${filePath}`)
    return []
  } catch (error) {
    const renames = RETIRED_SETTINGS_KEYS.map(r => `${r.from.join('.')} → ${r.to.join('.')}`).join(', ')
    return [
      {
        file: filePath,
        path: '',
        severity: 'warning',
        message: `retired settings spellings could not be rewritten in place (${errorMessage(error)}); this run reads them as their current spellings — rename them in the file (${renames}; tool names in rules and matchers likewise)`,
        suggestion: 'rename the keys and tool names to their current spellings',
      },
    ]
  }
}

function parseSettingsFileUncached(filePath: string): { settings: SettingsJson | null; errors: ValidationError[] } {
  let raw: string
  try {
    raw = readFileSync(filePath)
  } catch (error) {
    if (isENOENT(error)) {
      logForDebugging(`settings file absent: ${filePath}`)
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
  if (raw.trim() === '') {
    return { settings: {} as SettingsJson, errors: [] }
  }
  const shared = safeParseJSON(stripBOM(raw), false)
  let parsed = typeof shared === 'object' && shared !== null ? (structuredClone(shared) as unknown) : shared
  adoptLegacySupercodeSpelling(parsed)
  const retiredKeyWarnings = adoptRetiredExcludesSpelling(parsed, filePath)
  const rewritten = rewriteRetiredSettingsSpellings(parsed)
  const spellingWarnings = rewritten === parsed ? [] : publishRewrittenSpellings(filePath, rewritten)
  parsed = rewritten
  const warnings = [...retiredKeyWarnings, ...spellingWarnings, ...filterInvalidPermissionRules(parsed, filePath)]
  const result = SettingsSchema().safeParse(parsed)
  if (!result.success) {
    const salvaged = salvageValidSettings(parsed, result.error)
    const zodErrors =
      salvaged !== null
        ? formatZodError(result.error, filePath).map(record => ({ ...record, severity: 'warning' as const }))
        : formatZodError(result.error, filePath)
    return { settings: salvaged, errors: [...zodErrors, ...warnings] }
  }
  return { settings: result.data as SettingsJson, errors: warnings }
}

const SALVAGE_REMOVED: unique symbol = Symbol('settings-salvage-removed')

function pruneDeepestAlongPath(root: Record<string, unknown>, path: ReadonlyArray<PropertyKey>): boolean {
  if (path.length === 0) return false
  const chain: Array<{ parent: Record<PropertyKey, unknown> | unknown[]; key: PropertyKey }> = []
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null) break
    const container = node as Record<PropertyKey, unknown>
    if (!(key in container) || container[key] === SALVAGE_REMOVED) break
    chain.push({ parent: container as Record<PropertyKey, unknown> | unknown[], key })
    node = container[key]
  }
  if (chain.length === 0) return false
  const { parent, key } = chain[chain.length - 1] as { parent: Record<PropertyKey, unknown> | unknown[]; key: PropertyKey }
  if (Array.isArray(parent)) {
    parent[key as number] = SALVAGE_REMOVED
  } else {
    delete parent[key]
  }
  return true
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

function salvageValidSettings(parsed: unknown, error: z.ZodError): SettingsJson | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const working = structuredClone(parsed) as Record<string, unknown>
  let issues = error.issues
  for (let round = 0; round < 8; round++) {
    let prunedAny = false
    for (const issue of issues) {
      if (issue.path.length === 0) return null
      if (pruneDeepestAlongPath(working, issue.path as ReadonlyArray<PropertyKey>)) prunedAny = true
    }
    if (!prunedAny) return null
    sweepSalvageTombstones(working)
    const reparsed = SettingsSchema().safeParse(working)
    if (reparsed.success) return reparsed.data as SettingsJson
    issues = reparsed.error.issues
  }
  return null
}

export function parseSettingsFile(filePath: string): { settings: SettingsJson | null; errors: ValidationError[] } {
  const cached = getCachedParsedFile(filePath)
  if (cached !== undefined) {
    return cloneParsed(cached as { settings: SettingsJson | null; errors: ValidationError[] })
  }
  const result = parseSettingsFileUncached(filePath)
  setCachedParsedFile(filePath, result)
  return cloneParsed(result)
}


export function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return getMercuryHome()
    case 'projectSettings':
    case 'localSettings':
    case 'policySettings':
      return getOriginalCwd()
    case 'flagSettings': {
      const flagPath = getFlagSettingsPath()
      return flagPath !== undefined ? dirname(flagPath) : getOriginalCwd()
    }
  }
}

export function getSettingsFilePathForSource(source: SettingSource): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(getMercuryHome(), 'settings.json')
    case 'projectSettings':
      return (
        resolveProjectConfigPath(getOriginalCwd(), 'settings.json') ??
        join(getOriginalCwd(), MERCURY_PROJECT_DIR, 'settings.json')
      )
    case 'localSettings':
      return (
        resolveProjectConfigPath(getOriginalCwd(), 'settings.local.json') ??
        join(getOriginalCwd(), MERCURY_PROJECT_DIR, 'settings.local.json')
      )
    case 'policySettings':
      return join(getManagedFilePath(), 'managed-settings.json')
    case 'flagSettings':
      return getFlagSettingsPath()
  }
}

export function getRelativeSettingsFilePathForSource(source: 'projectSettings' | 'localSettings'): string {
  const absolute = getSettingsFilePathForSource(source) as string
  return relative(getOriginalCwd(), absolute)
}

export function getSettingsWriteFilePathForSource(source: SettingSource): string | undefined {
  switch (source) {
    case 'projectSettings':
      return adoptiveProjectPath(getOriginalCwd(), 'settings.json')
    case 'localSettings':
      return adoptiveProjectPath(getOriginalCwd(), 'settings.local.json')
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
    }
  }
  return { settings: merged, errors }
}

export function getManagedFileSettingsPresence(): { hasBase: boolean; hasDropIns: boolean } {
  const base = parseSettingsFile(join(getManagedFilePath(), 'managed-settings.json'))
  const hasBase = base.settings !== null && Object.keys(base.settings).length > 0
  let hasDropIns = false
  try {
    hasDropIns = readdirSync(getManagedSettingsDropInDir(), { withFileTypes: true }).some(
      entry =>
        (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.json') && !entry.name.startsWith('.'),
    )
  } catch {
    hasDropIns = false
  }
  return { hasBase, hasDropIns }
}

function loadPolicyForMerge(): { settings: SettingsJson | null; errors: ValidationError[] } {
  const collected: ValidationError[] = []
  const dedupe = (errors: ValidationError[]): ValidationError[] => {
    const seen = new Set<string>()
    return errors.filter(error => {
      const key = `${error.file ?? ''}|${error.path}|${error.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const mdm = getMdmSettings()
  collected.push(...mdm.errors)
  if (Object.keys(mdm.settings).length > 0) {
    return { settings: mdm.settings, errors: dedupe(collected) }
  }
  const file = loadManagedFileSettings()
  collected.push(...file.errors)
  if (file.settings !== null) {
    return { settings: file.settings, errors: dedupe(collected) }
  }
  const hkcu = getHkcuSettings()
  collected.push(...hkcu.errors)
  if (Object.keys(hkcu.settings).length > 0) {
    return { settings: hkcu.settings, errors: dedupe(collected) }
  }
  return { settings: null, errors: dedupe(collected) }
}

export function getPolicySettingsOrigin(): 'plist' | 'hklm' | 'file' | 'hkcu' | null {
  if (Object.keys(getMdmSettings().settings).length > 0) {
    return process.platform === 'win32' ? 'hklm' : 'plist'
  }
  if (loadManagedFileSettings().settings !== null) return 'file'
  if (Object.keys(getHkcuSettings().settings).length > 0) return 'hkcu'
  return null
}


function readSettingsForSourceUncached(source: SettingSource): SettingsJson | null {
  if (source === 'policySettings') {
    const mdm = getMdmSettings()
    if (Object.keys(mdm.settings).length > 0) return rewriteRetiredSettingsSpellings(mdm.settings) as SettingsJson
    const file = loadManagedFileSettings()
    if (file.settings !== null) return file.settings
    const hkcu = getHkcuSettings()
    if (Object.keys(hkcu.settings).length > 0) return rewriteRetiredSettingsSpellings(hkcu.settings) as SettingsJson
    return null
  }
  const filePath = getSettingsFilePathForSource(source)
  if (filePath === undefined) {
    if (source === 'flagSettings') {
      const inline = getFlagSettingsInline()
      if (inline !== null) {
        const result = SettingsSchema().safeParse(rewriteRetiredSettingsSpellings(inline))
        if (result.success) return result.data as SettingsJson
      }
    }
    return null
  }
  const parsed = parseSettingsFile(filePath)
  let settings = parsed.settings
  if (source === 'flagSettings') {
    const inline = getFlagSettingsInline()
    if (inline !== null) {
      const result = SettingsSchema().safeParse(rewriteRetiredSettingsSpellings(inline))
      if (result.success) {
        settings = mergeWith(settings ?? {}, result.data, settingsMergeCustomizer) as SettingsJson
      }
    }
  }
  return settings
}

export function getSettingsForSource(source: SettingSource): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) return cached
  const value = readSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, value)
  return value
}


let mergedLoadInProgress = false

export function getSettingsWithErrors(): SettingsWithErrors {
  if (mergedLoadInProgress) {
    return { settings: {} as SettingsJson, errors: [] }
  }
  const cached = getSessionSettingsCache()
  if (cached !== null) return cached as SettingsWithErrors
  mergedLoadInProgress = true
  try {
    profileCheckpoint('settings_merge_start')
    const startedAt = Date.now()
    const filesRead = new Set<string>()
    const errors: ValidationError[] = []
    let merged: SettingsJson = {} as SettingsJson

    for (const source of getEnabledSettingSources()) {
      if (source === 'policySettings') {
        const policy = loadPolicyForMerge()
        errors.push(...policy.errors)
        if (policy.settings !== null) {
          merged = mergeWith(merged, policy.settings, settingsMergeCustomizer) as SettingsJson
        }
        continue
      }
      const filePath = getSettingsFilePathForSource(source)
      if (filePath !== undefined) {
        const resolved = resolve(filePath)
        const dedupeKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
        const firstRead = !filesRead.has(dedupeKey)
        if (firstRead) filesRead.add(dedupeKey)
        const parsed = parseSettingsFile(filePath)
        if (firstRead) errors.push(...parsed.errors)
        if (parsed.settings !== null && Object.keys(parsed.settings).length > 0) {
          merged = mergeWith(merged, parsed.settings, settingsMergeCustomizer) as SettingsJson
        }
      }
      if (source === 'flagSettings') {
        const inline = getFlagSettingsInline()
        if (inline !== null) {
          const result = SettingsSchema().safeParse(inline)
          if (result.success) {
            merged = mergeWith(merged, result.data, settingsMergeCustomizer) as SettingsJson
          }
        }
      }
    }

    const value: SettingsWithErrors = { settings: merged, errors }
    setSessionSettingsCache(value)
    logForDebugging(
      `settings merged in ${Date.now() - startedAt}ms (${filesRead.size} files, ${errors.length} errors)`,
    )
    return value
  } finally {
    mergedLoadInProgress = false
  }
}

export function getInitialSettings(): SettingsJson {
  return getSettingsWithErrors().settings
}

export const getSettings_DEPRECATED = getInitialSettings

export type SettingsWithSources = {
  effective: SettingsJson
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

export function getSettingsWithSources(): SettingsWithSources {
  resetSettingsCache()
  const effective = getInitialSettings()
  const sources: Array<{ source: SettingSource; settings: SettingsJson }> = []
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (settings !== null && Object.keys(settings).length > 0) {
      sources.push({ source, settings })
    }
  }
  return { effective, sources }
}

export function rawSettingsContainsKey(key: string): boolean {
  for (const source of getEnabledSettingSources()) {
    if (source === 'policySettings') {
      const policy = getSettingsForSource('policySettings')
      if (policy !== null && typeof policy === 'object' && key in (policy as object)) return true
      continue
    }
    const filePath = getSettingsFilePathForSource(source)
    if (filePath === undefined) continue
    let raw: string
    try {
      raw = readFileSync(filePath)
    } catch (error) {
      if (isENOENT(error)) {
        logForDebugging(`settings file absent: ${filePath}`)
        continue
      }
      logError(error)
      return true
    }
    if (raw.trim() === '') continue
    const parsed = safeParseJSON(stripBOM(raw), false)
    if (parsed === null || typeof parsed !== 'object') return true
    if (key in (parsed as object)) return true
  }
  return false
}


const OUTSIDE_CHECKOUT_SOURCES: ReadonlySet<SettingSource> = new Set([
  'userSettings',
  'flagSettings',
  'policySettings',
])

export function getHooksFromOutsideCheckoutSources(): NonNullable<SettingsJson['hooks']> {
  let merged: SettingsJson = {} as SettingsJson
  for (const source of getEnabledSettingSources()) {
    if (!OUTSIDE_CHECKOUT_SOURCES.has(source)) continue
    const settings = getSettingsForSource(source)
    if (settings?.hooks) {
      merged = mergeWith(merged, { hooks: settings.hooks } as SettingsJson, settingsMergeCustomizer) as SettingsJson
    }
  }
  return merged.hooks ?? {}
}

export function getApiKeyHelperFromOutsideCheckoutSources(): string | undefined {
  let helper: string | undefined
  for (const source of getEnabledSettingSources()) {
    if (!OUTSIDE_CHECKOUT_SOURCES.has(source)) continue
    const value = getSettingsForSource(source)?.apiKeyHelper
    if (typeof value === 'string' && value) helper = value
  }
  return helper
}

export function hasSkipSovereignConsentPrompt(): boolean {
  const trustedSources: SettingSource[] = ['userSettings', 'localSettings', 'flagSettings', 'policySettings']
  for (const source of trustedSources) {
    const settings = getSettingsForSource(source)
    if (settings?.skipSovereignConsentPrompt === true) return true
  }
  return false
}

export function hasAutoModeOptIn(): boolean {
  return false
}

export function getUseAutoModeDuringPlan(): boolean {
  return true
}

export function getAutoModeConfig(): { allow?: string[]; soft_deny?: string[]; environment?: string } | undefined {
  return undefined
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
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      applyWriteMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
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
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * 2 ** attempt)
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

export function updateSettingsForSource(
  source: EditableSettingSource,
  partial: Partial<SettingsJson> | ((rawBase: Record<string, unknown>) => Partial<SettingsJson>),
): { error: Error | null } {
  if ((source as SettingSource) === 'policySettings' || (source as SettingSource) === 'flagSettings') {
    return { error: null }
  }
  const writePath = getSettingsWriteFilePathForSource(source)
  if (writePath === undefined) return { error: null }
  const unlock = acquireSettingsWriteLock(writePath)
  try {
    mkdirSync(dirname(writePath), { recursive: true })

    const readPath = getSettingsFilePathForSource(source) ?? writePath
    let baseSettings: Record<string, unknown>
    {
      let raw: string | null = null
      try {
        raw = readFileSync(readPath)
      } catch (readError) {
        if (!isENOENT(readError)) throw readError
        raw = null
      }
      if (raw === null || raw.trim() === '') {
        baseSettings = {}
      } else {
        let parsedRaw: unknown
        try {
          parsedRaw = JSON.parse(stripBOM(raw))
        } catch {
          logForDebugging(`settings write refused: ${writePath} is not parseable JSON (a file mid-edit is never overwritten)`, {
            level: 'error',
          })
          return {
            error: new Error(`Invalid JSON in ${writePath} — refusing to overwrite a file mid-edit`),
          }
        }
        if (typeof parsedRaw === 'object' && parsedRaw !== null && !Array.isArray(parsedRaw)) {
          baseSettings = parsedRaw as Record<string, unknown>
        } else {
          logForDebugging(`settings write refused: ${writePath} does not hold a JSON object (a file mid-edit is never overwritten)`, {
            level: 'error',
          })
          return {
            error: new Error(`Invalid JSON in ${writePath} — refusing to overwrite a file mid-edit`),
          }
        }
      }
    }
    adoptLegacySupercodeSpelling(baseSettings)
    baseSettings = rewriteRetiredSettingsSpellings(baseSettings) as Record<string, unknown>

    const resolvedPartial =
      typeof partial === 'function' ? partial(structuredClone(baseSettings)) : partial
    applyWriteMerge(baseSettings, resolvedPartial as Record<string, unknown>)

    if (source === 'userSettings') {
      const schemaPath = ensureLocalSettingsSchema()
      if (schemaPath !== null) {
        delete baseSettings.$schema
        const rest = { ...baseSettings }
        for (const k of Object.keys(baseSettings)) delete (baseSettings as Record<string, unknown>)[k]
        baseSettings.$schema = schemaPath
        Object.assign(baseSettings, rest)
      }
    }

    markInternalWrite(writePath)
    durableAtomicPublishSync(writePath, `${jsonStringify(baseSettings, null, 2)}\n`)
    resetSettingsCache()

    if (source === 'localSettings') {
      void addFileGlobRuleToGitignore(getRelativeSettingsFilePathForSource('localSettings'))
    }
    return { error: null }
  } catch (error) {
    logError(error)
    return { error: new Error(`Failed to update settings file ${writePath}: ${errorMessage(error)}`) }
  } finally {
    unlock?.()
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


const KNOWN_LOGGING_CHILDREN: Record<string, string[]> = {
  permissions: ['allow', 'deny', 'ask', 'defaultMode', 'disableSovereignMode', 'disableFlowMode', 'additionalDirectories'],
  sandbox: [
    'enabled',
    'failIfUnavailable',
    'allowUnsandboxedCommands',
    'network',
    'filesystem',
    'ignoreViolations',
    'excludedCommands',
    'autoAllowBashIfSandboxed',
    'enableWeakerNestedSandbox',
    'enableWeakerNetworkIsolation',
    'ripgrep',
  ],
  hooks: [
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'UserPromptSubmit',
    'SessionStart',
    'SessionEnd',
    'Stop',
    'SubagentStop',
    'PreCompact',
    'PostCompact',
    'TeammateIdle',
    'TaskCreated',
    'TaskCompleted',
  ],
}

export function getManagedSettingsKeysForLogging(settings: SettingsJson): string[] {
  const stripped = z.object(SettingsSchema().shape).parse(settings) as Record<string, unknown>
  const keys: string[] = []
  for (const [key, value] of Object.entries(stripped)) {
    if (value === undefined) continue
    const children = KNOWN_LOGGING_CHILDREN[key]
    if (children !== undefined && typeof value === 'object' && value !== null) {
      let pushedChild = false
      for (const child of children) {
        if (child in (value as object)) {
          keys.push(`${key}.${child}`)
          pushedChild = true
        }
      }
      if (!pushedChild) keys.push(key)
      continue
    }
    keys.push(key)
  }
  return keys.sort()
}
