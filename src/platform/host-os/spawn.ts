import { existsSync } from 'node:fs'
import { parseLegacyCommandString } from '../processes/resolvedInvocation.js'
import type { LookupWorld } from '../processes/which.js'
import { resolveProgramInPath } from './programs.js'
type DirectOrCmdSpec = {
  file: string
  args: string[]
  windowsVerbatimArguments: boolean
}

export type HostShellHint = 'powershell' | 'cmd' | 'posix-sh' | 'unknown'

export function commandShellOption(platform: NodeJS.Platform = process.platform): true | '/bin/sh' {
  return platform === 'win32' ? true : '/bin/sh'
}

export function shellCommandSpec(
  argv: readonly string[],
  comSpec?: string,
  platform: NodeJS.Platform = process.platform,
): DirectOrCmdSpec {
  if (platform === 'win32') {
    return {
      file: comSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${argv.join(' ')}"`],
      windowsVerbatimArguments: true,
    }
  }
  const [file, ...args] = argv
  return { file: file ?? '', args, windowsVerbatimArguments: false }
}

export function shellBinarySpec(
  command: string,
  args: readonly string[],
  comSpec?: string,
  platform: NodeJS.Platform = process.platform,
): DirectOrCmdSpec {
  if (platform === 'win32') {
    const tail = args.length > 0 ? ` ${args.join(' ')}` : ''
    return {
      file: comSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `""${command}"${tail}"`],
      windowsVerbatimArguments: true,
    }
  }
  return { file: command, args: [...args], windowsVerbatimArguments: false }
}

export function hostShellHint(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): HostShellHint {
  if (platform === 'win32') {
    if (typeof env.PSModulePath === 'string' && env.PSModulePath.length > 0) return 'powershell'
    if (typeof env.ComSpec === 'string') return 'cmd'
    return 'unknown'
  }
  if (typeof env.SHELL === 'string' && env.SHELL.length > 0) return 'posix-sh'
  return 'unknown'
}

const BATCH_SHIM = /\.(cmd|bat)$/i
const CMD_EXECUTABLE = /(?:^|[\\/])cmd(?:\.exe)?$/i

export function isBatchShim(file: string, platform: string = process.platform): boolean {
  return platform === 'win32' && BATCH_SHIM.test(file)
}

export function shimShellOption(
  platform: NodeJS.Platform = process.platform,
): { shell: true } | Record<string, never> {
  return platform === 'win32' ? { shell: true } : {}
}

export function commandShellArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command]
}

export function executableNeedsVerbatimArgs(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && CMD_EXECUTABLE.test(file)
}

export function hostScriptDialect(platform: NodeJS.Platform = process.platform): 'powershell' | 'posix-sh' {
  return platform === 'win32' ? 'powershell' : 'posix-sh'
}

function parseWindowsCommandArgs(raw: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let started = false
  let inQuotes = false
  for (let i = 0; i < raw.length; i++) {
    let slashes = 0
    while (i < raw.length && raw[i] === '\\') {
      slashes++
      i++
    }
    if (i < raw.length && raw[i] === '"') {
      cur += '\\'.repeat(Math.floor(slashes / 2))
      started = true
      if (slashes % 2 === 1) {
        cur += '"'
      } else if (inQuotes && raw[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (slashes > 0) {
      cur += '\\'.repeat(slashes)
      started = true
    }
    if (i >= raw.length) break
    const c = raw[i]!
    if (!inQuotes && (c === ' ' || c === '\t')) {
      if (started || cur.length > 0) {
        tokens.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += c
    started = true
  }
  if (started || cur.length > 0) tokens.push(cur)
  return tokens
}

export function parseEditorCommandLine(
  editor: string,
  world: LookupWorld,
): { executable: string; args: string[] } {
  if (world.platform === 'win32' && !editor.startsWith("'")) {
    if (!editor.startsWith('"')) {
      const boundaries = [editor.length, ...Array.from(editor.matchAll(/\s+/g), match => match.index).reverse()]
      for (const end of boundaries) {
        const executable = editor.slice(0, end)
        if (resolveProgramInPath(executable, world.path, world.platform) !== null) {
          return { executable, args: parseWindowsCommandArgs(editor.slice(end).trim()) }
        }
      }
    }
    const tokens = parseWindowsCommandArgs(editor)
    if (tokens.length > 0 && tokens[0]!.length > 0) {
      return { executable: tokens[0]!, args: tokens.slice(1) }
    }
    return { executable: editor, args: [] }
  }
  const invocation = parseLegacyCommandString(editor)
  if (invocation.executablePath.length > 0) {
    return { executable: invocation.executablePath, args: invocation.args }
  }
  return { executable: editor, args: [] }
}

export function editorInvocationOf(
  editor: string,
  editorCommand: string,
  resolved: { executable: string; args: string[] },
  platform: NodeJS.Platform = process.platform,
): { executablePath: string; args: string[] } {
  if (platform === 'win32' && editorCommand === editor) {
    return { executablePath: resolved.executable, args: resolved.args }
  }
  return parseLegacyCommandString(editorCommand)
}

export function editorShellCommandLine(
  editorExe: string,
  args: readonly string[],
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const quotedPath = platform === 'win32' ? '"%MERCURY_EDITOR_FILE%"' : `'${filePath.replaceAll("'", `'\\''`)}'`
  return [`"${editorExe}"`, ...args.map(arg => `"${arg}"`), quotedPath].join(' ')
}

type PromptEditorSpawnSpec =
  | {
      shell: false
      file: string
      args: string[]
      windowsVerbatimArguments: boolean
      extraEnv: Record<string, string>
    }
  | {
      shell: true
      commandLine: string
    }

export function promptEditorSpawnSpec(
  editorExe: string,
  args: readonly string[],
  filePath: string,
  comSpec: string | undefined,
  platform: NodeJS.Platform = process.platform,
): PromptEditorSpawnSpec {
  if (platform === 'win32') {
    const interpreter = (comSpec ?? 'cmd.exe').trim().replace(/^"+|"+$/g, '') || 'cmd.exe'
    if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(interpreter)) {
      const psQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`
      const psArgs = args.map(arg => ` ${psQuote(arg)}`).join('')
      return {
        shell: false,
        file: interpreter,
        args: ['-NoLogo', '-NoProfile', '-Command', `& ${psQuote(editorExe)}${psArgs} $env:MERCURY_EDITOR_FILE`],
        windowsVerbatimArguments: false,
        extraEnv: { MERCURY_EDITOR_FILE: filePath },
      }
    }
    const cmdLine = editorShellCommandLine(editorExe, args, '', 'win32')
    return {
      shell: false,
      file: interpreter,
      args: ['/d', '/v:off', '/s', '/c', `"${cmdLine}"`],
      windowsVerbatimArguments: true,
      extraEnv: { MERCURY_EDITOR_FILE: filePath },
    }
  }
  return {
    shell: true,
    commandLine: editorShellCommandLine(editorExe, args, filePath, platform),
  }
}

type ExternalEditorSpawnSpec =
  | { shell: true; command: string }
  | { shell: false; file: string; args: string[] }

function quoteForWindowsShell(value: string): string {
  return `"${value}"`
}

export function guiEditorSpawnSpec(
  editor: string,
  executable: string,
  args: readonly string[],
  targetArgs: readonly string[],
  editorExistsOnDisk?: boolean,
  platform: NodeJS.Platform = process.platform,
): ExternalEditorSpawnSpec {
  if (platform === 'win32') {
    const exists = editorExistsOnDisk ?? (editor.includes(' ') && existsSync(editor))
    const command =
      editor.includes(' ') && exists
        ? [quoteForWindowsShell(editor), ...targetArgs.map(quoteForWindowsShell)].join(' ')
        : [quoteForWindowsShell(executable), ...args.map(quoteForWindowsShell), ...targetArgs.map(quoteForWindowsShell)].join(' ')
    return { shell: true, command }
  }
  return { shell: false, file: executable, args: [...args, ...targetArgs] }
}

export function terminalEditorSpawnSpec(
  editor: string,
  executable: string,
  args: readonly string[],
  lineArgs: readonly string[],
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): ExternalEditorSpawnSpec {
  if (platform === 'win32') {
    return { shell: true, command: [editor, ...lineArgs, quoteForWindowsShell(filePath)].join(' ') }
  }
  return { shell: false, file: executable, args: [...args, ...lineArgs, filePath] }
}

const WINDOWS_TOOL_SHELL_DEFAULTS: Readonly<Record<string, string>> = {
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  GCM_INTERACTIVE: 'never',
}

const WINDOWS_HEADLESS_GIT_DEFAULTS: Readonly<Record<string, string>> = {
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
}

const EMPTY_ENV_DEFAULTS: Readonly<Record<string, string>> = {}

const GIT_FOR_WINDOWS_ASKPASS_DISPLAY = 'needs-to-be-defined'
const GIT_FOR_WINDOWS_ASKPASS = /(?:^|[/\\])(?:git-askpass(?:\.exe)?|git-gui--askpass)$/i

function unquoteAskpass(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function isPlatformAskpassVar(
  key: string,
  value: string | undefined,
  platform: string = process.platform,
): boolean {
  if (platform !== 'win32' || value === undefined) return false
  const upper = key.toUpperCase()
  if (upper === 'DISPLAY') return value === GIT_FOR_WINDOWS_ASKPASS_DISPLAY
  return (upper === 'SSH_ASKPASS' || upper === 'GIT_ASKPASS') && GIT_FOR_WINDOWS_ASKPASS.test(unquoteAskpass(value))
}

export function envVarKey(name: string, platform: string = process.platform): string {
  return platform === 'win32' ? name.toUpperCase() : name
}

export function toolShellEnvKey(key: string, platform: string = process.platform): string {
  return platform === 'win32' || /^(?:npm|pnpm)_config_/i.test(key) ? key.toUpperCase() : key
}

export function extraToolShellDefaults(platform: string = process.platform): Readonly<Record<string, string>> {
  return platform === 'win32' ? WINDOWS_TOOL_SHELL_DEFAULTS : EMPTY_ENV_DEFAULTS
}

export function headlessGitDefaults(platform: string = process.platform): Readonly<Record<string, string>> {
  return platform === 'win32' ? WINDOWS_HEADLESS_GIT_DEFAULTS : EMPTY_ENV_DEFAULTS
}

const SYSTEM_PROGRAM_FOLDERS: ReadonlySet<string> = new Set([
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
])

export function mergeLoginPath(
  own: string,
  carried: NodeJS.ProcessEnv | undefined,
  platform: string = process.platform,
): string {
  const exported = Object.entries(carried ?? {}).find(([name]) => toolShellEnvKey(name, platform) === 'PATH')?.[1] ?? ''
  const held = new Set(own.split(':'))
  const login = [...new Set(exported.split(':'))].filter(entry => entry !== '')
  const added = login.filter(entry => !held.has(entry))
  if (added.length === 0) return own
  if (platform === 'win32') return [...(own === '' ? [] : [own]), ...added].join(':')
  const ofTheLogin = new Set(login)
  const front = [...held].filter(entry => entry !== '' && !(ofTheLogin.has(entry) && SYSTEM_PROGRAM_FOLDERS.has(entry)))
  const kept = new Set(front)
  return [...front, ...login.filter(entry => !kept.has(entry))].join(':')
}

export function loginPathOverride(
  own: string,
  carried: NodeJS.ProcessEnv | undefined,
  platform: string = process.platform,
): string | undefined {
  return platform === 'win32' ? undefined : mergeLoginPath(own, carried, platform)
}

export function commandByteBudget(
  windowsLimit: number,
  posixLimit: number,
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === 'win32' ? windowsLimit : posixLimit
}

export function decodeShellScriptBytes(bytes: Buffer, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return bytes.toString('utf8').trim()
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.subarray(2).toString('utf16le')
      : bytes.toString('utf8').replace(/^\uFEFF/, '')
  return text.replace(/\r\n?/g, '\n').trim()
}
