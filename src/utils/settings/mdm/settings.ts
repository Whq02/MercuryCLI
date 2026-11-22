import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { logForDebugging } from '../../debug.js'
import { logForDiagnosticsNoPII } from '../../diagLogs.js'
import { getErrnoCode } from '../../errors.js'
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
import { passedOver } from '../../passedOver.js'
import { notBuilt } from '../../../pi/holes.js'

export { mdmBootAwaitsRawRead } from './probeMemo.js'


export type MdmTierResult = { settings: SettingsJson; errors: readonly ValidationError[] }

const EMPTY_TIER: MdmTierResult = Object.freeze({
  settings: Object.freeze({}) as SettingsJson,
  errors: Object.freeze([]),
})

export function parseCommandOutputAsSettings(stdout: string, sourcePath: string): MdmTierResult {
  return notBuilt('src/utils/settings/mdm/settings.ts:53')
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
  return notBuilt('src/utils/settings/mdm/settings.ts:92')
}

export async function ensureMdmSettingsLoaded(): Promise<void> {
  return notBuilt('src/utils/settings/mdm/settings.ts:155')
}

export function getMdmSettings(): MdmTierResult {
  return notBuilt('src/utils/settings/mdm/settings.ts:160')
}

export function getHkcuSettings(): MdmTierResult {
  return notBuilt('src/utils/settings/mdm/settings.ts:164')
}

export function clearMdmSettingsCache(): void {
  return notBuilt('src/utils/settings/mdm/settings.ts:168')
}

export function setMdmSettingsCache(mdm: MdmTierResult, hkcu: MdmTierResult): void {
  return notBuilt('src/utils/settings/mdm/settings.ts:174')
}

export async function refreshMdmSettings(): Promise<{ mdm: MdmTierResult; hkcu: MdmTierResult }> {
  return parseTiers(await fireRawRead())
}
