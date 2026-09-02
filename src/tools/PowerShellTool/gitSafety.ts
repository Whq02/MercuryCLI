import { getCwd } from '../../utils/cwd.js'
import { basename, posix as posixPath } from 'node:path'

const PS_DASH = /[-–—―]/

function normalisePath(raw: string): string {
  let value = raw
  if ((PS_DASH.test(value[0] ?? '') || value[0] === '/')) {
    const colon = value.indexOf(':', 1)
    if (colon !== -1) value = value.slice(colon + 1)
  }
  if (/^['"]/.test(value)) value = value.slice(1)
  if (/['"]$/.test(value)) value = value.slice(0, -1)
  value = value.replace(/`/g, '')
  value = value.replace(/^(?:[\w.]+\\){0,3}FileSystem::/i, '')
  value = value.replace(/^[A-Za-z]:(?![\\/])/, '')
  value = value.replace(/\\/g, '/')
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
  value = posixNormalise(value).replace(/^\.\//, '').toLowerCase()
  return value
}

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

function matchesGitInternal(path: string): boolean {
  if (path === 'head') return true
  if (path === '.git' || path.startsWith('.git/')) return true
  if (/^git~\d+(?:\/|$)/.test(path)) return true
  if (/^(?:objects|refs|hooks)(?:\/|$)/.test(path)) return true
  return false
}

export function isGitInternalPathPS(arg: string): boolean {
  const normalised = normalisePath(arg)
  const reentered = resolveCurrentDirectoryReentry(normalised)
  if (matchesGitInternal(reentered)) return true
  const escaped = resolveEscapingPath(normalised)
  if (escaped !== null && matchesGitInternal(escaped)) return true
  return false
}

export function isDotGitPathPS(arg: string): boolean {
  const normalised = normalisePath(arg)
  const reentered = resolveCurrentDirectoryReentry(normalised)
  const check = (p: string): boolean => p === '.git' || p.startsWith('.git/') || /^git~\d+(?:\/|$)/.test(p)
  if (check(reentered)) return true
  const escaped = resolveEscapingPath(normalised)
  return escaped !== null && check(escaped)
}
