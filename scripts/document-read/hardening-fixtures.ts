import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import assert from 'node:assert/strict'

export { pdfFixture, textPage } from './fixtures.ts'

export function zip(parts: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [name, value] of Object.entries(parts)) {
    const data = Buffer.from(value), packed = deflateRawSync(data), filename = Buffer.from(name)
    let crc = 0xffffffff
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42)
    local.push(h, filename, packed); central.push(c, filename); offset += h.length + filename.length + packed.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}

export function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `document-${name}-`))
  process.env.MERCURY_CONFIG_DIR = join(root, 'home')
  delete process.env.MERCURY_HOME
  delete process.env.MERCURY_CRITTER
  process.env.MERCURY_BARE = '1'
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.1' }
  return root
}

export async function reader(root: string) {
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const context: any = { options: { engineModel: 'glm-5.3' }, readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
  async function read(file: string, options: object = {}) {
    const result = await FileReadTool.call({ file_path: file, ...options }, context, undefined as any, { uuid: crypto.randomUUID() } as any)
    assert.equal(result.data.type, 'text')
    return (result.data as any).file.content as string
  }
  let healthReads = 0
  async function healthy() {
    const path = join(root, `healthy-${++healthReads}.txt`)
    writeFileSync(path, 'The session can still read.\n')
    assert.match(await read(path), /The session can still read\./)
  }
  return { read, healthy, context }
}
export function cleanup(root: string) { rmSync(root, { recursive: true, force: true }) }
