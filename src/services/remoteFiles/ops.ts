import { randomBytes } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTooLargeError, type ReadFileRangeResult } from '../../utils/readFileInRange.js'
import { remoteOpening, remoteRun, RemoteConnectionError } from './connection.js'
import { remoteQuote } from './prelude.js'
import { authorityText, formatRemotePath, noteRemoteGeneration, type RemoteAuthority, type RemoteTarget } from './target.js'

type RemoteKind = 'file' | 'folder' | 'a named pipe' | 'a socket' | 'a device' | 'other' | 'dangling'

type RemoteStat = { kind: RemoteKind; link: boolean; size: number; mtimeMs: number; mode: string | null }

type RemoteEntry = { name: string; kind: 'file' | 'folder' | 'link' | 'other' }

type RemoteHead = { size: number; mtimeMs: number; mode: string | null; lines: number; endsWithNewline: boolean; lead: string; crc: string | null }

type RemoteFacts = { home: string; system: string; here: boolean }

class RemoteFileError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteFileError'
    this.code = code
  }
}

export class RemoteChangedError extends Error {
  constructor(path: string, underARead = false) {
    super(underARead ? `${path} changed on the remote machine while it was being read; Read it again.` : `${path} changed on the remote machine after it was read.`)
    this.name = 'RemoteChangedError'
  }
}

const MAX_PAGE_LINES = 2 ** 31 - 1
const KINDS: Record<string, RemoteKind> = { d: 'folder', f: 'file', p: 'a named pipe', s: 'a socket', c: 'a device', o: 'other', x: 'dangling' }

const facts = new Map<string, { opening: number; known: Promise<RemoteFacts> }>()
const homes = new Map<string, { opening: number; known: Promise<string> }>()

function kept<Value>(cache: Map<string, { opening: number; known: Promise<Value> }>, key: string, authority: RemoteAuthority, read: () => Promise<Value>): Promise<Value> {
  const held = cache.get(key)
  const opening = remoteOpening(authority)
  if (held !== undefined && (held.opening === opening || held.opening === -1)) return held.known
  const entry = { opening: -1, known: read() }
  cache.set(key, entry)
  entry.known.then(
    () => {
      entry.opening = remoteOpening(authority)
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key)
    },
  )
  return entry.known
}

function words(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean)
  return (lines[lines.length - 1] ?? '').replace(/^(?:sh|bash|zsh|dash|ash)(?:: line \d+|: \d+)?: /, '')
}

function failed(target: RemoteTarget, status: number, stderr: string): RemoteFileError {
  const path = formatRemotePath(target)
  if (status === 44) return new RemoteFileError('ENOENT', `ENOENT: no such file or directory, open '${path}'`)
  if (status === 45) return new RemoteFileError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`)
  if (status === 46) return new RemoteFileError('ENOTREG', `${path} is not a regular file.`)
  if (status === 49) return new RemoteFileError('EISDIR', `EISDIR: illegal operation on a directory, open '${path}'`)
  const said = words(stderr)
  if (status === 47 || /permission denied/i.test(said)) return new RemoteFileError('EACCES', `EACCES: permission denied, open '${path}'`)
  return new RemoteFileError('EIO', `${path}: ${said === '' ? `the remote machine answered ${status}` : said}`)
}

function remoteFacts(authority: RemoteAuthority, signal: AbortSignal | undefined): Promise<RemoteFacts> {
  const key = authorityText(authority)
  return kept(facts, key, authority, async () => {
    const probe = join(tmpdir(), `.mercury-remote-${randomBytes(16).toString('hex')}`)
    let placed = false
    try {
      writeFileSync(probe, '')
      placed = true
    } catch {
    }
    try {
      const reply = await remoteRun(authority, { script: `m_facts ${remoteQuote(placed ? probe : '')}`, signal })
      const [home = '', system = '', here = '0'] = reply.stdout.toString('utf8').split('\0')
      if (reply.status !== 0 || !home.startsWith('/')) throw new RemoteFileError('EIO', `${key}: the remote account's home could not be read.`)
      return { home, system, here: here === '1' }
    } finally {
      if (placed) {
        try {
          unlinkSync(probe)
        } catch {
        }
      }
    }
  })
}

export async function remoteIsThisMachine(authority: RemoteAuthority, signal?: AbortSignal): Promise<boolean> {
  return (await remoteFacts(authority, signal)).here
}

function homeOf(authority: RemoteAuthority, user: string, signal: AbortSignal | undefined): Promise<string> {
  if (user === '') return remoteFacts(authority, signal).then(known => known.home)
  return kept(homes, `${authorityText(authority)} ${user}`, authority, () =>
    remoteRun(authority, { script: `m_home ${remoteQuote(user)}`, signal }).then(reply => {
      const home = reply.stdout.toString('utf8').replace(/\n$/, '')
      if (reply.status !== 0 || !home.startsWith('/')) throw new RemoteFileError('ENOENT', `${authorityText(authority)} has no account named ${user}.`)
      return home
    }),
  )
}

export async function remoteAbsolutePath(target: RemoteTarget, signal?: AbortSignal): Promise<string> {
  if (target.home === null) return target.path
  const home = await homeOf(target.authority, target.home, signal)
  if (target.path === '') return home
  return home === '/' ? `/${target.path}` : `${home}/${target.path}`
}

export async function remoteRealPath(target: RemoteTarget, signal?: AbortSignal): Promise<string> {
  const path = await remoteAbsolutePath(target, signal)
  const reply = await remoteRun(target.authority, { script: `m_real ${remoteQuote(path)}`, signal })
  const real = reply.stdout.toString('utf8').replace(/\n$/, '')
  return reply.status === 0 && real.startsWith('/') ? real : path
}

function metaOf(fields: string[]): { size: number; mtimeMs: number; mode: string | null } {
  const size = Number(fields[0])
  const mtime = Number(fields[1])
  return {
    size: Number.isFinite(size) ? size : 0,
    mtimeMs: Number.isFinite(mtime) ? mtime * 1000 : 0,
    mode: fields[2] === undefined || fields[2] === '-' ? null : fields[2],
  }
}

export async function remoteStat(target: RemoteTarget, signal?: AbortSignal): Promise<RemoteStat | null> {
  const path = await remoteAbsolutePath(target, signal)
  const reply = await remoteRun(target.authority, { script: `m_kind ${remoteQuote(path)}`, signal })
  if (reply.status === 44) return null
  const fields = reply.stdout.toString('utf8').trim().split(' ')
  const kind = KINDS[fields[0] ?? '']
  if (reply.status !== 0 || kind === undefined) throw failed(target, reply.status, reply.stderr)
  return { kind, link: fields[1] === 'l', ...metaOf(fields.slice(2)) }
}

function headOf(line: string): RemoteHead | null {
  const fields = line.split(' ')
  if (fields.length !== 7) return null
  const lines = Number(fields[3])
  if (!Number.isInteger(lines)) return null
  return {
    ...metaOf(fields),
    lines,
    endsWithNewline: fields[4] === '1',
    lead: fields[5] === '-' ? '' : fields[5]!,
    crc: fields[6] === '-' ? null : fields[6]!,
  }
}

function generationOf(head: RemoteHead): string | null {
  return head.crc === null ? null : `m${head.mtimeMs}:${head.size}:${head.crc}`
}

async function page(target: RemoteTarget, first: number, count: number, maxBytes: number, signal: AbortSignal | undefined): Promise<{ head: RemoteHead; body: Buffer; tooLarge: boolean }> {
  const path = await remoteAbsolutePath(target, signal)
  const reply = await remoteRun(target.authority, { script: `m_page ${remoteQuote(path)} ${first} ${count} ${maxBytes}`, signal })
  const cut = reply.stdout.indexOf(0x0a)
  const head = cut === -1 ? null : headOf(reply.stdout.subarray(0, cut).toString('latin1'))
  if ((reply.status !== 0 && reply.status !== 48) || head === null) throw failed(target, reply.status, reply.stderr)
  noteRemoteGeneration(formatRemotePath(target), generationOf(head))
  return { head, body: reply.stdout.subarray(cut + 1), tooLarge: reply.status === 48 }
}

function realLines(head: RemoteHead): number {
  return head.lines + (!head.endsWithNewline && head.size > 0 ? 1 : 0)
}

function sliced(text: string, offset: number, maxLines: number | undefined, head: RemoteHead): ReadFileRangeResult {
  const lines = text.split('\n')
  const end = maxLines === undefined ? lines.length : Math.min(offset + maxLines, lines.length)
  const selected = lines.slice(offset, Math.max(end, offset)).map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const content = selected.join('\n')
  return {
    content,
    lineCount: selected.length,
    totalLines: lines.length,
    totalBytes: head.size,
    readBytes: Buffer.byteLength(content),
    mtimeMs: head.mtimeMs,
    endsWithNewline: text.endsWith('\n'),
  }
}

export async function remoteReadRange(
  target: RemoteTarget,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult & { lead: string }> {
  const wanted = maxLines === undefined ? -1 : Math.min(Math.max(0, Math.floor(maxLines)), MAX_PAGE_LINES)
  for (let attempt = 0; ; attempt++) {
    const read = await page(target, offset + 1, wanted, maxBytes ?? 0, signal)
    const { head } = read
    if (read.tooLarge) throw new FileTooLargeError(head.size, maxBytes ?? 0, head.endsWithNewline ? head.lines : realLines(head))
    if (head.lead.startsWith('fffe')) {
      const whole = wanted === -1 && offset === 0 ? read : await page(target, 1, -1, 0, signal)
      const text = whole.body.toString('utf16le')
      return { ...sliced(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, offset, maxLines, whole.head), lead: whole.head.lead }
    }
    const totalLines = head.lines + 1
    const end = maxLines === undefined ? totalLines : Math.min(offset + wanted, totalLines)
    const expected = Math.max(0, Math.min(end, realLines(head)) - offset)
    let text = read.body.toString('utf8')
    if (offset === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    if (text.endsWith('\n')) text = text.slice(0, -1)
    const pieces = expected === 0 ? [] : text.split('\n').slice(0, expected)
    if (pieces.length !== expected && wanted !== 0) {
      if (attempt === 0) continue
      throw new RemoteChangedError(formatRemotePath(target), true)
    }
    if ((head.endsWithNewline || head.size === 0) && offset <= head.lines && end > head.lines) pieces.push('')
    const selected = pieces.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
    const content = selected.join('\n')
    return {
      content,
      lineCount: selected.length,
      totalLines,
      totalBytes: head.size,
      readBytes: Buffer.byteLength(content),
      mtimeMs: head.mtimeMs,
      endsWithNewline: head.endsWithNewline,
      lead: head.lead,
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index << 24
    for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1
    table[index] = value >>> 0
  }
  return table
})()

export function remoteSum(bytes: Uint8Array): string {
  let crc = 0
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ (length & 0xff)) & 0xff]!) >>> 0
  }
  return `${(~crc >>> 0).toString()} ${bytes.length}`
}

export async function remoteReadBytes(target: RemoteTarget, signal?: AbortSignal): Promise<{ bytes: Buffer; mtimeMs: number; mode: string | null; sum: string }> {
  const read = await page(target, 1, -1, 0, signal)
  const sum = remoteSum(read.body)
  noteRemoteGeneration(formatRemotePath(target), `m${read.head.mtimeMs}:${read.body.length}:${sum.split(' ')[0]}`)
  return { bytes: read.body, mtimeMs: read.head.mtimeMs, mode: read.head.mode, sum }
}

export async function remoteList(target: RemoteTarget, signal?: AbortSignal): Promise<RemoteEntry[]> {
  const path = await remoteAbsolutePath(target, signal)
  const reply = await remoteRun(target.authority, { script: `m_list ${remoteQuote(path)}`, signal })
  if (reply.status === 46) throw new RemoteFileError('ENOTDIR', `ENOTDIR: not a directory, scandir '${formatRemotePath(target)}'`)
  if (reply.status === 47) throw new RemoteFileError('EACCES', `EACCES: permission denied, scandir '${formatRemotePath(target)}'`)
  if (reply.status !== 0) throw failed(target, reply.status, reply.stderr)
  const fields = reply.stdout.toString('utf8').split('\0')
  const entries: RemoteEntry[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const kind = fields[at] === 'd' ? 'folder' : fields[at] === 'f' ? 'file' : fields[at] === 'l' ? 'link' : 'other'
    entries.push({ name: fields[at + 1]!, kind })
  }
  return entries
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

async function settled(target: RemoteTarget, path: string, sum: string, signal: AbortSignal | undefined): Promise<{ mtimeMs: number; generation: string | null }> {
  const reply = await remoteRun(target.authority, { script: `m_kind ${remoteQuote(path)}`, signal })
  const meta = metaOf(reply.stdout.toString('utf8').trim().split(' ').slice(2))
  const generation = `m${meta.mtimeMs}:${meta.size}:${sum.split(' ')[0]}`
  noteRemoteGeneration(formatRemotePath(target), generation)
  return { mtimeMs: meta.mtimeMs, generation }
}

export async function remoteCommit(
  target: RemoteTarget,
  bytes: Uint8Array,
  expected: string | null,
  mode: string | null,
  signal?: AbortSignal,
): Promise<{ mtimeMs: number; generation: string | null }> {
  const identity = formatRemotePath(target)
  const real = await remoteRealPath(target, signal)
  const sum = remoteSum(bytes)
  const was = expected ?? 'absent'
  const staged = `${parentOf(real) === '/' ? '' : parentOf(real)}/.${real.slice(real.lastIndexOf('/') + 1)}.mercury-${randomBytes(6).toString('hex')}`
  if (expected === null) {
    const made = await remoteRun(target.authority, { script: `mkdir -p ${remoteQuote(parentOf(real))}`, signal })
    if (made.status !== 0) throw failed(target, made.status, made.stderr)
  }
  const put = await remoteRun(target.authority, { script: ack => `m_put ${bytes.length} ${remoteQuote(staged)} ${ack}`, payload: bytes, signal })
  if (put.status === 73 && expected !== null) {
    const over = await remoteRun(target.authority, { script: ack => `m_over ${bytes.length} ${remoteQuote(real)} ${remoteQuote(was)} ${ack}`, payload: bytes, signal })
    if (over.status === 45) throw new RemoteChangedError(identity)
    if (over.status !== 0 || over.stdout.toString('utf8').trim() !== sum) throw failed(target, over.status, over.stderr === '' ? put.stderr : over.stderr)
    return settled(target, real, sum, signal)
  }
  if (put.status !== 0) throw failed(target, put.status, put.stderr)
  let landed: string
  try {
    const done = await remoteRun(target.authority, { script: `m_commit ${remoteQuote(staged)} ${remoteQuote(real)} ${remoteQuote(was)} ${mode ?? '-'}`, signal })
    if (done.status === 45) throw new RemoteChangedError(identity)
    if (done.status !== 0) throw failed(target, done.status, done.stderr)
    landed = done.stdout.toString('utf8').trim()
  } catch (error) {
    if (!(error instanceof RemoteConnectionError)) throw error
    const now = await remoteRun(target.authority, { script: `m_sum ${remoteQuote(real)} 2>/dev/null || printf absent`, signal }).then(
      reply => reply.stdout.toString('utf8').trim(),
      () => null,
    )
    if (now === sum) return settled(target, real, sum, signal)
    throw new RemoteFileError(
      'EIO',
      now === null
        ? `${error.message} The write to ${identity} was under way and its outcome could not be read: Read the file before relying on it.`
        : `${error.message} The write to ${identity} did not land: the file holds what it held before.`,
    )
  }
  if (landed !== sum) throw new RemoteFileError('EIO', `${identity} does not hold the bytes that were written to it.`)
  return settled(target, real, sum, signal)
}
