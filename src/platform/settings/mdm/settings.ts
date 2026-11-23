import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import escapeRegExp from 'lodash-es/escapeRegExp.js'

import { logForDebugging } from '../../logs/debugLog.js'
import { logForDiagnosticsNoPII } from '../../logs/diagnosticsLog.js'
import { getErrnoCode } from '../../errors/errors.js'
import { isRecord } from '../../primitives/isRecord.js'
import { safeParseJSON } from '../../storage/json.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from '../managedPath.js'
import type { SettingsJson } from '../settingsSchema.js'
import { SettingsSchema } from '../settingsSchema.js'
import type { ValidationError } from '../validation.js'
import { filterInvalidPermissionRules, formatZodError } from '../validation.js'
import {
  WINDOWS_REGISTRY_KEY_PATH_HKCU,
  WINDOWS_REGISTRY_KEY_PATH_HKLM,
  WINDOWS_REGISTRY_VALUE_NAME,
} from './mdmSources.js'
import type { RawReadResult } from './rawRead.js'
import { fireRawRead, getMdmRawReadPromise } from './rawRead.js'
import { recordMdmProbeOutcome } from './probeMemo.js'
import { passedOver } from '../../errors/passedOver.js'

export { mdmBootAwaitsRawRead } from './probeMemo.js'


export type MdmTierResult = { settings: SettingsJson; errors: readonly ValidationError[] }

const EMPTY_TIER: MdmTierResult = Object.freeze({
  settings: Object.freeze({}) as SettingsJson,
  errors: Object.freeze([]),
})

function registryValueOf(stdout: string): string | null {
  const valueLine = new RegExp(`^\\s+${escapeRegExp(WINDOWS_REGISTRY_VALUE_NAME)}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'i')
  for (const line of stdout.split(/\r?\n/)) {
    const payload = valueLine.exec(line)?.[1]?.trimEnd()
    if (payload) return payload
  }
  return null
}

export function parseCommandOutputAsSettings(stdout: string, sourcePath: string): MdmTierResult {
  const parsed = safeParseJSON(stdout)
  if (!isRecord(parsed)) return { settings: {}, errors: [] }
  const warnings = filterInvalidPermissionRules(parsed, sourcePath)
  const result = SettingsSchema().safeParse(parsed)
  if (!result.success) return { settings: {}, errors: [...formatZodError(result.error, sourcePath), ...warnings] }
  return { settings: result.data, errors: warnings }
}

function managedFileSettingsExist(): boolean {
  const candidates: string[] = [join(getManagedFilePath(), 'managed-settings.json')]
  try {
    for (const entry of readdirSync(getManagedSettingsDropInDir())) {
      if (entry.endsWith('.json') && !entry.startsWith('.')) {
        candidates.push(join(getManagedSettingsDropInDir(), entry))
      }
    }
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') logForDebugging(`managed settings drop-in dir unreadable (${code ?? 'unknown'}), so it counts as holding no managed files`)
  }
  for (const candidate of candidates) {
    try {
      const parsed = safeParseJSON(readFileSync(candidate, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        return true
      }
    } catch (error) {
      const code = getErrnoCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') logForDebugging(`managed settings file unreadable (${candidate}, ${code ?? 'unknown'}), so it counts as absent`)
    }
  }
  return false
}

function parseTiers(raw: RawReadResult): { mdm: MdmTierResult; hkcu: MdmTierResult } {
  for (const { stdout, label } of raw.plistStdouts ?? []) {
    const tier = parseCommandOutputAsSettings(stdout, label)
    if (Object.keys(tier.settings).length > 0) return { mdm: tier, hkcu: EMPTY_TIER }
  }
  const machineValue = raw.hklmStdout === null ? null : registryValueOf(raw.hklmStdout)
  if (machineValue !== null) {
    const tier = parseCommandOutputAsSettings(machineValue, `${WINDOWS_REGISTRY_KEY_PATH_HKLM}\\${WINDOWS_REGISTRY_VALUE_NAME}`)
    if (Object.keys(tier.settings).length > 0) return { mdm: tier, hkcu: EMPTY_TIER }
  }
  if (managedFileSettingsExist()) return { mdm: EMPTY_TIER, hkcu: EMPTY_TIER }
  const userValue = raw.hkcuStdout === null ? null : registryValueOf(raw.hkcuStdout)
  if (userValue === null) return { mdm: EMPTY_TIER, hkcu: EMPTY_TIER }
  return {
    mdm: EMPTY_TIER,
    hkcu: parseCommandOutputAsSettings(userValue, `${WINDOWS_REGISTRY_KEY_PATH_HKCU}\\${WINDOWS_REGISTRY_VALUE_NAME}`),
  }
}

let mdmCache: MdmTierResult | null = null
let hkcuCache: MdmTierResult | null = null
let loadInFlight: Promise<void> | null = null

async function loadMdmSettings(): Promise<void> {
  const startedAt = Date.now()
  const raw = await (getMdmRawReadPromise() ?? fireRawRead())
  const { mdm, hkcu } = parseTiers(raw)
  mdmCache = mdm
  hkcuCache = hkcu
  recordMdmProbeOutcome(raw)
  const durationMs = Date.now() - startedAt
  logForDebugging(`MDM settings load completed in ${durationMs}ms`)
  const keys = Object.keys(mdm.settings)
  if (keys.length === 0) return
  logForDebugging(`MDM policy keys: ${keys.join(', ')}`)
  try {
    logForDiagnosticsNoPII('info', 'mdm_settings_loaded', { durationMs, keyCount: keys.length, errorCount: mdm.errors.length })
  } catch (error) {
    passedOver(error)
  }
}

export async function ensureMdmSettingsLoaded(): Promise<void> {
  loadInFlight ??= loadMdmSettings()
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
