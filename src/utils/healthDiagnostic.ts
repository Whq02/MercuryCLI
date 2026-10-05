import { join } from 'node:path'

import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { CUSTOMIZATION_SURFACES } from './settings/types.js'
import { getManagedFilePath } from './settings/managedPath.js'

export type ManagedPolicyWarning = { issue: string; fix: string }

export function detectLinuxGlobPatternWarnings(): ManagedPolicyWarning[] {
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

export function managedPolicyPath(): string {
  return join(getManagedFilePath(), 'managed-settings.json')
}

export function managedPolicyPresent(): boolean {
  try {
    return getFsImplementation().existsSync(managedPolicyPath())
  } catch {
    return false
  }
}

export function detectManagedSettingsWarnings(): ManagedPolicyWarning[] {
  const policyPath = managedPolicyPath()
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
    const parsed = JSON.parse(raw) as { extensions?: { exclusive?: unknown } }
    const value = parsed.extensions?.exclusive
    if (value === undefined) return []
    const knownSurfaces = [...CUSTOMIZATION_SURFACES]
    if (typeof value !== 'boolean' && !Array.isArray(value)) {
      return [
        {
          issue: `managed-settings.json: extensions.exclusive has an invalid value of type ${typeof value}.`,
          fix: `The value reads as a full lock — every customization surface is restricted to extensions. Acceptable forms: true, or an array of surface names (${knownSurfaces.join(', ')}).`,
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
            issue: `managed-settings.json: extensions.exclusive contains ${unrecognised.length} unrecognised surface name(s): ${unrecognised.join(', ')}.`,
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
