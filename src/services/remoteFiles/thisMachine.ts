import { homedir, hostname, networkInterfaces, userInfo } from 'node:os'
import { join } from 'node:path'
import { isRemotePath, parseRemotePath, resolvedAuthority, type RemoteTarget } from './target.js'

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

function numberOf(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part.slice(2), 16)
  if (/^0[0-7]*$/.test(part)) return parseInt(part, 8)
  if (/^[1-9][0-9]*$/.test(part)) return parseInt(part, 10)
  return null
}

function ipv4Of(text: string): number | null {
  const parts = text.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const numbers = parts.map(numberOf)
  if (numbers.some(value => value === null)) return null
  const values = numbers as number[]
  const last = values[values.length - 1]!
  const leading = values.slice(0, -1)
  if (leading.some(value => value > 255) || last >= 2 ** (8 * (5 - values.length))) return null
  return leading.reduce((sum, value, index) => sum + value * 2 ** (8 * (3 - index)), 0) + last
}

function ipv6Of(text: string): number[] | null {
  const bare = text.replace(/%.*$/, '')
  if (!bare.includes(':')) return null
  const halves = bare.split('::')
  if (halves.length > 2) return null
  const words = (side: string): number[] | null => {
    if (side === '') return []
    const out: number[] = []
    const groups = side.split(':')
    for (const [index, group] of groups.entries()) {
      if (index === groups.length - 1 && group.includes('.')) {
        const v4 = /^\d+\.\d+\.\d+\.\d+$/.test(group) ? ipv4Of(group) : null
        if (v4 === null) return null
        out.push(Math.floor(v4 / 65536), v4 % 65536)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
      out.push(parseInt(group, 16))
    }
    return out
  }
  const head = words(halves[0]!)
  const tail = halves.length === 2 ? words(halves[1]!) : []
  if (head === null || tail === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  if (head.length + tail.length > 7) return null
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail]
}

function addressKey(text: string): string | null {
  const v6 = ipv6Of(text)
  if (v6 !== null) {
    const mapped = v6.slice(0, 5).every(word => word === 0) && v6[5] === 0xffff
    return mapped ? `4:${v6[6]! * 65536 + v6[7]!}` : `6:${v6.join(':')}`
  }
  const v4 = ipv4Of(text)
  return v4 === null ? null : `4:${v4}`
}

function loopbackKey(key: string): boolean {
  if (key.startsWith('4:')) {
    const value = Number(key.slice(2))
    return value === 0 || Math.floor(value / 2 ** 24) === 127
  }
  return key === '6:0:0:0:0:0:0:0:1' || key === '6:0:0:0:0:0:0:0:0'
}

function ownAddressKeys(): Set<string> {
  const keys = new Set<string>()
  try {
    for (const rows of Object.values(networkInterfaces())) {
      for (const row of rows ?? []) {
        const key = addressKey(row.address)
        if (key !== null) keys.add(key)
      }
    }
  } catch {
  }
  return keys
}

function ownNames(): Set<string> {
  const names = new Set<string>()
  try {
    const full = hostname().toLowerCase().replace(/\.$/, '')
    if (full !== '') {
      const short = full.split('.')[0]!
      for (const name of [full, short, `${short}.local`]) names.add(name)
    }
  } catch {
  }
  return names
}

function hostIsThisMachine(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (LOOPBACK_NAMES.has(name) || name.endsWith('.localhost')) return true
  const key = addressKey(name)
  if (key !== null) return loopbackKey(key) || ownAddressKeys().has(key)
  return ownNames().has(name)
}

function ownUserName(): string | undefined {
  try {
    return userInfo().username
  } catch {
    return process.env.USER ?? process.env.USERNAME
  }
}

function homesOf(user: string | undefined): string[] {
  if (user === undefined || user === ownUserName()) return [homedir()]
  return user === 'root' ? ['/root', '/var/root'] : [`/Users/${user}`, `/home/${user}`]
}

function localFormsOf(target: RemoteTarget): string[] {
  if (target.home === null) return [target.path.replace(/^\/(?=[A-Za-z]:\/)/, '')]
  const user = target.home === '' ? (target.authority.user ?? resolvedAuthority(target.authority)?.user) : target.home
  return homesOf(user).map(home => (target.path === '' ? home : join(home, target.path)))
}

export function remoteLocalForms(path: string, sameMachine = false): string[] | null {
  if (!isRemotePath(path)) return null
  let target: RemoteTarget | null
  try {
    target = parseRemotePath(path)
  } catch {
    return null
  }
  if (target === null) return null
  const resolved = resolvedAuthority(target.authority)?.hostname
  const here = sameMachine || hostIsThisMachine(target.authority.host) || (resolved !== undefined && hostIsThisMachine(resolved))
  return here ? localFormsOf(target) : null
}
