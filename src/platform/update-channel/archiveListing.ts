import { closeSync, createReadStream, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createInflateRaw } from 'node:zlib'
import type { UpdateCeilings } from './channelCore.js'
import { passedOver } from '../errors/passedOver.js'
import { isEscapingRelativePath } from '../host-os/paths.js'

type ArchiveForm = 'tar.gz' | 'zip'

type EntryKind = 'file' | 'directory' | 'symlink' | 'hardlink' | 'special'

interface ListedEntry {
  names: string[]
  kind: EntryKind
  targets: string[]
}

type ArchiveCheck = { state: 'ok'; entries: number } | { state: 'refused'; reason: string } | { state: 'unreadable'; note: string }

class ArchiveRefusal extends Error {}

const TAR_BLOCK = 512
const TAR_NOTE_BYTES = 64 * 1024
const ZIP_END_BYTES = 22
const ZIP_END_MARK = 0x06054b50
const ZIP_ENTRY_MARK = 0x02014b50
const ZIP_LOCAL_MARK = 0x04034b50

const tooManyEntries = (ceilings: UpdateCeilings): ArchiveRefusal => new ArchiveRefusal(`the archive lists more than ${ceilings.entries} entries, the most a release may hold`)
const tooManyBytes = (ceilings: UpdateCeilings): ArchiveRefusal => new ArchiveRefusal(`the archive unpacks to more than ${ceilings.unpackedBytes} bytes, the most a release may hold`)

function textField(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? length : end).toString('latin1')
}

function octalField(block: Buffer, start: number, length: number): number {
  const text = textField(block, start, length).trim()
  if (!/^[0-7]*$/.test(text)) throw new Error('a header holds a number that is not octal')
  return text === '' ? 0 : Number.parseInt(text, 8)
}

const isCutOf = (field: string, waiting: readonly string[]): boolean => waiting.some(whole => whole.startsWith(field))

function tarKind(type: string): EntryKind | 'note' {
  switch (type) {
    case '0':
    case '\0':
      return 'file'
    case '5':
      return 'directory'
    case '2':
      return 'symlink'
    case '1':
      return 'hardlink'
    case '3':
    case '4':
    case '6':
      return 'special'
    case 'L':
    case 'K':
    case 'x':
    case 'g':
      return 'note'
    default:
      throw new Error(`a header names an entry kind (${JSON.stringify(type)}) that a release archive does not hold`)
  }
}

function paxRecords(data: Buffer): Array<{ key: string; value: string }> {
  const records: Array<{ key: string; value: string }> = []
  let at = 0
  while (at < data.byteLength) {
    const space = data.indexOf(0x20, at)
    const length = space === -1 ? Number.NaN : Number(data.subarray(at, space).toString('latin1'))
    if (!Number.isInteger(length) || length <= space - at + 1 || at + length > data.byteLength || data[at + length - 1] !== 0x0a) throw new Error('an extended header is malformed')
    const record = data.subarray(space + 1, at + length - 1).toString('latin1')
    const equals = record.indexOf('=')
    if (equals === -1) throw new Error('an extended header is malformed')
    records.push({ key: record.slice(0, equals), value: record.slice(equals + 1) })
    at += length
  }
  return records
}

class TarListing {
  readonly entries: ListedEntry[] = []
  private streamBytes = 0
  private skip = 0
  private want = TAR_BLOCK
  private got: Buffer[] = []
  private gotBytes = 0
  private note: { type: string; size: number } | null = null
  private names: string[] = []
  private targets: string[] = []
  private ended = false

  constructor(private readonly ceilings: UpdateCeilings) {}

  take(chunk: Buffer): void {
    this.streamBytes += chunk.byteLength
    if (this.streamBytes > this.ceilings.unpackedBytes) throw tooManyBytes(this.ceilings)
    let at = 0
    while (at < chunk.byteLength) {
      if (this.ended) {
        if (chunk.subarray(at).some(byte => byte !== 0)) throw new Error('bytes follow the mark that ends the archive')
        return
      }
      if (this.skip > 0) {
        const step = Math.min(this.skip, chunk.byteLength - at)
        this.skip -= step
        at += step
        continue
      }
      const step = Math.min(this.want - this.gotBytes, chunk.byteLength - at)
      this.got.push(chunk.subarray(at, at + step))
      this.gotBytes += step
      at += step
      if (this.gotBytes < this.want) continue
      const unit = Buffer.concat(this.got)
      this.got = []
      this.gotBytes = 0
      if (this.note === null) this.header(unit)
      else this.noteRead(unit, this.note)
    }
  }

  finish(): ListedEntry[] {
    if (this.skip > 0 || this.gotBytes > 0 || this.note !== null) throw new Error('the archive ends in the middle of an entry')
    return this.entries
  }

  private header(block: Buffer): void {
    if (block.every(byte => byte === 0)) {
      this.ended = true
      return
    }
    const sum = block.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0)
    if (sum !== octalField(block, 148, 8) || textField(block, 257, 5) !== 'ustar') throw new Error('a header is not a tar header')
    if ((block[124]! & 0x80) !== 0) throw new Error('a header holds a size that is not octal')
    const size = octalField(block, 124, 12)
    const type = String.fromCharCode(block[156]!)
    const kind = tarKind(type)
    if (kind === 'note') {
      if (size > TAR_NOTE_BYTES) throw new Error('an extended header is larger than a name can be')
      if (size === 0) return
      this.note = { type, size }
      this.want = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
      return
    }
    if (kind !== 'file' && size !== 0) throw new Error('an entry that is not a file states a size')
    if (this.entries.length >= this.ceilings.entries) throw tooManyEntries(this.ceilings)
    const name = textField(block, 0, 100)
    const prefix = textField(block, 345, 155)
    const own = prefix === '' ? [name] : [`${prefix}/${name}`, name]
    if (kind === 'file' && (this.names.length > 0 ? this.names : own).some(used => used.endsWith('/'))) throw new Error('a header gives a file the name of a folder')
    this.entries.push({
      names: [...own.filter(field => !isCutOf(field, this.names)), ...this.names],
      kind,
      targets: kind === 'symlink' || kind === 'hardlink' ? [...[textField(block, 157, 100)].filter(field => !isCutOf(field, this.targets)), ...this.targets] : [],
    })
    this.names = []
    this.targets = []
    this.skip = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }

  private noteRead(unit: Buffer, note: { type: string; size: number }): void {
    const data = unit.subarray(0, note.size)
    this.note = null
    this.want = TAR_BLOCK
    if (note.type === 'L') this.names.push(textField(data, 0, data.byteLength))
    else if (note.type === 'K') this.targets.push(textField(data, 0, data.byteLength))
    else {
      for (const { key, value } of paxRecords(data)) {
        const renames = key === 'path' || key === 'linkpath'
        if (key === 'size' || key.startsWith('GNU.sparse') || (renames && note.type === 'g')) throw new Error(`an extended header sets ${key}, which a release archive does not use`)
        if (key === 'path') this.names.push(value)
        if (key === 'linkpath') this.targets.push(value)
      }
    }
  }
}

async function listTar(archivePath: string, ceilings: UpdateCeilings): Promise<ListedEntry[]> {
  const listing = new TarListing(ceilings)
  await pipeline(createReadStream(archivePath), createGunzip(), async (chunks: AsyncIterable<Buffer>) => {
    for await (const chunk of chunks) listing.take(chunk)
  })
  return listing.finish()
}

function readAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length)
  if (position < 0 || readSync(fd, out, 0, length, position) !== length) throw new Error('the archive is shorter than its own records say')
  return out
}

async function inflatedBytes(archivePath: string, start: number, length: number, limit: number): Promise<number> {
  const counted = { bytes: 0 }
  await pipeline(createReadStream(archivePath, { start, end: start + length - 1 }), createInflateRaw(), async (chunks: AsyncIterable<Buffer>) => {
    for await (const chunk of chunks) {
      counted.bytes += chunk.byteLength
      if (counted.bytes > limit) throw new Error('an entry holds more bytes than it states')
    }
  })
  return counted.bytes
}

async function listZip(archivePath: string, ceilings: UpdateCeilings): Promise<ListedEntry[]> {
  const fd = openSync(archivePath, 'r')
  try {
    const endAt = fstatSync(fd).size - ZIP_END_BYTES
    const end = readAt(fd, endAt, ZIP_END_BYTES)
    const mark = Buffer.alloc(4)
    mark.writeUInt32LE(ZIP_END_MARK)
    const total = end.readUInt16LE(10)
    const directoryBytes = end.readUInt32LE(12)
    const directoryAt = end.readUInt32LE(16)
    const plain = end.readUInt32LE(0) === ZIP_END_MARK && end.indexOf(mark, 1) === -1 && end.readUInt16LE(20) === 0 && end.readUInt16LE(4) === 0 && end.readUInt16LE(6) === 0 && end.readUInt16LE(8) === total
    if (!plain || total === 0xffff || directoryBytes === 0xffffffff || directoryAt === 0xffffffff || directoryAt + directoryBytes !== endAt) throw new Error('the zip does not close with the one plain end record a release zip has')
    if (total > ceilings.entries) throw tooManyEntries(ceilings)
    const entries: ListedEntry[] = []
    let at = directoryAt
    let unpackedBytes = 0
    for (let index = 0; index < total; index++) {
      const fixed = readAt(fd, at, 46)
      const method = fixed.readUInt16LE(10)
      const packed = fixed.readUInt32LE(20)
      const unpacked = fixed.readUInt32LE(24)
      const nameBytes = fixed.readUInt16LE(28)
      const localAt = fixed.readUInt32LE(42)
      const name = readAt(fd, at + 46, nameBytes).toString('latin1')
      at += 46 + nameBytes + fixed.readUInt16LE(30) + fixed.readUInt16LE(32)
      const readable = fixed.readUInt32LE(0) === ZIP_ENTRY_MARK && (fixed.readUInt16LE(8) & 1) === 0 && fixed.readUInt16LE(34) === 0 && packed !== 0xffffffff && unpacked !== 0xffffffff && localAt !== 0xffffffff
      if (!readable || at > endAt || (method !== 0 && method !== 8)) throw new Error('the zip lists an entry in a form a release zip does not use')
      unpackedBytes += unpacked
      if (unpackedBytes > ceilings.unpackedBytes) throw tooManyBytes(ceilings)
      const local = readAt(fd, localAt, 30)
      const dataAt = localAt + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      if (local.readUInt32LE(0) !== ZIP_LOCAL_MARK || dataAt + packed > directoryAt) throw new Error('the zip lists an entry whose bytes are not where it says')
      const held = method === 0 || packed === 0 ? packed : await inflatedBytes(archivePath, dataAt, packed, unpacked)
      if (held !== unpacked) throw new Error('the zip lists an entry that does not hold the bytes it states')
      entries.push({ names: [name], kind: /[\\/]$/.test(name) ? 'directory' : 'file', targets: [] })
    }
    if (at !== endAt) throw new Error('the zip does not close with the one plain end record a release zip has')
    return entries
  } finally {
    closeSync(fd)
  }
}

const shown = (name: string): string => JSON.stringify(Buffer.from(name, 'latin1').toString('utf8')).slice(0, 120)

function pathOf(name: string, form: ArchiveForm): string[] | null {
  const windows = form === 'zip'
  if (windows ? /^[\\/]/.test(name) || name.includes(':') : name.startsWith('/')) return null
  const segments = name.split(windows ? /[\\/]/ : posix.sep).filter(segment => segment !== '' && segment !== '.')
  return segments.some(segment => (windows ? /^\.{2,}$/.test(segment.replace(/[\x00-\x20\x7f-\xff]/g, '')) : segment === '..')) ? null : segments
}

function linkLands(from: string[], target: string, links: ReadonlySet<string>): 'inside' | 'outside' | 'through-link' {
  if (target.startsWith('/')) return 'outside'
  const at = [...from]
  for (const segment of target.split(posix.sep)) {
    if (segment === '' || segment === '.') continue
    if (links.has(at.join('/'))) return 'through-link'
    if (segment !== '..') at.push(segment)
    else if (at.pop() === undefined) return 'outside'
  }
  return 'inside'
}

function entryRefusal(entries: ListedEntry[], form: ArchiveForm): string | null {
  const links = new Set<string>()
  const seen = new Map<string, number>()
  const placed: Array<{ entry: ListedEntry; name: string; path: string[] }> = []
  for (const entry of entries) {
    for (const name of entry.names) {
      const path = pathOf(name, form)
      if (path === null || (path.length === 0 && entry.kind !== 'directory')) return `the archive holds an entry that leaves the folder it is unpacked into: ${shown(name)}`
      if (entry.kind === 'special') return `the archive holds a device, a FIFO or a socket: ${shown(name)}`
      const key = path.join('/')
      if (entry.kind === 'symlink') links.add(key)
      seen.set(key, (seen.get(key) ?? 0) + 1)
      placed.push({ entry, name, path })
    }
  }
  for (const { entry, name, path } of placed) {
    const beneathLink = path.some((_, index) => index > 0 && links.has(path.slice(0, index).join('/')))
    if (beneathLink || (links.has(path.join('/')) && seen.get(path.join('/')) !== 1)) return `the archive writes an entry through a link it made itself: ${shown(name)}`
    for (const target of entry.targets) {
      const lands = linkLands(entry.kind === 'symlink' ? path.slice(0, -1) : [], target, links)
      if (lands === 'outside') return `the archive holds a link that leaves the folder it is unpacked into: ${shown(name)}`
      if (lands === 'through-link') return `the archive writes an entry through a link it made itself: ${shown(name)}`
    }
  }
  return null
}

export async function checkArchiveBeforeUnpack(archivePath: string, form: ArchiveForm, ceilings: UpdateCeilings): Promise<ArchiveCheck> {
  try {
    const entries = form === 'zip' ? await listZip(archivePath, ceilings) : await listTar(archivePath, ceilings)
    const refusal = entryRefusal(entries, form)
    return refusal === null ? { state: 'ok', entries: entries.length } : { state: 'refused', reason: refusal }
  } catch (error) {
    if (error instanceof ArchiveRefusal) return { state: 'refused', reason: error.message }
    return { state: 'unreadable', note: error instanceof Error ? error.message.slice(0, 200) : String(error) }
  }
}

function linkOnDiskLands(link: string): string {
  try {
    return realpathSync(link)
  } catch (error) {
    passedOver(error)
    return resolve(dirname(link), readlinkSync(link))
  }
}

export function unpackedFolderRefusal(root: string, ceilings: UpdateCeilings): string | null {
  const home = realpathSync(root)
  const tally = { entries: 0, bytes: 0 }
  const folders = [home]
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (const name of readdirSync(folder)) {
      const full = join(folder, name)
      const stat = lstatSync(full)
      const told = JSON.stringify(relative(home, full)).slice(0, 120)
      tally.entries++
      if (tally.entries > ceilings.entries) return `the unpacker wrote more than ${ceilings.entries} entries, the most a release may hold`
      if (stat.isDirectory()) folders.push(full)
      else if (stat.isSymbolicLink()) {
        const away = relative(home, linkOnDiskLands(full))
        if (isAbsolute(away) || isEscapingRelativePath(away)) return `the unpacker left a link that leaves the folder it unpacked into: ${told}`
      } else if (!stat.isFile()) return `the unpacker left a device, a FIFO or a socket: ${told}`
      else {
        tally.bytes += stat.size
        if (tally.bytes > ceilings.unpackedBytes) return `the unpacker wrote more than ${ceilings.unpackedBytes} bytes, the most a release may hold`
      }
    }
  }
  return null
}
