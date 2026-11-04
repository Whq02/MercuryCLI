import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[arg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'image-mention-dropped-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

function crc32(bytes: Uint8Array): number {
  let crc = -1
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ -1) >>> 0
}
function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
function garbagePng(width: number, height: number, bodyBytes: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.concat([Buffer.from([0x78, 0x9c, 0x01]), randomBytes(bodyBytes)])), chunk('IEND', new Uint8Array())])
}

try {
  const { processAtMentionedFiles } = await import(`${root}/src/utils/attachments/mentionResolvers.ts`)
  const { normalizeAttachmentForAPI } = await import(`${root}/src/utils/messages/attachmentText.ts`)
  const context = {
    getAppState() { return { toolPermissionContext: { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map() } } },
    options: {},
    readFileState: new Map(),
    abortController: new AbortController(),
    nestedMemoryAttachmentTriggers: new Set(),
  }
  const roads = [
    { name: 'the mention byte cap', file: 'over-cap.png', bytes: 5 * 1024 * 1024, reason: 'over the 256KB limit for a mentioned file' },
  ]
  for (const road of roads) {
    const file = join(scratch, road.file)
    writeFileSync(file, garbagePng(6000, 6000, road.bytes))
    const rows = await processAtMentionedFiles(`describe @${file}`, context as never)
    assert.equal(rows.length, 1, `${road.name}: an image mention whose image cannot be attached yields one row, not silence: ${JSON.stringify(rows).slice(0, 300)}`)
    const row = rows[0] as { type: string; filename: string; displayPath: string; reason: string }
    assert.equal(row.type, 'dropped_image_file', `${road.name}: the row is the dropped-image row, not a file row: ${JSON.stringify(row).slice(0, 200)}`)
    assert.equal(row.filename, file)
    assert.ok(row.reason.includes(road.reason), `${road.name}: the reason says why: ${row.reason}`)
    const text = JSON.stringify(normalizeAttachmentForAPI(row as never))
    assert.ok(text.includes('could not be attached and was dropped from this turn'), `${road.name}: the model is told the image was dropped: ${text.slice(0, 300)}`)
    assert.ok(text.includes(row.reason), `${road.name}: the model is told why`)
    console.log(`PASS ${road.name}: dropped with a visible row — ${row.reason}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
