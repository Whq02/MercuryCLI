import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'

export const GODOT_DEBUGGER_VERSION = '4.6'
const MAX_PACKET = 8 << 20
const MAX_VALUES = 1_000_000

export function requireGodotDebuggerVersion(version: string): void {
  if (!/^4\.6(?:\.|$)/.test(version)) throw new Error(`Godot debugger version ${version} is unsupported; the decoder carries Godot ${GODOT_DEBUGGER_VERSION}`)
}

export function decodeGodotVariant(bytes: Buffer, version = GODOT_DEBUGGER_VERSION): unknown {
  requireGodotDebuggerVersion(version)
  if (bytes.length > MAX_PACKET) throw new Error('Godot debugger packet exceeds 8 MiB')
  let offset = 0
  let values = 0
  const take = (n: number): number => {
    if (n < 0 || offset + n > bytes.length) throw new Error('Godot debugger Variant is truncated')
    const start = offset
    offset += n
    return start
  }
  const u32 = (): number => bytes.readUInt32LE(take(4))
  const int64 = (): number | bigint => {
    const n = bytes.readBigInt64LE(take(8))
    return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n
  }
  const string = (): string => {
    const length = u32()
    const start = take(Math.ceil(length / 4) * 4)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + length))
  }
  const containerType = (kind: number): void => {
    if (kind === 1) {
      const type = u32()
      if (type > 38) throw new Error(`Godot debugger unknown Variant type ${type} in typed container`)
    } else if (kind > 1) string()
  }
  const read = (depth: number): unknown => {
    if (depth > 64 || ++values > MAX_VALUES) throw new Error('Godot debugger Variant exceeds nesting or value limit')
    const header = u32()
    const type = header & 255
    const flags = header >>> 16
    const allowed = type === 27 ? 15 : type === 28 ? 3 : [2, 3, 35, 36, 38].includes(type) ? 1 : 0
    if ((header & 0xff00) !== 0 || (flags & ~allowed) !== 0) throw new Error(`Godot debugger unsupported Variant header ${header} for Godot ${version}`)
    if (type === 0) return null
    if (type === 1) return u32() !== 0
    if (type === 2) return flags ? int64() : bytes.readInt32LE(take(4))
    if (type === 3) return flags ? bytes.readDoubleLE(take(8)) : bytes.readFloatLE(take(4))
    if (type === 4 || type === 21) return string()
    if (type === 27 || type === 28) {
      containerType(flags & 3)
      if (type === 27) containerType((flags >>> 2) & 3)
      const count = u32() & 0x7fffffff
      if (count > MAX_VALUES || count * (type === 27 ? 8 : 4) > bytes.length - offset) throw new Error('Godot debugger container length exceeds packet or value limit')
      if (type === 28) return Array.from({ length: count }, () => read(depth + 1))
      const entries: Array<[unknown, unknown]> = []
      for (let i = 0; i < count; i++) entries.push([read(depth + 1), read(depth + 1)])
      return entries.every(([key]) => typeof key === 'string') ? Object.fromEntries(entries as Array<[string, unknown]>) : new Map(entries)
    }
    if (type >= 29 && type <= 38) {
      const count = u32()
      if (count > MAX_VALUES) throw new Error('Godot debugger packed array exceeds value limit')
      if (type === 29) {
        const start = take(Math.ceil(count / 4) * 4)
        return Array.from(bytes.subarray(start, start + count))
      }
      if (type === 34) return Array.from({ length: count }, () => string().replace(/\0$/, ''))
      const dimensions = type === 35 ? 2 : type === 36 ? 3 : type >= 37 ? 4 : 1
      const wide = type === 31 || type === 33 || (type !== 37 && flags === 1)
      const width = wide ? 8 : 4
      if (count * dimensions * width > bytes.length - offset) throw new Error('Godot debugger packed array is truncated')
      const component = (): number | bigint => type === 30 ? bytes.readInt32LE(take(4)) : type === 31 ? int64() : wide ? bytes.readDoubleLE(take(8)) : bytes.readFloatLE(take(4))
      return Array.from({ length: count }, () => dimensions === 1 ? component() : Array.from({ length: dimensions }, component))
    }
    throw new Error(`Godot debugger unknown Variant type ${type}; the decoder carries Godot ${version}`)
  }
  const result = read(0)
  if (offset !== bytes.length) throw new Error('Godot debugger Variant has trailing bytes')
  return result
}

export function encodeGodotVariant(value: unknown): Buffer {
  const parts: Buffer[] = []
  let size = 0
  let values = 0
  const add = (part: Buffer): void => {
    size += part.length
    if (size > MAX_PACKET) throw new Error('Godot debugger command exceeds 8 MiB')
    parts.push(part)
  }
  const word = (n: number): void => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    add(b)
  }
  const write = (v: unknown, depth: number): void => {
    if (depth > 64 || ++values > MAX_VALUES) throw new Error('Godot debugger command exceeds nesting or value limit')
    if (v === null) word(0)
    else if (typeof v === 'boolean') { word(1); word(v ? 1 : 0) }
    else if (typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v))) {
      word(2 | 0x10000)
      const b = Buffer.alloc(8)
      b.writeBigInt64LE(BigInt(v))
      add(b)
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      word(3 | 0x10000)
      const b = Buffer.alloc(8)
      b.writeDoubleLE(v)
      add(b)
    } else if (typeof v === 'string') {
      word(4)
      const b = Buffer.from(v, 'utf8')
      word(b.length)
      add(b)
      add(Buffer.alloc((4 - b.length % 4) % 4))
    } else if (Array.isArray(v)) {
      word(28); word(v.length)
      for (const item of v) write(item, depth + 1)
    } else if (v && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null || v instanceof Map)) {
      const entries = v instanceof Map ? [...v.entries()] : Object.entries(v)
      word(27); word(entries.length)
      for (const [key, item] of entries) { write(key, depth + 1); write(item, depth + 1) }
    } else throw new Error('Godot debugger cannot encode this command Variant')
  }
  write(value, 0)
  return Buffer.concat(parts, size)
}

export function encodeGodotPacket(value: unknown): Buffer {
  const body = encodeGodotVariant(value)
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

export class GodotPacketDecoder {
  private header = Buffer.alloc(4)
  private headerBytes = 0
  private body: Buffer | null = null
  private bodyBytes = 0

  push(chunk: Buffer, receive: (message: unknown, bytes: number) => void): void {
    let offset = 0
    while (offset < chunk.length) {
      if (!this.body) {
        const n = Math.min(4 - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + n)
        this.headerBytes += n
        offset += n
        if (this.headerBytes < 4) continue
        const length = this.header.readUInt32LE(0)
        if (length < 4 || length > MAX_PACKET) throw new Error(`Godot debugger invalid packet length ${length}; maximum is 8 MiB`)
        this.body = Buffer.alloc(length)
        this.bodyBytes = 0
      }
      const n = Math.min(this.body.length - this.bodyBytes, chunk.length - offset)
      chunk.copy(this.body, this.bodyBytes, offset, offset + n)
      this.bodyBytes += n
      offset += n
      if (this.bodyBytes === this.body.length) {
        const message = decodeGodotVariant(this.body)
        const bytes = this.body.length
        this.body = null
        this.headerBytes = 0
        receive(message, bytes)
      }
    }
  }

  finish(): void {
    if (this.headerBytes || this.body) throw new Error('Godot debugger connection ended with a truncated packet')
  }
}

export interface GodotDebuggerMessage {
  name: string
  thread: number | bigint
  data: unknown[]
}

export class GodotDebuggerTransport {
  readonly token = randomBytes(24).toString('hex')
  port = 0
  connected = false
  accepted = false
  receivedBytes = 0
  error: string | null = null
  private server: Server
  private socket: Socket | null = null
  private closing = false

  constructor(private receive: (message: GodotDebuggerMessage) => void) {
    this.server = createServer(socket => {
      if (this.socket || this.closing) { socket.destroy(); return }
      this.socket = socket
      this.accepted = true
      socket.setNoDelay(true)
      const decoder = new GodotPacketDecoder()
      socket.on('data', bytes => {
        try {
          decoder.push(bytes, (raw, length) => {
            this.receivedBytes += length
            if (this.receivedBytes > 64 * 1024 * 1024) throw new Error('Godot debugger stream exceeds 64 MiB; shorten the sample window')
            if (!Array.isArray(raw) || raw.length !== 3 || typeof raw[0] !== 'string' || !(typeof raw[1] === 'bigint' || (typeof raw[1] === 'number' && Number.isSafeInteger(raw[1]))) || !Array.isArray(raw[2])) throw new Error('Godot debugger message must be [name, thread, data]')
            this.receive({ name: raw[0], thread: raw[1], data: raw[2] })
          })
        } catch (e) { this.fail(e) }
      })
      socket.on('error', e => { if (!this.closing) this.fail(e) })
      socket.on('end', () => { try { decoder.finish() } catch (e) { this.fail(e) } })
    })
    this.server.on('error', e => this.fail(e))
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') { reject(new Error('Godot debugger did not bind a loopback port')); return }
        this.port = address.port
        resolve()
      })
    })
  }

  send(name: string, thread: number | bigint, data: unknown[]): void {
    if (!this.socket || this.socket.destroyed || this.error) throw new Error(this.error ?? 'Godot debugger is not connected')
    if (this.socket.writableLength > MAX_PACKET) throw new Error('Godot debugger command queue exceeds 8 MiB')
    this.socket.write(encodeGodotPacket([name, thread, data]))
  }

  private fail(error: unknown): void {
    this.error ??= `Godot debugger refused: ${(error as Error).message}`
    this.socket?.destroy()
  }

  async close(): Promise<void> {
    this.closing = true
    this.socket?.destroy()
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}
