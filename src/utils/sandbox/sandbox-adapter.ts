/**
 * Adapter over the vendored external sandbox runtime: translates the product's
 * settings/permission model into that runtime's config, adds product-specific
 * deny paths and post-command scrubbing, and re-exports a single manager
 * façade. The enforcement itself belongs to the external package.
 */
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

/**
 * The project-config home names, enumerated LITERALLY here (contract data):
 * the native home and the external harness's compatibility home. This is a
 * deliberate, adjudicated exception to the route-through-the-resolver rule —
 * the sandbox deny-write policy must name BOTH, and routing through the
 * resolver would name only the resolved home and narrow the deny set (the
 * wrong direction for a security policy).
 */
const CONFIG_HOMES = ['.mercury', '.claude']
/** Bare-repository entry names to guard (contract data). */
const BARE_REPO_ENTRIES = ['HEAD', 'objects', 'refs', 'hooks', 'config']
/** Settings file names (contract data). */
const SETTINGS_FILES = ['settings.json', 'settings.local.json']

// ─────────────────────────────────────────────────────────────────────────────
// Path convention resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a PERMISSION-RULE path pattern for the sandbox. Product-specific
 * prefixes the runtime does not understand: `//` = absolute from root (drop
 * one slash); `/` = relative to the declaring settings file's directory;
 * home-relative and relative pass through.
 */
export function resolvePathPatternForSandbox(pattern: string, sourceRoot: string): string {
  if (pattern.startsWith('//')) return pattern.slice(1) // absolute from root
  if (pattern.startsWith('/')) return join(sourceRoot, pattern) // relative to source root
  return pattern // ~/… and relative pass through
}

/**
 * Resolve a SANDBOX-FILESYSTEM-SETTING path with STANDARD semantics: absolute
 * = absolute; home-relative expanded here; relative resolves against the
 * declaring settings file's directory. The legacy double-slash escape is
 * still accepted, checked first.
 */
export function resolveSandboxFilesystemPath(pattern: string, sourceRoot: string): string {
  if (pattern.startsWith('//')) return pattern.slice(1) // legacy escape, checked first
  const expanded = expandPath(pattern)
  if (isAbsolute(expanded)) return expanded
  return resolve(sourceRoot, expanded)
}

// ─────────────────────────────────────────────────────────────────────────────
// Enablement + policy (memoised platform / dependency checks)
// ─────────────────────────────────────────────────────────────────────────────

const isSupportedPlatformMemo = memoize(async (): Promise<boolean> => {
  const platform = getPlatform()
  if (platform === 'macos' || platform === 'linux') return true
  if (platform === 'wsl') return String(getWslVersion() ?? '') === '2'
  return false
})

let dependenciesOk = true

/** A synchronous platform-supported check (macOS/Linux always; WSL needs v2). */
function isSupportedPlatformSync(): boolean {
  const platform = getPlatform()
  if (platform === 'macos' || platform === 'linux') return true
  if (platform === 'wsl') return String(getWslVersion() ?? '') === '2'
  return false
}

let cachedDepCheck: SandboxDependencyCheck = { warnings: [], errors: [] }
let dependenciesChecked = false

/**
 * The dependency check, run once per process on the FIRST question that
 * needs it — never answered from the cold default. The runtime's check is
 * synchronous on the platforms that sandbox (a lookup of bubblewrap and
 * ripgrep on Linux; nothing to look up on macOS); answering "enabled" before
 * it ran let a boot with sandbox.enabled and no bubblewrap pass the
 * unavailable-sandbox warning and the failIfUnavailable refusal, then run
 * every command unconfined with nothing said.
 */
function ensureDependencyCheck(): void {
  if (dependenciesChecked) return
  dependenciesChecked = true
  try {
    const result = RuntimeSandboxManager.checkDependencies()
    cachedDepCheck = result
    dependenciesOk = result.errors.length === 0
  } catch {
    // leave the cached default
  }
}

/** Warm the dependency-check cache (called during initialisation). */
async function warmDependencyCheck(): Promise<void> {
  ensureDependencyCheck()
}

/** Whether the managed policy restricts sandbox domains to the policy layer. */
export function shouldAllowManagedSandboxDomainsOnly(): boolean {
  const settings = safeGetSettings('policySettings')
  return getSandboxNetwork(settings)?.allowManagedDomainsOnly === true
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings access (kept narrow — the settings layer is out of slice)
// ─────────────────────────────────────────────────────────────────────────────

type SettingsShape = {
  sandbox?: Record<string, unknown>
  permissions?: { allow?: string[]; deny?: string[]; additionalDirectories?: string[] }
}

function safeGetSettings(source: string): SettingsShape {
  try {
    // Lazy require avoids a static cycle with the settings layer.
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

// ─────────────────────────────────────────────────────────────────────────────
// Config construction
// ─────────────────────────────────────────────────────────────────────────────

/** The scrub list — recorded bare-repo paths to remove post-command. */
let scrubList: string[] = []
/** The worktree main-repo path, resolved once per session. */
let cachedWorktreeMainRepo: string | undefined
let worktreeResolved = false

/** Detect the main repository path of a git worktree (once, cached). */
function resolveWorktreeMainRepo(sessionDir: string): string | undefined {
  if (worktreeResolved) return cachedWorktreeMainRepo
  worktreeResolved = true
  try {
    const gitEntry = join(sessionDir, '.git')
    if (statSync(gitEntry).isDirectory()) {
      cachedWorktreeMainRepo = undefined // a directory means "not a worktree"
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

/**
 * The adapter-side bound on every path list handed to the vendored runtime
 * (sweep #2, S2 B4.4 — RULED keep + track): the runtime expands
 * globs and deny sets into per-file arguments, and an operator settings
 * list that balloons past the argv ceiling kills the sandboxed spawn
 * (E2BIG) instead of sandboxing it. Lists are de-duplicated and capped;
 * a truncation is logged once per list so the operator knows which
 * entries stopped applying — never silent.
 */
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

/** Build the deny-write set for settings, skills, and bare-repo entries. */
function buildDenyWrite(): string[] {
  const denyWrite = new Set<string>()
  const originalCwd = getOriginalCwd()
  const currentCwd = getCwd()
  const dirs = currentCwd === originalCwd ? [originalCwd] : [originalCwd, currentCwd]

  // Settings files of every known settings source + managed drop-in dir.
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
    // settings layer unavailable — skip
  }

  // When the session dir differs from the start dir, deny settings under each
  // config home in the current dir.
  if (currentCwd !== originalCwd) {
    for (const home of CONFIG_HOMES) {
      for (const file of SETTINGS_FILES) denyWrite.add(join(currentCwd, home, file))
    }
  }

  // Skills directory under each home, in both dirs.
  for (const dir of dirs) {
    for (const home of CONFIG_HOMES) denyWrite.add(join(dir, home, 'skills'))
  }

  // Bare-repository planting defence. Existence is judged by lstat — a
  // SYMLINK at a bare-repo name (a stow/nix-managed `config`, a dangling
  // link) EXISTS and belongs in denyWrite; stat followed the link, called
  // a dangling one absent, and the post-command scrub then deleted the
  // user's own symlink (the symlinked-settings deletion class, at the one
  // seam of ours that removes paths after a command).
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
      else scrubList.push(path) // record for post-command scrubbing
    }
  }

  return [...denyWrite]
}

/**
 * The platform's own per-user temp directory, resolved: on macOS the
 * DARWIN_USER_TEMP_DIR tree under /var/folders, which mktemp and the tools
 * built on it use ahead of TMPDIR. Absent elsewhere (a Linux TMPDIR is
 * honoured by the tools, and the /tmp fallback would be the whole of
 * /tmp). Read once per process.
 */
const platformUserTempDir = memoize((): string | null => {
  if (getPlatform() !== 'macos') return null
  try {
    const dir = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 2_000 }).trim()
    return dir === '' ? null : realpathSync(dir)
  } catch {
    return null
  }
})

/** Build the allow-write set (cwd, temp, worktree main repo, additional dirs). */
function buildAllowWrite(): string[] {
  const allowWrite = new Set<string>(['.']) // the cwd as the literal single-dot
  try {
    const { getMercuryTempDir, getProjectTempDir } = require('../permissions/filesystem.js') as {
      getMercuryTempDir(): string
      getProjectTempDir(): string
    }
    allowWrite.add(getProjectTempDir())
    // The product temp root (the resolved /tmp/mercury-<uid>/): the shell
    // provider writes its cwd-tracking record there and the executor hands
    // it to the sandboxed child as TMPDIR, so a write there must be allowed
    // or every sandboxed command ends on the record's refusal (status 1, no
    // cd ever recorded) and mktemp-class commands fail inside the sandbox.
    allowWrite.add(getMercuryTempDir())
  } catch {
    // filesystem helper unavailable
  }
  // The platform's per-user temp directory beside the product root: the
  // user's own scratch (mode 0700), never the project or the home, so a
  // bare mktemp under the sandbox lands somewhere it is allowed to.
  const platformTemp = platformUserTempDir()
  if (platformTemp) allowWrite.add(platformTemp)
  const sessionDir = getCwd()
  const mainRepo = resolveWorktreeMainRepo(sessionDir)
  if (mainRepo && mainRepo !== sessionDir) allowWrite.add(mainRepo)
  // Additional directories (CLI/session).
  const merged = getMergedSettings()
  for (const dir of merged.permissions?.additionalDirectories ?? []) allowWrite.add(dir)
  return [...allowWrite]
}

/** Convert merged settings into the runtime config (exported for tests). */
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

// ─────────────────────────────────────────────────────────────────────────────
// The manager façade
// ─────────────────────────────────────────────────────────────────────────────

/** The manager façade interface. */
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

/** The product sandbox manager singleton. */
export const SandboxManager: ISandboxManager = {
  async initialize(askCallback?: SandboxAskCallback): Promise<void> {
    if (!SandboxManager.isSandboxingEnabled()) return
    if (initPromise) return initPromise
    // Create the promise synchronously before any await.
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
      // Subscribe to settings changes to rebuild + push a fresh config.
      try {
        const settingsModule = require('../settings/changeDetector.js') as {
          onSettingsChanged?(fn: () => void): () => void
        }
        settingsSubscription = settingsModule.onSettingsChanged?.(() => SandboxManager.refreshConfig()) ?? null
      } catch {
        settingsSubscription = null
      }
    })().catch(error => {
      initPromise = null // clear so init can be retried
      logForDebugging(`sandbox initialisation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return initPromise
  },

  isSupportedPlatform: () => isSupportedPlatformMemo(),
  isPlatformInEnabledList(): boolean {
    try {
      // The merged settings: the list is an operator setting like the rest of
      // the sandbox section. It was read from a source name that does not
      // exist, which answered empty, so the list never applied anywhere.
      const list = getSandboxSection(getMergedSettings()).enabledPlatforms as string[] | undefined
      if (list === undefined) return true // absent ⇒ all allowed
      return list.includes(getPlatform())
    } catch {
      return true
    }
  },

  getSandboxUnavailableReason(): string | null {
    if (!SandboxManager.isSandboxEnabledInSettings()) return null // no noise when never enabled
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

  // Every vendored-manager member below is called through its DECLARED
  // surface (sandbox-manager.d.ts) — no cast may mediate the access, because a
  // cast-invented name is a latent runtime TypeError the compiler cannot see.
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
    // The vendored signature is (command, binShell?, customConfig?, abortSignal?)
    // — the signal rides fourth so a sandbox setup scan is cancellable when the
    // command is aborted.
    return RuntimeSandboxManager.wrapWithSandbox(command, innerShell, undefined, abortSignal)
  },

  cleanupAfterCommand(): void {
    RuntimeSandboxManager.cleanupAfterCommand()
    // Then the bare-repository scrub.
    for (const path of scrubList) {
      try {
        rmSync(path, { recursive: true, force: true })
        if (existsSync(path)) continue
        logForDebugging(`scrubbed planted bare-repo path ${path}`)
      } catch {
        // ignore "not found" (the common case)
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

/**
 * Add a command to the exclusion list, deriving the pattern from Bash-tool
 * permission suggestions when present. Returns the pattern used.
 */
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

// getMercuryHome is used for managed drop-in resolution parity.
void getMercuryHome
