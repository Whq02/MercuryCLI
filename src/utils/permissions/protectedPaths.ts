import { homedir } from 'node:os'
import { posix, resolve } from 'node:path'
import { getCwd } from '../cwd.js'
import { defaultMercuryHome, getAuthScope, getMercuryHome } from '../envUtils.js'
import { getPathsForPermissionCheck } from '../fsOperations.js'

export function spelling(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  const profile = process.env.USERPROFILE || home
  return path.trim().replace(/\\/g, '/')
    .replace(/^~(?=\/|$)/, home.replace(/\\/g, '/'))
    .replace(/^(?:\$\{HOME\}|\$HOME|%HOME%)(?=\/|$)/i, home.replace(/\\/g, '/'))
    .replace(/^(?:%USERPROFILE%|\$\{?(?:env:)?USERPROFILE\}?)(?=\/|$)/i, profile.replace(/\\/g, '/'))
    .replace(/^(?:\$\{MERCURY_CONFIG_DIR\}|\$MERCURY_CONFIG_DIR|%MERCURY_CONFIG_DIR%|\$env:MERCURY_CONFIG_DIR)(?=\/|$)/i, getMercuryHome().replace(/\\/g, '/'))
    .replace(/^\/(?:mnt\/)?([a-z])\//i, '$1:/')
}

function comparable(path: string): string {
  return posix.normalize(spelling(path)).replace(/\/$/, '').normalize('NFC').toLowerCase()
}

export function protectedPathForms(path: string, cwd = getCwd()): string[] {
  const expanded = spelling(path)
  const absolute = expanded.startsWith('/') || /^[a-z]:\//i.test(expanded) ? expanded : resolve(cwd, expanded)
  return [...new Set(getPathsForPermissionCheck(absolute).map(comparable))]
}

const HOME_TREES = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gh', '.config/gcloud', 'library/keychains', '.local/share/keyrings']
const HOME_FILES = ['.netrc', '.pgpass', '.npmrc', '.pypirc', '.git-credentials']
const SYSTEM_TREES = ['/etc/sudoers.d', '/etc/systemd', '/library/keychains']
const SYSTEM_FILES = ['/etc/sudoers', '/etc/passwd', '/etc/shadow']
const inside = (path: string, base: string): boolean => path === base || path.startsWith(base + '/')

export function credentialStorePath(path: string, cwd = getCwd()): string | null {
  const own = mercurySecretPath(path, cwd)
  if (own !== null) return own
  const homes = [process.env.HOME, process.env.USERPROFILE, homedir()].filter((p): p is string => !!p).flatMap(p => protectedPathForms(p, cwd))
  for (const candidate of protectedPathForms(path, cwd)) {
    const system = candidate.replace(/^\/private\/etc(?=\/|$)/, '/etc')
    if (SYSTEM_FILES.includes(system) || SYSTEM_TREES.some(base => inside(system, base))) return candidate
    const conventional = candidate.match(/^(?:\/(?:users|home)\/[^/]+|\/root|[a-z]:\/users\/[^/]+)(?=\/|$)/)?.[0]
    for (const home of conventional ? [...homes, conventional] : homes) {
      if (HOME_FILES.some(file => candidate === `${home}/${file}`) || HOME_TREES.some(dir => inside(candidate, `${home}/${dir}`))) return candidate
    }
  }
  return null
}

const MERCURY_SECRET_PATTERNS = ['.credentials.json', '.provider-secrets.json', '*-auth.json', 'browser-secrets.json', '.credentials.json.corrupt.*', '.provider-secrets.json.corrupt.*']

export function mercurySecretReadIgnores(): Map<string, string[]> {
  return new Map([getMercuryHome(), getAuthScope(), defaultMercuryHome()].filter((path): path is string => !!path)
    .flatMap(home => getPathsForPermissionCheck(spelling(home)).map(path => [path, MERCURY_SECRET_PATTERNS] as [string, string[]])))
}

export function mercurySecretPath(path: string, cwd = getCwd()): string | null {
  const trimmed = path.trim()
  let target = trimmed
  if (/^mercury:\/\/file\//i.test(trimmed)) {
    const raw = trimmed.slice('mercury://file/'.length).split('?')[0]!
    try { target = decodeURIComponent(raw) } catch { target = raw }
  }
  const plain = target.replace(/:[-\d+,]+$/, '')
  const homes = [...mercurySecretReadIgnores().keys()].map(comparable)
  for (const candidate of protectedPathForms(plain, cwd)) {
    const parent = posix.dirname(candidate)
    const name = posix.basename(candidate)
    const conventional = /^(?:\/(?:users|home)\/[^/]+|\/root|[a-z]:\/users\/[^/]+)\/\.mercury$/.test(parent)
    if (!conventional && !homes.includes(parent)) continue
    if (/^(?:\.credentials\.json|\.provider-secrets\.json)(?:\.corrupt\.[^/]+)?$/.test(name) || /^.+-auth\.json$/.test(name) || name === 'browser-secrets.json') return candidate
  }
  return null
}
