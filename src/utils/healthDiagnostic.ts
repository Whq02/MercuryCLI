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

/**
 * Assemble the installation/health record the health surface renders. The
 * Several installation-topology fields are constant in this
 * build by design.
 */

// The health surface prints this literal; also the version fallback.
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

/** The invoked executable, or the unknown marker. */
export function getInvokedBinary(): string {
  try {
    if (isInBundledMode()) return process.execPath
    return process.argv[1] ?? UNKNOWN_MARKER
  } catch {
    return UNKNOWN_MARKER
  }
}

/**
 * One typed classification for the whole product — never hand-rolled here,
 * and never defaulted to a source-build placeholder that would tell a
 * managed install to update itself with a version control command.
 */
export async function getCurrentInstallationType(): Promise<InstallationType> {
  return resolveInstallProvenance().kind
}

/**
 * On Linux, one warning when wildcard patterns are present inside sandbox
 * permission rules — they are only partially honoured on this platform.
 */
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

/**
 * The one configuration-correctness check: the managed policy's
 * extensions-only-customization field. The schema silently rescues bad values
 * (so one future enum value cannot null out an entire policy file), but the
 * administrator should still be told. Runs before any development-mode
 * short-circuit because it is about configuration, not install topology.
 * Absent or malformed files are not this check's business.
 */
export function detectManagedSettingsWarnings(): Array<{ issue: string; fix: string }> {
  // getManagedFilePath() names the managed ROOT DIRECTORY; the policy file is
  // its managed-settings.json child (the same spelling the settings loader
  // uses). Reading the root itself threw EISDIR into the bare catch on every
  // real install, so this check could never fire (field F-2.1).
  const policyPath = join(getManagedFilePath(), 'managed-settings.json')
  let raw: string
  try {
    raw = getFsImplementation().readFileSync(policyPath, { encoding: 'utf8' })
  } catch (error) {
    // An absent policy is not this check's business. Any OTHER read failure
    // is a configuration fact the administrator should hear — a policy that
    // exists but cannot be read applies nothing.
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
    // Malformed JSON: the settings loader reports that on its own surface.
    return []
  }
}

/** Assemble the whole diagnostic record. */
export async function getHealthDiagnostic(): Promise<DiagnosticInfo> {
  const provenance = resolveInstallProvenance()

  const warnings: Array<{ issue: string; fix: string }> = [
    ...detectManagedSettingsWarnings(),
    ...detectLinuxGlobPatternWarnings(),
  ]

  // The diagnostic runs without ever having searched, so the lazy version
  // probe has not happened. Await the one-shot warm-up first, and report an
  // unprobed state as not-working — never optimistically true.
  await warmRipgrepStatus()
  const ripgrep = getRipgrepStatus()
  const ripgrepStatus: DiagnosticInfo['ripgrepStatus'] = {
    // An unknown (unprobed) status reports as false, never optimistically true.
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
    // The install snapshot's update owner; the STORED configuration value
    // describes another harness's co-resident installation and must never be
    // mutated.
    configInstallMethod: provenance.updateOwner,
    autoUpdates: disabledReason
      ? `disabled (${formatAutoUpdaterDisabledReason(disabledReason)})`
      : 'enabled',
    // The permission probe applied only to a deleted install topology.
    hasUpdatePermissions: null,
    // A source build: scanning for stray binaries of another harness's name
    // would flag the user's unrelated installation as a duplicate (it is
    // a launcher dependency) and never find the actual installation — the
    // honest location is the path row. Keeping this empty also keeps the
    // leftover-package-manager cleanup block from ever firing.
    multipleInstallations: [],
    warnings,
    // Never populated in this build; left absent rather than invented.
    // (recommendation)
    // Always undefined on a source build. (packageManager)
    ripgrepStatus,
  }
}
