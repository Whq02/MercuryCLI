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


export type MdmTierResult = { settings: SettingsJson; errors: ValidationError[] }

const EMPTY_TIER: MdmTierResult = Object.freeze({
  settings: Object.freeze({}) as SettingsJson,
  errors: Object.freeze([]) as unknown as ValidationError[],
})

let mdmCache: MdmTierResult | null = null
let hkcuCache: MdmTierResult | null = null
let loadInFlight: Promise<void> | null = null

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

function managedFileSettingsExist(): boolean {
  const candidates: string[] = [join(getManagedFilePath(), 'managed-settings.json')]
  try {
    for (const entry of readdirSync(getManagedSettingsDropInDir())) {
      if (entry.endsWith('.json') && !entry.startsWith('.')) {
        candidates.push(join(getManagedSettingsDropInDir(), entry))
      }
    }
  } catch {
  }
  for (const candidate of candidates) {
    try {
      const parsed = safeParseJSON(readFileSync(candidate, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        return true
      }
    } catch {
    }
  }
  return false
}

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

export function startMdmSettingsLoad(): void {
  if (loadInFlight !== null) return
  loadInFlight = (async () => {
    const startedAt = Date.now()
    const raw = await (getMdmRawReadPromise() ?? fireRawRead())
    const { mdm, hkcu } = parseTiers(raw)
    mdmCache = mdm
    hkcuCache = hkcu
    recordMdmProbeOutcome(raw)
    const durationMs = Date.now() - startedAt
    logForDebugging(`MDM settings load completed in ${durationMs}ms`)
    if (Object.keys(mdm.settings).length > 0) {
      logForDebugging(`MDM policy keys: ${Object.keys(mdm.settings).join(', ')}`)
      try {
        logForDiagnosticsNoPII('info', 'mdm_settings_loaded', {
          durationMs,
          keyCount: Object.keys(mdm.settings).length,
          errorCount: mdm.errors.length,
        })
      } catch {
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

export function clearMdmSettingsCache(): void {
  mdmCache = null
  hkcuCache = null
  loadInFlight = null
}

export function setMdmSettingsCache(mdm: MdmTierResult, hkcu: MdmTierResult): void {
  mdmCache = mdm
  hkcuCache = hkcu
}

export async function refreshMdmSettings(): Promise<{ mdm: MdmTierResult; hkcu: MdmTierResult }> {
  return parseTiers(await fireRawRead())
}
