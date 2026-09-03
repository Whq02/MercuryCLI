import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync, rmSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  SandboxManager as RuntimeSandboxManager,
  SandboxViolationStore,
  SandboxRuntimeConfigSchema,
  getWslVersion,
} from '@anthropic-ai/sandbox-runtime'
import type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  IgnoreViolationsConfig,
  NetworkHostPattern,
  NetworkRestrictionConfig,
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
} from '@anthropic-ai/sandbox-runtime'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { memoize } from 'lodash-es'
import { getMercuryHome } from '../envUtils.js'
import { expandPath } from '../path.js'
import { getPlatform } from '../platform.js'
import type { PermissionUpdate } from '../../types/permissions.js'

export type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  IgnoreViolationsConfig,
  NetworkHostPattern,
  NetworkRestrictionConfig,
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
}
export { SandboxViolationStore, SandboxRuntimeConfigSchema }

const CONFIG_HOMES = ['.mercury', '.claude']
const BARE_REPO_ENTRIES = ['HEAD', 'objects', 'refs', 'hooks', 'config']
const SETTINGS_FILES = ['settings.json', 'settings.local.json']


export function resolvePathPatternForSandbox(pattern: string, sourceRoot: string): string {
  if (pattern.startsWith('//')) return pattern.slice(1)
  if (pattern.startsWith('/')) return join(sourceRoot, pattern)
  return pattern
}

export function resolveSandboxFilesystemPath(pattern: string, sourceRoot: string): string {
  if (pattern.startsWith('//')) return pattern.slice(1)
  const expanded = expandPath(pattern)
  if (isAbsolute(expanded)) return expanded
  return resolve(sourceRoot, expanded)
}


const isSupportedPlatformMemo = memoize(async (): Promise<boolean> => {
  const platform = getPlatform()
  if (platform === 'macos' || platform === 'linux') return true
  if (platform === 'wsl') return String(getWslVersion() ?? '') === '2'
  return false
})

let dependenciesOk = true

function isSupportedPlatformSync(): boolean {
  const platform = getPlatform()
  if (platform === 'macos' || platform === 'linux') return true
  if (platform === 'wsl') return String(getWslVersion() ?? '') === '2'
  return false
}

let cachedDepCheck: SandboxDependencyCheck = { warnings: [], errors: [] }
let dependenciesChecked = false

function ensureDependencyCheck(): void {
  if (dependenciesChecked) return
  dependenciesChecked = true
  try {
    const result = RuntimeSandboxManager.checkDependencies()
    cachedDepCheck = result
    dependenciesOk = result.errors.length === 0
  } catch {
  }
}

async function warmDependencyCheck(): Promise<void> {
  ensureDependencyCheck()
}

export function shouldAllowManagedSandboxDomainsOnly(): boolean {
  const settings = safeGetSettings('policySettings')
  return getSandboxNetwork(settings)?.allowManagedDomainsOnly === true
}


type SettingsShape = {
  sandbox?: Record<string, unknown>
  permissions?: { allow?: string[]; deny?: string[]; additionalDirectories?: string[] }
}

function safeGetSettings(source: string): SettingsShape {
  try {
    const settingsModule = require('../settings/settings.js') as {
      getSettingsForSource(s: string): SettingsShape | undefined
    }
    return settingsModule.getSettingsForSource(source) ?? {}
  } catch {
    return {}
  }
}

function getMergedSettings(): SettingsShape {
  try {
    const settingsModule = require('../settings/settings.js') as { getSettings_DEPRECATED(): SettingsShape }
    return settingsModule.getSettings_DEPRECATED() ?? {}
  } catch {
    return {}
  }
}

function getSandboxSection(settings: SettingsShape): Record<string, unknown> {
  return (settings.sandbox as Record<string, unknown>) ?? {}
}

function getSandboxNetwork(settings: SettingsShape): Record<string, unknown> | undefined {
  return getSandboxSection(settings).network as Record<string, unknown> | undefined
}

function getSandboxFilesystem(settings: SettingsShape): Record<string, unknown> | undefined {
  return getSandboxSection(settings).filesystem as Record<string, unknown> | undefined
}


let scrubList: string[] = []
let cachedWorktreeMainRepo: string | undefined
let worktreeResolved = false

function resolveWorktreeMainRepo(sessionDir: string): string | undefined {
  if (worktreeResolved) return cachedWorktreeMainRepo
  worktreeResolved = true
  try {
    const gitEntry = join(sessionDir, '.git')
    if (statSync(gitEntry).isDirectory()) {
      cachedWorktreeMainRepo = undefined
      return undefined
    }
    const content = readFileSync(gitEntry, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(content)
    if (!match) return undefined
    const gitdir = resolve(sessionDir, match[1]!.trim())
    const segment = `${sep}.git${sep}worktrees${sep}`
    const idx = gitdir.lastIndexOf(segment)
    if (idx <= 0) return undefined
    cachedWorktreeMainRepo = gitdir.slice(0, idx)
    return cachedWorktreeMainRepo
  } catch {
    cachedWorktreeMainRepo = undefined
    return undefined
  }
}

export const SANDBOX_PATH_LIST_CAP = 1024
const truncationLogged = new Set<string>()
export function boundPathList(label: string, list: readonly string[]): string[] {
  const unique = [...new Set(list.filter(entry => typeof entry === 'string' && entry !== ''))]
  if (unique.length <= SANDBOX_PATH_LIST_CAP) return unique
  if (!truncationLogged.has(label)) {
    truncationLogged.add(label)
    logForDebugging(
      `sandbox: ${label} carries ${unique.length} entries — only the first ${SANDBOX_PATH_LIST_CAP} reach the runtime (the argv ceiling); trim the settings list`,
      { level: 'warn' },
    )
  }
  return unique.slice(0, SANDBOX_PATH_LIST_CAP)
}

function buildDenyWrite(): string[] {
  const denyWrite = new Set<string>()
  const originalCwd = getOriginalCwd()
  const currentCwd = getCwd()
  const dirs = currentCwd === originalCwd ? [originalCwd] : [originalCwd, currentCwd]

  try {
    const settingsModule = require('../settings/settings.js') as {
      SETTING_SOURCES?: string[]
      getSettingsFilePathForSource(s: string): string | undefined
      getManagedSettingsDropInDir?(): string | undefined
    }
    for (const source of settingsModule.SETTING_SOURCES ?? []) {
      const path = settingsModule.getSettingsFilePathForSource?.(source)
      if (path) denyWrite.add(path)
    }
    const dropIn = settingsModule.getManagedSettingsDropInDir?.()
    if (dropIn) denyWrite.add(dropIn)
  } catch {
  }

  if (currentCwd !== originalCwd) {
    for (const home of CONFIG_HOMES) {
      for (const file of SETTINGS_FILES) denyWrite.add(join(currentCwd, home, file))
    }
  }

  for (const dir of dirs) {
    for (const home of CONFIG_HOMES) denyWrite.add(join(dir, home, 'skills'))
  }

  scrubList = []
  for (const dir of dirs) {
    for (const entry of BARE_REPO_ENTRIES) {
      const path = join(dir, entry)
      let exists = false
      try {
        lstatSync(path)
        exists = true
      } catch {
        exists = false
      }
      if (exists) denyWrite.add(path)
      else scrubList.push(path)
    }
  }

  return [...denyWrite]
}

const platformUserTempDir = memoize((): string | null => {
  if (getPlatform() !== 'macos') return null
  try {
    const dir = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 2_000 }).trim()
    return dir === '' ? null : realpathSync(dir)
  } catch {
    return null
  }
})

function buildAllowWrite(): string[] {
  const allowWrite = new Set<string>(['.'])
  try {
    const { getMercuryTempDir, getProjectTempDir } = require('../permissions/filesystem.js') as {
      getMercuryTempDir(): string
      getProjectTempDir(): string
    }
    allowWrite.add(getProjectTempDir())
    allowWrite.add(getMercuryTempDir())
  } catch {
  }
  const platformTemp = platformUserTempDir()
  if (platformTemp) allowWrite.add(platformTemp)
  const sessionDir = getCwd()
  const mainRepo = resolveWorktreeMainRepo(sessionDir)
  if (mainRepo && mainRepo !== sessionDir) allowWrite.add(mainRepo)
  const merged = getMergedSettings()
  for (const dir of merged.permissions?.additionalDirectories ?? []) allowWrite.add(dir)
  return [...allowWrite]
}

export function convertToSandboxRuntimeConfig(settings: SettingsShape): SandboxRuntimeConfig {
  const network = getSandboxNetwork(settings) ?? {}
  const managedOnly = shouldAllowManagedSandboxDomainsOnly()

  const allowedDomains = managedOnly
    ? (getSandboxNetwork(safeGetSettings('policySettings'))?.allowedDomains as string[] | undefined) ?? []
    : (network.allowedDomains as string[] | undefined) ?? []

  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains,
      deniedDomains: (network.deniedDomains as string[] | undefined) ?? [],
      allowUnixSockets: network.allowUnixSockets as string[] | undefined,
      allowAllUnixSockets: network.allowAllUnixSockets as boolean | undefined,
      allowLocalBinding: network.allowLocalBinding as boolean | undefined,
      httpProxyPort: network.httpProxyPort as number | undefined,
      socksProxyPort: network.socksProxyPort as number | undefined,
    },
    filesystem: {
      allowWrite: boundPathList('filesystem.allowWrite', buildAllowWrite()),
      denyWrite: boundPathList('filesystem.denyWrite', buildDenyWrite()),
      allowRead: boundPathList('filesystem.allowRead', (getSandboxFilesystem(settings)?.allowRead as string[] | undefined) ?? []),
      denyRead: boundPathList('filesystem.denyRead', (getSandboxFilesystem(settings)?.denyRead as string[] | undefined) ?? []),
    },
  }
  return config
}


export type ISandboxManager = {
  initialize(askCallback?: SandboxAskCallback): Promise<void>
  isSupportedPlatform(): Promise<boolean>
  isPlatformInEnabledList(): boolean
  getSandboxUnavailableReason(): string | null
  isSandboxingEnabled(): boolean
  isSandboxEnabledInSettings(): boolean
  checkDependencies(): SandboxDependencyCheck
  isAutoAllowBashIfSandboxedEnabled(): boolean
  areUnsandboxedCommandsAllowed(): boolean
  isSandboxRequired(): boolean
  areSandboxSettingsLockedByPolicy(): boolean
  setSandboxSettings(settings: Record<string, unknown>): void
  getFsReadConfig(): FsReadRestrictionConfig
  getFsWriteConfig(): FsWriteRestrictionConfig
  getNetworkRestrictionConfig(): NetworkRestrictionConfig
  getAllowUnixSockets(): string[] | undefined
  getAllowLocalBinding(): boolean | undefined
  getIgnoreViolations(): IgnoreViolationsConfig | undefined
  getEnableWeakerNestedSandbox(): boolean | undefined
  getExcludedCommands(): string[]
  getProxyPort(): number | undefined
  getSocksProxyPort(): number | undefined
  getLinuxHttpSocketPath(): string | undefined
  getLinuxSocksSocketPath(): string | undefined
  waitForNetworkInitialization(): Promise<void>
  wrapWithSandbox(command: string, innerShell?: string, abortSignal?: AbortSignal): Promise<string>
  cleanupAfterCommand(): void
  getSandboxViolationStore(): InstanceType<typeof SandboxViolationStore>
  annotateStderrWithSandboxFailures(command: string, stderr: string): string
  getLinuxGlobPatternWarnings(): string[]
  refreshConfig(): void
  reset(): void
}

let initPromise: Promise<void> | null = null
let settingsSubscription: (() => void) | null = null

export const SandboxManager: ISandboxManager = {
  async initialize(askCallback?: SandboxAskCallback): Promise<void> {
    if (!SandboxManager.isSandboxingEnabled()) return
    if (initPromise) return initPromise
    initPromise = (async () => {
      await warmDependencyCheck()
      resolveWorktreeMainRepo(getCwd())
      const config = convertToSandboxRuntimeConfig(getMergedSettings())
      const wrappedCallback: SandboxAskCallback | undefined = askCallback
        ? (async (host: NetworkHostPattern) => {
            if (shouldAllowManagedSandboxDomainsOnly()) {
              logForDebugging(`sandbox blocked host under managed-domains-only: ${String(host)}`)
              return false
            }
            return askCallback(host)
          })
        : undefined
      await RuntimeSandboxManager.initialize(config, wrappedCallback)
      try {
        const settingsModule = require('../settings/changeDetector.js') as {
          onSettingsChanged?(fn: () => void): () => void
        }
        settingsSubscription = settingsModule.onSettingsChanged?.(() => SandboxManager.refreshConfig()) ?? null
      } catch {
        settingsSubscription = null
      }
    })().catch(error => {
      initPromise = null
      logForDebugging(`sandbox initialisation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return initPromise
  },

  isSupportedPlatform: () => isSupportedPlatformMemo(),
  isPlatformInEnabledList(): boolean {
    try {
      const list = getSandboxSection(getMergedSettings()).enabledPlatforms as string[] | undefined
      if (list === undefined) return true
      return list.includes(getPlatform())
    } catch {
      return true
    }
  },

  getSandboxUnavailableReason(): string | null {
    if (!SandboxManager.isSandboxEnabledInSettings()) return null
    const platform = getPlatform()
    if (platform === 'wsl' && String(getWslVersion() ?? '') === '1') {
      return 'The sandbox (sandbox.enabled) needs WSL2; WSL1 is not supported.'
    }
    if (!isSupportedPlatformSync()) {
      return `The sandbox (sandbox.enabled) is not supported on ${platform}; it runs on macOS, Linux and WSL2.`
    }
    if (!SandboxManager.isPlatformInEnabledList()) {
      return `The sandbox (sandbox.enabled) is not enabled on ${platform} by the sandbox.enabledPlatforms setting.`
    }
    const deps = SandboxManager.checkDependencies()
    if ((deps as { errors?: string[] }).errors?.length) {
      const errors = (deps as { errors: string[] }).errors.join(', ')
      const hint = platform === 'macos' ? 'Run /sandbox and /health to diagnose.' : `Install the missing tools: ${errors}.`
      return `The sandbox (sandbox.enabled) is missing dependencies: ${errors}. ${hint}`
    }
    return null
  },

  isSandboxingEnabled(): boolean {
    if (!isSupportedPlatformSync()) return false
    ensureDependencyCheck()
    if (!dependenciesOk) return false
    if (!SandboxManager.isPlatformInEnabledList()) return false
    return SandboxManager.isSandboxEnabledInSettings()
  },

  isSandboxEnabledInSettings(): boolean {
    try {
      return getSandboxSection(getMergedSettings()).enabled === true
    } catch {
      logForDebugging('failed to read sandbox.enabled; treating as off')
      return false
    }
  },

  checkDependencies: () => {
    ensureDependencyCheck()
    return cachedDepCheck
  },

  isAutoAllowBashIfSandboxedEnabled(): boolean {
    const value = getSandboxSection(getMergedSettings()).autoAllowBashIfSandboxed
    return value === undefined ? true : value === true
  },
  areUnsandboxedCommandsAllowed(): boolean {
    const value = getSandboxSection(getMergedSettings()).allowUnsandboxedCommands
    return value === undefined ? true : value === true
  },
  isSandboxRequired(): boolean {
    if (!SandboxManager.isSandboxingEnabled()) return false
    return getSandboxSection(getMergedSettings()).failIfUnavailable === true
  },
  areSandboxSettingsLockedByPolicy(): boolean {
    const keys = ['enabled', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands']
    for (const source of ['flagSettings', 'policySettings']) {
      const section = getSandboxSection(safeGetSettings(source))
      if (keys.some(key => section[key] !== undefined)) return true
    }
    return false
  },

  setSandboxSettings(settings: Record<string, unknown>): void {
    try {
      const settingsModule = require('../settings/settings.js') as {
        getSettingsForSource(s: string): SettingsShape | undefined
        updateSettingsForSource(s: string, v: unknown): { error: Error | null }
      }
      const current = settingsModule.getSettingsForSource('localSettings') ?? {}
      const merged = { ...getSandboxSection(current), ...settings }
      settingsModule.updateSettingsForSource('localSettings', { ...current, sandbox: merged })
    } catch (error) {
      logForDebugging(`failed to write sandbox settings: ${error instanceof Error ? error.message : String(error)}`)
    }
  },

  getFsReadConfig: () => RuntimeSandboxManager.getFsReadConfig(),
  getFsWriteConfig: () => RuntimeSandboxManager.getFsWriteConfig(),
  getNetworkRestrictionConfig: () => RuntimeSandboxManager.getNetworkRestrictionConfig(),
  getAllowUnixSockets: () => RuntimeSandboxManager.getAllowUnixSockets(),
  getAllowLocalBinding: () => RuntimeSandboxManager.getAllowLocalBinding(),
  getIgnoreViolations: () => RuntimeSandboxManager.getIgnoreViolations() as IgnoreViolationsConfig | undefined,
  getEnableWeakerNestedSandbox: () => getSandboxSection(getMergedSettings()).enableWeakerNestedSandbox as boolean | undefined,
  getExcludedCommands(): string[] {
    return (getSandboxSection(getMergedSettings()).excludedCommands as string[] | undefined) ?? []
  },
  getProxyPort: () => RuntimeSandboxManager.getProxyPort(),
  getSocksProxyPort: () => RuntimeSandboxManager.getSocksProxyPort(),
  getLinuxHttpSocketPath: () => RuntimeSandboxManager.getLinuxHttpSocketPath(),
  getLinuxSocksSocketPath: () => RuntimeSandboxManager.getLinuxSocksSocketPath(),
  waitForNetworkInitialization: async () => {
    await RuntimeSandboxManager.waitForNetworkInitialization()
  },

  async wrapWithSandbox(command: string, innerShell?: string, abortSignal?: AbortSignal): Promise<string> {
    if (SandboxManager.isSandboxingEnabled()) {
      if (!initPromise) throw new Error('Sandbox is enabled but not initialised; refusing to run unsandboxed.')
      await initPromise
    }
    return RuntimeSandboxManager.wrapWithSandbox(command, innerShell, undefined, abortSignal)
  },

  cleanupAfterCommand(): void {
    RuntimeSandboxManager.cleanupAfterCommand()
    for (const path of scrubList) {
      try {
        rmSync(path, { recursive: true, force: true })
        if (existsSync(path)) continue
        logForDebugging(`scrubbed planted bare-repo path ${path}`)
      } catch {
      }
    }
  },

  getSandboxViolationStore: () => RuntimeSandboxManager.getSandboxViolationStore(),
  annotateStderrWithSandboxFailures: (_command: string, stderr: string) =>
    RuntimeSandboxManager.annotateStderrWithSandboxFailures(_command, stderr),

  getLinuxGlobPatternWarnings(): string[] {
    const platform = getPlatform()
    if (platform !== 'linux' && platform !== 'wsl') return []
    if (!SandboxManager.isSandboxEnabledInSettings()) return []
    try {
      const perms = getMergedSettings().permissions ?? {}
      const rules = [...(perms.allow ?? []), ...(perms.deny ?? [])]
      return rules.filter(rule => {
        const content = rule.replace(/^[^(]+\(/, '').replace(/\)$/, '').replace(/\/\*\*$/, '')
        return /[*?[\]]/.test(content)
      })
    } catch {
      return []
    }
  },

  refreshConfig(): void {
    if (!SandboxManager.isSandboxEnabledInSettings()) return
    const config = convertToSandboxRuntimeConfig(getMergedSettings())
    RuntimeSandboxManager.updateConfig(config)
  },

  reset(): void {
    settingsSubscription?.()
    settingsSubscription = null
    cachedWorktreeMainRepo = undefined
    worktreeResolved = false
    scrubList = []
    isSupportedPlatformMemo.cache.clear?.()
    cachedDepCheck = { warnings: [], errors: [] }
    dependenciesOk = true
    dependenciesChecked = false
    initPromise = null
    void RuntimeSandboxManager.reset()
  },
}

export function addToExcludedCommands(command: string, permissionUpdates?: PermissionUpdate[]): string {
  let pattern = command
  if (permissionUpdates) {
    for (const update of permissionUpdates) {
      if (update.type !== 'addRules') continue
      const bashRule = (update.rules as { toolName: string; ruleContent?: string }[]).find(
        r => r.toolName === 'Bash',
      )
      if (bashRule?.ruleContent) {
        pattern = bashRule.ruleContent.replace(/:\*$/, '')
        break
      }
    }
  }
  const existing = SandboxManager.getExcludedCommands()
  if (!existing.includes(pattern)) {
    SandboxManager.setSandboxSettings({ excludedCommands: [...existing, pattern] })
  }
  return pattern
}

void getMercuryHome
