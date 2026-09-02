import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { existsSync, writeSync } from 'node:fs'
import { dirname, resolve, sep, win32 as pathWin32 } from 'node:path'

import memoize from 'lodash-es/memoize.js'

import { releaseLauncherAltHoldNow } from '../ink/launcherAltHold.js'

import { logForDebugging } from './debug.js'
import { memoizeWithLRU } from './memoize.js'

/**
 * Windows git/git-bash discovery plus pure Windows-POSIX path conversion.
 */

/**
 * Filesystem-only existence probe; any throw is false. Never a subprocess:
 * a process start per probe is orders of magnitude more expensive, and a
 * command-string subprocess mis-answers for directories whose names carry
 * quoting or shell-special characters.
 */
function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate)
  } catch {
    return false
  }
}

/**
 * Ordered executable candidates on Windows. PATH is authoritative and is
 * consulted FIRST; only then (and only for git) the classic install
 * locations are appended, 64-bit ahead of 32-bit. The ordering is not
 * cosmetic: probing fixed locations ahead of PATH overtook package-manager
 * and portable installs with a stale Program Files copy — a real release
 * gate failure. The MinGW-subtree copy of git is deliberately not a
 * candidate (bare tools without their expected environment).
 */
function findExecutableCandidates(name: string): string[] {
  const candidates: string[] = []
  try {
    const result = spawnSync('where.exe', [name], {
      windowsHide: true,
      encoding: 'utf8',
      // Every Windows boot walks this before first paint; a PATH entry on a
      // disconnected mapped drive must cost seconds, never a dead console.
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...subprocessEnv() },
    })
    if (result.status === 0 && result.stdout) {
      const cwdLower = process.cwd().toLowerCase()
      // Split on the literal CRLF pair, never a lone LF.
      for (const line of result.stdout.split('\r\n')) {
        if (line === '') continue
        // Security filter: an executable of the target name dropped into
        // the project directory (.bat/.cmd/.exe) must never be selected.
        const resolved = resolve(line)
        const resolvedLower = resolved.toLowerCase()
        if (dirname(resolved).toLowerCase() === cwdLower || resolvedLower.startsWith(cwdLower + sep)) {
          logForDebugging(`windowsPaths: skipping ${resolved} (inside the working directory)`)
          continue
        }
        candidates.push(line)
      }
    }
  } catch {
    // where.exe unavailable — continue with the fixed locations.
  }
  if (name === 'git') {
    for (const classic of [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ]) {
      if (pathExists(classic)) candidates.push(classic)
    }
  }
  return candidates
}

/**
 * PURE derivation of every bash.exe location a list of git.exe candidates
 * implies, in candidate order, deduplicated case-insensitively — no
 * filesystem access and no platform branch, so it is testable on any host.
 *
 * Each git path contributes a sibling probe (two levels up, then
 * bin\bash.exe) and an install-root probe (when git sits in a `bin` whose
 * parent is mingw64/mingw32/usr, the root is that parent's parent; else
 * the holder's parent). The install-root probe is what survives an
 * MSYS-flavoured PATH, where the MinGW copy is ordered first and its
 * sibling derivation points at a directory with no bash at all — the
 * resolver walks the WHOLE list rather than giving up at the head.
 */
export function gitBashCandidatePaths(gitPaths: string[]): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []
  const push = (candidate: string): void => {
    const key = candidate.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }
  for (const gitPath of gitPaths) {
    push(pathWin32.join(pathWin32.dirname(pathWin32.dirname(gitPath)), 'bin', 'bash.exe'))
    const holder = pathWin32.dirname(gitPath)
    const holderName = pathWin32.basename(holder).toLowerCase()
    const parent = pathWin32.dirname(holder)
    const parentName = pathWin32.basename(parent).toLowerCase()
    const installRoot =
      holderName === 'bin' && (parentName === 'mingw64' || parentName === 'mingw32' || parentName === 'usr')
        ? pathWin32.dirname(parent)
        : parent
    push(pathWin32.join(installRoot, 'bin', 'bash.exe'))
  }
  // Classic install roots as a last resort.
  push('C:\\Program Files\\Git\\bin\\bash.exe')
  push('C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  return candidates
}

/**
 * Memoized git-bash resolver; exits the process when nothing is found.
 * `MERCURY_GIT_BASH_PATH` overrides discovery.
 */
export const findGitBashPath = memoize((): string => {
  const override = process.env.MERCURY_GIT_BASH_PATH
  if (override !== undefined && override !== '') {
    if (pathExists(override)) return override
    // Release the launcher's alt-screen hold BEFORE the refusal prints: on a
    // launcher boot the splash handed over with MERCURY_ALT_HELD=1 and no
    // AlternateScreen has consumed it yet, so these bytes landed on the
    // ALTERNATE buffer — which the module's own exit net then discarded with
    // ?1049l, leaving exit 1 and a blank prompt with the install guidance
    // gone (TASK-017 S2, gitbash-refusal-painted-into-discarded-alt-buffer;
    // main.tsx's writeErr is the same pattern). Idempotent, no-op unheld.
    releaseLauncherAltHoldNow()
    // writeSync, never the stream: Node's TTY writes are ASYNC on win32 and
    // process.exit can discard the queued bytes — this refusal is the ONLY
    // thing the operator sees before Mercury declines to start, and a blank
    // exit 1 explains nothing (the failLoud discipline; TASK-017 S1).
    try {
      writeSync(2, `Error: unable to find MERCURY_GIT_BASH_PATH at ${override} — the path does not exist.\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(1)
  }
  for (const candidate of gitBashCandidatePaths(findExecutableCandidates('git'))) {
    if (pathExists(candidate)) return candidate
  }
  // Same hold-release-before-print law as the override arm above — this is
  // the field-proven fresh-install foot-gun's one message.
  releaseLauncherAltHoldNow()
  try {
    writeSync(
      2,
      'Error: Mercury on Windows requires git-bash. Download it from https://git-scm.com/downloads/win — ' +
        'if it is already installed but not on PATH, set MERCURY_GIT_BASH_PATH=<path to your bash.exe> ' +
        '(for example C:\\Program Files\\Git\\bin\\bash.exe).\n',
    )
  } catch {
    /* a closed fd must not mask the exit */
  }
  process.exit(1)
})

/** Windows only: point SHELL at git-bash. COMSPEC is deliberately untouched (system process execution uses it). */
export function setShellIfWindows(): void {
  if (process.platform !== 'win32') return
  const bashPath = findGitBashPath()
  process.env.SHELL = bashPath
  logForDebugging(`windowsPaths: SHELL set to ${bashPath}`)
}

/**
 * Windows → POSIX: UNC `\\server\share` becomes `//server/share`; a
 * drive-letter path (separator required right after the colon — a bare
 * `C:` or relative `C:foo` falls through) becomes `/<lowercase drive>/…`;
 * anything else has its backslashes flipped.
 */
export const windowsPathToPosixPath = memoizeWithLRU(
  (windowsPath: string): string => {
    if (windowsPath.startsWith('\\\\')) {
      return `//${windowsPath.slice(2).replace(/\\/g, '/')}`
    }
    const driveMatch = windowsPath.match(/^([A-Za-z]):([\\/])(.*)$/s)
    if (driveMatch) {
      const drive = (driveMatch[1] as string).toLowerCase()
      const rest = (driveMatch[3] as string).replace(/\\/g, '/')
      return `/${drive}/${rest}`
    }
    return windowsPath.replace(/\\/g, '/')
  },
  windowsPath => windowsPath,
  500,
)

/**
 * The Bash tool's directory record, read back on Windows. The provider
 * writes the shell's final directory as `pwd -P` (POSIX) and, under git-bash,
 * a second line with the shell's OWN Win32 spelling (`pwd -W`). The shell's
 * answer wins: it alone can place an MSYS virtual root (/tmp, /usr/local,
 * /etc, /mingw64/bin) — the converter below has no mount table, and its
 * slash-flip of such a path came out DRIVE-RELATIVE (\tmp), which node's
 * win32 isAbsolute accepts and resolves against the process drive, so a
 * cd into /tmp moved the session to a real but wrong folder when C:\tmp
 * existed and was dropped silently when it did not (FN-015 rank 45).
 * Without the second line the POSIX line converts, and a drive-relative
 * result is REFUSED with the reason named: the session directory stays put.
 */
export function nativeCwdFromShellRecord(record: string): { path: string } | { refused: string } {
  const lines = record
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  const posix = lines[0]
  if (posix === undefined) return { refused: 'the shell recorded no directory (the command may have died before writing it)' }
  const native = lines[1]
  if (native !== undefined) return { path: posixPathToWindowsPath(native) }
  const converted = posixPathToWindowsPath(posix)
  if (/^\\(?!\\)/.test(converted)) {
    return {
      refused: `${posix} is an MSYS virtual root the converter cannot place (it would become the drive-relative ${converted}); the shell's own Win32 spelling (pwd -W) was not recorded`,
    }
  }
  return { path: converted }
}

/**
 * POSIX → Windows: `//server/share` becomes `\\server\share`; a
 * `/cygdrive/<letter>` or MSYS `/<letter>/` prefix becomes an uppercase
 * drive; anything else has its slashes flipped. An otherwise-empty
 * drive-letter remainder becomes a single backslash.
 */
export const posixPathToWindowsPath = memoizeWithLRU(
  (posixPath: string): string => {
    if (posixPath.startsWith('//')) {
      return `\\\\${posixPath.slice(2).replace(/\//g, '\\')}`
    }
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/.*)?$/s)
    if (cygdriveMatch) {
      const rest = (cygdriveMatch[2] ?? '').replace(/\//g, '\\')
      return `${(cygdriveMatch[1] as string).toUpperCase()}:${rest === '' ? '\\' : rest}`
    }
    const msysMatch = posixPath.match(/^\/([A-Za-z])(\/.*)?$/s)
    if (msysMatch) {
      const rest = (msysMatch[2] ?? '').replace(/\//g, '\\')
      return `${(msysMatch[1] as string).toUpperCase()}:${rest === '' ? '\\' : rest}`
    }
    return posixPath.replace(/\//g, '\\')
  },
  posixPath => posixPath,
  500,
)
