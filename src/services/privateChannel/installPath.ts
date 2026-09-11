import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { whichSync } from '../../utils/which.js'
import { pathEntryEquals, type LayoutRoots } from './installLayout.js'

export const PATH_SENTINEL = 'mercury-managed-path'
export const WIN32_USER_PATH_STORE = 'the user PATH (HKCU\\Environment)'

export type UserPathKind = 'ExpandString' | 'String'

export type UserPathRead =
  | { state: 'ok'; value: string; kind: UserPathKind }
  | { state: 'absent' }
  | { state: 'failed'; note: string }

export interface PathEntryIo {
  env: NodeJS.ProcessEnv
  home: string
  readFile(path: string): string | null
  appendFile(path: string, text: string): void
  resolveCommand(name: string): string | null
  readUserPath(): UserPathRead
  writeUserPath(expected: string, value: string, kind: UserPathKind): void
}

export type PathEntryOutcome =
  | { state: 'on-path'; dir: string; line: string }
  | { state: 'reachable'; dir: string; resolved: string; line: string }
  | { state: 'present'; dir: string; targets: string[]; line: string }
  | { state: 'would-write'; dir: string; targets: string[]; line: string }
  | { state: 'written'; dir: string; targets: string[]; line: string }
  | { state: 'refused'; dir: string; reason: string; line: string }


export function spellUnderHome(dir: string, home: string, prefix = '$HOME'): string {
  const root = home.replace(/\/+$/, '')
  if (root && (dir === root || dir.startsWith(`${root}/`))) return prefix + dir.slice(root.length)
  return dir
}

export function shGuardedLine(spelled: string): string {
  return `case ":$PATH:" in *":${spelled}:"*) ;; *) export PATH="${spelled}:$PATH" ;; esac # ${PATH_SENTINEL}`
}

export function fishConfText(spelled: string): string {
  return [
    `# ${PATH_SENTINEL} — the stable Mercury command's folder, written by \`mercury install\``,
    'if type -q fish_add_path',
    `    fish_add_path --path "${spelled}"`,
    `else if not contains -- "${spelled}" $PATH`,
    `    set -gx PATH "${spelled}" $PATH`,
    'end',
    '',
  ].join('\n')
}

export function textNamesDir(text: string, dir: string, home: string): boolean {
  if (text.includes(PATH_SENTINEL)) return true
  const spellings = new Set([dir])
  const root = home.replace(/\/+$/, '')
  if (root && dir.startsWith(`${root}/`)) {
    const rest = dir.slice(root.length)
    for (const prefix of ['$HOME', '${HOME}', '~']) spellings.add(prefix + rest)
  }
  return [...spellings].some(s => text.includes(s))
}

function expandWin32(entry: string, env: NodeJS.ProcessEnv): string {
  return entry.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())
    const value = key === undefined ? undefined : env[key]
    return value === undefined ? whole : value
  })
}

export function userPathListsDir(value: string, dir: string, env: NodeJS.ProcessEnv): boolean {
  return value
    .split(';')
    .some(entry => entry.trim() !== '' && (pathEntryEquals(entry, dir, true) || pathEntryEquals(expandWin32(entry, env), dir, true)))
}

const shellNameOf = (env: NodeJS.ProcessEnv): string => basename(env.SHELL ?? '')

export function manualPathLine(roots: LayoutRoots, io: Pick<PathEntryIo, 'env' | 'home'>): string {
  if (roots.isWindows) {
    return `Settings › System › Advanced system settings › Environment Variables › User variables › Path › New: ${roots.binDir}`
  }
  const spelled = spellUnderHome(roots.binDir, io.home)
  return shellNameOf(io.env) === 'fish' ? `fish_add_path "${spelled}"` : `export PATH="${spelled}:$PATH"`
}

export const describePathTarget = (target: string, home: string): string => spellUnderHome(target, home, '~')

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200)

function sameFile(a: string, b: string, isWindows: boolean): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  const x = real(a)
  const y = real(b)
  return isWindows ? x.toLowerCase() === y.toLowerCase() : x === y
}

export type CommandOnPath =
  | { state: 'stable'; resolved: string }
  | { state: 'other'; resolved: string }
  | { state: 'absent' }

export function commandOnPath(roots: LayoutRoots, resolveCommand: (name: string) => string | null = whichSync): CommandOnPath {
  const resolved = resolveCommand('mercury')
  if (resolved === null) return { state: 'absent' }
  const members = [roots.shimPath, ...(roots.shimSetPaths ?? [])]
  return members.some(member => sameFile(member, resolved, roots.isWindows)) ? { state: 'stable', resolved } : { state: 'other', resolved }
}

export function commandOnPathWarning(
  roots: LayoutRoots,
  found: CommandOnPath,
  stableWords = 'the stable command',
  io: Pick<PathEntryIo, 'env' | 'home'> = { env: process.env, home: homedir() },
): [fact: string, fix: string] | null {
  if (found.state === 'stable') return null
  const fact =
    found.state === 'other'
      ? `the \`mercury\` your shell runs is ${found.resolved}; ${stableWords} is ${roots.shimPath}`
      : `no \`mercury\` is on your PATH; ${stableWords} is ${roots.shimPath}`
  const fix = roots.isWindows
    ? `put ${roots.binDir} ${found.state === 'other' ? 'ahead of it in' : 'on'} your user PATH (Settings › System › Advanced system settings › Environment Variables › User variables › Path)`
    : `put ${roots.binDir} ${found.state === 'other' ? 'ahead of it ' : ''}on PATH — in this terminal: ${manualPathLine(roots, io)}`
  return [fact, fix]
}


interface Decision {
  outcome: PathEntryOutcome
  apply?: () => PathEntryOutcome
}

const refusal = (roots: LayoutRoots, io: Pick<PathEntryIo, 'env' | 'home'>, reason: string): PathEntryOutcome => ({
  state: 'refused',
  dir: roots.binDir,
  reason,
  line: manualPathLine(roots, io),
})

function decidePosix(roots: LayoutRoots, io: PathEntryIo): Decision {
  const dir = roots.binDir
  const line = manualPathLine(roots, io)
  const shell = shellNameOf(io.env)
  const spelled = spellUnderHome(dir, io.home)
  let targets: string[]
  let text: string
  switch (shell) {
    case 'zsh':
      targets = [join(io.home, '.zshrc')]
      text = `${shGuardedLine(spelled)}\n`
      break
    case 'bash': {
      const login =
        ['.bash_profile', '.bash_login', '.profile'].map(name => join(io.home, name)).find(candidate => io.readFile(candidate) !== null) ??
        join(io.home, '.profile')
      targets = [join(io.home, '.bashrc'), login]
      text = `${shGuardedLine(spelled)}\n`
      break
    }
    case 'fish':
      targets = [join(io.home, '.config', 'fish', 'conf.d', 'mercury.fish')]
      text = fishConfText(spelled)
      break
    default:
      return {
        outcome: refusal(roots, io, shell ? `your shell (${shell}) has no startup file this installer knows` : 'SHELL is not set, so no startup file can be chosen'),
      }
  }
  const existing = new Map<string, string | null>()
  for (const target of targets) existing.set(target, io.readFile(target))
  const consulted = shell === 'fish' ? [...targets, join(io.home, '.config', 'fish', 'config.fish')] : targets
  const naming = consulted.filter(target => {
    const content = existing.has(target) ? existing.get(target) ?? null : io.readFile(target)
    return content !== null && textNamesDir(content, dir, io.home)
  })
  if (naming.length > 0) return { outcome: { state: 'present', dir, targets: naming, line } }
  const apply = (): PathEntryOutcome => {
    const written: string[] = []
    for (const target of targets) {
      const current = existing.get(target) ?? null
      const lead = current === null || current === '' || current.endsWith('\n') ? '' : '\n'
      try {
        io.appendFile(target, lead + text)
      } catch (e) {
        const partial = written.length > 0 ? ` (already written: ${written.map(w => describePathTarget(w, io.home)).join(', ')})` : ''
        throw new Error(`could not write ${describePathTarget(target, io.home)}: ${errorText(e)}${partial}`)
      }
      written.push(target)
    }
    return { state: 'written', dir, targets: written, line }
  }
  return { outcome: { state: 'would-write', dir, targets, line }, apply }
}

function decideWin32(roots: LayoutRoots, io: PathEntryIo): Decision {
  const dir = roots.binDir
  const line = manualPathLine(roots, io)
  const read = io.readUserPath()
  if (read.state === 'failed') return { outcome: refusal(roots, io, `the user PATH could not be read (${read.note}); nothing was written`) }
  if (read.state === 'absent') return { outcome: refusal(roots, io, 'the user PATH has no value to append to; nothing was written') }
  if (read.value.split(';').every(entry => entry.trim() === '')) {
    return { outcome: refusal(roots, io, 'the user PATH read back empty — a value that can be empty is never written over; nothing was written') }
  }
  if (userPathListsDir(read.value, dir, io.env)) return { outcome: { state: 'present', dir, targets: [WIN32_USER_PATH_STORE], line } }
  const value = `${read.value.replace(/;+$/, '')};${dir}`
  const apply = (): PathEntryOutcome => {
    io.writeUserPath(read.value, value, read.kind)
    return { state: 'written', dir, targets: [WIN32_USER_PATH_STORE], line }
  }
  return { outcome: { state: 'would-write', dir, targets: [WIN32_USER_PATH_STORE], line }, apply }
}

function decide(roots: LayoutRoots, io: PathEntryIo): Decision {
  const dir = roots.binDir
  const line = manualPathLine(roots, io)
  const onPath = (io.env.PATH ?? '').split(roots.isWindows ? ';' : ':').some(entry => pathEntryEquals(entry, dir, roots.isWindows))
  if (onPath) return { outcome: { state: 'on-path', dir, line } }
  const resolved = io.resolveCommand('mercury')
  if (resolved !== null) {
    const members = [roots.shimPath, ...(roots.shimSetPaths ?? [])]
    if (members.some(member => sameFile(member, resolved, roots.isWindows))) return { outcome: { state: 'on-path', dir, line } }
    return { outcome: { state: 'reachable', dir, resolved, line } }
  }
  return roots.isWindows ? decideWin32(roots, io) : decidePosix(roots, io)
}

export function planBinDirOnPath(roots: LayoutRoots, io: PathEntryIo): PathEntryOutcome {
  try {
    return decide(roots, io).outcome
  } catch (e) {
    return refusal(roots, io, `the PATH state could not be read (${errorText(e)})`)
  }
}

export function ensureBinDirOnPath(roots: LayoutRoots, io: PathEntryIo): PathEntryOutcome {
  let decision: Decision
  try {
    decision = decide(roots, io)
  } catch (e) {
    return refusal(roots, io, `the PATH state could not be read (${errorText(e)})`)
  }
  if (!decision.apply) return decision.outcome
  try {
    const written = decision.apply()
    io.env.PATH = roots.isWindows ? `${io.env.PATH ?? ''};${roots.binDir}` : `${roots.binDir}:${io.env.PATH ?? ''}`
    return written
  } catch (e) {
    return refusal(roots, io, errorText(e))
  }
}


export const WIN32_READ_USER_PATH_PS1 = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }',
  '$key = $null',
  'try {',
  "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
  '} catch {',
  "  Write-Output ('FAILED ' + $PSItem.Exception.Message)",
  '  exit 0',
  '}',
  "if ($null -eq $key) { Write-Output 'FAILED HKCU\\Environment could not be opened'; exit 0 }",
  'try {',
  "  $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  if ($null -eq $raw) { Write-Output 'ABSENT'; exit 0 }",
  "  $kind = $key.GetValueKind('Path')",
  "  Write-Output ('KIND ' + $kind.ToString())",
  "  Write-Output ('VALUE ' + [string]$raw)",
  '} finally { $key.Close() }',
  '',
].join('\n')

export const WIN32_WRITE_USER_PATH_PS1 = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }',
  '$expected = [string]$env:MERCURY_PATH_EXPECTED',
  '$value = [string]$env:MERCURY_PATH_VALUE',
  '$kindName = [string]$env:MERCURY_PATH_KIND',
  "if (-not $value) { Write-Output 'EMPTY refusing to write an empty PATH'; exit 0 }",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "if ($null -eq $key) { Write-Output 'FAILED HKCU\\Environment could not be opened for writing'; exit 0 }",
  'try {',
  "  $current = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  if (($null -eq $current) -or ([string]$current -cne $expected)) { Write-Output 'MOVED the user PATH changed since it was read; nothing was written'; exit 0 }",
  '  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString',
  "  if ($kindName -eq 'String') { $kind = [Microsoft.Win32.RegistryValueKind]::String }",
  "  $key.SetValue('Path', $value, $kind)",
  '} finally { $key.Close() }',
  'try {',
  "  Add-Type -Namespace MercuryInstall -Name Env -MemberDefinition @'",
  '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]',
  'public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
  "'@",
  '  $result = [UIntPtr]::Zero',
  "  [MercuryInstall.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null",
  '} catch { }',
  "Write-Output 'WRITTEN'",
  '',
].join('\n')

export function parseUserPathReadOutput(out: string): UserPathRead {
  const lines = out.split(/\r?\n/)
  const first = lines[0] ?? ''
  if (first === 'ABSENT') return { state: 'absent' }
  if (first.startsWith('FAILED')) return { state: 'failed', note: first.slice('FAILED'.length).trim() || 'the registry read failed' }
  const kindLine = lines.find(l => l.startsWith('KIND '))
  const valueLine = lines.find(l => l.startsWith('VALUE '))
  if (kindLine === undefined || valueLine === undefined) return { state: 'failed', note: `unexpected reader output: ${out.slice(0, 120)}` }
  const kind = kindLine.slice('KIND '.length).trim()
  if (kind !== 'ExpandString' && kind !== 'String') {
    return { state: 'failed', note: `the user PATH value has kind ${kind || '(unknown)'}; only REG_EXPAND_SZ and REG_SZ are written` }
  }
  return { state: 'ok', value: valueLine.slice('VALUE '.length), kind }
}

function runPowerShell(exe: string, script: string, extraEnv: Record<string, string>): string {
  return execFileSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    env: { ...subprocessEnv(), ...extraEnv },
  })
}

function readUserPathRegistry(powershell: (() => string | null) | undefined): UserPathRead {
  const exe = powershell?.() ?? null
  if (exe === null) return { state: 'failed', note: 'no PowerShell found (pwsh or powershell)' }
  try {
    return parseUserPathReadOutput(runPowerShell(exe, WIN32_READ_USER_PATH_PS1, {}))
  } catch (e) {
    return { state: 'failed', note: errorText(e) }
  }
}

function writeUserPathRegistry(powershell: (() => string | null) | undefined, expected: string, value: string, kind: UserPathKind): void {
  const exe = powershell?.() ?? null
  if (exe === null) throw new Error('no PowerShell found (pwsh or powershell)')
  const out = runPowerShell(exe, WIN32_WRITE_USER_PATH_PS1, { MERCURY_PATH_EXPECTED: expected, MERCURY_PATH_VALUE: value, MERCURY_PATH_KIND: kind })
  const first = out.split(/\r?\n/)[0] ?? ''
  if (first !== 'WRITTEN') throw new Error(first || 'the registry write printed nothing')
}

function readUserPathFile(file: string): UserPathRead {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'failed', note: errorText(e) }
  }
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; value?: unknown }
    if (typeof parsed.value !== 'string' || (parsed.kind !== 'ExpandString' && parsed.kind !== 'String')) {
      return { state: 'failed', note: `${file} is not a {kind, value} record` }
    }
    return { state: 'ok', value: parsed.value, kind: parsed.kind }
  } catch (e) {
    return { state: 'failed', note: errorText(e) }
  }
}

function writeUserPathFile(file: string, expected: string, value: string, kind: UserPathKind): void {
  if (value.trim() === '') throw new Error('refusing to write an empty PATH')
  const current = readUserPathFile(file)
  if (current.state !== 'ok' || current.value !== expected) throw new Error('the user PATH changed since it was read; nothing was written')
  writeFileSync(file, `${JSON.stringify({ kind, value }, null, 1)}\n`)
}

export function realPathEntryIo(opts: { powershell?: () => string | null } = {}): PathEntryIo {
  const storeFile = flagEnv('MERCURY_USER_PATH_FILE')
  return {
    env: process.env,
    home: homedir(),
    readFile(path) {
      try {
        return readFileSync(path, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    appendFile(path, text) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, text)
    },
    resolveCommand: name => whichSync(name),
    readUserPath: () => (storeFile ? readUserPathFile(storeFile) : readUserPathRegistry(opts.powershell)),
    writeUserPath: (expected, value, kind) =>
      storeFile ? writeUserPathFile(storeFile, expected, value, kind) : writeUserPathRegistry(opts.powershell, expected, value, kind),
  }
}
