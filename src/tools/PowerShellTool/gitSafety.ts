/**
 * Git-safety path recognition over raw PowerShell argument text. Git can be
 * weaponised for sandbox escape two ways: a bare-repository attack (the current
 * directory carries repository markers but no valid .git/HEAD, so git runs
 * hooks from the current directory), and a git-internal write followed by a git
 * run in one compound (the git subcommand executes freshly created hooks).
 *
 * `isGitInternalPathPS` is the sole guard for the bare-repository HEAD attack —
 * its current-directory resolution is load-bearing and must not be removed.
 */
import { getCwd } from '../../utils/cwd.js'
import { basename, posix as posixPath } from 'node:path'

/** PowerShell dash characters (ASCII dash + the Unicode alternatives). */
const PS_DASH = /[-–—―]/

/**
 * Normalise a raw PowerShell path argument (order matters). Returns the
 * normalised, lowercased, forward-slash path.
 */
function normalisePath(raw: string): string {
  let value = raw
  // 1. Colon-bound value extraction: a dash/slash prefix, then a colon after pos 0.
  if ((PS_DASH.test(value[0] ?? '') || value[0] === '/')) {
    const colon = value.indexOf(':', 1)
    if (colon !== -1) value = value.slice(colon + 1)
  }
  // 2. Strip surrounding quotes.
  if (/^['"]/.test(value)) value = value.slice(1)
  if (/['"]$/.test(value)) value = value.slice(0, -1)
  // 3. Strip all backticks.
  value = value.replace(/`/g, '')
  // 4. Strip a FileSystem provider qualification.
  value = value.replace(/^(?:[\w.]+\\){0,3}FileSystem::/i, '')
  // 5. Strip a drive-relative prefix (drive letter + colon NOT followed by a separator).
  value = value.replace(/^[A-Za-z]:(?![\\/])/, '')
  // 6. Backslashes to forward slashes.
  value = value.replace(/\\/g, '/')
  // 7. Per-component Win32 trailing-strip semantics.
  const components = value.split('/')
  const cleaned = components.map(component => {
    if (component === '' || component === '.' || component === '..') return component
    let c = component
    let prev: string
    do {
      prev = c
      c = c.replace(/[ ]+$/, '').replace(/\.+$/, '')
      if (c === '.' || c === '..') return c
    } while (c !== prev)
    return c === '' ? '.' : c
  })
  value = cleaned.join('/')
  // 8. POSIX-normalise, drop a leading `./`, lowercase.
  value = posixNormalise(value).replace(/^\.\//, '').toLowerCase()
  return value
}

/** Resolve `.`, `..`, and duplicate separators without touching the filesystem. */
function posixNormalise(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.split(posixPath.sep)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
    } else {
      out.push(segment)
    }
  }
  return (absolute ? '/' : '') + out.join('/')
}

/** Resolve a path that leaves and re-enters the current directory via its parent. */
function resolveCurrentDirectoryReentry(normalised: string): string {
  const cwdBase = basename(getCwd()).toLowerCase()
  let value = normalised
  if (value.startsWith('../')) {
    let prev: string
    do {
      prev = value
      value = value.replace(new RegExp(`^\\.\\./${escapeRe(cwdBase)}/`), '')
    } while (value !== prev)
    if (value === `../${cwdBase}`) return '.'
  }
  return value
}

/** For an escaping path, resolve it against the actual cwd; return the cwd-relative remainder or null. */
function resolveEscapingPath(normalised: string): string | null {
  if (!(normalised.startsWith('../') || normalised.startsWith('/') || /^[a-z]:/.test(normalised))) return null
  const cwd = getCwd().toLowerCase().replace(/\\/g, '/')
  const resolved = posixNormalise(cwd + '/' + normalised)
  if (resolved === cwd) return '.'
  if (resolved.startsWith(cwd + '/')) return resolved.slice(cwd.length + 1)
  return null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Git-internal prefixes (contract data). */
function matchesGitInternal(path: string): boolean {
  if (path === 'head') return true
  if (path === '.git' || path.startsWith('.git/')) return true
  if (/^git~\d+(?:\/|$)/.test(path)) return true // NTFS 8.3 short-name form
  if (/^(?:objects|refs|hooks)(?:\/|$)/.test(path)) return true
  // A per-component `head` at any position? The spec pins the exact component head
  // as the whole normalised path OR the first component of the resolved re-entry.
  return false
}

/** True when the argument names a git-internal path (the bare-repo HEAD guard). */
export function isGitInternalPathPS(arg: string): boolean {
  const normalised = normalisePath(arg)
  const reentered = resolveCurrentDirectoryReentry(normalised)
  if (matchesGitInternal(reentered)) return true
  const escaped = resolveEscapingPath(normalised)
  if (escaped !== null && matchesGitInternal(escaped)) return true
  return false
}

/** The strict variant: only `.git`, anything under `.git/`, or the NTFS short-name form. */
export function isDotGitPathPS(arg: string): boolean {
  const normalised = normalisePath(arg)
  const reentered = resolveCurrentDirectoryReentry(normalised)
  const check = (p: string): boolean => p === '.git' || p.startsWith('.git/') || /^git~\d+(?:\/|$)/.test(p)
  if (check(reentered)) return true
  const escaped = resolveEscapingPath(normalised)
  return escaped !== null && check(escaped)
}
