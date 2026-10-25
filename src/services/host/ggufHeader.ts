import engineTable from '../../../assets/host/llamacpp-engine.json' with { type: 'json' }

type GgufValue = string | number | boolean | Array<number | boolean>
interface GgufHeader { version: number; tensorCount: number; architecture?: string; kv: Record<string, GgufValue>; tensors: string[]; types?: number[]; headerBytes: number }
interface EngineTable { llamacpp: string; architectures: string[]; tensors: string[]; types: Record<string, number>; typeCount: number }
type GgufParse = { state: 'ok'; header: GgufHeader } | { state: 'more' } | { state: 'bad'; reason: string }
type GgufHeaderRead = { ok: true; header: GgufHeader; bytes: number } | { ok: false; status?: number; words: string; bad?: boolean }
export type GgufEngineCheck = { state: 'known' | 'unknown' | 'unread'; words: string }
interface GgufReadOptions { token?: string; signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch; firstChunk?: number; headerCap?: number }

export const LLAMACPP_ENGINE_TABLE: EngineTable = engineTable
const GGUF_HEADER_CAP = 64 * 1024 * 1024
const GGML_MAX_DIMS = 4
const FIRST_CHUNK = 256 * 1024
const READ_TIMEOUT_MS = 20_000
const SCALAR_SIZE: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
const SCALAR_ARRAY_KEEP = 1024

class NeedMore extends Error {}
class Cursor {
  pos = 0
  private readonly view: DataView
  constructor(private readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  private need(n: number): void { if (this.pos + n > this.bytes.length) throw new NeedMore() }
  u32(): number { this.need(4); const value = this.view.getUint32(this.pos, true); this.pos += 4; return value }
  u64(): number { this.need(8); const value = this.view.getBigUint64(this.pos, true); this.pos += 8; if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('a GGUF count exceeds 2^53'); return Number(value) }
  scalar(type: number): number | boolean {
    const size = SCALAR_SIZE[type]
    if (size === undefined) throw new Error('unknown GGUF value type ' + type)
    this.need(size)
    const at = this.pos
    this.pos += size
    switch (type) {
      case 0: return this.view.getUint8(at)
      case 1: return this.view.getInt8(at)
      case 2: return this.view.getUint16(at, true)
      case 3: return this.view.getInt16(at, true)
      case 4: return this.view.getUint32(at, true)
      case 5: return this.view.getInt32(at, true)
      case 6: return this.view.getFloat32(at, true)
      case 7: return this.view.getUint8(at) !== 0
      case 10: return Number(this.view.getBigUint64(at, true))
      case 11: return Number(this.view.getBigInt64(at, true))
      default: return this.view.getFloat64(at, true)
    }
  }
  string(): string {
    const length = this.u64()
    if (length > GGUF_HEADER_CAP) throw new Error('a GGUF string exceeds the header cap')
    this.need(length)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(this.bytes.subarray(this.pos, this.pos + length))
    this.pos += length
    return text
  }
  array(): Array<number | boolean> | undefined {
    const type = this.u32()
    const count = this.u64()
    if (type === 8) { for (let i = 0; i < count; i++) this.string(); return undefined }
    if (type === 9) { for (let i = 0; i < count; i++) this.array(); return undefined }
    const size = SCALAR_SIZE[type]
    if (size === undefined) throw new Error('unknown GGUF array type ' + type)
    if (count > SCALAR_ARRAY_KEEP) {
      this.need(count * size)
      this.pos += count * size
      return undefined
    }
    const values: Array<number | boolean> = []
    for (let i = 0; i < count; i++) values.push(this.scalar(type))
    return values
  }
}

export function parseGgufHeader(bytes: Uint8Array): GgufParse {
  try {
    const cursor = new Cursor(bytes)
    if (bytes.length < 4) return bytes.length === 0 ? { state: 'more' } : { state: 'bad', reason: 'the file does not start with GGUF' }
    if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== 'GGUF') return { state: 'bad', reason: 'the file does not start with GGUF' }
    cursor.pos = 4
    const version = cursor.u32()
    if (version !== 2 && version !== 3) return { state: 'bad', reason: 'GGUF version ' + version + ' is not one the engine reads' }
    const tensorCount = cursor.u64()
    const kvCount = cursor.u64()
    if (tensorCount > 1_000_000 || kvCount > 1_000_000) return { state: 'bad', reason: 'the GGUF header names an impossible count' }
    const kv: Record<string, GgufValue> = {}
    for (let i = 0; i < kvCount; i++) {
      const key = cursor.string()
      const type = cursor.u32()
      if (type === 8) { const value = cursor.string(); if (value.length <= 200) kv[key] = value }
      else if (type === 9) { const values = cursor.array(); if (values !== undefined) kv[key] = values }
      else kv[key] = cursor.scalar(type)
    }
    const tensors: string[] = []
    const types: number[] = []
    for (let i = 0; i < tensorCount; i++) {
      const name = cursor.string()
      const dims = cursor.u32()
      if (dims > GGML_MAX_DIMS) return { state: 'bad', reason: 'tensor ' + name + ' claims ' + dims + ' dimensions; llama.cpp reads at most ' + GGML_MAX_DIMS }
      for (let d = 0; d < dims; d++) cursor.u64()
      const type = cursor.u32()
      cursor.u64()
      tensors.push(name)
      types.push(type)
    }
    const architecture = typeof kv['general.architecture'] === 'string' ? kv['general.architecture'] : undefined
    return { state: 'ok', header: { version, tensorCount, ...(architecture ? { architecture } : {}), kv, tensors, types, headerBytes: cursor.pos } }
  } catch (error) {
    if (error instanceof NeedMore) return { state: 'more' }
    return { state: 'bad', reason: error instanceof Error ? error.message : String(error) }
  }
}

export const tensorFamily = (name: string): string => name.replace(/\.(?:weight|bias)$/, '').split('.').map(segment => /^\d+$/.test(segment) ? 'N' : segment).join('.')

const architectureFault = (architecture: string | undefined, table: EngineTable): string | undefined =>
  !architecture ? 'its header names no architecture'
    : !table.architectures.includes(architecture) ? 'its architecture "' + architecture + '" is not known to llama.cpp ' + table.llamacpp.slice(0, 7) + ' · a newer llama.cpp is needed'
    : undefined

function tensorTypeFault(headers: readonly GgufHeader[], table: EngineTable): string | undefined {
  const known = new Set(Object.values(table.types))
  for (const header of headers) {
    const types = header.types ?? []
    for (let i = 0; i < types.length; i++) {
      const type = types[i]!
      if (known.has(type)) continue
      const example = ' (e.g. ' + header.tensors[i] + ')'
      return type >= table.typeCount ? 'tensor type ' + type + ' is unknown to llama.cpp ' + table.llamacpp.slice(0, 7) + example + ' · a newer llama.cpp is needed'
        : 'tensor type ' + type + ' was removed from llama.cpp' + example + ' · look for another quantisation of this model'
    }
  }
  return undefined
}

function shardFault(headers: readonly GgufHeader[]): string | undefined {
  const seen = new Set<string>()
  for (const header of headers) for (const name of header.tensors) { if (seen.has(name)) return "tensor '" + name + "' appears twice"; seen.add(name) }
  const count = Number(headers[0]?.kv['split.count'] ?? 1)
  if (!(count > 1)) return undefined
  if (headers.length !== count) return 'split.count names ' + count + ' shards but ' + headers.length + ' header' + (headers.length === 1 ? ' was' : 's were') + ' read'
  for (const [index, header] of headers.entries()) {
    const no = header.kv['split.no']
    if (no !== index) return 'shard ' + (index + 1) + ' of ' + count + ' carries split.no ' + (no === undefined ? 'nothing' : String(no)) + ' · llama.cpp expects ' + index
  }
  const declared = headers[0]!.kv['split.tensors.count']
  if (typeof declared !== 'number') return 'the first shard names no split.tensors.count'
  if (declared !== seen.size) return 'split.tensors.count names ' + declared + ' tensors but the ' + count + ' shards carry ' + seen.size
  return undefined
}

export function compareGgufWithEngine(headers: readonly GgufHeader[], table: EngineTable = LLAMACPP_ENGINE_TABLE): { ok: boolean; words: string } {
  const short = table.llamacpp.slice(0, 7)
  const architecture = headers[0]?.architecture
  const fault = architectureFault(architecture, table)
  if (fault) return { ok: false, words: 'engine cannot load this file: ' + fault }
  const names = headers.flatMap(header => header.tensors)
  const families = [...new Set(names.map(tensorFamily))]
  const known = new Set(table.tensors)
  const unknown = families.filter(family => !known.has(family))
  if (unknown.length) return { ok: false, words: 'engine cannot load this file: ' + unknown.length + ' tensor famil' + (unknown.length === 1 ? 'y is' : 'ies are') + ' unknown to llama.cpp ' + short + ' (e.g. ' + unknown[0] + ') · a newer llama.cpp is needed' }
  const type = tensorTypeFault(headers, table)
  if (type) return { ok: false, words: 'engine cannot load this file: ' + type }
  const shard = shardFault(headers)
  if (shard) return { ok: false, words: 'engine cannot load this file: ' + shard }
  return { ok: true, words: 'header read · architecture ' + architecture + ' · ' + names.length + ' tensors in ' + families.length + ' families, all known to llama.cpp ' + short }
}

async function readRange(url: string, start: number, end: number, options: GgufReadOptions): Promise<{ status: number; bytes: Uint8Array; location?: string }> {
  const doFetch = options.fetch ?? fetch
  const deadline = AbortSignal.timeout(options.timeoutMs ?? READ_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const headers: Record<string, string> = { Range: 'bytes=' + start + '-' + end, ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}) }
  const response = await doFetch(url, { method: 'GET', headers, redirect: 'manual', signal })
  const location = response.headers.get('location') ?? undefined
  if (response.status >= 300 && response.status < 400 && location) { await response.body?.cancel().catch(() => {}); return { status: response.status, bytes: new Uint8Array(), location } }
  if (response.status !== 200 && response.status !== 206) { await response.body?.cancel().catch(() => {}); return { status: response.status, bytes: new Uint8Array() } }
  const want = end - start + 1
  const chunks: Uint8Array[] = []
  let have = 0
  const reader = response.body?.getReader()
  if (!reader) return { status: response.status, bytes: new Uint8Array() }
  while (have < want) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    have += value.length
  }
  await reader.cancel().catch(() => {})
  const bytes = new Uint8Array(Math.min(have, want))
  let at = 0
  for (const chunk of chunks) { const take = Math.min(chunk.length, bytes.length - at); bytes.set(chunk.subarray(0, take), at); at += take; if (at >= bytes.length) break }
  return { status: response.status, bytes }
}

export async function readGgufHeader(url: string, options: GgufReadOptions = {}): Promise<GgufHeaderRead> {
  const cap = options.headerCap ?? GGUF_HEADER_CAP
  let step = options.firstChunk ?? FIRST_CHUNK
  let target = url
  let authorised = true
  let have: Uint8Array = new Uint8Array()
  let ignoresRange = false
  let hops = 0
  try {
    while (have.length < cap) {
      const start = ignoresRange ? 0 : have.length
      const end = Math.min(have.length + step, cap) - 1
      const read = await readRange(target, start, end, authorised ? options : { ...options, token: undefined })
      if (read.location) {
        if (++hops > 5) return { ok: false, words: 'Hugging Face redirected the file header more than five times' }
        const next = new URL(read.location, target)
        if (next.origin !== new URL(target).origin) authorised = false
        target = next.toString()
        continue
      }
      if (read.status !== 200 && read.status !== 206) return { ok: false, status: read.status, words: 'Hugging Face answered HTTP ' + read.status + ' for the file header' }
      if (read.status === 200) ignoresRange = true
      const short = read.bytes.length < end - start + 1
      if (ignoresRange) have = read.bytes
      else { const joined = new Uint8Array(have.length + read.bytes.length); joined.set(have); joined.set(read.bytes, have.length); have = joined }
      if (!have.length) return { ok: false, bad: true, words: 'the file is empty' }
      const parsed = parseGgufHeader(have)
      if (parsed.state === 'ok') return { ok: true, header: parsed.header, bytes: have.length }
      if (parsed.state === 'bad') return { ok: false, bad: true, words: parsed.reason }
      if (short) return { ok: false, bad: true, words: 'the file ends inside its header' }
      step = Math.min(step * 4, cap)
    }
    return { ok: false, words: 'the file header is larger than ' + Math.round(cap / 1024 / 1024) + ' MB' }
  } catch (error) {
    return { ok: false, words: /abort|timeout/i.test(String(error)) ? 'Hugging Face did not answer the file header in time' : 'Hugging Face did not answer the file header' }
  }
}

export const hubFileUrl = (base: string, repo: string, revision: string, path: string): string => base.replace(/\/+$/, '') + '/' + repo.split('/').map(encodeURIComponent).join('/') + '/resolve/' + encodeURIComponent(revision) + '/' + path.split('/').map(encodeURIComponent).join('/')
const shardPath = (first: string, index: number): string => first.replace(/-00001-of-(\d{5})\.gguf$/i, (_, total: string) => '-' + String(index).padStart(5, '0') + '-of-' + total + '.gguf')

export async function checkGgufAgainstEngine(base: string, repo: string, revision: string, weightFile: string, options: GgufReadOptions = {}, table: EngineTable = LLAMACPP_ENGINE_TABLE): Promise<GgufEngineCheck> {
  const unread = (words: string): GgufEngineCheck => ({ state: 'unread', words: 'engine check skipped · ' + words })
  const first = await readGgufHeader(hubFileUrl(base, repo, revision, weightFile), options)
  if (!first.ok) {
    if (first.bad) return { state: 'unknown', words: 'engine cannot load this file: ' + first.words }
    if (first.status === 401 || first.status === 403) return unread('Hugging Face answered HTTP ' + first.status + ' for the file header (gated · sign in with /logins huggingface or accept the terms at https://huggingface.co/' + repo + ')')
    return unread(first.words)
  }
  const early = architectureFault(first.header.architecture, table)
  if (early) return { state: 'unknown', words: 'engine cannot load this file: ' + early }
  const headers = [first.header]
  const splits = Number(first.header.kv['split.count'] ?? 1)
  const named = /-00001-of-(\d{5})\.gguf$/i.exec(weightFile)
  const sharded = named !== null
  if (named && Number(named[1]) !== splits) return { state: 'unknown', words: 'engine cannot load this file: its name says ' + Number(named[1]) + ' shards but ' + (first.header.kv['split.count'] === undefined ? 'its header names no split.count' : 'split.count says ' + splits) }
  if (sharded && Number.isInteger(splits) && splits > 1) {
    for (let index = 2; index <= splits; index++) {
      const shard = await readGgufHeader(hubFileUrl(base, repo, revision, shardPath(weightFile, index)), options)
      if (!shard.ok) {
        if (shard.bad) return { state: 'unknown', words: 'engine cannot load this file: shard ' + index + ' of ' + splits + ' · ' + shard.words }
        return unread('shard ' + index + ' of ' + splits + ' · ' + shard.words)
      }
      headers.push(shard.header)
    }
  }
  const verdict = compareGgufWithEngine(headers, table)
  return { state: verdict.ok ? 'known' : 'unknown', words: verdict.words }
}
