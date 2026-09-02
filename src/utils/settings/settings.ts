import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import mergeWith from 'lodash-es/mergeWith.js'
import { z } from 'zod/v4'

import { getFlagSettingsInline, getFlagSettingsPath, getOriginalCwd } from '../../bootstrap/state.js'
import { getRemoteManagedSettingsSyncFromCache } from '../../services/remoteManagedSettings/syncCacheState.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../debug.js'
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

/**
 * The settings load/merge/precedence/write pipeline: per-file parsing with
 * cloned cache hand-outs, per-source reads, the low-to-high merged
 * cascade, policy tier selection, and the durable write path.
 */


// ————— merge policies —————

/**
 * The LOAD-time array policy: concatenate then de-duplicate, preserving
 * first-seen order across the low→high walk. Anything else defers to the
 * default deep merge. (Write-time merging is the OTHER policy: arrays
 * replace wholesale and explicit undefined deletes.)
 */
export function settingsMergeCustomizer(objValue: unknown, srcValue: unknown): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return [...new Set([...objValue, ...srcValue])]
  }
  return undefined
}

// ————— per-file parsing —————

function cloneParsed(value: { settings: SettingsJson | null; errors: ValidationError[] }): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  return JSON.parse(JSON.stringify(value)) as { settings: SettingsJson | null; errors: ValidationError[] }
}

/**
 * One-time persisted-value adoption: a stored
 * legacy `ultracodeEffort` reads as `supercodeEffort`. Every file-store read
 * flows through this parse, and the write path re-reads through it too, so
 * the next settings write persists the new spelling and drops the old key.
 * No alias exists anywhere else.
 */
function adoptLegacySupercodeSpelling(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const record = parsed as Record<string, unknown>
  if (!('ultracodeEffort' in record)) return
  if (record['supercodeEffort'] === undefined) record['supercodeEffort'] = record['ultracodeEffort']
  delete record['ultracodeEffort']
}

/** The pre-rename exclusion key (FC-102): 'claudeMdExcludes' was accepted
 *  with zero validation errors — unknown top-level keys are preserved by
 *  policy — and silently excluded NOTHING. The legacy spelling is ADOPTED
 *  (the sibling supercode precedent: the operator's intent lands) and the
 *  rename is NAMED as a warning the Settings row surfaces. */
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

function parseSettingsFileUncached(filePath: string): { settings: SettingsJson | null; errors: ValidationError[] } {
  let raw: string
  try {
    raw = readFileSync(filePath)
  } catch (error) {
    // A missing file or broken symlink is only debug-worthy.
    if (isENOENT(error)) {
      logForDebugging(`settings file absent: ${filePath}`)
      return { settings: null, errors: [] }
    }
    // Any OTHER read failure (EISDIR — a directory literally named
    // settings.json — EACCES, and kin) is a real validation problem the
    // doctor must see: the empty-errors return here made doctor report
    // "0 validation errors" over an unreadable store.
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
  // Lenient parse, BOM stripped, parse failures unlogged on this path —
  // the resulting null reaches the schema and surfaces as the root-level
  // malformed-JSON validation error.
  //
  // CLONED before the two in-place passes below: safeParseJSON hands every
  // caller the SAME cached object (json.ts LRU, keyed by the text — every
  // settings file is under its 8KB bypass), so mutating it here stripped the
  // invalid rules out of the shared value and the SECOND parse of the same
  // text collected zero warnings — the '1 settings issue' notice retracted
  // itself after any unrelated settings write while the bad rule still sat
  // in the file, and two byte-identical files could only ever report the
  // first one's warnings (TASK-017 S2,
  // shared-json-parse-object-mutated-by-settings-validator; the layer above
  // already clones on hand-out for exactly this hazard).
  const shared = safeParseJSON(stripBOM(raw), false)
  const parsed = typeof shared === 'object' && shared !== null ? (structuredClone(shared) as unknown) : shared
  adoptLegacySupercodeSpelling(parsed)
  const retiredKeyWarnings = adoptRetiredExcludesSpelling(parsed, filePath)
  const warnings = [...retiredKeyWarnings, ...filterInvalidPermissionRules(parsed, filePath)]
  const result = SettingsSchema().safeParse(parsed)
  if (!result.success) {
    // One bad value must not void the file: every unrelated key — including
    // every permissions.deny rule — would silently stop applying (FC-004).
    // Prune exactly the invalid entries and keep the valid remainder; the
    // errors still surface either way. Only a root-shape failure (malformed
    // JSON, non-object root) still fails whole.
    const salvaged = salvageValidSettings(parsed, result.error)
    // The loader is the one place that KNOWS the semantics (B9's severity
    // channel): a successful salvage means every listed value was skipped
    // and the remainder applies — 'warning'; a voided file (salvage null)
    // keeps the hard default, whole-file-skip words and all.
    const zodErrors =
      salvaged !== null
        ? formatZodError(result.error, filePath).map(record => ({ ...record, severity: 'warning' as const }))
        : formatZodError(result.error, filePath)
    return { settings: salvaged, errors: [...zodErrors, ...warnings] }
  }
  return { settings: result.data as SettingsJson, errors: warnings }
}

/** The array-element tombstone used by the salvage prune (spliced in a sweep
 *  so sibling issue indexes never shift mid-round). */
const SALVAGE_REMOVED: unique symbol = Symbol('settings-salvage-removed')

/**
 * Prune the deepest EXISTING node along one issue path. A wrong-typed leaf is
 * dropped where it sits; a missing-required leaf prunes its nearest existing
 * ancestor (the malformed hook ENTRY, not the file). Array elements become
 * tombstones for the caller's sweep. Returns false when nothing was pruned.
 */
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

/** Sweep the tombstones the prune left in arrays, depth-first. */
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

/**
 * Drop exactly the schema-invalid entries of a settings blob and return the
 * valid remainder, or null when nothing can be salvaged (root-shape failure,
 * or pruning cannot converge). Bounded rounds: each prune can surface a new
 * issue one level up (a hook entry emptied of its only member), so re-parse
 * and re-prune until clean.
 */
function salvageValidSettings(parsed: unknown, error: z.ZodError): SettingsJson | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const working = structuredClone(parsed) as Record<string, unknown>
  let issues = error.issues
  for (let round = 0; round < 8; round++) {
    let prunedAny = false
    for (const issue of issues) {
      if (issue.path.length === 0) return null // root-shape failure — unsalvageable
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

/**
 * Cached by path; the result is CLONED on every hand-out including the
 * first — callers deep-merge into what they receive and would otherwise
 * poison the cache for the next reader.
 */
export function parseSettingsFile(filePath: string): { settings: SettingsJson | null; errors: ValidationError[] } {
  const cached = getCachedParsedFile(filePath)
  if (cached !== undefined) {
    return cloneParsed(cached as { settings: SettingsJson | null; errors: ValidationError[] })
  }
  const result = parseSettingsFileUncached(filePath)
  setCachedParsedFile(filePath, result)
  return cloneParsed(result)
}

// ————— paths —————

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

/**
 * READ resolution. Project and local paths probe the project-config homes
 * in order and take the first home in which the file ITSELF exists (an
 * existing legacy or compat file is honoured in place); no home carrying
 * it falls back to the canonical home. Re-run on every call — nothing
 * memoises it, so an adopted-forward file changes where later reads look.
 */
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

/** The read path expressed relative to the project root (gitignore rules and UI labels need this form). */
export function getRelativeSettingsFilePathForSource(source: 'projectSettings' | 'localSettings'): string {
  const absolute = getSettingsFilePathForSource(source) as string
  return relative(getOriginalCwd(), absolute)
}

/**
 * WRITE resolution: project and local writes always target the canonical
 * home (with one-time zero-loss adoption of a legacy file, and an alias
 * refusal that makes this fallible — the throw is deliberate).
 */
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

// ————— managed / policy —————

/** The managed base file merged first, then every drop-in `*.json` sorted ascending (later wins). Null when nothing produced content. */
export function loadManagedFileSettings(): { settings: SettingsJson | null; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  let merged: SettingsJson | null = null
  const mergeIn = (settings: SettingsJson | null): void => {
    // Only a parsed, non-empty object counts as content.
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
    // A missing or non-directory drop-in directory is not an error.
    if (!isENOENT(error) && (error as { code?: string }).code !== 'ENOTDIR') {
      logError(error)
    }
  }
  return { settings: merged, errors }
}

/** Deliberately asymmetric: the base half requires a parsed non-empty object; the drop-in half is a listing test only. */
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

/**
 * The remote blob must be re-validated before use — a per-source reader
 * returning the raw blob unvalidated could spoof a security-sensitive
 * setting the merged loader correctly rejected.
 */
function getValidatedRemoteBlob(): { original: SettingsJson; parsed: SettingsJson } | null {
  const blob = getRemoteManagedSettingsSyncFromCache()
  if (blob === null) return null
  const result = SettingsSchema().safeParse(blob)
  if (!result.success) return null
  return { original: blob as SettingsJson, parsed: result.data as SettingsJson }
}

/**
 * The policy contribution for the MERGED view: schema-parsed remote first,
 * then MDM, then the managed file, then HKCU — first source with content
 * wins; errors collect from every tier consulted (the winner included) and
 * de-duplicate by (file, path, message).
 */
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
  const remoteBlob = getRemoteManagedSettingsSyncFromCache()
  if (remoteBlob !== null) {
    const result = SettingsSchema().safeParse(remoteBlob)
    if (result.success) {
      // The merged view takes the schema-PARSED result; the per-source
      // reader hands back the original blob. Deliberately different.
      return { settings: result.data as SettingsJson, errors: dedupe(collected) }
    }
    collected.push(...formatZodError(result.error, 'remote managed settings'))
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

/** Which policy tier won; the same remote validation applies, so a rejected blob is never reported as the origin. */
export function getPolicySettingsOrigin(): 'remote' | 'plist' | 'hklm' | 'file' | 'hkcu' | null {
  if (getValidatedRemoteBlob() !== null) return 'remote'
  if (Object.keys(getMdmSettings().settings).length > 0) {
    return process.platform === 'win32' ? 'hklm' : 'plist'
  }
  if (loadManagedFileSettings().settings !== null) return 'file'
  if (Object.keys(getHkcuSettings().settings).length > 0) return 'hkcu'
  return null
}

// ————— per-source reads —————

function readSettingsForSourceUncached(source: SettingSource): SettingsJson | null {
  if (source === 'policySettings') {
    const remote = getValidatedRemoteBlob()
    // The per-source read hands back the ORIGINAL blob so nothing the
    // schema would strip is lost.
    if (remote !== null) return remote.original
    const mdm = getMdmSettings()
    if (Object.keys(mdm.settings).length > 0) return mdm.settings
    const file = loadManagedFileSettings()
    if (file.settings !== null) return file.settings
    const hkcu = getHkcuSettings()
    if (Object.keys(hkcu.settings).length > 0) return hkcu.settings
    return null
  }
  const filePath = getSettingsFilePathForSource(source)
  if (filePath === undefined) {
    if (source === 'flagSettings') {
      const inline = getFlagSettingsInline()
      if (inline !== null) {
        const result = SettingsSchema().safeParse(inline)
        if (result.success) return result.data as SettingsJson
      }
    }
    return null
  }
  const parsed = parseSettingsFile(filePath)
  let settings = parsed.settings
  if (source === 'flagSettings') {
    // Inline SDK-supplied settings validate and merge ON TOP of the flag
    // file; invalid inline settings are silently ignored.
    const inline = getFlagSettingsInline()
    if (inline !== null) {
      const result = SettingsSchema().safeParse(inline)
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

// ————— the merged load —————

let mergedLoadInProgress = false

export function getSettingsWithErrors(): SettingsWithErrors {
  // Re-entrancy guard: a nested load returns empty settings.
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
        // The dedupe set counts DISTINCT FILES (telemetry) and gates the
        // error push — but never the merge: a --settings file that IS a
        // cascade member must still apply at THIS source's priority.
        // Skipping the later merge silently demoted the operator's explicit
        // flag file below project/local, and on win32 the outcome even
        // flipped on the drive letter's case — so the key case-folds there
        // (FC-027). An identical file re-merges idempotently.
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

/** The effective merged settings; always an object. */
export function getInitialSettings(): SettingsJson {
  return getSettingsWithErrors().settings
}

/** Compatibility alias of {@link getInitialSettings}. */
export const getSettings_DEPRECATED = getInitialSettings

export type SettingsWithSources = {
  effective: SettingsJson
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

/**
 * The effective merge plus per-source raw settings low→high (non-empty,
 * enabled sources only). Resets the caches FIRST so the effective view and
 * the per-source views describe the same disk state.
 */
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

/** Does any user-controlled settings file mention this key at all,
 *  validation aside? UNKNOWN answers YES (release-hardening audit rank
 *  40): a source file that exists but cannot be parsed or read MAY carry
 *  the key. The cleanup retention guard consumes this, and answering
 *  false for exactly the broken file the guard exists to respect let the
 *  sweep delete on the 30-day default while the user's configured window
 *  sat unreadable in that file. The policy tier is probed through its
 *  parsed view too (registry/plist policy has no local file). */
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
      return true // present but unreadable — it may carry the key
    }
    if (raw.trim() === '') continue
    const parsed = safeParseJSON(stripBOM(raw), false)
    if (parsed === null || typeof parsed !== 'object') return true // unparseable — it may carry the key
    if (key in (parsed as object)) return true
  }
  return false
}

// ————— security-sensitive readers —————

/**
 * The settings sources living OUTSIDE the checkout: the operator's config
 * home, the CLI flag, and managed policy. In the fresh-clone threat every
 * file INSIDE the checkout is attacker-delivered — .mercury/settings.json
 * AND the nominally gitignored .mercury/settings.local.json, which a
 * hostile repository can simply commit — so EXECUTABLE config (hooks, the
 * apiKeyHelper) reads from these sources alone when an untrusted workspace
 * runs headless (FC-144). Deliberately NARROWER than
 * hasSkipDangerousModePermissionPrompt's trusted set below: that reader
 * guards the operator's own machine pre-accepting a dialog; this one guards
 * a checkout executing on arrival.
 */
const OUTSIDE_CHECKOUT_SOURCES: ReadonlySet<SettingSource> = new Set([
  'userSettings',
  'flagSettings',
  'policySettings',
])

/** The merged hooks map from the outside-checkout sources only (FC-144). */
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

/** The apiKeyHelper from the outside-checkout sources only (FC-144);
 *  higher-precedence sources win, mirroring the full merge. */
export function getApiKeyHelperFromOutsideCheckoutSources(): string | undefined {
  let helper: string | undefined
  for (const source of getEnabledSettingSources()) {
    if (!OUTSIDE_CHECKOUT_SOURCES.has(source)) continue
    const value = getSettingsForSource(source)?.apiKeyHelper
    if (typeof value === 'string' && value) helper = value
  }
  return helper
}

/**
 * True when the user, local, flag or policy source carries the acceptance
 * flag. The PROJECT source is deliberately excluded — a hostile repository
 * must not pre-accept the bypass-permissions dialog.
 */
export function hasSkipDangerousModePermissionPrompt(): boolean {
  const trustedSources: SettingSource[] = ['userSettings', 'localSettings', 'flagSettings', 'policySettings']
  for (const source of trustedSources) {
    const settings = getSettingsForSource(source)
    if (settings?.skipDangerousModePermissionPrompt === true) return true
  }
  return false
}

/** Constant in this tree; the exclude-project-settings contract around it is preserved. */
export function hasAutoModeOptIn(): boolean {
  return false
}

/** Constant in this tree (opt-out default). */
export function getUseAutoModeDuringPlan(): boolean {
  return true
}

/** Constant in this tree. */
export function getAutoModeConfig(): { allow?: string[]; soft_deny?: string[]; environment?: string } | undefined {
  return undefined
}

/** Apollo Mode's pre-flight interview poll budget: `apollo.preflightQuestions`,
 *  default 7. Reads the
 *  merged settings the way every settings consumer does (session cache,
 *  invalidated on settings changes). */
export function getApolloPreflightQuestions(): number {
  const value = getInitialSettings().apollo?.preflightQuestions
  return typeof value === 'number' && Number.isFinite(value) ? value : 7
}

// ————— writing —————

/** Write-merge policy: objects deep-merge, arrays REPLACE, explicit undefined DELETES. */
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

/** The bounded write lock — the global-config writer's family (pinned
 *  `${file}.lock` artefact, realpath off so a not-yet-created target is
 *  lockable, ELOCKED backoff 15·2^n ≈ 2s total). Null when the lock could
 *  not be taken: the write proceeds lockless exactly as before, with the
 *  contention named in the debug log (release-hardening audit rank 41 —
 *  two sessions' unserialized read-merge-publish rounds dropped each
 *  other's grants). */
function acquireSettingsWriteLock(file: string): (() => void) | null {
  try {
    let lastContention: unknown
    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        return lockfile.lockSync(file, {
          lockfilePath: `${file}.lock`,
          realpath: false,
          onCompromised: (err: Error) => {
            // The library default throws from a timer — an unhandled crash.
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

/**
 * Merges a partial update into an editable source's file. Policy/flag
 * writes are silent no-ops. NOTE: write-path resolution runs OUTSIDE the
 * error guard and can throw (the canonical-home alias refusal) — that
 * placement is deliberate; callers who must never see a throw guard it
 * themselves.
 *
 * The partial may be an UPDATER — a function receiving the fresh raw
 * parsed file and returning the partial to merge (release-hardening audit
 * rank 41): an array computed from any CACHED view republishes a stale
 * snapshot wholesale (applyWriteMerge replaces arrays), silently dropping
 * a peer session's grant and any rule the loader had filtered from the
 * cached view. The whole read-merge-publish additionally runs under the
 * bounded write lock above.
 */
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

    // THE WRITE BASE IS THE RAW FILE (TASK-017 S2,
    // settings-write-erases-rejected-permission-rules +
    // nested-settings-keys-stripped-on-write): the parsed view is a
    // FILTERED view — filterInvalidPermissionRules drops the rules it
    // warned about and every nested schema strips unknown keys — and
    // republishing that view meant any unrelated write (/theme, /model, a
    // 'don't ask again' grant) silently EDITED the operator's file: the
    // warned-invalid rule vanished together with its only evidence, and a
    // hook matcher's extra key (hooks.ts's own recorded data-loss defect)
    // vanished with it. The base is now the file's own parseable JSON —
    // read fresh, bypassing every cache — while the schema keeps gating
    // the READ view exactly as before, and an unparseable file still
    // refuses below (never clobber a mid-edit file).
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
          // Never clobber a file the user is mid-edit. Said once in the
          // debug log too — the returned verdict is the callers' truth,
          // and a refusal that leaves no trace anywhere is how relocated
          // values went missing (release-hardening audit rank 17).
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
    // The legacy-key adoption keeps persisting through writes — applied to
    // the raw base now that the filtered view no longer is the base.
    adoptLegacySupercodeSpelling(baseSettings)

    // An updater computes its partial FROM the fresh raw base — the only
    // view an array rewrite may lawfully replace.
    const resolvedPartial =
      typeof partial === 'function' ? partial(structuredClone(baseSettings)) : partial
    applyWriteMerge(baseSettings, resolvedPartial as Record<string, unknown>)

    // The config-home file carries the LOCAL generated schema pointer —
    // editors validate against Mercury's own schema, refreshed with the
    // build. Only userSettings: a machine-absolute path has no place in a
    // committed project file. An unwritable home leaves any pointer as-is.
    if (source === 'userSettings') {
      const schemaPath = ensureLocalSettingsSchema()
      if (schemaPath !== null) {
        // $schema LEADS the written file (editor convention), and the lead
        // position makes the key order DETERMINISTIC across write histories
        // — a later merge write returns an unchanged file to its prior
        // bytes (the survives-with-prior-bytes law).
        delete baseSettings.$schema
        const rest = { ...baseSettings }
        for (const k of Object.keys(baseSettings)) delete (baseSettings as Record<string, unknown>)[k]
        baseSettings.$schema = schemaPath
        Object.assign(baseSettings, rest)
      }
    }

    // Marked BEFORE touching disk so the watcher can ignore its own echo.
    markInternalWrite(writePath)
    // Durable and atomic; the file stays human-editable JSON.
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

/**
 * Removes an editable source's file when it holds an EMPTY object — the
 * uninstall husk law, mirroring the secure store's own prune: a `{}` file
 * carries zero configuration and the loader reads absent and empty
 * identically, so an emptied file leaves the disk instead of standing as a
 * husk. `$schema` does not count as configuration: it is an editor pointer
 * the loader ignores, and the own-naming lane stamps it onto every
 * user-settings write — a file holding only the pointer reads identically
 * to absent and would otherwise stand as the husk forever once the two
 * lanes fold. A populated, unparseable, or absent file is
 * never touched (config is the operator's file).
 */
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
    // A mid-edit or unreadable file stays exactly as it is.
    logForDebugging(`settings husk prune skipped for ${writePath}: ${errorMessage(error)}`)
  }
}

// ————— logging keys —————

const KNOWN_LOGGING_CHILDREN: Record<string, string[]> = {
  permissions: ['allow', 'deny', 'ask', 'defaultMode', 'disableBypassPermissionsMode', 'additionalDirectories'],
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

/**
 * Key NAMES for logging (never values). Strips unknown keys by re-parsing
 * in stripping mode — which THROWS on a schema-invalid object; hand it
 * settings that already validated. Permissions/sandbox/hooks expand one
 * level for known children only. Sorted.
 */
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
