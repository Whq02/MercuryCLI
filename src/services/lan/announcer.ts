import { spawn, type ChildProcess } from 'node:child_process'
import { hostname } from 'node:os'

export const MERCURY_TENSORFOLD_SERVICE_TYPE = '_mercury-tf._tcp'

export interface AnnouncementTxt {
  model?: string
  window?: number
  version?: string
  chip?: string
  engine?: number
  pair?: number
  keyed?: '1' | '0'
}

export interface Announcement {
  name: string
  port: number
  txt: AnnouncementTxt
}

export interface AnnouncerHandle {
  pid: number | undefined
  command: string
  stop(): void
}

export interface AnnouncerIo {
  platform?: NodeJS.Platform
  spawnImpl?: typeof spawn
  which?: (binary: string) => boolean
}

export function announcerMachineName(): string {
  const raw = hostname().replace(/\.local\.?$/i, '')
  return raw.replace(/[^A-Za-z0-9 _.-]/g, '').trim() || 'Mac'
}

export function txtWords(txt: AnnouncementTxt): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(txt)) {
    if (value === undefined || value === '') continue
    out.push(`${key}=${String(value).replace(/\s+/g, '_')}`)
  }
  return out
}

export function announcerCommand(announcement: Announcement, platform: NodeJS.Platform): { file: string; args: string[] } | undefined {
  const words = txtWords(announcement.txt)
  if (platform === 'darwin') return { file: 'dns-sd', args: ['-R', announcement.name, MERCURY_TENSORFOLD_SERVICE_TYPE, 'local', String(announcement.port), ...words] }
  if (platform === 'linux') return { file: 'avahi-publish-service', args: [announcement.name, MERCURY_TENSORFOLD_SERVICE_TYPE, String(announcement.port), ...words] }
  return undefined
}

export function startAnnouncer(announcement: Announcement, io: AnnouncerIo = {}): AnnouncerHandle | undefined {
  const command = announcerCommand(announcement, io.platform ?? process.platform)
  if (command === undefined) return undefined
  const spawnImpl = io.spawnImpl ?? spawn
  let child: ChildProcess
  try {
    child = spawnImpl(command.file, command.args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
  } catch {
    return undefined
  }
  child.on('error', () => {})
  child.unref?.()
  return {
    pid: child.pid,
    command: [command.file, ...command.args].join(' '),
    stop: () => {
      try {
        child.kill('SIGTERM')
      } catch {
      }
    },
  }
}

export interface BrowsedAnnouncement {
  name: string
  host: string
  port: number
  txt: Record<string, string>
}

export function parseBrowseNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split('\n')) {
    const match = /^\S+\s+Add\s+\d+\s+\d+\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line)
    if (match && !names.includes(match[1]!)) names.push(match[1]!)
  }
  return names
}

export function parseLookup(text: string): { host: string; port: number; txt: Record<string, string> } | undefined {
  const reached = /can be reached at (\S+?)\.?:(\d+)/.exec(text)
  if (!reached) return undefined
  const txt: Record<string, string> = {}
  const txtLine = text.split('\n').find(line => /^\s+\S+=/.test(line))
  if (txtLine) {
    for (const pair of txtLine.trim().split(/\s+/)) {
      const eq = pair.indexOf('=')
      if (eq > 0) txt[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
  }
  return { host: reached[1]!.replace(/\.$/, ''), port: Number(reached[2]), txt }
}

function runFor(file: string, args: string[], ms: number, spawnImpl: typeof spawn): Promise<string> {
  return new Promise(resolve => {
    let out = ''
    let child: ChildProcess
    try {
      child = spawnImpl(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve('')
      return
    }
    child.stdout?.on('data', chunk => {
      out += String(chunk)
    })
    child.on('error', () => resolve(out))
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
      }
    }, ms)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

export async function browseAnnouncements(io: AnnouncerIo & { browseMs?: number; lookupMs?: number } = {}): Promise<BrowsedAnnouncement[]> {
  const platform = io.platform ?? process.platform
  const spawnImpl = io.spawnImpl ?? spawn
  if (platform === 'darwin') {
    const listing = await runFor('dns-sd', ['-B', MERCURY_TENSORFOLD_SERVICE_TYPE, 'local.'], io.browseMs ?? 1500, spawnImpl)
    const found: BrowsedAnnouncement[] = []
    for (const name of parseBrowseNames(listing)) {
      const lookup = parseLookup(await runFor('dns-sd', ['-L', name, MERCURY_TENSORFOLD_SERVICE_TYPE, 'local.'], io.lookupMs ?? 1500, spawnImpl))
      if (lookup) found.push({ name, ...lookup })
    }
    return found
  }
  if (platform === 'linux') {
    const listing = await runFor('avahi-browse', ['-rpt', MERCURY_TENSORFOLD_SERVICE_TYPE], io.browseMs ?? 3000, spawnImpl)
    const found: BrowsedAnnouncement[] = []
    for (const line of listing.split('\n')) {
      const cells = line.split(';')
      if (cells[0] !== '=' || cells.length < 10) continue
      const txt: Record<string, string> = {}
      for (const pair of (cells[9] ?? '').match(/"([^"]*)"/g) ?? []) {
        const inner = pair.slice(1, -1)
        const eq = inner.indexOf('=')
        if (eq > 0) txt[inner.slice(0, eq)] = inner.slice(eq + 1)
      }
      const name = (cells[3] ?? '').replace(/\\032/g, ' ')
      if (name && !found.some(row => row.name === name)) found.push({ name, host: cells[6] ?? '', port: Number(cells[8]), txt })
    }
    return found
  }
  return []
}
