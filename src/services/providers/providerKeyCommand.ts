import { spawnSync } from 'node:child_process'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted, untrustedWorkspaceHeadless } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { isBareMode } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { getEnabledSettingSources, type SettingSource } from '../../utils/settings/constants.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { signInLedgerEpoch } from '../../utils/accounts/signInLedger.js'

const OUTSIDE_CHECKOUT_SOURCES: ReadonlySet<SettingSource> = new Set([
  'userSettings',
  'flagSettings',
  'policySettings',
])

const KEY_COMMAND_TIMEOUT_MS = 10_000
const KEY_COMMAND_BACKOFF_MS = 30_000

interface CacheEntry {
  command: string
  key: string | null
  failure: { message: string; at: number } | null
  fetchedAtMs: number
}

const cache = new Map<string, CacheEntry>()
let seenEpoch = -1

function syncEpoch(): void {
  const epoch = signInLedgerEpoch()
  if (seenEpoch !== epoch) {
    seenEpoch = epoch
    cache.clear()
  }
}

function commandFromSettings(settings: Record<string, any> | null | undefined, family: string): string | undefined {
  if (!settings) return undefined
  if (family.startsWith('compat:')) {
    const endpoint = family.slice('compat:'.length)
    const block = settings.compatProvider
    const direct = typeof block === 'object' && block !== null
      ? (endpoint === 'default' && typeof block.keyCommand === 'string' ? block.keyCommand : typeof block[endpoint]?.keyCommand === 'string' ? block[endpoint].keyCommand : undefined)
      : undefined
    if (direct?.trim()) return direct.trim()
    const mapped = settings.credentials?.keyCommands?.[family] ?? settings.credentials?.keyCommands?.[`compat/${endpoint}`] ?? (endpoint === 'default' ? settings.credentials?.keyCommands?.['openai-compat'] : undefined)
    return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : undefined
  }
  if (family === 'anthropic' && typeof settings.credentials?.keyCommand === 'string' && settings.credentials.keyCommand.trim()) {
    return settings.credentials.keyCommand.trim()
  }
  const mapped = settings.credentials?.keyCommands?.[family]
  return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : undefined
}

function allowedSources(family: string): readonly SettingSource[] {
  if (family.startsWith('compat:')) return ['userSettings', 'flagSettings', 'policySettings']
  if (isBareMode()) return ['flagSettings']
  const enabled = getEnabledSettingSources()
  if (untrustedWorkspaceHeadless()) return enabled.filter(source => OUTSIDE_CHECKOUT_SOURCES.has(source))
  return enabled
}

function blockedByInteractiveTrust(family: string, configured: string): boolean {
  if (family.startsWith('compat:') || getIsNonInteractiveSession() || checkHasTrustDialogAccepted()) return false
  const fromProject =
    configured === commandFromSettings(getSettingsForSource('projectSettings') as Record<string, any>, family) ||
    configured === commandFromSettings(getSettingsForSource('localSettings') as Record<string, any>, family)
  return fromProject
}

export function configuredProviderKeyCommand(family: string): string | undefined {
  let command: string | undefined
  for (const source of allowedSources(family)) {
    const value = commandFromSettings(getSettingsForSource(source) as Record<string, any>, family)
    if (value !== undefined) command = value
  }
  return command
}

function settingLabelOf(family: string): string {
  if (family === 'anthropic' && getInitialSettings().credentials?.keyCommand) return 'credentials.keyCommand'
  if (family.startsWith('compat:')) {
    const name = family.slice('compat:'.length)
    return name === 'default' ? 'compatProvider.keyCommand' : `compatProvider.${name}.keyCommand`
  }
  return `credentials.keyCommands.${family}`
}

function runCommandSync(command: string, label: string): { key: string | null; failure: { message: string; at: number } | null } {
  const result = spawnSync(command, {
    shell: true,
    cwd: getCwd(),
    env: process.env,
    timeout: KEY_COMMAND_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  const now = Date.now()
  const timedOut = Boolean((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || /timed out/i.test(result.error?.message ?? ''))
  if (timedOut || result.status !== 0) {
    const stderr = (result.stderr ?? '').trim()
    const code = result.status ?? 1
    const why = timedOut ? 'timed out after 10s' : `exited with code ${code}`
    const message = `${label} ${why}${stderr ? `: ${stderr}` : ''}`
    logError(new Error(message))
    return { key: null, failure: { message, at: now } }
  }
  const value = (result.stdout ?? '').trim()
  if (!value) {
    const message = `${label} returned no value`
    logError(new Error(message))
    return { key: null, failure: { message, at: now } }
  }
  return { key: value, failure: null }
}

export function resolveProviderKeyCommand(family: string): string | undefined {
  syncEpoch()
  const command = configuredProviderKeyCommand(family)
  if (!command) {
    cache.delete(family)
    return undefined
  }
  if (blockedByInteractiveTrust(family, command)) return undefined
  const now = Date.now()
  const existing = cache.get(family)
  if (existing && existing.command === command) {
    if (existing.key !== null) return existing.key
    if (existing.failure !== null && now - existing.fetchedAtMs < KEY_COMMAND_BACKOFF_MS) return undefined
  }
  const outcome = runCommandSync(command, settingLabelOf(family))
  cache.set(family, { command, key: outcome.key, failure: outcome.failure, fetchedAtMs: now })
  return outcome.key ?? undefined
}

export function providerKeyCommandFailure(family: string): { message: string; at: number } | null {
  syncEpoch()
  const existing = cache.get(family)
  if (!existing || existing.failure === null) return null
  const command = configuredProviderKeyCommand(family)
  return command !== undefined && existing.command === command ? existing.failure : null
}

export function invalidateProviderKeyCommand(family?: string): void {
  if (family === undefined) {
    cache.clear()
    return
  }
  const existing = cache.get(family)
  if (existing) {
    existing.key = null
    existing.fetchedAtMs = 0
  }
}

export function recoverProviderKeyCommand(family: string, previousKey?: string): string | undefined {
  invalidateProviderKeyCommand(family)
  const fresh = resolveProviderKeyCommand(family)
  return fresh && fresh !== previousKey ? fresh : undefined
}
