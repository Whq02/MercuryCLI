const SCHEME = /^ssh:\/\//i
const HOME_FORM = /^\/~([A-Za-z0-9._-]*)(?:\/|$)/
const CONTROL = /[\u0000-\u001f\u007f]/

export const REMOTE_RULE_ROOT = 'ssh://'

export type RemoteAuthority = { user?: string; host: string; port?: number }

export type RemoteTarget = {
  authority: RemoteAuthority
  home: string | null
  path: string
  folder: boolean
}

export type RemoteAuthorityFacts = { hostname: string; user?: string; port?: number }

export class RemotePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemotePathError'
  }
}

export function isRemotePath(value: unknown): boolean {
  return typeof value === 'string' && SCHEME.test(value.trimStart())
}

function decodeOnce(text: string, whole: string): string {
  if (!text.includes('%')) return text
  const encoder = new TextEncoder()
  const bytes: number[] = []
  for (let at = 0; at < text.length; at++) {
    const escape = text[at] === '%' ? /^[0-9A-Fa-f]{2}$/.exec(text.slice(at + 1, at + 3)) : null
    if (escape !== null) {
      bytes.push(parseInt(escape[0], 16))
      at += 2
      continue
    }
    const char = String.fromCodePoint(text.codePointAt(at)!)
    bytes.push(...encoder.encode(char))
    at += char.length - 1
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    throw new RemotePathError(`${whole} holds an escape that is not UTF-8 text.`)
  }
}

function splitAuthority(text: string): { user?: string; host: string; port?: string } {
  const at = text.lastIndexOf('@')
  const user = at === -1 ? {} : { user: text.slice(0, at) }
  const rest = at === -1 ? text : text.slice(at + 1)
  const close = rest.startsWith('[') ? rest.indexOf(']') : -1
  if (close !== -1) {
    const after = rest.slice(close + 1)
    return { ...user, host: rest.slice(1, close), ...(after === '' ? {} : { port: after.startsWith(':') ? after.slice(1) : after }) }
  }
  const colon = rest.lastIndexOf(':')
  if (colon === -1 || rest.indexOf(':') !== colon) return { ...user, host: rest }
  return { ...user, host: rest.slice(0, colon), port: rest.slice(colon + 1) }
}

function parseAuthority(text: string, whole: string): RemoteAuthority {
  const parts = splitAuthority(text)
  if (parts.user !== undefined && parts.user.includes(':')) {
    throw new RemotePathError(`${whole} carries a password; ssh signs in with your keys and agent, so leave it out.`)
  }
  const user = parts.user === undefined ? undefined : decodeOnce(parts.user, whole)
  const host = decodeOnce(parts.host, whole)
  if (host === '' || host.startsWith('.') || /[\s/]/.test(host) || CONTROL.test(host)) throw new RemotePathError(`${whole} names no host.`)
  if (user !== undefined && (user === '' || CONTROL.test(user))) throw new RemotePathError(`${whole} names no user before the @.`)
  if (host.startsWith('-') || user?.startsWith('-') === true) {
    throw new RemotePathError(`${whole} begins a host or a user with a dash, which ssh would read as an option.`)
  }
  if (parts.port === undefined) return { ...(user === undefined ? {} : { user }), host }
  const port = /^[0-9]{1,5}$/.test(parts.port) ? Number(parts.port) : 0
  if (port < 1 || port > 65535) throw new RemotePathError(`${whole} has a port that is not a number from 1 to 65535.`)
  return { ...(user === undefined ? {} : { user }), host, port }
}

export function parseRemotePath(raw: string): RemoteTarget | null {
  const whole = raw.trim()
  const rest = whole.replace(SCHEME, '')
  if (rest === '' || rest === '/') return null
  if (rest.startsWith('/')) throw new RemotePathError(`${whole} names no host: write ssh://<host>${rest}.`)
  const slash = rest.indexOf('/')
  const authority = parseAuthority(slash === -1 ? rest : rest.slice(0, slash), whole)
  const written = slash === -1 ? '/~' : rest.slice(slash)
  const homeForm = HOME_FORM.exec(written)
  const decoded = decodeOnce(homeForm === null ? written : written.slice(homeForm[0].length), whole)
  if (decoded.includes('\0')) throw new RemotePathError(`${whole} holds a null byte.`)
  const segments = decoded.split('/').filter(segment => segment !== '' && segment !== '.')
  const folder = written.length > 1 && written.endsWith('/')
  return homeForm === null
    ? { authority, home: null, path: `/${segments.join('/')}`, folder }
    : { authority, home: homeForm[1]!, path: segments.join('/'), folder }
}

function escaped(text: string, pattern: RegExp): string {
  return text.replace(pattern, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

function encodePath(text: string): string {
  return escaped(text, /[%\u0000-\u001f\u007f]/g).replace(/ $/, '%20')
}

function encodeName(text: string): string {
  return escaped(text, /[%@:/[\] \u0000-\u001f\u007f]/g)
}

function hostText(host: string): string {
  return host.includes(':') ? `[${host}]` : encodeName(host)
}

export function authorityText(authority: RemoteAuthority): string {
  const user = authority.user === undefined ? '' : `${encodeName(authority.user)}@`
  return `${user}${hostText(authority.host)}${authority.port === undefined ? '' : `:${authority.port}`}`
}

export function formatRemotePath(target: RemoteTarget): string {
  const head = `ssh://${authorityText(target.authority)}`
  if (target.home !== null) return `${head}/~${target.home}${target.path === '' ? '' : `/${encodePath(target.path)}`}`
  const path = encodePath(target.path)
  return `${head}${path.startsWith('/~') ? `/%7E${path.slice(2)}` : path}`
}

function remoteIdentity(path: string): string {
  try {
    const target = parseRemotePath(path)
    return target === null ? REMOTE_RULE_ROOT : formatRemotePath(target)
  } catch {
    return path.trim()
  }
}

const GENERATIONS_KEPT = 4096
const generations = new Map<string, string | null>()

export function noteRemoteGeneration(path: string, generation: string | null): void {
  const key = remoteIdentity(path)
  generations.delete(key)
  generations.set(key, generation)
  if (generations.size > GENERATIONS_KEPT) generations.delete(generations.keys().next().value as string)
}

export function remoteGeneration(path: string): string | null | undefined {
  if (!isRemotePath(path)) return undefined
  return generations.get(remoteIdentity(path)) ?? null
}

export function remoteChild(target: RemoteTarget, name: string): RemoteTarget {
  const base = target.home === null ? (target.path === '/' ? '' : target.path) : target.path
  return { ...target, path: base === '' && target.home !== null ? name : `${base}/${name}`, folder: false }
}

const resolvedAuthorities = new Map<string, RemoteAuthorityFacts>()

export function noteResolvedAuthority(authority: RemoteAuthority, facts: RemoteAuthorityFacts): void {
  resolvedAuthorities.set(authorityText(authority), { ...facts, hostname: facts.hostname.toLowerCase() })
}

export function resolvedAuthority(authority: RemoteAuthority): RemoteAuthorityFacts | undefined {
  return resolvedAuthorities.get(authorityText(authority))
}

function ruleParts(pattern: string): { authority: string; rest: string } | null {
  if (!SCHEME.test(pattern)) return null
  const body = pattern.replace(SCHEME, '')
  const slash = body.indexOf('/')
  return slash === -1 ? { authority: body, rest: '' } : { authority: body.slice(0, slash), rest: body.slice(slash) }
}

export function remoteRuleAuthority(pattern: string): RemoteAuthority | null {
  const parts = ruleParts(pattern)
  if (parts === null || parts.authority === '' || /[*?]/.test(parts.authority)) return null
  try {
    return parseAuthority(parts.authority, pattern)
  } catch {
    return null
  }
}

function authorityKey(text: string): string {
  return text.replace(/[A-Z]/g, letter => `^${letter.toLowerCase()}`)
}

function spelledAuthority(host: string, user: string | undefined, port: number | undefined): string {
  return `${user === undefined ? '' : `${user}@`}${host}${port === undefined ? '' : `:${port}`}`
}

function rulePatternFor(authority: string, rest: string): string {
  return `/${authorityKey(authority).replace(/[\\[\]]/g, char => `\\${char}`)}${rest}`
}

export function remoteRulePattern(pattern: string): string | null {
  const parts = ruleParts(pattern)
  if (parts === null) return null
  if (parts.authority.startsWith('=')) return rulePatternFor(parts.authority, parts.rest)
  const strict = remoteRuleAuthority(pattern)
  if (strict === null) return rulePatternFor(parts.authority === '' ? '*' : parts.authority, parts.rest)
  const host = strict.host.includes(':') ? `[${strict.host}]` : strict.host
  return rulePatternFor(spelledAuthority(host, strict.user, strict.port), parts.rest)
}

export function remoteRuleEndpointForms(pattern: string): string[] {
  const parts = ruleParts(pattern)
  const strict = remoteRuleAuthority(pattern)
  if (parts === null || strict === null) return []
  const facts = resolvedAuthority(strict)
  if (facts === undefined) return []
  return [`ssh://${spelledAuthority(`=${facts.hostname}`, strict.user, strict.port)}${parts.rest}`]
}

function pathForms(target: RemoteTarget, behavior: 'allow' | 'deny' | 'ask'): string[] {
  const base = target.home === null ? [] : [`~${target.home}`]
  const segments = target.home === null ? target.path.split('/').filter(Boolean) : target.path === '' ? [] : target.path.split('/')
  const spelled = [...base, ...segments].join('/')
  if (!segments.includes('..')) return [spelled]
  if (behavior === 'allow') return []
  const kept: string[] = []
  for (const segment of segments) {
    if (segment !== '..') kept.push(segment)
    else if (kept.length > 0) kept.pop()
    else if (target.home !== null) return [spelled]
  }
  return [...new Set([spelled, [...base, ...kept].join('/')])]
}

export function remoteRuleCandidates(path: string, behavior: 'allow' | 'deny' | 'ask'): string[] | null {
  if (!isRemotePath(path)) return null
  let target: RemoteTarget | null
  try {
    target = parseRemotePath(path)
  } catch {
    return []
  }
  if (target === null) return []
  const facts = resolvedAuthority(target.authority)
  const user = target.authority.user ?? facts?.user
  const port = target.authority.port ?? facts?.port
  const written = target.authority.host.includes(':') ? `[${target.authority.host}]` : target.authority.host
  const hosts = facts === undefined ? [written] : [written, `=${facts.hostname}`]
  const authorities = hosts.flatMap(host => [
    host,
    ...(user === undefined ? [] : [spelledAuthority(host, user, undefined)]),
    ...(port === undefined ? [] : [spelledAuthority(host, undefined, port)]),
    ...(user === undefined || port === undefined ? [] : [spelledAuthority(host, user, port)]),
  ])
  const paths = pathForms(target, behavior)
  return authorities.flatMap(authority => paths.map(spelled => (spelled === '' ? authorityKey(authority) : `${authorityKey(authority)}/${spelled}`)))
}

export function remoteHostLabel(path: string): string | null {
  if (!isRemotePath(path)) return null
  try {
    const target = parseRemotePath(path)
    return target === null ? null : authorityText(target.authority)
  } catch {
    return null
  }
}

export function remoteSessionRule(path: string): string | null {
  const host = remoteHostLabel(path)
  return host === null ? null : `ssh://${host}/**`
}
