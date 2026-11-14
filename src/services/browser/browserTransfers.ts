import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface Transfer {
  id: string
  guid: string
  tab: string
  url: string
  name: string
  type: string | null
  state: 'pending' | 'complete' | 'failed'
  received: number
  total: number | null
  path: string | null
  bytes: number | null
  sha256: string | null
  failure: string | null
  startedAt: number
  movedAt: number
  done: Promise<void>
}

interface Held extends Transfer {
  home: string
  landing: boolean
  settle: () => void
}

export interface TransferBook {
  list: Transfer[]
  count: number
}

export function newTransferBook(): TransferBook {
  return { list: [], count: 0 }
}

export function beginTransfer(
  book: TransferBook,
  facts: { guid: string; tab: string; url: string; name: string; type: string | null; home: string },
): Transfer {
  let settle = (): void => {}
  const done = new Promise<void>(resolve => {
    settle = resolve
  })
  let id = `d${++book.count}`
  while (fs.lstatSync(path.join(facts.home, id), { throwIfNoEntry: false }) !== undefined) id = `d${++book.count}`
  const held: Held = {
    id,
    guid: facts.guid,
    tab: facts.tab,
    url: facts.url,
    name: facts.name,
    type: facts.type,
    state: 'pending',
    received: 0,
    total: null,
    path: null,
    bytes: null,
    sha256: null,
    failure: null,
    startedAt: Date.now(),
    movedAt: Date.now(),
    done,
    home: facts.home,
    landing: false,
    settle,
  }
  book.list.push(held)
  return held
}

const MAX_SAFE_NAME_BYTES = 200
const RESERVED_WIN_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i

function boundBytes(text: string, maxBytes: number): string {
  let out = ''
  let used = 0
  for (const ch of text) {
    const step = Buffer.byteLength(ch, 'utf8')
    if (used + step > maxBytes) break
    out += ch
    used += step
  }
  return out
}

function safeName(name: string): string {
  let clean = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^[ ]+|[ .]+$/g, '')
  if (clean === '' || clean === '.' || clean === '..') return 'download'
  if (RESERVED_WIN_NAME.test(clean)) clean = `_${clean}`
  if (Buffer.byteLength(clean, 'utf8') <= MAX_SAFE_NAME_BYTES) return clean
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 && Buffer.byteLength(clean.slice(dot), 'utf8') <= 32 ? clean.slice(dot) : ''
  const stem = boundBytes(ext === '' ? clean : clean.slice(0, dot), MAX_SAFE_NAME_BYTES - Buffer.byteLength(ext, 'utf8')).replace(/[ .]+$/g, '')
  const joined = `${stem || 'download'}${ext}`
  return RESERVED_WIN_NAME.test(joined) ? `_${boundBytes(joined, MAX_SAFE_NAME_BYTES - 1)}` : joined
}

async function moveFile(from: string, to: string): Promise<void> {
  if (await fs.promises.lstat(to).then(() => true, () => false)) {
    throw new Error(`refusing to overwrite existing destination ${to}`)
  }
  try {
    await fs.promises.rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err
    const part = `${to}.part-${process.pid}-${Date.now()}`
    try {
      await fs.promises.copyFile(from, part, fs.constants.COPYFILE_EXCL)
      if (await fs.promises.lstat(to).then(() => true, () => false)) {
        throw new Error(`refusing to overwrite existing destination ${to}`)
      }
      await fs.promises.rename(part, to)
    } catch (copyErr) {
      await fs.promises.rm(part, { force: true }).catch(() => undefined)
      throw copyErr
    }
    await fs.promises.rm(from, { force: true })
  }
}

function digestOf(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function publish(held: Held): Promise<void> {
  const source = path.join(held.home, 'incoming', held.guid)
  const dir = path.join(held.home, held.id)
  const target = path.join(dir, safeName(held.name))
  try {
    await fs.promises.mkdir(held.home, { recursive: true })
    await fs.promises.mkdir(dir)
    const realHome = await fs.promises.realpath(held.home)
    const realDir = await fs.promises.realpath(dir)
    if (!realDir.startsWith(realHome + path.sep)) {
      throw new Error(`download directory ${dir} escaped ${held.home}`)
    }
    await moveFile(source, target)
    held.bytes = (await fs.promises.stat(target)).size
    held.sha256 = await digestOf(target)
    held.path = target
    held.state = 'complete'
  } catch (err) {
    await fs.promises.rm(source, { force: true }).catch(() => undefined)
    held.failure = `the bytes arrived but the file could not be put in place: ${(err as Error).message}`
    held.state = 'failed'
  }
  held.settle()
}

function fail(held: Held, reason: string): void {
  if (held.landing) return
  held.landing = true
  held.failure = reason
  held.state = 'failed'
  fs.rm(path.join(held.home, 'incoming', held.guid), { force: true }, () => undefined)
  held.settle()
}

export function moveTransfer(
  book: TransferBook,
  guid: string,
  progress: { state: 'inProgress' | 'completed' | 'canceled'; receivedBytes: number; totalBytes: number },
): void {
  const held = book.list.find(transfer => transfer.guid === guid && transfer.state === 'pending') as Held | undefined
  if (held === undefined || held.landing) return
  if (progress.receivedBytes > held.received) held.movedAt = Date.now()
  held.received = progress.receivedBytes
  if (progress.totalBytes > 0) held.total = progress.totalBytes
  if (progress.state === 'inProgress') return
  if (progress.state === 'canceled') {
    fail(held, 'the browser stopped it before the file was whole')
    return
  }
  held.landing = true
  void publish(held)
}

export function endTransfers(book: TransferBook, guids: Iterable<string>, reason: string): void {
  const ended = new Set(guids)
  for (const transfer of book.list) {
    if (transfer.state === 'pending' && ended.has(transfer.guid)) fail(transfer as Held, reason)
  }
}

export async function sweepIncoming(book: TransferBook, home: string, staging: string | undefined, idle: () => boolean): Promise<void> {
  if (!idle()) return
  await Promise.all(book.list.filter(transfer => transfer.state === 'pending').map(transfer => transfer.done))
  if (!idle()) return
  try {
    if (staging !== undefined) fs.rmSync(staging, { recursive: true, force: true })
    fs.rmSync(path.join(home, 'incoming'), { recursive: true, force: true })
    fs.rmdirSync(home)
  } catch {
    return
  }
}
