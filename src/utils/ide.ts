// ============================================================================
// ide — the editor-discovery owner (idewave spec).
//
//  One module owning: advertisement-file discovery and staleness hygiene,
//  candidate validity, the single-flight auto-pick poll, the two-family
//  editor taxonomy and running-editor process scan, VS Code-family extension
//  installation under Mercury's OWN extension identity, the non-blocking
//  init orchestration, and the connected-bridge helpers.
//
// Identity mandates: the advertisement home is a subdirectory of
//  Mercury's own config home (compat homes are a bounded READ affordance);
//  the install arm targets Mercury's own extension identifier and FAILS
//  HONESTLY while no Mercury artifact is published — foreign software is
//  never installed; every env read gates on a registered MERCURY_IDE_* flag,
//  with the externally documented Claude-family spelling decoded one rung
//  below at this consumer (the spelling itself is never renamed).
//
// Failure posture: discovery and hygiene never throw into their
//  callers — they log and degrade to empty/null.
// ============================================================================

import { existsSync } from 'node:fs'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { Socket } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { memoize } from 'lodash-es'
import { subprocessEnv } from './subprocessEnv.js'

import { getIsScrollDraining, getOriginalCwd } from '../bootstrap/state.js'
import { MERCURY_VERSION } from '../constants/product.js'
import { callIdeRpc } from '../services/mcp/client.js'
import type { ConnectedMCPServer, MCPServerConnection } from '../services/mcp/types.js'
import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { env } from './env.js'
import { envDynamic } from './envDynamic.js'
import { configHomeExplicitlySet, getMercuryHome } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getAncestorCommandsAsync, getAncestorPidsAsync, isProcessRunning } from './genericProcessUtils.js'
import { checkWSLDistroMatch, WindowsToWSLConverter } from './idePathConversion.js'
import { isJetBrainsPluginInstalledCached } from './jetbrains.js'
import { logError } from './log.js'
import { PROJECT_CONFIG_DIR_NAMES } from './projectConfig.js'
import { whichSync } from './which.js'

// A survivor (useIdeAtMentioned via its own import today; kept here so the
// bridge consumers can reach the direct-RPC helper through this module path).
export { callIdeRpc } from '../services/mcp/client.js'

// ---------------------------------------------------------------------------
// Contract data
// ---------------------------------------------------------------------------

/** Reserved bridge connection name (contract data — connection owner, /ide). */
export const IDE_BRIDGE_SERVER_NAME = 'ide'

/** Advertisement-file suffix; the numeric stem carries the TCP port. Field
 *  format written by deployed editor extensions — keep reading it. */
const LOCKFILE_SUFFIX = '.lock'

/** Bridge subdirectory under a config home. Field layout: `<home>/ide/`. */
const IDE_BRIDGE_DIR = 'ide'

/**
 * Mercury's OWN marketplace-style extension identifier — the
 * publisher.name of integrations/vscode/package.json. The ONE owned install
 * identity; no foreign identifier is ever installed.
 */
export const MERCURY_IDE_EXTENSION_ID = 'mercury.mercury-vscode'

/**
 * No published Mercury extension artifact exists yet: the install arm must
 * return the honest named failure instead of invoking any installer
 * Flip when the Mercury artifact ships on a channel the CLI
 * force-install can reach.
 */
const MERCURY_EXTENSION_ARTIFACT_PUBLISHED = false

/**
 * Close-every-open-diff RPC op. No surviving file pins the spelling
 * — this is the deployed counterpart's publicly observed tool name, and
 * the caller swallows a counterpart that lacks the op either way.
 */
const CLOSE_ALL_DIFF_TABS_OP = 'closeAllDiffTabs'

const GENERIC_IDE_DISPLAY_NAME = 'IDE'

/** TCP reachability probe budget. */
const REACHABILITY_TIMEOUT_MS = 500

/** Auto-pick poll: hygiene first, then once per second for 30 seconds. */
const AUTO_PICK_BUDGET_MS = 30_000
const AUTO_PICK_INTERVAL_MS = 1_000

/** Rapid successive VS Code-family CLI invocations crash; wait before one. */
const CLI_INVOCATION_DELAY_MS = 500

/** Windows-side sweep constants (Linux compatibility layer only). */
const WINDOWS_USERS_MOUNT = '/mnt/c/Users'
const WINDOWS_SYSTEM_PROFILES = new Set(['all users', 'default', 'default user', 'public'])

// ---------------------------------------------------------------------------
// Registered flag reads — canonical MERCURY_IDE_* rows through the
// registry.
// ---------------------------------------------------------------------------

/** The channel port an embedding editor advertises into its terminal. */
function advertisedIdePort(): number | null {
  const raw = flagEnv('MERCURY_IDE_PORT')
  if (raw === undefined || raw.trim() === '') return null
  const port = Number.parseInt(raw, 10)
  return Number.isFinite(port) ? port : null
}

/** Accept any advertisement regardless of workspace match. */
function skipValidCheckEnabled(): boolean {
  return flagEnabled('MERCURY_IDE_SKIP_VALID_CHECK')
}

/** Never auto-install the extension. */
function skipAutoInstallEnabled(): boolean {
  return flagEnabled('MERCURY_IDE_SKIP_AUTO_INSTALL')
}

/** Connection-host override. */
function ideHostOverride(): string | null {
  const raw = flagEnv('MERCURY_IDE_HOST_OVERRIDE')
  if (raw === undefined || raw.trim() === '') return null
  return raw.trim()
}

/** Treat the terminal as editor-embedded even without identity. */
function forceIdeTerminalEnabled(): boolean {
  return flagEnabled('MERCURY_IDE_FORCE_TERMINAL')
}

// ---------------------------------------------------------------------------
// Editor taxonomy — two families; the kind vocabulary is an
// export seam (surviving importers: /ide command, command types, jetbrains
// probe, status surfaces).
// ---------------------------------------------------------------------------

export type IdeType =
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'codium'
  | 'antigravity'
  | 'pycharm'
  | 'intellij'
  | 'webstorm'
  | 'phpstorm'
  | 'rubymine'
  | 'clion'
  | 'goland'
  | 'rider'
  | 'datagrip'
  | 'appcode'
  | 'dataspell'
  | 'aqua'
  | 'gateway'
  | 'fleet'
  | 'jetbrains'
  | 'androidstudio'

type EditorFamily = 'vscode' | 'jetbrains'

/**
 * Per-kind identity, derived from public product facts. Process matching is
 * EXECUTABLE IDENTITY ONLY — never argv (an argv substring once impersonated
 * a discontinued IDE and triggered a wrong auto-install):
 *   darwinKeywords — matched against full executable paths (`ps -axo comm=`),
 *     where app-bundle names carry display names;
 *   linuxKeywords  — matched against truncated lowercase process names
 *     (`ps -eo comm=`); an EMPTY list deliberately excludes the kind on that
 *     platform because its name collides with unrelated processes;
 *   win32Executables — task-list image names.
 */
interface EditorSignature {
  family: EditorFamily
  displayName: string
  darwinKeywords: string[]
  linuxKeywords: string[]
  win32Executables: string[]
  /** VS Code family public CLI command name (JetBrains has none). */
  cliCommand?: string
  /** macOS app-bundle directory names for the parent-walk CLI discovery. */
  bundleNames?: string[]
}

const EDITOR_SIGNATURES: Record<IdeType, EditorSignature> = {
  vscode: {
    family: 'vscode',
    displayName: 'VS Code',
    darwinKeywords: ['visual studio code'],
    // 'code' collides with prefixes of other names: exact-match only (the
    // scanner special-cases equality for this keyword).
    linuxKeywords: ['code'],
    win32Executables: ['code.exe'],
    cliCommand: 'code',
    bundleNames: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'],
  },
  cursor: {
    family: 'vscode',
    displayName: 'Cursor',
    darwinKeywords: ['cursor.app'],
    linuxKeywords: ['cursor'],
    win32Executables: ['cursor.exe'],
    cliCommand: 'cursor',
    bundleNames: ['Cursor.app'],
  },
  windsurf: {
    family: 'vscode',
    displayName: 'Windsurf',
    darwinKeywords: ['windsurf.app'],
    linuxKeywords: ['windsurf'],
    win32Executables: ['windsurf.exe'],
    cliCommand: 'windsurf',
    bundleNames: ['Windsurf.app'],
  },
  codium: {
    family: 'vscode',
    displayName: 'VSCodium',
    darwinKeywords: ['vscodium.app'],
    linuxKeywords: ['codium'],
    win32Executables: ['vscodium.exe'],
    cliCommand: 'codium',
    bundleNames: ['VSCodium.app'],
  },
  antigravity: {
    // Terminal-identity only: no public executable/CLI table to scan or
    // install against, so every scan list stays empty.
    family: 'vscode',
    displayName: 'Antigravity',
    darwinKeywords: [],
    linuxKeywords: [],
    win32Executables: [],
  },
  pycharm: {
    family: 'jetbrains',
    displayName: 'PyCharm',
    darwinKeywords: ['pycharm'],
    linuxKeywords: ['pycharm'],
    win32Executables: ['pycharm64.exe', 'pycharm.exe'],
  },
  intellij: {
    family: 'jetbrains',
    displayName: 'IntelliJ IDEA',
    darwinKeywords: ['intellij idea'],
    linuxKeywords: ['idea'],
    win32Executables: ['idea64.exe', 'idea.exe'],
  },
  webstorm: {
    family: 'jetbrains',
    displayName: 'WebStorm',
    darwinKeywords: ['webstorm'],
    linuxKeywords: ['webstorm'],
    win32Executables: ['webstorm64.exe'],
  },
  phpstorm: {
    family: 'jetbrains',
    displayName: 'PhpStorm',
    darwinKeywords: ['phpstorm'],
    linuxKeywords: ['phpstorm'],
    win32Executables: ['phpstorm64.exe'],
  },
  rubymine: {
    family: 'jetbrains',
    displayName: 'RubyMine',
    darwinKeywords: ['rubymine'],
    linuxKeywords: ['rubymine'],
    win32Executables: ['rubymine64.exe'],
  },
  clion: {
    family: 'jetbrains',
    displayName: 'CLion',
    darwinKeywords: ['clion'],
    linuxKeywords: ['clion'],
    win32Executables: ['clion64.exe'],
  },
  goland: {
    family: 'jetbrains',
    displayName: 'GoLand',
    darwinKeywords: ['goland'],
    linuxKeywords: ['goland'],
    win32Executables: ['goland64.exe'],
  },
  rider: {
    family: 'jetbrains',
    displayName: 'Rider',
    darwinKeywords: ['rider'],
    linuxKeywords: ['rider'],
    win32Executables: ['rider64.exe'],
  },
  datagrip: {
    family: 'jetbrains',
    displayName: 'DataGrip',
    darwinKeywords: ['datagrip'],
    linuxKeywords: ['datagrip'],
    win32Executables: ['datagrip64.exe'],
  },
  appcode: {
    // macOS-only product line.
    family: 'jetbrains',
    displayName: 'AppCode',
    darwinKeywords: ['appcode'],
    linuxKeywords: [],
    win32Executables: [],
  },
  dataspell: {
    family: 'jetbrains',
    displayName: 'DataSpell',
    darwinKeywords: ['dataspell'],
    linuxKeywords: ['dataspell'],
    win32Executables: ['dataspell64.exe'],
  },
  aqua: {
    // 'aqua' collides with unrelated Linux process names.
    family: 'jetbrains',
    displayName: 'Aqua',
    darwinKeywords: ['aqua.app'],
    linuxKeywords: [],
    win32Executables: ['aqua64.exe'],
  },
  gateway: {
    // 'gateway' is too generic outside the bundle-named macOS path.
    family: 'jetbrains',
    displayName: 'JetBrains Gateway',
    darwinKeywords: ['jetbrains gateway'],
    linuxKeywords: [],
    win32Executables: [],
  },
  fleet: {
    // 'fleet' collides with device-management agents on Linux.
    family: 'jetbrains',
    displayName: 'Fleet',
    darwinKeywords: ['fleet.app'],
    linuxKeywords: [],
    win32Executables: ['fleet.exe'],
  },
  jetbrains: {
    // Generic family marker (the JediTerm fallback vocabulary); never a scan
    // target of its own.
    family: 'jetbrains',
    displayName: 'JetBrains IDE',
    darwinKeywords: [],
    linuxKeywords: [],
    win32Executables: [],
  },
  androidstudio: {
    // 'studio' is too generic on Linux.
    family: 'jetbrains',
    displayName: 'Android Studio',
    darwinKeywords: ['android studio'],
    linuxKeywords: [],
    win32Executables: ['studio64.exe'],
  },
}

/** Scan order: code-forks BEFORE vscode so per-line first-match keeps a
 *  fork's helper processes from counting as VS Code. */
const RUNNING_SCAN_ORDER: IdeType[] = [
  'cursor',
  'windsurf',
  'codium',
  'vscode',
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rubymine',
  'clion',
  'goland',
  'rider',
  'datagrip',
  'appcode',
  'dataspell',
  'aqua',
  'gateway',
  'fleet',
  'androidstudio',
]

function normalizeToIdeType(value: string | null | undefined): IdeType | null {
  if (!value) return null
  const lowered = value.toLowerCase()
  return Object.prototype.hasOwnProperty.call(EDITOR_SIGNATURES, lowered) ? (lowered as IdeType) : null
}

/** Family markers for wire display names (config ideName strings) that are
 *  not bare kind tokens. Conservative: generic words (aqua/gateway/fleet)
 *  only match as exact kinds, never as substrings. */
const JETBRAINS_NAME_MARKERS = [
  'jetbrains',
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rubymine',
  'clion',
  'goland',
  'rider',
  'datagrip',
  'appcode',
  'dataspell',
  'android studio',
]

const VSCODE_NAME_MARKERS = ['visual studio code', 'vs code', 'vscode', 'vscodium', 'cursor', 'windsurf', 'antigravity']

/** Accepts a kind, a terminal identity, or a wire display name. */
export function isJetBrainsIde(value: string | null | undefined): boolean {
  if (!value) return false
  const kind = normalizeToIdeType(value)
  if (kind !== null) return EDITOR_SIGNATURES[kind].family === 'jetbrains'
  const lowered = value.toLowerCase()
  return JETBRAINS_NAME_MARKERS.some(marker => lowered.includes(marker))
}

/** Accepts a kind, a terminal identity, or a wire display name. */
export function isVSCodeFamilyIde(value: string | null | undefined): boolean {
  if (!value) return false
  const kind = normalizeToIdeType(value)
  if (kind !== null) return EDITOR_SIGNATURES[kind].family === 'vscode'
  const lowered = value.toLowerCase()
  return VSCODE_NAME_MARKERS.some(marker => lowered.includes(marker))
}

// ---------------------------------------------------------------------------
// Display names — kind ⇒ product name; terminal-command mapping
// for common editors; capitalized-basename fallback; generic label when
// identity is unknown. Consumed by plan/permission surfaces and the /ide UI.
// ---------------------------------------------------------------------------

const EDITOR_COMMAND_NAMES: Record<string, string> = {
  code: 'VS Code',
  'code-insiders': 'VS Code Insiders',
  codium: 'VSCodium',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  vim: 'Vim',
  nvim: 'Neovim',
  vi: 'Vi',
  emacs: 'Emacs',
  nano: 'Nano',
  pico: 'Pico',
  micro: 'Micro',
  subl: 'Sublime Text',
  sublime_text: 'Sublime Text',
  zed: 'Zed',
  hx: 'Helix',
  kak: 'Kakoune',
  mate: 'TextMate',
  kate: 'Kate',
  gedit: 'gedit',
  notepad: 'Notepad',
  'notepad++': 'Notepad++',
}

function displayNameForToken(token: string): string | null {
  const kind = normalizeToIdeType(token)
  if (kind !== null) return EDITOR_SIGNATURES[kind].displayName
  const base = basename(token).toLowerCase().replace(/\.(exe|cmd|bat|app)$/, '')
  return EDITOR_COMMAND_NAMES[base] ?? null
}

/**
 * Kind, terminal identity, or editor command string (may carry arguments —
 * every whitespace token is tried, since compound commands place the editor
 * either first or last) to a friendly display name.
 */
export function toIDEDisplayName(ide: string | null | undefined): string {
  if (!ide || ide.trim() === '') return GENERIC_IDE_DISPLAY_NAME
  const trimmed = ide.trim()
  const whole = displayNameForToken(trimmed)
  if (whole !== null) return whole
  for (const token of trimmed.split(/\s+/)) {
    const known = displayNameForToken(token)
    if (known !== null) return known
  }
  const firstToken = trimmed.split(/\s+/)[0] ?? trimmed
  const base = basename(firstToken).toLowerCase().replace(/\.(exe|cmd|bat|app)$/, '')
  if (base === '') return GENERIC_IDE_DISPLAY_NAME
  return base.charAt(0).toUpperCase() + base.slice(1)
}

// ---------------------------------------------------------------------------
// Embedded-terminal identity — static env for the VS Code-family
// read, dynamic env for the JetBrains read; the force flag also counts. The
// three predicates are memoized (terminal identity is static per process).
// ---------------------------------------------------------------------------

const vsCodeFamilyTerminal = memoize((): boolean => {
  const kind = normalizeToIdeType(env.terminal)
  return kind !== null && EDITOR_SIGNATURES[kind].family === 'vscode'
})

const jetBrainsFamilyTerminal = memoize((): boolean => {
  const kind = normalizeToIdeType(envDynamic.getTerminalWithJetBrainsDetection())
  return kind !== null && EDITOR_SIGNATURES[kind].family === 'jetbrains'
})

const embeddedTerminal = memoize(
  (): boolean => forceIdeTerminalEnabled() || vsCodeFamilyTerminal() || jetBrainsFamilyTerminal(),
)

export function isSupportedVSCodeTerminal(): boolean {
  return vsCodeFamilyTerminal()
}

export function isSupportedJetBrainsTerminal(): boolean {
  return jetBrainsFamilyTerminal()
}

export function isSupportedTerminal(): boolean {
  return embeddedTerminal()
}

/** The embedded terminal's editor kind, when its identity maps into the
 *  taxonomy. The JetBrains arm reads the refined dynamic accessor. */
export function getTerminalIdeType(): IdeType | null {
  const staticKind = normalizeToIdeType(env.terminal)
  if (staticKind !== null && EDITOR_SIGNATURES[staticKind].family === 'vscode') return staticKind
  return normalizeToIdeType(envDynamic.getTerminalWithJetBrainsDetection())
}

function embeddedTerminalDisplayName(): string | null {
  const terminal = envDynamic.getTerminalWithJetBrainsDetection()
  if (terminal === null || !isSupportedTerminal()) return null
  return toIDEDisplayName(terminal)
}

// ---------------------------------------------------------------------------
// Records (export seams — spellings pinned by surviving importers)
// ---------------------------------------------------------------------------

export interface DetectedIDEInfo {
  name: string
  port: number
  workspaceFolders: string[]
  url: string
  isValid: boolean
  authToken?: string
  ideRunningInWindows?: boolean
}

export interface IDEExtensionInstallationStatus {
  installed: boolean
  error: string | null
  installedVersion: string | null
  ideType: IdeType | null
}

/** Parsed advertisement payload. Key spellings are field facts —
 *  the deployed extensions' JSON contract, read tolerantly. */
interface IdeAdvertisement {
  pid?: number
  workspaceFolders: string[]
  ideName?: string
  transport?: string
  runningInWindows?: boolean
  authToken?: string
}

// ---------------------------------------------------------------------------
// Bridge homes and advertisement enumeration
// ---------------------------------------------------------------------------

/** One-shot memoized Windows user-profile resolution (compatibility layer):
 *  env var when present, else a cold PowerShell query costing up to seconds
 *  — static per session. Failure logs and yields null (fewer candidates). */
let windowsProfilePromise: Promise<string | null> | null = null

function windowsUserProfileLocalPath(): Promise<string | null> {
  windowsProfilePromise ??= (async () => {
    let windowsPath = process.env.USERPROFILE?.trim() || null
    if (!windowsPath) {
      const outcome = await execFileNoThrow(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '$env:USERPROFILE'],
        { timeout: 15_000 },
      )
      if (outcome.code === 0 && outcome.stdout.trim() !== '') {
        windowsPath = outcome.stdout.trim()
      } else {
        logForDebugging(
          `ide: windows user-profile query failed (exit ${outcome.code}): ${outcome.stderr.trim() || outcome.error || 'no output'}`,
        )
        return null
      }
    }
    return new WindowsToWSLConverter(process.env.WSL_DISTRO_NAME).toLocalPath(windowsPath)
  })()
  return windowsProfilePromise
}

/** Windows-side candidate bridge homes: the resolved profile's homes plus
 *  every real user under the mounted users directory. Home NAMES follow the
 * owned directory-name constants, Mercury-first. */
async function windowsSideBridgeHomes(): Promise<string[]> {
  const homes: string[] = []
  const profile = await windowsUserProfileLocalPath()
  if (profile) {
    for (const dirName of PROJECT_CONFIG_DIR_NAMES) homes.push(join(profile, dirName, IDE_BRIDGE_DIR))
  }
  try {
    const entries = await readdir(WINDOWS_USERS_MOUNT, { withFileTypes: true })
    for (const entry of entries) {
      // Windows profile junctions surface as symlinks and must survive.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (WINDOWS_SYSTEM_PROFILES.has(entry.name.toLowerCase())) continue
      for (const dirName of PROJECT_CONFIG_DIR_NAMES) {
        homes.push(join(WINDOWS_USERS_MOUNT, entry.name, dirName, IDE_BRIDGE_DIR))
      }
    }
  } catch (error) {
    // Inaccessibility is expected (unmounted drive, no list permission).
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR' || code === 'EPERM') {
      logForDebugging(`ide: windows users directory inaccessible: ${String(error)}`)
    } else {
      logError(error)
    }
  }
  return homes
}

/**
 * Candidate homes, primary first, WITHOUT existence pre-checks (the consumer
 * readdirs each; pre-stat doubles syscalls and is slow on mounted drives).
 * Compat homes are a bounded READ affordance — and an explicitly pinned
 * config home is an isolation boundary the fallback never escapes.
 */
async function candidateBridgeHomes(): Promise<string[]> {
  const homes: string[] = [join(getMercuryHome(), IDE_BRIDGE_DIR)]
  if (!configHomeExplicitlySet()) {
    for (const dirName of PROJECT_CONFIG_DIR_NAMES) homes.push(join(homedir(), dirName, IDE_BRIDGE_DIR))
  }
  if (env.isWslEnvironment()) homes.push(...(await windowsSideBridgeHomes()))
  return [...new Set(homes)]
}

interface LockfileRef {
  path: string
  port: number
  mtimeMs: number
}

/**
 * Every advertisement file across all candidate homes, newest first, deduped
 * by port (newest wins). A missing/inaccessible home contributes nothing
 * silently; unexpected errors log and yield an empty overall result.
 */
async function enumerateIdeLockfiles(): Promise<LockfileRef[]> {
  try {
    const homes = await candidateBridgeHomes()
    const perHome = await Promise.all(
      homes.map(async home => {
        let names: string[]
        try {
          names = await readdir(home)
        } catch {
          return [] as LockfileRef[]
        }
        const refs: LockfileRef[] = []
        for (const name of names) {
          if (!name.endsWith(LOCKFILE_SUFFIX)) continue
          const port = Number.parseInt(name.slice(0, -LOCKFILE_SUFFIX.length), 10)
          if (!Number.isFinite(port) || port <= 0) continue
          const path = join(home, name)
          try {
            const stats = await stat(path)
            refs.push({ path, port, mtimeMs: stats.mtimeMs })
          } catch {
            // Raced deletion or unreadable entry: skip this file.
          }
        }
        return refs
      }),
    )
    const merged = perHome.flat().sort((a, b) => b.mtimeMs - a.mtimeMs)
    const seenPorts = new Set<number>()
    const deduped: LockfileRef[] = []
    for (const ref of merged) {
      if (seenPorts.has(ref.port)) continue
      seenPorts.add(ref.port)
      deduped.push(ref)
    }
    return deduped
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * Advertisement payload read: JSON form first; a parse failure
 * falls back to the legacy bare newline-separated workspace-root list.
 * Unreadable ⇒ null (logged); hygiene deletes it.
 */
async function readAdvertisement(path: string): Promise<IdeAdvertisement | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    logForDebugging(`ide: unreadable advertisement ${path}: ${String(error)}`)
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const windowsMarker = record.runningInWindows ?? record.ideRunningInWindows
      return {
        ...(typeof record.pid === 'number' ? { pid: record.pid } : {}),
        workspaceFolders: Array.isArray(record.workspaceFolders)
          ? record.workspaceFolders.filter((folder): folder is string => typeof folder === 'string')
          : [],
        ...(typeof record.ideName === 'string' ? { ideName: record.ideName } : {}),
        ...(typeof record.transport === 'string' ? { transport: record.transport } : {}),
        ...(typeof windowsMarker === 'boolean' ? { runningInWindows: windowsMarker } : {}),
        ...(typeof record.authToken === 'string' ? { authToken: record.authToken } : {}),
      }
    }
  } catch {
    // Legacy payload form below.
  }
  return {
    workspaceFolders: raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0),
  }
}

// ---------------------------------------------------------------------------
// Reachability probe and host resolution
// ---------------------------------------------------------------------------

/** Plain TCP connect: true on connect (socket destroyed), false on error or
 *  timeout; never rejects. */
function probeTcpReachable(host: string, port: number, timeoutMs: number = REACHABILITY_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new Socket()
    let settled = false
    const settle = (reachable: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
    try {
      socket.connect(port, host)
    } catch {
      settle(false)
    }
  })
}

const LOOPBACK_HOST = '127.0.0.1'
const hostResolutionCache = new Map<string, Promise<string>>()

async function resolveIdeHostUncached(isWindowsHosted: boolean, port: number): Promise<string> {
  if (!env.isWslEnvironment() || !isWindowsHosted) return LOOPBACK_HOST
  try {
    // The Windows host is the compatibility layer's default-route gateway.
    const route = await execFileNoThrow('ip', ['route', 'show', 'default'], { timeout: 5_000 })
    if (route.code === 0) {
      const match = /default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(route.stdout)
      const gateway = match?.[1]
      if (gateway && (await probeTcpReachable(gateway, port))) return gateway
    }
  } catch {
    // Loopback fallback below.
  }
  return LOOPBACK_HOST
}

/** Memoized per (hosted-on-Windows marker, port); the override flag is read
 *  live and outranks the cache. All errors fall back to loopback silently. */
function resolveIdeHost(isWindowsHosted: boolean, port: number): Promise<string> {
  const override = ideHostOverride()
  if (override !== null) return Promise.resolve(override)
  const key = `${isWindowsHosted ? 'windows' : 'local'}:${port}`
  let pending = hostResolutionCache.get(key)
  if (!pending) {
    pending = resolveIdeHostUncached(isWindowsHosted, port)
    hostResolutionCache.set(key, pending)
  }
  return pending
}

// ---------------------------------------------------------------------------
// Staleness hygiene — runs before an auto-pick search.
// ---------------------------------------------------------------------------

async function deleteLockfile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    logForDebugging(`ide: could not delete stale advertisement ${path}: ${String(error)}`)
  }
}

/**
 * Unreadable ⇒ delete. Advertised pid gone ⇒ delete — except under the
 * compatibility layer, where pids are unreliable: there delete only when the
 * TCP probe of the resolved host+port also fails. No pid ⇒ delete when the
 * probe fails. Failure-isolated: deletion failures log, the whole pass logs
 * and returns on any unexpected error.
 */
async function cleanStaleIdeLockfiles(): Promise<void> {
  try {
    const wsl = env.isWslEnvironment()
    for (const ref of await enumerateIdeLockfiles()) {
      const payload = await readAdvertisement(ref.path)
      if (payload === null) {
        await deleteLockfile(ref.path)
        continue
      }
      const isWindowsHosted = payload.runningInWindows === true
      if (typeof payload.pid === 'number') {
        if (isProcessRunning(payload.pid)) continue
        if (wsl) {
          const host = await resolveIdeHost(isWindowsHosted, ref.port)
          if (await probeTcpReachable(host, ref.port)) continue
        }
        await deleteLockfile(ref.path)
        continue
      }
      const host = await resolveIdeHost(isWindowsHosted, ref.port)
      if (!(await probeTcpReachable(host, ref.port))) await deleteLockfile(ref.path)
    }
  } catch (error) {
    logError(error)
  }
}

// ---------------------------------------------------------------------------
// Candidate validity
// ---------------------------------------------------------------------------

/** NFC-normalize (macOS yields decomposed Unicode, editors report composed)
 *  and uppercase a leading drive letter so Windows-cased paths compare. */
function normalizeForContainment(path: string): string {
  const normalized = path.normalize('NFC')
  if (/^[a-z]:([\\/]|$)/i.test(normalized)) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1)
  }
  return normalized
}

function pathContains(root: string, target: string): boolean {
  let rootN = normalizeForContainment(root)
  const targetN = normalizeForContainment(target)
  while (rootN.length > 1 && (rootN.endsWith('/') || rootN.endsWith('\\'))) rootN = rootN.slice(0, -1)
  if (rootN === targetN) return true
  return targetN.startsWith(`${rootN}/`) || targetN.startsWith(`${rootN}\\`)
}

/**
 * The session's ORIGINAL working directory sits at-or-under an advertised
 * root. Under the compatibility layer with a Windows-hosted editor and a
 * distribution name in env: roots naming a DIFFERENT distribution are
 * rejected, the raw root is tried, then the root converted to a local path.
 */
function workspaceContainsOriginalCwd(workspaceFolders: string[], isWindowsHosted: boolean): boolean {
  const cwd = getOriginalCwd()
  const distro = process.env.WSL_DISTRO_NAME
  const convert = env.isWslEnvironment() && isWindowsHosted && Boolean(distro)
  const converter = convert ? new WindowsToWSLConverter(distro) : null
  for (const folder of workspaceFolders) {
    if (converter && distro && !checkWSLDistroMatch(folder, distro)) continue
    if (pathContains(folder, cwd)) return true
    if (converter && pathContains(converter.toLocalPath(folder), cwd)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Detection and the ancestry gate
// ---------------------------------------------------------------------------

/**
 * One detection pass. Advertisement files are read IN PARALLEL (serial IO
 * measurably hurt the poll). Ordering law: the workspace check runs FIRST so
 * non-matching candidates never pay the process-tree walk; the ancestor set
 * is fetched lazily at most once per pass.
 */
export async function detectIDEs(includeInvalid: boolean = false): Promise<DetectedIDEInfo[]> {
  try {
    const lockfiles = await enumerateIdeLockfiles()
    if (lockfiles.length === 0) return []

    const skipCheck = skipValidCheckEnabled()
    const advertisedPort = advertisedIdePort()
    const wsl = env.isWslEnvironment()
    const embedded = isSupportedTerminal()
    const terminalName = embeddedTerminalDisplayName()
    let ancestorsPromise: Promise<Set<number>> | null = null
    const ancestorSet = (): Promise<Set<number>> => {
      ancestorsPromise ??= getAncestorPidsAsync(process.pid, 10).then(pids => new Set(pids))
      return ancestorsPromise
    }

    const evaluated = await Promise.all(
      lockfiles.map(async (ref): Promise<DetectedIDEInfo | null> => {
        try {
          const payload = await readAdvertisement(ref.path)
          if (payload === null) return null
          const isWindowsHosted = payload.runningInWindows === true

          const portMatches = advertisedPort !== null && advertisedPort === ref.port
          const validBySkip = skipCheck
          const isValid =
            validBySkip || portMatches || workspaceContainsOriginalCwd(payload.workspaceFolders, isWindowsHosted)

          // Ancestry gate: embedded, not under the compatibility layer, and
          // the port does not match the advertised one — the candidate must
          // belong to THIS session's process ancestry. The skip flag is an
          // explicit operator override and bypasses the gate. Dead or
          // missing pid ⇒ candidate skipped entirely.
          if (isValid && !validBySkip && embedded && !wsl && !portMatches) {
            const pid = payload.pid
            if (typeof pid !== 'number' || !isProcessRunning(pid)) return null
            if (pid !== process.ppid && !(await ancestorSet()).has(pid)) return null
          }

          const host = await resolveIdeHost(isWindowsHosted, ref.port)
          const url =
            payload.transport === 'ws' ? `ws://${host}:${ref.port}` : `http://${host}:${ref.port}/sse`
          return {
            name: payload.ideName ?? terminalName ?? GENERIC_IDE_DISPLAY_NAME,
            port: ref.port,
            workspaceFolders: payload.workspaceFolders,
            url,
            isValid,
            ...(payload.authToken !== undefined ? { authToken: payload.authToken } : {}),
            ...(isWindowsHosted ? { ideRunningInWindows: true } : {}),
          }
        } catch (error) {
          logForDebugging(`ide: candidate ${ref.path} skipped: ${String(error)}`)
          return null
        }
      }),
    )

    const detected = evaluated.filter((info): info is DetectedIDEInfo => info !== null)
    const valid = detected.filter(info => info.isValid)

    // Embedded-terminal disambiguator: with the advertised port set and
    // exactly one valid candidate on it, that one IS the answer.
    if (advertisedPort !== null) {
      const matching = valid.filter(info => info.port === advertisedPort)
      const sole = matching[0]
      if (matching.length === 1 && sole !== undefined) return [sole]
    }

    return includeInvalid ? detected : valid
  } catch (error) {
    logError(error)
    return []
  }
}

// ---------------------------------------------------------------------------
// Auto-pick — find exactly one, single-flight.
// ---------------------------------------------------------------------------

let activePickController: AbortController | null = null

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

/**
 * Hygiene first; then poll detection once per second for up to 30 seconds; a
 * poll is skipped while the UI reports scroll-draining (detection does file
 * IO and process spawns that would fight the render loop). Starting a new
 * search aborts the previous one. Returns a candidate ONLY when detection
 * yields exactly one valid candidate; abort or timeout ⇒ null.
 */
export async function findAvailableIDE(): Promise<DetectedIDEInfo | null> {
  activePickController?.abort()
  const controller = new AbortController()
  activePickController = controller
  try {
    await cleanStaleIdeLockfiles()
    const deadline = Date.now() + AUTO_PICK_BUDGET_MS
    while (!controller.signal.aborted && Date.now() < deadline) {
      if (!getIsScrollDraining()) {
        const valid = await detectIDEs(false)
        if (controller.signal.aborted) return null
        const sole = valid[0]
        if (valid.length === 1 && sole !== undefined) return sole
      }
      await abortableDelay(AUTO_PICK_INTERVAL_MS, controller.signal)
    }
    return null
  } catch (error) {
    logError(error)
    return null
  } finally {
    if (activePickController === controller) activePickController = null
  }
}

// ---------------------------------------------------------------------------
// Running-editor detection — EXECUTABLE IDENTITY ONLY, cached.
// ---------------------------------------------------------------------------

let runningIDECache: IdeType[] | null = null

function matchDarwinLine(line: string): IdeType | null {
  for (const kind of RUNNING_SCAN_ORDER) {
    if (EDITOR_SIGNATURES[kind].darwinKeywords.some(keyword => line.includes(keyword))) return kind
  }
  return null
}

function matchLinuxLine(line: string): IdeType | null {
  for (const kind of RUNNING_SCAN_ORDER) {
    for (const keyword of EDITOR_SIGNATURES[kind].linuxKeywords) {
      // 'code' is exact-match only; everything else may carry a truncated
      // launcher suffix (`pycharm.sh` under the 15-character comm limit).
      if (keyword === 'code' ? line === keyword : line === keyword || line.startsWith(keyword)) return kind
    }
  }
  return null
}

function matchWin32Image(imageName: string): IdeType | null {
  for (const kind of RUNNING_SCAN_ORDER) {
    if (EDITOR_SIGNATURES[kind].win32Executables.includes(imageName)) return kind
  }
  return null
}

/** The PURE per-line comm matcher — the provable seam under the process scan
 *  (the argv-grep false-positive incident law rides it: `ps` comm output only,
 *  matched line by line, scan-order stable). Exported for the detection proof. */
export function matchRunningIdeComms(lines: readonly string[], platform: 'darwin' | 'linux'): IdeType[] {
  const matcher = platform === 'darwin' ? matchDarwinLine : matchLinuxLine
  const found = new Set<IdeType>()
  for (const rawLine of lines) {
    const line = rawLine.trim().toLowerCase()
    if (line === '') continue
    const kind = matcher(line)
    if (kind !== null) found.add(kind)
  }
  return RUNNING_SCAN_ORDER.filter(kind => found.has(kind))
}

async function scanRunningEditorProcesses(): Promise<IdeType[]> {
  if (process.platform === 'win32') {
    const found = new Set<IdeType>()
    const outcome = await execFileNoThrow('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 30_000 })
    if (outcome.code !== 0) throw new Error(`tasklist exited ${outcome.code}: ${outcome.stderr.trim()}`)
    for (const line of outcome.stdout.split('\n')) {
      const image = /^"([^"]*)"/.exec(line.trim())?.[1]?.toLowerCase()
      if (!image) continue
      const kind = matchWin32Image(image)
      if (kind !== null) found.add(kind)
    }
    return RUNNING_SCAN_ORDER.filter(kind => found.has(kind))
  }
  const psArgs = process.platform === 'darwin' ? ['-axo', 'comm='] : ['-eo', 'comm=']
  const outcome = await execFileNoThrow('ps', psArgs, { timeout: 30_000 })
  if (outcome.code !== 0) throw new Error(`ps exited ${outcome.code}: ${outcome.stderr.trim()}`)
  return matchRunningIdeComms(outcome.stdout.split('\n'), process.platform === 'darwin' ? 'darwin' : 'linux')
}

/** Scan for running editors (feeds the /ide install offer). Failure logs and
 *  returns empty; the result is cached module-level. */
export async function detectRunningIDEs(): Promise<IdeType[]> {
  try {
    const found = await scanRunningEditorProcesses()
    runningIDECache = found
    return found
  } catch (error) {
    logError(error)
    runningIDECache = []
    return []
  }
}

/** Cached read for cheap consumers; null until a scan has run. */
export function getCachedRunningIDEs(): IdeType[] | null {
  return runningIDECache
}

export function resetRunningIDECache(): void {
  runningIDECache = null
}

// ---------------------------------------------------------------------------
// Extension installation — VS Code family only; JetBrains is
// detect-only through the surviving plugin probe.
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Linux CLI invocations clear DISPLAY — a fork's broken CLI otherwise
 *  launches the GUI instead of acting headlessly. */
function vsCodeCliEnvSpread(): { env?: NodeJS.ProcessEnv } {
  if (process.platform !== 'linux') return {}
  const cliEnv: NodeJS.ProcessEnv = { ...subprocessEnv() }
  delete cliEnv.DISPLAY
  return { env: cliEnv }
}

/**
 * CLI discovery: on macOS walk the process ancestry (bounded 10 hops) for a
 * known app-bundle path and derive that bundle's CLI (public bundle layout),
 * verifying existence; else the public CLI command name — on Windows the
 * `.cmd` wrapper explicitly (a documented upstream defect resolves the bare
 * name to the GUI binary).
 */
async function findVSCodeFamilyCli(kind: IdeType): Promise<string | null> {
  const signature = EDITOR_SIGNATURES[kind]
  const cliName = signature.cliCommand
  if (cliName === undefined) return null
  if (process.platform === 'darwin') {
    try {
      const commands = await getAncestorCommandsAsync(process.pid, 10)
      for (const command of commands) {
        for (const bundle of signature.bundleNames ?? []) {
          const index = command.indexOf(bundle)
          if (index < 0) continue
          const cliPath = join(command.slice(0, index + bundle.length), 'Contents', 'Resources', 'app', 'bin', cliName)
          if (existsSync(cliPath)) return cliPath
        }
      }
    } catch (error) {
      logForDebugging(`ide: macOS CLI parent-walk failed: ${String(error)}`)
    }
  }
  const commandName = process.platform === 'win32' ? `${cliName}.cmd` : cliName
  return whichSync(commandName) !== null ? commandName : null
}

/** Installed check: list-with-versions and search Mercury's own identifier. */
async function readInstalledExtensionState(cli: string): Promise<{ installed: boolean; version: string | null }> {
  const outcome = await execFileNoThrow(cli, ['--list-extensions', '--show-versions'], {
    timeout: 30_000,
    ...vsCodeCliEnvSpread(),
  })
  if (outcome.code !== 0) {
    logForDebugging(`ide: --list-extensions exited ${outcome.code}: ${outcome.stderr.trim()}`)
    return { installed: false, version: null }
  }
  for (const rawLine of outcome.stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const at = line.lastIndexOf('@')
    const id = at > 0 ? line.slice(0, at) : line
    if (id.toLowerCase() === MERCURY_IDE_EXTENSION_ID) {
      return { installed: true, version: at > 0 ? line.slice(at + 1) : null }
    }
  }
  return { installed: false, version: null }
}

/** Numeric-triple compare; non-numeric segments count as zero. */
function semverOlder(candidate: string, reference: string): boolean {
  const parse = (value: string): number[] =>
    value
      .split('.')
      .slice(0, 3)
      .map(part => {
        const numeric = Number.parseInt(part, 10)
        return Number.isFinite(numeric) ? numeric : 0
      })
  const a = parse(candidate)
  const b = parse(reference)
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left < right
  }
  return false
}

function noPublishedArtifactError(displayName: string): string {
  return (
    `No published Mercury extension artifact yet — the ${displayName} extension ` +
    `(${MERCURY_IDE_EXTENSION_ID}) cannot be auto-installed until Mercury ships one. ` +
    'In-editor features stay off until then.'
  )
}

/**
 * The VS Code-family install flow: discover the CLI, read installed state,
 * install/update when missing or older than the harness build version.
 * While no Mercury artifact is published this arm returns the honest named
 * failure and invokes no installer.
 */
async function runVSCodeFamilyInstall(
  kind: IdeType,
): Promise<{ status: IDEExtensionInstallationStatus; freshInstall: boolean }> {
  const displayName = toIDEDisplayName(kind)
  const cli = await findVSCodeFamilyCli(kind)
  if (cli === null) {
    return {
      status: {
        installed: false,
        error:
          `${displayName} CLI not found — install its shell command` +
          (EDITOR_SIGNATURES[kind].cliCommand ? ` ("${EDITOR_SIGNATURES[kind].cliCommand}")` : '') +
          ' from the editor, then run /ide again.',
        installedVersion: null,
        ideType: kind,
      },
      freshInstall: false,
    }
  }

  const before = await readInstalledExtensionState(cli)
  if (before.installed && (before.version === null || !semverOlder(before.version, MERCURY_VERSION))) {
    return {
      status: { installed: true, error: null, installedVersion: before.version, ideType: kind },
      freshInstall: false,
    }
  }

  if (!MERCURY_EXTENSION_ARTIFACT_PUBLISHED) {
    return {
      status: {
        installed: before.installed,
        error: noPublishedArtifactError(displayName),
        installedVersion: before.version,
        ideType: kind,
      },
      freshInstall: false,
    }
  }

  // Rapid successive CLI invocations crash the editor CLI: wait first.
  await delay(CLI_INVOCATION_DELAY_MS)
  const outcome = await execFileNoThrow(cli, ['--force', '--install-extension', MERCURY_IDE_EXTENSION_ID], {
    timeout: 120_000,
    ...vsCodeCliEnvSpread(),
  })
  if (outcome.code !== 0) {
    return {
      status: {
        installed: false,
        error: `${displayName} extension install failed (exit ${outcome.code}): ${outcome.stderr.trim().slice(0, 400)}`,
        installedVersion: null,
        ideType: kind,
      },
      freshInstall: false,
    }
  }

  // Post-install: arm in-editor diffs when the diff tool was never chosen.
  if (getGlobalConfig().diffTool === undefined) {
    saveGlobalConfig(current => ({ ...current, diffTool: 'auto' }))
  }
  const after = await readInstalledExtensionState(cli)
  return {
    status: {
      installed: true,
      error: null,
      installedVersion: after.version ?? MERCURY_VERSION,
      ideType: kind,
    },
    freshInstall: !before.installed,
  }
}

/** Lazy dialog-module load: a top-level import would drag the React/ink
 *  graph into this utility module and create a cycle (the dialog imports
 *  this module). */
async function ideOnboardingShown(): Promise<boolean> {
  try {
    const dialog = await import('../components/IdeOnboardingDialog.js')
    return dialog.hasIdeOnboardingDialogBeenShown()
  } catch (error) {
    logForDebugging(`ide: onboarding-shown query failed: ${String(error)}`)
    return true
  }
}

// ---------------------------------------------------------------------------
// Init orchestration — called by the session hook; never blocks
// startup.
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget the auto-pick into the detection callback, and in parallel
 * run the install arm unless vetoed (skip flag truthy, or the config
 * auto-install field explicitly false). The explicit install request from
 * the /ide command wins over the embedded-terminal kind. Install rejections
 * become a failed status, never a throw. VS Code family: on success the
 * auto-pick re-runs (the fresh extension may now advertise) and a FRESH
 * install fires onboarding when never shown for this terminal. JetBrains:
 * detect-only — the installed-check warms the cache the status surfaces
 * read; an explicit request gets an honest marketplace-notice status.
 */
export async function initializeIdeIntegration(
  onIdeDetected: (ide: DetectedIDEInfo | null) => void,
  ideToInstallExtension: IdeType | null,
  onShowOnboarding: () => void,
  onInstallStatus: (status: IDEExtensionInstallationStatus) => void,
): Promise<void> {
  void findAvailableIDE()
    .then(ide => onIdeDetected(ide))
    .catch(error => {
      logError(error)
      onIdeDetected(null)
    })

  try {
    if (skipAutoInstallEnabled()) return
    if (getGlobalConfig().autoInstallIdeExtension === false) return
    const target = ideToInstallExtension ?? getTerminalIdeType()
    if (target === null) return

    if (EDITOR_SIGNATURES[target].family === 'jetbrains') {
      const installed = await isJetBrainsPluginInstalledCached(target)
      if (ideToInstallExtension !== null) {
        onInstallStatus(
          installed
            ? { installed: true, error: null, installedVersion: null, ideType: target }
            : {
                installed: false,
                error:
                  `JetBrains plugins install from inside the IDE — open Settings → Plugins in ` +
                  `${toIDEDisplayName(target)}, install the Mercury plugin from its marketplace, ` +
                  'then restart the IDE fully.',
                installedVersion: null,
                ideType: target,
              },
        )
      }
      if (installed && !(await ideOnboardingShown())) onShowOnboarding()
      return
    }

    const { status, freshInstall } = await runVSCodeFamilyInstall(target)
    onInstallStatus(status)
    if (status.installed && status.error === null) {
      void findAvailableIDE()
        .then(ide => {
          if (ide !== null) onIdeDetected(ide)
        })
        .catch(error => logForDebugging(`ide: post-install auto-pick failed: ${String(error)}`))
      if (freshInstall && !(await ideOnboardingShown())) onShowOnboarding()
    }
  } catch (error) {
    onInstallStatus({
      installed: false,
      error: error instanceof Error ? error.message : String(error),
      installedVersion: null,
      ideType: ideToInstallExtension,
    })
  }
}

// ---------------------------------------------------------------------------
// Connected-bridge helpers
// ---------------------------------------------------------------------------

/** The reserved-name bridge entry in connected state, typed. */
export function getConnectedIdeClient(
  clients: MCPServerConnection[] | undefined,
): ConnectedMCPServer | undefined {
  const entry = clients?.find(client => client.name === IDE_BRIDGE_SERVER_NAME)
  return entry !== undefined && entry.type === 'connected' ? entry : undefined
}

/**
 * Bridge display name: the dedicated config entry's editor-name field for
 * the two IDE transports, else the embedded-terminal display name, else
 * null.
 */
export function getIdeClientName(client: MCPServerConnection | undefined): string | null {
  if (client !== undefined) {
    const config = client.config
    if (config.type === 'sse-ide' || config.type === 'ws-ide') return config.ideName
  }
  return embeddedTerminalDisplayName()
}

/** Connected-bridge display name (null when nothing is connected and no
 *  embedded editor terminal names one). */
export function getConnectedIdeName(mcpClients: MCPServerConnection[]): string | null {
  return getIdeClientName(getConnectedIdeClient(mcpClients))
}

/** In-editor diff capability: a connected bridge exists. */
export function hasAccessToIDEExtensionDiffFeature(clients: MCPServerConnection[] | undefined): boolean {
  return getConnectedIdeClient(clients) !== undefined
}

/** Close every open diff tab. ALL errors are swallowed — fired on prompt
 *  submit, and the editor may not support the op. */
export async function closeOpenDiffs(client: ConnectedMCPServer): Promise<void> {
  try {
    await callIdeRpc(CLOSE_ALL_DIFF_TABS_OP, {}, client)
  } catch (error) {
    logForDebugging(`ide: ${CLOSE_ALL_DIFF_TABS_OP} failed: ${String(error)}`)
  }
}
