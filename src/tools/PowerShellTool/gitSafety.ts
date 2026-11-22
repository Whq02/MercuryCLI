import { getShellCwd } from '../../utils/Shell.js'
import { basename, posix as posixPath } from 'node:path'
import { notBuilt } from '../../pi/holes.js'

const PS_DASH = /[-–—―]/

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

function resolveCurrentDirectoryReentry(normalised: string): string {
  const cwdBase = basename(getShellCwd()).toLowerCase()
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

function resolveEscapingPath(normalised: string): string | null {
  if (!(normalised.startsWith('../') || normalised.startsWith('/') || /^[a-z]:/.test(normalised))) return null
  const cwd = getShellCwd().toLowerCase().replace(/\\/g, '/')
  const drive = /^[a-z]:/.exec(cwd)?.[0] ?? ''
  const resolved = posixNormalise(normalised.startsWith('../') ? `${cwd}/${normalised}` : normalised.startsWith('/') ? `${drive}${normalised}` : normalised)
  if (resolved === cwd) return '.'
  if (resolved.startsWith(cwd + '/')) return resolved.slice(cwd.length + 1)
  return null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesGitInternal(path: string): boolean {
  if (path === 'head') return true
  if (path === '.git' || path.startsWith('.git/')) return true
  if (/^git~\d+(?:\/|$)/.test(path)) return true
  if (/^(?:objects|refs|hooks)(?:\/|$)/.test(path)) return true
  return false
}

export function isGitInternalPathPS(arg: string): boolean {
  return notBuilt('src/tools/PowerShellTool/gitSafety.ts:86')
}

export function isDotGitPathPS(arg: string): boolean {
  return notBuilt('src/tools/PowerShellTool/gitSafety.ts:95')
}
