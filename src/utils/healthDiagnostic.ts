import { join } from 'node:path'

import { MERCURY_VERSION } from '../constants/product.js'
import {
  resolveInstallProvenance,
  type InstallProvenanceKind,
} from '../services/privateChannel/installProvenance.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { getCwd } from './cwd.js'
import { formatAutoUpdaterDisabledReason, getAutoUpdaterDisabledReason } from './config.js'
import { isInBundledMode } from './bundledMode.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { getRipgrepStatus, warmRipgrepStatus } from './ripgrep.js'
import { CUSTOMIZATION_SURFACES } from './settings/types.js'
import { getManagedFilePath } from './settings/managedPath.js'


const UNKNOWN_MARKER = 'unknown'

export type InstallationType = InstallProvenanceKind

export type DiagnosticInfo = {
  installationType: InstallationType
  version: string
  installationPath: string
  invokedBinary: string
  configInstallMethod: string
  autoUpdates: string
  hasUpdatePermissions: boolean | null
  multipleInstallations: Array<{ type: string; path: string }>
  warnings: Array<{ issue: string; fix: string }>
  recommendation?: string
  packageManager?: string
  ripgrepStatus: { working: boolean; mode: string; systemPath?: string }
}

export function getInvokedBinary(): string {
  try {
    if (isInBundledMode()) return process.execPath
    return process.argv[1] ?? UNKNOWN_MARKER
  } catch {
    return UNKNOWN_MARKER
  }
}

export async function getCurrentInstallationType(): Promise<InstallationType> {
  return resolveInstallProvenance().kind
}

export function detectLinuxGlobPatternWarnings(): Array<{ issue: string; fix: string }> {
  if (getPlatform() !== 'linux') return []
  const patterns = SandboxManager.getLinuxGlobPatternWarnings()
  if (patterns.length === 0) return []
  const shown = patterns.slice(0, 3).join(', ')
  const remainder = patterns.length - 3
  const remainderNote = remainder > 0 ? ` (and ${remainder} more)` : ''
  return [
    {
      issue: 'Wildcard patterns inside sandbox permission rules are only partially honoured on Linux.',
      fix: `${patterns.length} pattern(s) found: ${shown}${remainderNote}. Such patterns in the file-edit and file-read rule families are dropped.`,
    },
  ]
}

export function detectManagedSettingsWarnings(): Array<{ issue: string; fix: string }> {
  const policyPath = join(getManagedFilePath(), 'managed-settings.json')
  let raw: string
  try {
    raw = getFsImplementation().readFileSync(policyPath, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    return [
      {
        issue: `managed-settings.json could not be read (${code ?? 'unknown error'}).`,
        fix: `The managed policy at ${policyPath} exists but is unreadable, so none of its settings apply. Check its permissions and file type.`,
      },
    ]
  }
  try {
    const parsed = JSON.parse(raw) as { strictExtensionOnlyCustomization?: unknown }
    const value = parsed.strictExtensionOnlyCustomization
    if (value === undefined) return []
    const knownSurfaces = [...CUSTOMIZATION_SURFACES]
    if (typeof value !== 'boolean' && !Array.isArray(value)) {
      return [
        {
          issue: `managed-settings.json: strictExtensionOnlyCustomization has an invalid value of type ${typeof value}.`,
          fix: `The value is silently ignored. Acceptable forms: true, or an array of surface names (${knownSurfaces.join(', ')}).`,
        },
      ]
    }
    if (Array.isArray(value)) {
      const unrecognised = value.filter(
        entry => typeof entry === 'string' && !knownSurfaces.includes(entry as never),
      )
      if (unrecognised.length > 0) {
        return [
          {
            issue: `managed-settings.json: strictExtensionOnlyCustomization contains ${unrecognised.length} unrecognised surface name(s): ${unrecognised.join(', ')}.`,
            fix: `Unrecognised names are ignored for forwards compatibility. Known surfaces for this version: ${knownSurfaces.join(', ')}. Either remove them, or this client is older than the settings intended.`,
          },
        ]
      }
    }
    return []
  } catch {
    return []
  }
}

export async function getHealthDiagnostic(): Promise<DiagnosticInfo> {
  const provenance = resolveInstallProvenance()

  const warnings: Array<{ issue: string; fix: string }> = [
    ...detectManagedSettingsWarnings(),
    ...detectLinuxGlobPatternWarnings(),
  ]

  await warmRipgrepStatus()
  const ripgrep = getRipgrepStatus()
  const ripgrepStatus: DiagnosticInfo['ripgrepStatus'] = {
    working: ripgrep.working === true,
    mode: ripgrep.mode,
    ...(ripgrep.mode === 'system' ? { systemPath: ripgrep.path } : {}),
  }

  const disabledReason = getAutoUpdaterDisabledReason()

  return {
    installationType: provenance.kind,
    version: typeof MERCURY_VERSION === 'string' && MERCURY_VERSION ? MERCURY_VERSION : UNKNOWN_MARKER,
    installationPath: provenance.activeRoot || getCwd(),
    invokedBinary: getInvokedBinary(),
    configInstallMethod: provenance.updateOwner,
    autoUpdates: disabledReason
      ? `disabled (${formatAutoUpdaterDisabledReason(disabledReason)})`
      : 'enabled',
    hasUpdatePermissions: null,
    multipleInstallations: [],
    warnings,
    ripgrepStatus,
  }
}
