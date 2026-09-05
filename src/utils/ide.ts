
import { existsSync, watch, type FSWatcher } from 'node:fs'
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
import { locateBridgeVsix, MERCURY_IDE_EXTENSION_ID } from './editorExtensionPackage.js'
import { isJetBrainsPluginInstalledCached } from './jetbrains.js'
import { logError } from './log.js'
import { PROJECT_CONFIG_DIR_NAMES } from './projectConfig.js'
import { resolveWatchRoot } from './watchRoot.js'
import { whichSync } from './which.js'

export { callIdeRpc } from '../services/mcp/client.js'


export const IDE_BRIDGE_SERVER_NAME = 'ide'

const LOCKFILE_SUFFIX = '.lock'

const IDE_BRIDGE_DIR = 'ide'

export { MERCURY_IDE_EXTENSION_ID } from './editorExtensionPackage.js'

const CLOSE_ALL_DIFF_TABS_OP = 'closeAllDiffTabs'

const GENERIC_IDE_DISPLAY_NAME = 'IDE'

const REACHABILITY_TIMEOUT_MS = 500

const AUTO_PICK_BUDGET_MS = 30_000
const AUTO_PICK_FLOOR_MS = 10_000

const CLI_INVOCATION_DELAY_MS = 500

const WINDOWS_USERS_MOUNT = '/mnt/c/Users'
const WINDOWS_SYSTEM_PROFILES = new Set(['all users', 'default', 'default user', 'public'])


function advertisedIdePort(): number | null {
  const raw = flagEnv('MERCURY_IDE_PORT')
  if (raw === undefined || raw.trim() === '') return null
  const port = Number.parseInt(raw, 10)
  return Number.isFinite(port) ? port : null
}

function skipValidCheckEnabled(): boolean {
  return flagEnabled('MERCURY_IDE_SKIP_VALID_CHECK')
}

function skipAutoInstallEnabled(): boolean {
  return flagEnabled('MERCURY_IDE_SKIP_AUTO_INSTALL')
}

function ideHostOverride(): string | null {
  const raw = flagEnv('MERCURY_IDE_HOST_OVERRIDE')
  if (raw === undefined || raw.trim() === '') return null
  return raw.trim()
}

function forceIdeTerminalEnabled(): boolean {
  return flagEnabled('MERCURY_IDE_FORCE_TERMINAL')
}


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

interface EditorSignature {
  family: EditorFamily
  displayName: string
  darwinKeywords: string[]
  linuxKeywords: string[]
  win32Executables: string[]
  cliCommand?: string
  bundleNames?: string[]
}

const EDITOR_SIGNATURES: Record<IdeType, EditorSignature> = {
  vscode: {
    family: 'vscode',
    displayName: 'VS Code',
    darwinKeywords: ['visual studio code'],
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
    family: 'jetbrains',
    displayName: 'Aqua',
    darwinKeywords: ['aqua.app'],
    linuxKeywords: [],
    win32Executables: ['aqua64.exe'],
  },
  gateway: {
    family: 'jetbrains',
    displayName: 'JetBrains Gateway',
    darwinKeywords: ['jetbrains gateway'],
    linuxKeywords: [],
    win32Executables: [],
  },
  fleet: {
    family: 'jetbrains',
    displayName: 'Fleet',
    darwinKeywords: ['fleet.app'],
    linuxKeywords: [],
    win32Executables: ['fleet.exe'],
  },
  jetbrains: {
    family: 'jetbrains',
    displayName: 'JetBrains IDE',
    darwinKeywords: [],
    linuxKeywords: [],
    win32Executables: [],
  },
  androidstudio: {
    family: 'jetbrains',
    displayName: 'Android Studio',
    darwinKeywords: ['android studio'],
    linuxKeywords: [],
    win32Executables: ['studio64.exe'],
  },
}

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

export function isJetBrainsIde(value: string | null | undefined): boolean {
  if (!value) return false
  const kind = normalizeToIdeType(value)
  if (kind !== null) return EDITOR_SIGNATURES[kind].family === 'jetbrains'
  const lowered = value.toLowerCase()
  return JETBRAINS_NAME_MARKERS.some(marker => lowered.includes(marker))
}

export function isVSCodeFamilyIde(value: string | null | undefined): boolean {
  if (!value) return false
  const kind = normalizeToIdeType(value)
  if (kind !== null) return EDITOR_SIGNATURES[kind].family === 'vscode'
  const lowered = value.toLowerCase()
  return VSCODE_NAME_MARKERS.some(marker => lowered.includes(marker))
}


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

interface IdeAdvertisement {
  pid?: number
  workspaceFolders: string[]
  ideName?: string
  transport?: string
  runningInWindows?: boolean
  authToken?: string
}


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

async function windowsSideBridgeHomes(): Promise<string[]> {
  const homes: string[] = []
  const profile = await windowsUserProfileLocalPath()
  if (profile) {
    for (const dirName of PROJECT_CONFIG_DIR_NAMES) homes.push(join(profile, dirName, IDE_BRIDGE_DIR))
  }
  try {
    const entries = await readdir(WINDOWS_USERS_MOUNT, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (WINDOWS_SYSTEM_PROFILES.has(entry.name.toLowerCase())) continue
      for (const dirName of PROJECT_CONFIG_DIR_NAMES) {
        homes.push(join(WINDOWS_USERS_MOUNT, entry.name, dirName, IDE_BRIDGE_DIR))
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR' || code === 'EPERM') {
      logForDebugging(`ide: windows users directory inaccessible: ${String(error)}`)
    } else {
      logError(error)
    }
  }
  return homes
}

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
  }
  return {
    workspaceFolders: raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0),
  }
}


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
    const route = await execFileNoThrow('ip', ['route', 'show', 'default'], { timeout: 5_000 })
    if (route.code === 0) {
      const match = /default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(route.stdout)
      const gateway = match?.[1]
      if (gateway && (await probeTcpReachable(gateway, port))) return gateway
    }
  } catch {
  }
  return LOOPBACK_HOST
}

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


async function deleteLockfile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    logForDebugging(`ide: could not delete stale advertisement ${path}: ${String(error)}`)
  }
}

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


let activePickController: AbortController | null = null
let activePick: Promise<DetectedIDEInfo | null> | null = null

function abortableDelay(ms: number, signal: AbortSignal, arm?: (wake: () => void) => void): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
    arm?.(done)
  })
}

function watchBridgeHomes(homes: readonly string[], onChange: () => void): () => void {
  const watchers: FSWatcher[] = []
  for (const home of homes) {
    if (!existsSync(home)) continue
    try {
      const w = watch(resolveWatchRoot(home), () => onChange())
      w.on('error', () => {
        try {
          w.close()
        } catch {
        }
      })
      watchers.push(w)
    } catch {
    }
  }
  return () => {
    for (const w of watchers) {
      try {
        w.close()
      } catch {
      }
    }
  }
}

export function findAvailableIDE(): Promise<DetectedIDEInfo | null> {
  if (activePick !== null) return activePick
  const controller = new AbortController()
  activePickController = controller
  let wake: (() => void) | null = null
  let stopWatch: () => void = () => {}
  let pick: Promise<DetectedIDEInfo | null> | null = null
  const run = async (): Promise<DetectedIDEInfo | null> => {
    try {
      await cleanStaleIdeLockfiles()
      stopWatch = watchBridgeHomes(await candidateBridgeHomes(), () => wake?.())
      const deadline = Date.now() + AUTO_PICK_BUDGET_MS
      while (!controller.signal.aborted && Date.now() < deadline) {
        if (!getIsScrollDraining()) {
          const valid = await detectIDEs(false)
          if (controller.signal.aborted) return null
          const sole = valid[0]
          if (valid.length === 1 && sole !== undefined) return sole
        }
        await abortableDelay(Math.max(0, Math.min(AUTO_PICK_FLOOR_MS, deadline - Date.now())), controller.signal, w => {
          wake = w
        })
        wake = null
      }
      return null
    } catch (error) {
      logError(error)
      return null
    } finally {
      stopWatch()
      if (activePickController === controller) activePickController = null
      if (activePick === pick) activePick = null
    }
  }
  pick = run()
  activePick = pick
  return pick
}


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

export function getCachedRunningIDEs(): IdeType[] | null {
  return runningIDECache
}

export function resetRunningIDECache(): void {
  runningIDECache = null
}


function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function vsCodeCliEnvSpread(): { env?: NodeJS.ProcessEnv } {
  if (process.platform !== 'linux') return {}
  const cliEnv: NodeJS.ProcessEnv = { ...subprocessEnv() }
  delete cliEnv.DISPLAY
  return { env: cliEnv }
}

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

  const vsix = locateBridgeVsix()
  if (vsix === null) {
    return {
      status: {
        installed: before.installed,
        error:
          `No Mercury extension package (mercury-vscode.vsix) beside this build — ` +
          `\`mercury editor status\` shows where one is looked for; a source checkout builds it with ` +
          `bash scripts/vscode/build-vsix.sh. In-editor features stay off until it is installed.`,
        installedVersion: before.version,
        ideType: kind,
      },
      freshInstall: false,
    }
  }

  await delay(CLI_INVOCATION_DELAY_MS)
  const outcome = await execFileNoThrow(cli, ['--force', '--install-extension', vsix], {
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

async function ideOnboardingShown(): Promise<boolean> {
  try {
    const dialog = await import('../components/IdeOnboardingDialog.js')
    return dialog.hasIdeOnboardingDialogBeenShown()
  } catch (error) {
    logForDebugging(`ide: onboarding-shown query failed: ${String(error)}`)
    return true
  }
}


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


export function getConnectedIdeClient(
  clients: MCPServerConnection[] | undefined,
): ConnectedMCPServer | undefined {
  const entry = clients?.find(client => client.name === IDE_BRIDGE_SERVER_NAME)
  return entry !== undefined && entry.type === 'connected' ? entry : undefined
}

export function getIdeClientName(client: MCPServerConnection | undefined): string | null {
  if (client !== undefined) {
    const config = client.config
    if (config.type === 'sse-ide' || config.type === 'ws-ide') return config.ideName
  }
  return embeddedTerminalDisplayName()
}

export function getConnectedIdeName(mcpClients: MCPServerConnection[]): string | null {
  return getIdeClientName(getConnectedIdeClient(mcpClients))
}

export function hasAccessToIDEExtensionDiffFeature(clients: MCPServerConnection[] | undefined): boolean {
  return getConnectedIdeClient(clients) !== undefined
}

export async function closeOpenDiffs(client: ConnectedMCPServer): Promise<void> {
  try {
    await callIdeRpc(CLOSE_ALL_DIFF_TABS_OP, {}, client)
  } catch (error) {
    logForDebugging(`ide: ${CLOSE_ALL_DIFF_TABS_OP} failed: ${String(error)}`)
  }
}
