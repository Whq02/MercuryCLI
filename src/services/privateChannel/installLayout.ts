import { execFileSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { createHash } from 'node:crypto'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  isTransientWin32FsCode,
  WIN32_RENAME_RETRY_DELAYS_MS,
} from '../../substrate/durablePublish.js'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'
import {
  BUNDLE_MEMBER_NAMES,
  describePayload,
  parsePrivateVersion,
  resolveBundleMember,
  type PayloadDescriptor,
} from './channelCore.js'
import { checkVendoredRuntime, payloadVendoredRuntime, readRuntimeRecord } from './vendoredRuntime.js'

export interface LayoutRoots {
  versionsDir: string
  binDir: string
  shimPath: string
  shimSetPaths?: string[]
  isWindows: boolean
}

export function resolveLayoutRoots(platform: string = process.platform): LayoutRoots {
  const isWindows = platform === 'win32'
  const versionsDir = flagEnv('MERCURY_VERSIONS_DIR') || join(getMercuryHome(), 'versions')
  const binDir = isWindows
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Mercury', 'bin')
    : join(homedir(), '.local', 'bin')
  const shimPath = join(binDir, isWindows ? 'mercury.cmd' : 'mercury')
  const shimSetPaths = isWindows ? [shimPath, join(binDir, 'mercury')] : [shimPath]
  return { versionsDir, binDir, shimPath, shimSetPaths, isWindows }
}

export function pathEntryEquals(entry: string, target: string, isWindows: boolean): boolean {
  if (!entry.trim()) return false
  const strip = (s: string): string => {
    const out = s.replace(isWindows ? /[\\/]+$/ : /\/+$/, '')
    return out === '' ? s : out
  }
  const norm = (s: string): string => {
    let v = strip(s.trim())
    try {
      v = realpathSync.native(v)
    } catch {
    }
    return isWindows ? v.toLowerCase() : v
  }
  return norm(entry) === norm(target)
}


const faultCounts = new Map<string, number>()

function injectFault(point: string): boolean {
  const spec = flagEnv('MERCURY_UPDATE_FAULT')
  if (!spec) return false
  for (const entry of spec.split(',')) {
    const [name, countRaw] = entry.split(':')
    if (name !== point) continue
    const budget = countRaw ? Number(countRaw) : Number.POSITIVE_INFINITY
    const key = `${spec}::${point}`
    const used = faultCounts.get(key) ?? 0
    if (used >= budget) return false
    faultCounts.set(key, used + 1)
    return true
  }
  return false
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const isTransientFsCode = isTransientWin32FsCode

function renameWithRetry(from: string, to: string, faultPoint: string, isWindows: boolean): void {
  for (let attempt = 0; ; attempt++) {
    try {
      if (injectFault(faultPoint)) {
        const err = new Error(`injected ${faultPoint} failure`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!isWindows || !isTransientFsCode(code) || attempt >= WIN32_RENAME_RETRY_DELAYS_MS.length) throw e
      sleepSync(WIN32_RENAME_RETRY_DELAYS_MS[attempt]!)
    }
  }
}

function removeWithRetry(path: string, faultPoint: string, isWindows: boolean): void {
  for (let attempt = 0; ; attempt++) {
    try {
      if (injectFault(faultPoint)) {
        const err = new Error(`injected ${faultPoint} failure`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      rmSync(path, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!isWindows || !isTransientFsCode(code) || attempt >= WIN32_RENAME_RETRY_DELAYS_MS.length) throw e
      sleepSync(WIN32_RENAME_RETRY_DELAYS_MS[attempt]!)
    }
  }
}


export type PointerState =
  | { state: 'ok'; value: string }
  | { state: 'absent' }
  | { state: 'empty' }
  | { state: 'unreadable'; note: string }

function readPointerState(path: string): PointerState {
  let raw: string
  try {
    if (injectFault('pointer-read')) {
      const err = new Error('injected pointer-read failure') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    return { state: 'unreadable', note: e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
  const value = raw.split(/\r?\n/)[0]?.trim() ?? ''
  if (!value) return { state: 'empty' }
  return { state: 'ok', value }
}

function readPointerFile(path: string): string | null {
  const state = readPointerState(path)
  return state.state === 'ok' ? state.value : null
}

export const readCurrentVersionState = (roots: LayoutRoots): PointerState =>
  readPointerState(join(roots.versionsDir, 'current.txt'))
export const readCurrentVersion = (roots: LayoutRoots): string | null =>
  readPointerFile(join(roots.versionsDir, 'current.txt'))
export const readPreviousVersion = (roots: LayoutRoots): string | null =>
  readPointerFile(join(roots.versionsDir, 'previous.txt'))

function writePointerFile(path: string, value: string, isWindows: boolean): void {
  const pointerName = path.endsWith('current.txt') ? 'current' : 'previous'
  if (injectFault(`pointer-write-${pointerName}`)) {
    throw new Error(`injected pointer-write-${pointerName} failure`)
  }
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, value + '\n')
  renameWithRetry(tmp, path, `pointer-rename-${pointerName}`, isWindows)
}

export function switchCurrent(roots: LayoutRoots, version: string): { previous: string | null } {
  mkdirSync(roots.versionsDir, { recursive: true })
  const previous = readCurrentVersion(roots)
  if (previous && previous !== version) writePointerFile(join(roots.versionsDir, 'previous.txt'), previous, roots.isWindows)
  writePointerFile(join(roots.versionsDir, 'current.txt'), version, roots.isWindows)
  return { previous }
}

export function restoreCurrent(roots: LayoutRoots, version: string): void {
  writePointerFile(join(roots.versionsDir, 'current.txt'), version, roots.isWindows)
}


export type LockResult = { state: 'acquired' } | { state: 'held'; byPid: number | null }

export function acquireUpdateLock(roots: LayoutRoots): LockResult {
  const lockDir = join(roots.versionsDir, '.update.lock')
  mkdirSync(roots.versionsDir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), String(process.pid))
      return { state: 'acquired' }
    } catch {
      const pid = Number(readPointerFile(join(lockDir, 'pid')))
      const alive =
        Number.isFinite(pid) &&
        pid > 0 &&
        (() => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        })()
      if (alive) return { state: 'held', byPid: pid }
      rmSync(lockDir, { recursive: true, force: true })
    }
  }
  return { state: 'held', byPid: null }
}

export function releaseUpdateLock(roots: LayoutRoots): void {
  const lockDir = join(roots.versionsDir, '.update.lock')
  const pid = Number(readPointerFile(join(lockDir, 'pid')))
  if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) return
  rmSync(lockDir, { recursive: true, force: true })
}


export interface SweepReport {
  removed: string[]
  restored: string[]
}

export function sweepUpdaterResidue(roots: LayoutRoots): SweepReport {
  const report: SweepReport = { removed: [], restored: [] }
  let entries: string[]
  try {
    entries = readdirSync(roots.versionsDir)
  } catch {
    return report
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (const entry of entries) {
    const m = /^\.(?:download-(\d+)|staging-.+-(\d+)|replaced-(.+)-(\d+))$/.exec(entry)
    const tmp = /^(?:current|previous)\.txt\.tmp\.(\d+)$/.exec(entry)
    if (!m && !tmp) continue
    const pid = Number(m ? (m[1] ?? m[2] ?? m[4]) : tmp![1])
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue
    const full = join(roots.versionsDir, entry)
    if (m?.[3] !== undefined) {
      const versionDir = join(roots.versionsDir, m[3])
      if (!existsSync(versionDir)) {
        try {
          renameSync(full, versionDir)
          report.restored.push(entry)
          continue
        } catch {
          continue
        }
      }
    }
    rmSync(full, { recursive: true, force: true })
    report.removed.push(entry)
  }
  return report
}


export type PayloadCheck =
  | { state: 'ok'; version: string; launcher: string; bundle: string; descriptor: PayloadDescriptor }
  | { state: 'invalid'; note: string }

const dirMembers = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function validatePayloadDir(dir: string): PayloadCheck {
  const members = dirMembers(dir)
  if (!existsSync(join(dir, 'manifest.json'))) return { state: 'invalid', note: `no manifest.json in ${dir}` }
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  } catch (e) {
    return { state: 'invalid', note: `manifest.json unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }
  const described = describePayload(manifest, members)
  if (described.state !== 'ok') return { state: 'invalid', note: described.note }
  const descriptor = described.descriptor
  if (!existsSync(join(dir, descriptor.primary))) {
    return { state: 'invalid', note: `declared primary ${descriptor.primary} is absent from ${dir}` }
  }
  if (!existsSync(join(dir, 'vendor', 'ripgrep'))) return { state: 'invalid', note: 'vendor/ripgrep missing from the payload' }
  const runtime = readRuntimeRecord(manifest)
  if (runtime?.vendored) {
    const carried = checkVendoredRuntime(dir, runtime)
    if (carried.state !== 'ok') return { state: 'invalid', note: `vendored runtime missing from the payload: ${carried.note}` }
  }
  const posixLauncher = join(dir, 'mercury')
  const winLauncher = join(dir, 'mercury.cmd')
  const launcher = existsSync(posixLauncher) ? posixLauncher : existsSync(winLauncher) ? winLauncher : null
  if (!launcher)
    return {
      state: 'invalid',
      note: 'no release launcher beside the bundle — this is a build tree, not an extracted release archive',
    }
  return { state: 'ok', version: descriptor.version, launcher, bundle: descriptor.primary, descriptor }
}

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

function walkPayloadFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...walkPayloadFiles(full, rel))
    else out.push(rel)
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function payloadDigestOf(dir: string): string {
  const h = createHash('sha256')
  for (const rel of walkPayloadFiles(dir)) {
    if (rel === 'manifest.json') continue
    h.update(`${rel}\n${sha256File(join(dir, rel))}\n`)
  }
  return h.digest('hex')
}

export type InstallOutcome =
  | { state: 'installed'; versionDir: string; changed: true }
  | { state: 'already-installed'; versionDir: string; changed: false }
  | { state: 'failed'; note: string; retryable?: boolean }

export function installPayload(roots: LayoutRoots, payloadDir: string, version: string, onStage?: () => void): InstallOutcome {
  const versionDir = join(roots.versionsDir, version)
  mkdirSync(roots.versionsDir, { recursive: true })

  if (existsSync(versionDir)) {
    try {
      if (payloadDigestOf(versionDir) === payloadDigestOf(payloadDir)) {
        return { state: 'already-installed', versionDir, changed: false }
      }
    } catch {
    }
  }

  const staging = join(roots.versionsDir, `.staging-${version}-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  let displaced: string | null = null
  try {
    onStage?.()
    cpSync(payloadDir, staging, { recursive: true })
    const check = validatePayloadDir(staging)
    if (check.state !== 'ok') {
      rmSync(staging, { recursive: true, force: true })
      return { state: 'failed', note: `staged copy incomplete: ${check.note}` }
    }
    if (!roots.isWindows) {
      chmodSync(join(staging, 'mercury'), 0o755)
      if (existsSync(join(staging, 'install.sh'))) chmodSync(join(staging, 'install.sh'), 0o755)
      const carried = payloadVendoredRuntime(staging)
      if (carried !== null) chmodSync(carried.binaryPath, 0o755)
    }
    if (existsSync(versionDir)) {
      displaced = join(roots.versionsDir, `.replaced-${version}-${process.pid}`)
      rmSync(displaced, { recursive: true, force: true })
      renameWithRetry(versionDir, displaced, 'displace-rename', roots.isWindows)
    }
    try {
      renameWithRetry(staging, versionDir, 'promote-rename', roots.isWindows)
    } catch (promoteErr) {
      rmSync(staging, { recursive: true, force: true })
      const promoteNote = promoteErr instanceof Error ? promoteErr.message.slice(0, 200) : String(promoteErr)
      const retryable = isTransientFsCode((promoteErr as NodeJS.ErrnoException).code)
      if (displaced && !existsSync(versionDir)) {
        try {
          if (injectFault('restore-rename')) {
            throw new Error('injected restore-rename failure')
          }
          renameSync(displaced, versionDir)
        } catch (restoreErr) {
          return {
            state: 'failed',
            retryable,
            note:
              `promote rename failed (${promoteNote}) AND the displaced working copy could not be restored — ` +
              `it is parked at ${displaced}; move it back to ${versionDir} to recover ` +
              `(${restoreErr instanceof Error ? restoreErr.message.slice(0, 120) : String(restoreErr)})`,
          }
        }
      }
      return {
        state: 'failed',
        retryable,
        note: `promote rename failed (${promoteNote}); the previous working copy was restored${retryable ? ' — retry `mercury update`' : ''}`,
      }
    }
    if (displaced) rmSync(displaced, { recursive: true, force: true })
    return { state: 'installed', versionDir, changed: true }
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    const code = (e as NodeJS.ErrnoException).code
    return { state: 'failed', retryable: isTransientFsCode(code) || undefined, note: e instanceof Error ? e.message : String(e) }
  }
}

export function listInstalledVersions(roots: LayoutRoots): string[] {
  let entries: string[]
  try {
    entries = readdirSync(roots.versionsDir)
  } catch {
    return []
  }
  return entries
    .filter(e => parsePrivateVersion(e) !== null)
    .filter(e => {
      try {
        return statSync(join(roots.versionsDir, e)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .reverse()
}

export function versionDirIntact(roots: LayoutRoots, version: string): boolean {
  return validatePayloadDir(join(roots.versionsDir, version)).state === 'ok'
}


export const SHIM_MARKER_FAMILY = 'mercury-managed-shim'
export const SHIM_MARKER = `${SHIM_MARKER_FAMILY} v3`

export function shimContent(isWindows: boolean): string {
  if (isWindows) {
    return [
      '@echo off',
      `rem ${SHIM_MARKER} — the stable Mercury command.`,
      'rem Written by `mercury install`; updates switch versions\\current.txt,',
      'rem never this file. Manual recovery: edit current.txt (one line).',
      'setlocal',
      'rem the root mirrors the runtime resolution exactly (prove-install-layout',
      'rem asserts the chain): MERCURY_VERSIONS_DIR pins the versions root; else',
      'rem the config home resolves MERCURY_CONFIG_DIR > MERCURY_HOME >',
      'rem ~/.mercury, and the root is <home>\\versions.',
      'set "MROOT="',
      'if defined MERCURY_VERSIONS_DIR set "MROOT=%MERCURY_VERSIONS_DIR%"',
      'if defined MROOT goto haveroot',
      'set "MHOME="',
      'if defined MERCURY_CONFIG_DIR set "MHOME=%MERCURY_CONFIG_DIR%"',
      'if not defined MHOME if defined MERCURY_HOME set "MHOME=%MERCURY_HOME%"',
      'if not defined MHOME set "MHOME=%USERPROFILE%\\.mercury"',
      'set "MROOT=%MHOME%\\versions"',
      ':haveroot',
      'if not exist "%MROOT%\\current.txt" (',
      '  echo mercury: no managed install at %MROOT% — run `mercury install` from an extracted release archive 1>&2',
      '  exit /b 1',
      ')',
      'rem VP-01: current.txt is the ONE hand-editable recovery',
      'rem file, so it crosses into command construction under the recorded class',
      'rem law: FIRST LINE ONLY (for /f never carries an embedded newline into',
      'rem %MVER% the way set /p could), then an existence check that turns',
      'rem any malformed pointer into a concise refusal instead of a batch',
      'rem parse abort. Blank leading lines are skipped by for /f — recovery-',
      'rem friendly. A pointer that names no installed version fails plainly.',
      'set "MVER="',
      'for /f "usebackq delims=" %%v in ("%MROOT%\\current.txt") do if not defined MVER set "MVER=%%v"',
      'if not defined MVER (',
      '  echo mercury: %MROOT%\\current.txt is empty — run `mercury update`, or set it to an installed version directory name 1>&2',
      '  exit /b 1',
      ')',
      'rem FC-021: the pointer is a version directory NAME, never a path.',
      'rem Quotes are STRIPPED first (a quoted pointer aborted the parser raw);',
      'rem then any separator or dot-dot refuses BEFORE the call — a pointer',
      'rem of ..\\outside\\evil executed a launcher outside the versions root.',
      'rem Substring tests only; the refusal never echoes the content.',
      'set "MVER=%MVER:"=%"',
      'rem FC-055: trailing spaces on the pointer made the shim refuse a',
      'rem version update --status called healthy — the status read trims,',
      'rem the batch read kept them. Trim trailing spaces/tabs to agree.',
      ':trimver',
      'if "%MVER:~-1%"==" " set "MVER=%MVER:~0,-1%" & goto trimver',
      'if "%MVER:~-1%"=="\t" set "MVER=%MVER:~0,-1%" & goto trimver',
      'set "MBAD="',
      'if not "%MVER:\\=%"=="%MVER%" set "MBAD=1"',
      'if not "%MVER:/=%"=="%MVER%" set "MBAD=1"',
      'if not "%MVER:..=%"=="%MVER%" set "MBAD=1"',
      'if defined MBAD (',
      '  echo mercury: current.txt must hold a version directory name, not a path — edit it to an installed version directory name 1>&2',
      '  exit /b 1',
      ')',
      'rem the refusal deliberately does NOT echo the pointer content — a',
      'rem hand-edited value could carry cmd metacharacters into the echo.',
      'if not exist "%MROOT%\\%MVER%\\mercury.cmd" (',
      '  echo mercury: current.txt does not name an installed version under %MROOT% — edit it to an installed version directory name 1>&2',
      '  exit /b 1',
      ')',
      'call "%MROOT%\\%MVER%\\mercury.cmd" %*',
      'exit /b %ERRORLEVEL%',
    ].join('\r\n') + '\r\n'
  }
  return `#!/bin/sh
# ${SHIM_MARKER} — the stable Mercury command.
# Written by \`mercury install\`; updates and rollbacks switch
# <versions>/current.txt, never this file. Manual recovery: edit
# current.txt (one line: the active version directory name).
# The root mirrors the runtime resolution exactly (prove-install-layout
# asserts the chain): MERCURY_VERSIONS_DIR pins the versions root; else the
# config home resolves MERCURY_CONFIG_DIR > MERCURY_HOME > ~/.mercury, and
# the root is <home>/versions.
if [ -n "\${MERCURY_VERSIONS_DIR:-}" ]; then root="$MERCURY_VERSIONS_DIR"
else
  if [ -n "\${MERCURY_CONFIG_DIR:-}" ]; then home="$MERCURY_CONFIG_DIR"
  elif [ -n "\${MERCURY_HOME:-}" ]; then home="$MERCURY_HOME"
  else home="$HOME/.mercury"
  fi
  root="$home/versions"
fi
if [ ! -f "$root/current.txt" ]; then
  echo "mercury: no managed install at $root — run "'\`mercury install\`'" from an extracted release archive" >&2
  exit 1
fi
# VP-01 parity: current.txt is the ONE hand-editable recovery
# file — FIRST LINE ONLY (read -r; a multi-line edit can never garble the
# exec path), and an empty pointer refuses plainly.
# F2/D4: the first NON-BLANK line (parity with cmd's for /f
# blank-skip — a leading blank routed into the empty-refusal branch).
ver=""
while IFS= read -r ver; do [ -n "$ver" ] && break; done < "$root/current.txt"
# FC-055: IFS= deliberately keeps inner spacing, so trailing whitespace
# survives the read and refused a pointer update --status called healthy.
# Strip trailing whitespace only (parity with the cmd twin's :trimver).
ver="\${ver%"\${ver##*[![:space:]]}"}"
if [ -z "$ver" ]; then
  # D1: single-quoted segment keeps the backticks LITERAL — an interpolated
  # \`mercury update\` EXECUTED as command substitution and recursed the
  # shim unboundedly (2,373 frames in the field probe).
  echo "mercury: $root/current.txt is empty — run "'\`mercury update\`'", or set it to an installed version directory name" >&2
  exit 1
fi
# FC-021 parity: the pointer is a version directory NAME, never a path — a
# separator or dot-dot walked the exec outside the versions root (confirmed
# live: ../outside/evil executed). Refuse before any path is built; the
# refusal never echoes the content (the recorded metacharacter law).
case "$ver" in
  */*|*\\*|*..*|*'"'*)
    echo "mercury: current.txt must hold a version directory name, not a path — edit it to an installed version directory name" >&2
    exit 1
    ;;
esac
# D3: the version-dir guard (parity with the cmd shim's plain refusal —
# an unguarded exec died raw with 'No such file', exit 127).
if [ ! -f "$root/$ver/mercury.cmd" ] && [ ! -f "$root/$ver/mercury" ]; then
  echo "mercury: current.txt does not name an installed version under $root — edit it to an installed version directory name" >&2
  exit 1
fi
# 5.1b (LN-07): ONE delegation text serves the POSIX shim AND the win32
# git-bash facade — the versioned cmd launcher wins where it exists (MSYS
# bridges .cmd through cmd.exe, preserving args/exit/Ctrl-C), else the
# POSIX launcher. No second version selection anywhere.
if [ -f "$root/$ver/mercury.cmd" ]; then exec "$root/$ver/mercury.cmd" "$@"; fi
exec "$root/$ver/mercury" "$@"
`
}

export type ShimOutcome =
  | { state: 'written'; path: string; replaced: 'nothing' | 'managed-shim' | 'foreign-file'; backupPath?: string }
  | { state: 'refused-foreign'; path: string; note: string }
  | { state: 'current'; path: string }

export interface ShimSetOutcome {
  members: ShimOutcome[]
  complete: boolean
}

function writeOneShim(path: string, desired: string, executable: boolean, isWindows: boolean, opts: { force?: boolean }): ShimOutcome {
  let existing: string | null = null
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = null
  }
  if (existing === desired) return { state: 'current', path }
  let replaced: 'nothing' | 'managed-shim' | 'foreign-file' = 'nothing'
  let backupPath: string | undefined
  if (existing !== null) {
    const managed = existing.includes(SHIM_MARKER_FAMILY)
    if (!managed && !opts.force) {
      return {
        state: 'refused-foreign',
        path,
        note: 'an existing non-Mercury-managed command is already at this path — rerun with --force to replace it (a .bak copy is kept), or invoke the versioned launcher directly',
      }
    }
    replaced = managed ? 'managed-shim' : 'foreign-file'
    if (!managed) {
      backupPath = `${path}.bak`
      cpSync(path, backupPath)
    }
  }
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, desired)
  if (executable) chmodSync(tmp, 0o755)
  renameWithRetry(tmp, path, 'shim-rename', isWindows)
  return { state: 'written', path, replaced, backupPath }
}

function shimMemberContent(path: string, isWindows: boolean): { text: string; executable: boolean } {
  const isCmd = path.toLowerCase().endsWith('.cmd')
  if (isWindows && isCmd) return { text: shimContent(true), executable: false }
  return { text: shimContent(false), executable: true }
}

function shimSetPathsOf(roots: LayoutRoots): string[] {
  if (roots.shimSetPaths && roots.shimSetPaths.length > 0) return roots.shimSetPaths
  return roots.isWindows ? [roots.shimPath, join(dirname(roots.shimPath), 'mercury')] : [roots.shimPath]
}

export function writeShimSet(roots: LayoutRoots, opts: { force?: boolean } = {}): ShimSetOutcome {
  mkdirSync(roots.binDir, { recursive: true })
  const members: ShimOutcome[] = []
  for (const path of shimSetPathsOf(roots)) {
    const { text, executable } = shimMemberContent(path, roots.isWindows)
    members.push(writeOneShim(path, text, executable, roots.isWindows, opts))
  }
  return { members, complete: members.every(m => m.state === 'written' || m.state === 'current') }
}

export function writeShim(roots: LayoutRoots, opts: { force?: boolean } = {}): ShimOutcome & { set: ShimSetOutcome } {
  const set = writeShimSet(roots, opts)
  const primary = set.members[0] ?? { state: 'refused-foreign' as const, path: roots.shimPath, note: 'empty launcher set' }
  return { ...primary, set }
}

export function shimStatus(roots: LayoutRoots): 'absent' | 'managed' | 'foreign' {
  try {
    const existing = readFileSync(roots.shimPath, 'utf8')
    return existing.includes(SHIM_MARKER_FAMILY) ? 'managed' : 'foreign'
  } catch {
    return 'absent'
  }
}

export function reconcileManagedShims(
  roots: LayoutRoots = resolveLayoutRoots(),
): ShimSetOutcome | null {
  try {
    if (readCurrentVersion(roots) === null) return null
    return writeShimSet(roots)
  } catch {
    return null
  }
}


export type SmokeOutcome = { state: 'ok'; printed: string } | { state: 'failed'; note: string }

export function smokeVersion(dir: string, expectedVersion: string, primaryBundle?: string): SmokeOutcome {
  const validated = primaryBundle ? null : validatePayloadDir(dir)
  const bundle = primaryBundle ?? (validated?.state === 'ok' ? validated.bundle : resolveBundleMember(dirMembers(dir)))
  if (!bundle) {
    return { state: 'failed', note: `no runtime bundle (${BUNDLE_MEMBER_NAMES.join(' | ')}) in ${dir}` }
  }
  const node = payloadVendoredRuntime(dir)?.binaryPath ?? process.execPath
  try {
    const printed = execFileSync(node, [join(dir, bundle), '--version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...subprocessEnv() },
    }).trim()
    if (!printed.includes(expectedVersion)) {
      return { state: 'failed', note: `--version printed "${printed}" (expected ${expectedVersion})` }
    }
    return { state: 'ok', printed }
  } catch (e) {
    return { state: 'failed', note: e instanceof Error ? e.message.slice(0, 300) : String(e) }
  }
}


export interface UninstallReport {
  removedVersionsDir: boolean
  removedShim: boolean
  removedSetMembers: string[]
  preservedForeign: string[]
  preservedConfigHome: string
}

export function uninstallLayout(roots: LayoutRoots): UninstallReport {
  const hadVersions = existsSync(roots.versionsDir)
  if (hadVersions) removeWithRetry(roots.versionsDir, 'uninstall-rm', roots.isWindows)
  const removedSetMembers: string[] = []
  const preservedForeign: string[] = []
  for (const path of shimSetPathsOf(roots)) {
    try {
      const existing = readFileSync(path, 'utf8')
      if (existing.includes(SHIM_MARKER_FAMILY)) {
        removeWithRetry(path, 'uninstall-rm', roots.isWindows)
        removedSetMembers.push(path)
      } else {
        preservedForeign.push(path)
      }
    } catch {
    }
  }
  const removedShim = removedSetMembers.includes(roots.shimPath)
  return { removedVersionsDir: hadVersions, removedShim, removedSetMembers, preservedForeign, preservedConfigHome: getMercuryHome() }
}

export function formatUninstallReport(roots: LayoutRoots, report: UninstallReport): string {
  const lines = [report.removedVersionsDir ? `removed: ${roots.versionsDir}` : `nothing to remove at ${roots.versionsDir}`]
  for (const path of shimSetPathsOf(roots)) {
    if (report.removedSetMembers.includes(path)) lines.push(`removed: ${path}`)
    else if (report.preservedForeign.includes(path)) lines.push(`preserved (not a Mercury-managed command — left as found): ${path}`)
    else lines.push(`nothing to remove at ${path} (absent)`)
  }
  lines.push(`preserved: ${report.preservedConfigHome} (configuration, sessions, extensions — uninstalling never deletes user state)`)
  return lines.join('\n')
}

export function runningPayloadDir(): string {
  return dirname(process.argv[1] ?? '')
}
