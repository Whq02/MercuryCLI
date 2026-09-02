import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { logForDebugging } from '../../debug.js'
import { logForDiagnosticsNoPII } from '../../diagLogs.js'
import { safeParseJSON } from '../../json.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from '../managedPath.js'
import type { SettingsJson } from '../types.js'
import { SettingsSchema } from '../types.js'
import type { ValidationError } from '../validation.js'
import { filterInvalidPermissionRules, formatZodError } from '../validation.js'
import {
  WINDOWS_REGISTRY_KEY_PATH_HKCU,
  WINDOWS_REGISTRY_KEY_PATH_HKLM,
  WINDOWS_REGISTRY_VALUE_NAME,
} from './constants.js'
import type { RawReadResult } from './rawRead.js'
import { fireRawRead, getMdmRawReadPromise } from './rawRead.js'
import { recordMdmProbeOutcome } from './probeMemo.js'

export { mdmBootAwaitsRawRead } from './probeMemo.js'

/**
 * Parsing, caching and first-source-wins selection for MDM (admin) and
 * HKCU (user-writable Windows) policy tiers.
 */

export type MdmTierResult = { settings: SettingsJson; errors: ValidationError[] }

// A shared frozen empty value: callers can never mutate the "no policy"
// answer, and both caches read as empty (never undefined) before the load.
const EMPTY_TIER: MdmTierResult = Object.freeze({
  settings: Object.freeze({}) as SettingsJson,
  errors: Object.freeze([]) as unknown as ValidationError[],
})

let mdmCache: MdmTierResult | null = null
let hkcuCache: MdmTierResult | null = null
let loadInFlight: Promise<void> | null = null

/**
 * Registry stdout parsing: `<indent><name><ws>REG_SZ<ws><payload>` lines,
 * name matched case-insensitively and literally (metacharacters escaped),
 * REG_EXPAND_SZ accepted, leading whitespace required, trailing payload
 * whitespace trimmed. An empty payload does not count — the scan
 * continues. First match wins; both line-ending conventions accepted.
 */
export function parseRegQueryStdout(
  stdout: string,
  valueName: string = WINDOWS_REGISTRY_VALUE_NAME,
): string | null {
  const escapedName = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const linePattern = new RegExp(`^\\s+${escapedName}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'i')
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(linePattern)
    if (!match) continue
    const payload = (match[1] as string).replace(/\s+$/, '')
    if (payload === '') continue
    return payload
  }
  return null
}

/**
 * Lenient parse → in-place permission-rule filtering → schema validation.
 * A non-JSON or non-object payload is simply absent (empty settings, no
 * errors); a schema failure yields EMPTY settings plus the formatted
 * errors — a broken policy must not partially apply. Rule-filter warnings
 * ride along in both outcomes.
 */
export function parseCommandOutputAsSettings(stdout: string, sourcePath: string): MdmTierResult {
  const parsed = safeParseJSON(stdout)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { settings: {} as SettingsJson, errors: [] }
  }
  const warnings = filterInvalidPermissionRules(parsed, sourcePath)
  const result = SettingsSchema().safeParse(parsed)
  if (!result.success) {
    return { settings: {} as SettingsJson, errors: [...formatZodError(result.error, sourcePath), ...warnings] }
  }
  return { settings: result.data as SettingsJson, errors: [...warnings] }
}

/** Non-empty JSON object in the base file or any drop-in; unreadable/malformed entries skipped. */
function managedFileSettingsExist(): boolean {
  const candidates: string[] = [join(getManagedFilePath(), 'managed-settings.json')]
  try {
    for (const entry of readdirSync(getManagedSettingsDropInDir())) {
      if (entry.endsWith('.json') && !entry.startsWith('.')) {
        candidates.push(join(getManagedSettingsDropInDir(), entry))
      }
    }
  } catch {
    // No drop-in directory.
  }
  for (const candidate of candidates) {
    try {
      const parsed = safeParseJSON(readFileSync(candidate, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        return true
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return false
}

/**
 * First-source-wins: a plist parse with at least one key wins outright and
 * suppresses HKCU; else an HKLM result with at least one key; else, when
 * file-based managed settings exist, HKCU is skipped entirely; only then
 * does HKCU apply. A tier parsing to zero keys is discarded WITH its
 * validation errors and the walk continues. Registry labels name the
 * MERCURY key path even when the compatibility key supplied the payload
 * (the raw reader already collapsed the two per hive).
 */
function parseTiers(raw: RawReadResult): { mdm: MdmTierResult; hkcu: MdmTierResult } {
  if (raw.plistStdouts !== null) {
    for (const entry of raw.plistStdouts) {
      const parsed = parseCommandOutputAsSettings(entry.stdout, entry.label)
      if (Object.keys(parsed.settings).length > 0) {
        return { mdm: parsed, hkcu: EMPTY_TIER }
      }
    }
  }
  if (raw.hklmStdout !== null) {
    const payload = parseRegQueryStdout(raw.hklmStdout)
    if (payload !== null) {
      const parsed = parseCommandOutputAsSettings(
        payload,
        `${WINDOWS_REGISTRY_KEY_PATH_HKLM}\\${WINDOWS_REGISTRY_VALUE_NAME}`,
      )
      if (Object.keys(parsed.settings).length > 0) {
        return { mdm: parsed, hkcu: EMPTY_TIER }
      }
    }
  }
  if (managedFileSettingsExist()) {
    return { mdm: EMPTY_TIER, hkcu: EMPTY_TIER }
  }
  if (raw.hkcuStdout !== null) {
    const payload = parseRegQueryStdout(raw.hkcuStdout)
    if (payload !== null) {
      const parsed = parseCommandOutputAsSettings(
        payload,
        `${WINDOWS_REGISTRY_KEY_PATH_HKCU}\\${WINDOWS_REGISTRY_VALUE_NAME}`,
      )
      return { mdm: EMPTY_TIER, hkcu: parsed }
    }
  }
  return { mdm: EMPTY_TIER, hkcu: EMPTY_TIER }
}

/** Idempotent fire-and-forget; reuses the startup raw read when one is in flight. */
export function startMdmSettingsLoad(): void {
  if (loadInFlight !== null) return
  loadInFlight = (async () => {
    const startedAt = Date.now()
    const raw = await (getMdmRawReadPromise() ?? fireRawRead())
    const { mdm, hkcu } = parseTiers(raw)
    mdmCache = mdm
    hkcuCache = hkcu
    // FN-020 row 4: the completed read's outcome is the next boot's probe
    // (win32 only; see probeMemo.ts).
    recordMdmProbeOutcome(raw)
    const durationMs = Date.now() - startedAt
    logForDebugging(`MDM settings load completed in ${durationMs}ms`)
    if (Object.keys(mdm.settings).length > 0) {
      // Key NAMES only — never values.
      logForDebugging(`MDM policy keys: ${Object.keys(mdm.settings).join(', ')}`)
      try {
        logForDiagnosticsNoPII('info', 'mdm_settings_loaded', {
          durationMs,
          keyCount: Object.keys(mdm.settings).length,
          errorCount: mdm.errors.length,
        })
      } catch {
        // The diagnostic channel is best-effort; it must not fail the load.
      }
    }
  })()
}

export async function ensureMdmSettingsLoaded(): Promise<void> {
  startMdmSettingsLoad()
  await loadInFlight
}

export function getMdmSettings(): MdmTierResult {
  return mdmCache ?? EMPTY_TIER
}

export function getHkcuSettings(): MdmTierResult {
  return hkcuCache ?? EMPTY_TIER
}

/** Also forgets the in-flight load, so the next kick-off starts fresh. */
export function clearMdmSettingsCache(): void {
  mdmCache = null
  hkcuCache = null
  loadInFlight = null
}

/** Used by the MDM poll to make synchronous readers see fresh values. */
export function setMdmSettingsCache(mdm: MdmTierResult, hkcu: MdmTierResult): void {
  mdmCache = mdm
  hkcuCache = hkcu
}

/** A fresh raw read and parse WITHOUT touching the caches; the apply decision belongs to the caller. */
export async function refreshMdmSettings(): Promise<{ mdm: MdmTierResult; hkcu: MdmTierResult }> {
  return parseTiers(await fireRawRead())
}
