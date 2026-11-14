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
  while (fs.existsSync(path.join(facts.home, id))) id = `d${++book.count}`
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

function safeName(name: string): string {
  const base = path.basename(name.replace(/[\\/]/g, '_')).replace(/[\u0000-\u001f\u007f]/g, '_').trim()
  return base === '' || base === '.' || base === '..' ? 'download' : base
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err
    await fs.promises.copyFile(from, to)
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
  const target = path.join(held.home, held.id, safeName(held.name))
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await moveFile(path.join(held.home, 'incoming', held.guid), target)
    held.bytes = (await fs.promises.stat(target)).size
    held.sha256 = await digestOf(target)
    held.path = target
    held.state = 'complete'
  } catch (err) {
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

export async function sweepIncoming(book: TransferBook, home: string, idle: () => boolean): Promise<void> {
  if (!idle()) return
  await Promise.all(book.list.filter(transfer => transfer.state === 'pending').map(transfer => transfer.done))
  if (!idle()) return
  try {
    fs.rmSync(path.join(home, 'incoming'), { recursive: true, force: true })
    fs.rmdirSync(home)
  } catch {
    return
  }
}
