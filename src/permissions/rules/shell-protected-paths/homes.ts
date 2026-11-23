import { readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { posix } from 'node:path'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { defaultMercuryHome, getAuthScope, getMercuryHome } from '../../../platform/environment/envUtils.js'
import { type CommandReading, type ReadWorld, UNREAD_PART, readCommand, wordKnown } from '../decision/commandAnalysis.js'
import { mercurySecretPath, protectedPathForms, spelling } from './paths.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import { readWorldUsesWindowsForms } from '../../../platform/host-os/commandForms.js'

export const SECRET_NAME_SAMPLES = ['.credentials.json', '.provider-secrets.json', 'mcp-auth.json', 'x-auth.json', 'browser-secrets.json', '.credentials.json.corrupt.1', '.provider-secrets.json.corrupt.1']
export const CONVENTIONAL_USER_HOME = '(?:\\/(?:users|home)\\/[^/]+|\\/root|[a-z]:\\/users\\/[^/]+)'
const CONVENTIONAL_HOME = new RegExp(`^${CONVENTIONAL_USER_HOME}\\/\\.mercury$`)
export const HOLDS_CONVENTIONAL_HOME = new RegExp(`^${CONVENTIONAL_USER_HOME}$`)
const DYNAMIC_PART = /[*?[{$]/
const DRIVE_PATH = /^[A-Za-z][:|][\\/]/

function currentUser(): { user?: string; uid?: string } {
  const named = hostEnv().USER || hostEnv().LOGNAME || hostEnv().USERNAME
  try {
    const info = userInfo()
    return { user: named || info.username, uid: String(info.uid) }
  } catch {
    return named ? { user: named } : {}
  }
}

export function floorsWorld(cwd: string): ReadWorld {
  const home = (hostEnv().HOME || hostEnv().USERPROFILE || homedir()).replace(/\\/g, '/')
  return { cwd: cwd.replace(/\\/g, '/'), home, homesRoot: posix.dirname(home), ownNames: [], ...currentUser(), windows: readWorldUsesWindowsForms() }
}

let homeUnknownSaid = false

export async function readForFloors(command: string, powershell: boolean, cwd: string, returnsTo?: string): Promise<CommandReading | null> {
  let world: ReadWorld
  try {
    world = floorsWorld(cwd)
  } catch (error) {
    if (!homeUnknownSaid) {
      homeUnknownSaid = true
      logForDebugging(`shell floors: the home folder could not be told (${error instanceof Error ? error.message : String(error)}), so the credential and self-protection floors read no command`)
    }
    return null
  }
  return readCommand(command, powershell ? 'powershell' : 'posix', returnsTo === undefined ? world : { ...world, returnsTo })
}

export function mercuryHomes(): string[] {
  return [...new Set([getMercuryHome(), getAuthScope(), defaultMercuryHome()].filter((path): path is string => !!path).flatMap(path => protectedPathForms(path)))]
}

export function namesMercuryHome(word: string, cwd: string, homes: readonly string[]): boolean {
  if (word === '' || word.includes(UNREAD_PART)) return false
  return protectedPathForms(word, cwd).some(form => homes.includes(form) || CONVENTIONAL_HOME.test(form))
}

export function wildcardSource(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === UNREAD_PART) out += '.*'
    else if (ch === '$') {
      const named = /^\$(?:\{[^}]*\}|\([^)]*\)|[a-z_][a-z0-9_]*)/i.exec(pattern.slice(i))
      out += '.*'
      i += named === null ? 0 : named[0].length - 1
    } else if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
      } else out += '[^/]*'
    } else if (ch === '?') out += '[^/]'
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end < 0) out += '\\['
      else {
        out += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end > 0 && pattern.slice(i, end).includes(',')) {
        out += `(?:${pattern.slice(i + 1, end).split(',').map(wildcardSource).join('|')})`
        i = end
      } else out += '\\{'
    } else out += ch.replace(/[.+^$()|\\\]}]/g, '\\$&')
  }
  return out
}

export function secretsHeld(home: string): string[] {
  try {
    return readdirSync(home).filter(name => mercurySecretPath(`${home}/${name}`, home) !== null).map(name => name.toLowerCase())
  } catch (error) {
    passedOver(error)
    return []
  }
}

export function couldNameSecret(word: string, cwd: string, homes: readonly string[], spelledHome = false): boolean {
  if (!DYNAMIC_PART.test(word) && !word.includes(UNREAD_PART)) return false
  const expanded = spelling(word)
  const segments = expanded.split(/[\\/]/)
  const at = segments.findIndex(segment => DYNAMIC_PART.test(segment) || segment.includes(UNREAD_PART))
  if (at < 0) return false
  const fixed = segments.slice(0, at).join('/') || (expanded.startsWith('/') ? '/' : '.')
  let pattern: RegExp
  try {
    pattern = new RegExp(`^${wildcardSource(segments.slice(at).join('/').toLowerCase())}$`)
  } catch (error) {
    globNotCompiled(word, error)
    return false
  }
  for (const folder of protectedPathForms(fixed, cwd)) {
    const conventional = CONVENTIONAL_HOME.test(folder) ? [folder] : []
    for (const home of [...homes, ...conventional]) {
      if (home !== folder && (spelledHome || !home.startsWith(folder === '/' ? '/' : `${folder}/`))) continue
      const below = home === folder ? '' : `${home.slice(folder === '/' ? 1 : folder.length + 1)}/`
      for (const name of [...SECRET_NAME_SAMPLES, ...secretsHeld(home)]) if (pattern.test(below + name)) return true
    }
  }
  return false
}

export function fileUrlPaths(word: string): string[] {
  const url = /^file:(?:\/\/(?:(?:localhost|127\.0\.0\.1)(?=\/))?|(?=\/(?!\/)))([\s\S]*)$/i.exec(word)
  if (url === null || (!url[1]!.startsWith('/') && !DRIVE_PATH.test(url[1]!))) return []
  let decoded: string
  try {
    decoded = decodeURIComponent(url[1]!)
  } catch {
    decoded = url[1]!
  }
  const drive = decoded.startsWith('/') ? decoded.slice(1) : decoded
  return DRIVE_PATH.test(drive) && (drive !== decoded || drive[1] === '|') ? [decoded, `${drive[0]}:${drive.slice(2)}`] : [decoded]
}

export function spellingsOf(word: string): string[] {
  const out = [word]
  const equals = word.indexOf('=')
  if (equals > 0) out.push(word.slice(equals + 1))
  for (const candidate of [...out]) {
    const plain = candidate.startsWith('@') ? candidate.slice(1).split(';')[0]! : candidate
    if (plain !== candidate) out.push(plain)
    out.push(...fileUrlPaths(plain))
  }
  return out
}

export function underOtherHomes(word: string, homes: readonly string[]): string[] {
  if (word !== '~' && !word.startsWith('~/')) return []
  return homes.map(home => home + word.slice(1))
}

export function holdsMercuryHome(word: string, cwd: string, homes: readonly string[], hidden = true): boolean {
  if (word === '' || word.includes(UNREAD_PART)) return false
  return protectedPathForms(word, cwd).some(form => (hidden && HOLDS_CONVENTIONAL_HOME.test(form)) || homes.some(home => home.startsWith(`${form}/`) && (hidden || !home.slice(form.length).includes('/.'))))
}

export const GLOB_PART = /[*?[{]/

export function globNotCompiled(glob: string, error: unknown): void {
  logForDebugging(`shell floors: the glob ${glob} could not be compiled (${error instanceof Error ? error.message : String(error)}), so it is read as naming nothing Mercury keeps`, { level: 'warn' })
}

export function globNamesStore(word: string, cwd: string, homes: readonly string[], hidden: boolean, dotted = false): boolean {
  if (!GLOB_PART.test(word) || word.includes(UNREAD_PART)) return false
  const expanded = spelling(word)
  const segments = expanded.split(/[\\/]/)
  const at = segments.findIndex(segment => GLOB_PART.test(segment))
  if (at < 0) return false
  const fixed = segments.slice(0, at).join('/') || (expanded.startsWith('/') ? '/' : '.')
  const patterns = segments.slice(at).filter(segment => segment !== '').map(segment => segment.toLowerCase())
  let tests: RegExp[]
  try {
    tests = patterns.map(pattern => new RegExp(`^${wildcardSource(pattern)}$`))
  } catch (error) {
    globNotCompiled(word, error)
    return false
  }
  const dotLed = (pattern: string): boolean => pattern.startsWith('.') || /^\{(?:[^}]*,)?\./.test(pattern)
  for (const folder of protectedPathForms(fixed, cwd)) {
    const under = `${folder}/`
    for (const home of [...homes, ...(HOLDS_CONVENTIONAL_HOME.test(folder) ? [under + posix.basename(defaultMercuryHome().replace(/\\/g, '/')).toLowerCase()] : [])]) {
      if (!home.startsWith(under)) continue
      const below = home.slice(under.length).split(/[\\/]/)
      if (patterns.length > below.length && !dotted) continue
      if (!below.every((segment, index) => index >= patterns.length || (tests[index]!.test(segment) && (dotted || dotLed(patterns[index]!) || !segment.startsWith('.'))))) continue
      if (hidden || !below.slice(patterns.length).some(segment => segment.startsWith('.'))) return true
    }
  }
  return false
}

export const UPLOADERS = new Set(['curl', 'wget'])

export function secretNameBehindUnread(word: string, homes: readonly string[]): boolean {
  if (wordKnown(word)) return false
  const name = posix.basename(word.replace(/\\/g, '/'))
  if (name === '' || !wordKnown(name) || GLOB_PART.test(name)) return false
  return homes.some(home => mercurySecretPath(name, home) !== null)
}
