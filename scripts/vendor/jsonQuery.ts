import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { extractTarGz } from './tarExtract.ts'

interface QueryLock {
  name: string
  version: string
  engine: string
  license: string
  archives: Record<string, { url: string; sha256: string; integrity?: string }>
  abi: Record<string, string>
  memory: { upstreamMaximum: number; maximum: number }
  files: Array<{ archive: string; entry: string; path: string; sha256: string; bytes?: number; edit?: string; upstream?: { sha256: string; bytes: number } }>
  components: Array<{ name: string; version?: string; license: string; notice: string }>
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const lockAt = (root: string): QueryLock => JSON.parse(readFileSync(join(root, 'vendor/json-query.lock.json'), 'utf8'))

function leb(value: number): number[] {
  const out: number[] = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    out.push(byte)
  } while (value !== 0)
  return out
}

export function raiseWasmMemoryMaximum(bytes: Buffer, from: number, to: number): Buffer {
  const lost = (): never => { throw new Error('JSON query engine: the memory maximum is not where its pin expects it in the WebAssembly module') }
  let at = 8
  const read = (): number => {
    let result = 0, shift = 0, byte: number
    do {
      if (at >= bytes.length || shift > 28) lost()
      byte = bytes[at++]!
      result |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return result >>> 0
  }
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100 || from % 65536 !== 0 || to % 65536 !== 0 || to > 2147483648) lost()
  const parts: Buffer[] = [bytes.subarray(0, 8)]
  let raised = 0
  while (at < bytes.length) {
    const start = at, id = bytes[at++]!, size = read(), end = at + size
    if (end > bytes.length) lost()
    if (id === 5) {
      const count = read(), flags = read(), minimum = read(), maximum = flags === 1 ? read() : -1
      if (count !== 1 || maximum * 65536 !== from || at !== end) lost()
      const body = [...leb(1), ...leb(flags), ...leb(minimum), ...leb(to / 65536)]
      parts.push(Buffer.from([5, ...leb(body.length), ...body]))
      raised++
    } else parts.push(bytes.subarray(start, end))
    at = end
  }
  if (raised !== 1) lost()
  return Buffer.concat(parts)
}

export function raiseLoaderMemoryMaximum(text: string, from: number, to: number): string {
  const pinned = `getHeapMax = () => ${from};`
  if (text.split(pinned).length !== 2 || text.split(String(from)).length !== 2) throw new Error('JSON query engine: the memory maximum is not where its pin expects it in the loader')
  return text.replace(pinned, `getHeapMax = () => ${to};`)
}

function verify(dir: string, lock: QueryLock): void {
  for (const file of lock.files) {
    const bytes = readFileSync(join(dir, file.path))
    if (digest(bytes) !== file.sha256 || (file.bytes !== undefined && bytes.length !== file.bytes)) throw new Error(`JSON query pack differs from its lock: ${file.path}`)
  }
  const expected = new Set([...lock.files.map(file => file.path), '.vendor-manifest.json'])
  const walk = (at: string, prefix = ''): void => {
    for (const item of readdirSync(at, { withFileTypes: true })) {
      const rel = `${prefix}${item.name}`
      if (item.isDirectory()) walk(join(at, item.name), `${rel}/`)
      else if (!item.isFile() || !expected.has(rel)) throw new Error(`JSON query pack has an unexpected member: ${rel}`)
    }
  }
  walk(dir)
}

export function checkJsonQuery(root: string): QueryLock {
  const lock = lockAt(root)
  const dir = join(root, 'vendor/json-query/extracted')
  verify(dir, lock)
  const record = JSON.parse(readFileSync(join(dir, '.vendor-manifest.json'), 'utf8'))
  if (record.name !== lock.name || record.version !== lock.version || JSON.stringify(record.abi) !== JSON.stringify(lock.abi) || JSON.stringify(record.memory) !== JSON.stringify(lock.memory) || JSON.stringify(record.files) !== JSON.stringify(lock.files)) throw new Error('JSON query pack record differs from its lock')
  return lock
}

export async function fetchJsonQuery(root: string, archives: Record<string, string> = {}): Promise<void> {
  const lock = lockAt(root)
  const cache = join(root, 'vendor/json-query')
  mkdirSync(cache, { recursive: true })
  const scratchRoot = process.env.MERCURY_TMPDIR ?? tmpdir()
  mkdirSync(scratchRoot, { recursive: true })
  const stage = mkdtempSync(join(scratchRoot, 'json-query-pack-'))
  const prepared = join(stage, 'prepared')
  mkdirSync(prepared)
  try {
    for (const [key, archive] of Object.entries(lock.archives)) {
      const cached = join(cache, `${key}.tgz`)
      let bytes: Buffer
      if (archives[key]) bytes = readFileSync(archives[key])
      else if (existsSync(cached) && digest(readFileSync(cached)) === archive.sha256) bytes = readFileSync(cached)
      else {
        const response = await fetch(archive.url)
        if (!response.ok) throw new Error(`JSON query pack download: HTTP ${response.status}`)
        bytes = Buffer.from(await response.arrayBuffer())
      }
      if (digest(bytes) !== archive.sha256 || (archive.integrity !== undefined && `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== archive.integrity)) throw new Error(`JSON query archive digest differs: ${key}`)
      writeFileSync(cached, bytes)
      const unpacked = join(stage, key)
      mkdirSync(unpacked)
      const extraction = extractTarGz({ tarballPath: cached, destDir: unpacked, stripComponents: 1 })
      if (!extraction.ok) throw new Error(extraction.message)
      for (const file of lock.files.filter(file => file.archive === key)) {
        const target = join(prepared, file.path)
        mkdirSync(dirname(target), { recursive: true })
        if (file.edit === undefined) cpSync(join(unpacked, file.entry), target)
        else {
          const upstream = readFileSync(join(unpacked, file.entry))
          if (file.upstream === undefined || digest(upstream) !== file.upstream.sha256 || upstream.length !== file.upstream.bytes) throw new Error(`JSON query pack differs from its upstream pin: ${file.path}`)
          if (file.edit === 'wasm-memory-maximum') writeFileSync(target, raiseWasmMemoryMaximum(upstream, lock.memory.upstreamMaximum, lock.memory.maximum))
          else if (file.edit === 'loader-memory-maximum') writeFileSync(target, raiseLoaderMemoryMaximum(upstream.toString('utf8'), lock.memory.upstreamMaximum, lock.memory.maximum))
          else throw new Error(`JSON query pack names an edit this fetch does not know: ${file.edit}`)
        }
      }
    }
    verify(prepared, lock)
    writeFileSync(join(prepared, '.vendor-manifest.json'), `${JSON.stringify(lock, null, 2)}\n`)
    const incoming = join(cache, `prepared-${process.pid}`)
    cpSync(prepared, incoming, { recursive: true })
    rmSync(join(cache, 'extracted'), { recursive: true, force: true })
    renameSync(incoming, join(cache, 'extracted'))
    checkJsonQuery(root)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export function vendorJsonQuery(root: string, out: string): QueryLock {
  const lock = checkJsonQuery(root)
  const dest = join(out, 'vendor/json-query')
  rmSync(dest, { recursive: true, force: true })
  cpSync(join(root, 'vendor/json-query/extracted'), dest, { recursive: true })
  for (const script of ['jsonQueryWorker.mjs', 'jsonQueryProcess.mjs']) cpSync(join(root, 'src/tools/FileReadTool', script), join(dest, script))
  return lock
}
