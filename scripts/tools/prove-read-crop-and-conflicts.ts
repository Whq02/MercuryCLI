#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'read-crop-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { unresolvedConflictBlocks } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { imageDimensionsFromHeader } = await import('../../src/tools/FileReadTool/imageProcessorJs.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 400 ? `${detail.slice(0, 400)}…` : detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, body: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(body)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))])
}

const fixtures = mkdtempSync(join(tmpdir(), 'read-crop-fixture-'))
const wide = join(fixtures, 'wide.png')
writeFileSync(wide, png(9000, 40, (x, y) => (x < 200 ? [255, 0, 0] : x < 400 ? [0, 255, 0] : [(x + y) % 256, 0, 255])))
const small = join(fixtures, 'small.png')
writeFileSync(small, png(8, 4, (x) => (x < 4 ? [10, 20, 30] : [200, 210, 220])))

function makeContext(): unknown {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  }
}
type ImageData = { type: string; file: { base64: string; type: string; dimensions?: { originalWidth: number; originalHeight: number; displayWidth: number; displayHeight: number } } }
type Outcome = { ok: true; data: ImageData; notes: string[] } | { ok: false; message: string }
let serial = 0
async function read(input: Record<string, unknown>): Promise<Outcome> {
  serial++
  const context = makeContext()
  const verdict = await (FileReadTool as { validateInput: Function }).validateInput(input, context)
  if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  try {
    const result = await (FileReadTool as { call: Function }).call(input, context, null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_crop_${serial}` } })
    const notes = ((result.newMessages ?? []) as Array<{ message?: { content?: unknown } }>).map(m => (typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content ?? '')))
    return { ok: true, data: result.data as ImageData, notes }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const sizeOf = (data: ImageData): { width: number; height: number } | null => {
  const header = imageDimensionsFromHeader(Buffer.from(data.file.base64, 'base64'))
  return header === null ? null : { width: header.width, height: header.height }
}
const messageOf = (o: Outcome): string => (o.ok ? `(landed) ${JSON.stringify(o.data.file.dimensions)} ${o.notes.join(' | ')}` : o.message)

section('A. a crop box is cut from the original pixels before any downscale')
{
  const whole = await read({ file_path: wide })
  check('A1 the 9000x40 image read whole is downscaled to the provider caps (8000 px per side)', whole.ok && (sizeOf(whole.data)?.width ?? 9000) < 9000, messageOf(whole))
  const crop = await read({ file_path: wide, crop: [0, 0, 200, 40] })
  check('A2 the crop [0, 0, 200, 40] comes back at its full 200x40 resolution', crop.ok && sizeOf(crop.data)?.width === 200 && sizeOf(crop.data)?.height === 40, messageOf(crop))
  check('A3 the result names the crop, the original size and that the cut came before any downscale', crop.ok && crop.notes.some(note => note.includes('the crop [0, 0, 200, 40] of') && note.includes('9000x40 px original before any downscale')), messageOf(crop))
  const other = await read({ file_path: wide, crop: [200, 0, 400, 40] })
  check('A4 a different box yields different pixels (the green band, not the red one)', other.ok && crop.ok && other.data.file.base64 !== crop.data.file.base64 && sizeOf(other.data)?.width === 200, messageOf(other))
  const tiny = await read({ file_path: small, crop: [4, 0, 8, 4] })
  check('A5 a box on a small image is exact to the pixel (8x4 to the right 4x4)', tiny.ok && sizeOf(tiny.data)?.width === 4 && sizeOf(tiny.data)?.height === 4, messageOf(tiny))
  const full = await read({ file_path: small, crop: [0, 0, 8, 4] })
  check('A6 a box that is the whole image is the whole image', full.ok && sizeOf(full.data)?.width === 8 && sizeOf(full.data)?.height === 4, messageOf(full))
  const { javascriptImageProcessor } = await import('../../src/tools/FileReadTool/imageProcessorJs.ts')
  const jsCrop = await javascriptImageProcessor(readFileSync(small)).extract({ left: 4, top: 0, width: 4, height: 4 }).toBuffer()
  check('A8 the JavaScript road (no native processor) crops the same box to 4x4', imageDimensionsFromHeader(jsCrop)?.width === 4 && imageDimensionsFromHeader(jsCrop)?.height === 4)
  const plain = await read({ file_path: small })
  check('A7 a read without a box is unchanged (the control: 8x4, no crop note)', plain.ok && sizeOf(plain.data)?.width === 8 && !plain.notes.some(note => note.includes('the crop [')), messageOf(plain))
}

section('B. refusals: outside the image, inverted, malformed, or on a text file')
{
  const outside = await read({ file_path: small, crop: [0, 0, 9, 4] })
  check('B1 a box past the right edge is refused naming the image size', !outside.ok && outside.message.includes('crop refused: [0, 0, 9, 4] reaches outside the image, which is 8x4 px'), messageOf(outside))
  const below = await read({ file_path: small, crop: [0, 0, 8, 5] })
  check('B2 a box past the bottom edge is refused', !below.ok && below.message.includes('reaches outside the image'), messageOf(below))
  const inverted = await read({ file_path: small, crop: [6, 0, 2, 4] })
  check('B3 an inverted box is refused', !inverted.ok && inverted.message.includes('crop refused: [6, 0, 2, 4] is inverted or empty'), messageOf(inverted))
  const empty = await read({ file_path: small, crop: [2, 2, 2, 4] })
  check('B4 an empty box is refused', !empty.ok && empty.message.includes('is inverted or empty'), messageOf(empty))
  const negative = await read({ file_path: small, crop: [-1, 0, 4, 4] })
  check('B5 a negative coordinate is refused', !negative.ok, messageOf(negative))
  const fraction = await read({ file_path: small, crop: [0.5, 0, 4, 4] })
  check('B6 a fractional coordinate is refused', !fraction.ok, messageOf(fraction))
  const three = await read({ file_path: small, crop: [0, 0, 4] })
  check('B7 three numbers are refused (the box is four)', !three.ok, messageOf(three))
  const text = join(fixtures, 'notes.txt')
  writeFileSync(text, 'plain\n')
  const onText = await read({ file_path: text, crop: [0, 0, 1, 1] })
  check('B8 a crop on a text file is never refused: the file is read and one note says crop was ignored', onText.ok && (onText.data as unknown as { type: string }).type === 'text' && onText.notes.some(note => note.includes('crop ignored — .txt is not an image') && note.includes('Send crop only for an image file')), messageOf(onText))
  const onTextPages = await read({ file_path: text, pages: '1-2' })
  check('B8b pages on a text file is never refused: the file is read and one note says pages was ignored', onTextPages.ok && onTextPages.notes.some(note => note.includes('pages ignored — .txt is not a PDF')), messageOf(onTextPages))
  check('B9 the refusals wrote nothing and the image is intact', readFileSync(small).length > 0 && imageDimensionsFromHeader(readFileSync(small))?.width === 8)
}

section('D. the zero box [0, 0, 0, 0] is no crop at all (the placeholder a model fills an unused box with)')
{
  const zeroOnImage = await read({ file_path: small, crop: [0, 0, 0, 0] })
  check('D1 on an image the zero box reads the whole image, no refusal, no crop note (8x4 as the control)', zeroOnImage.ok && sizeOf(zeroOnImage.data)?.width === 8 && sizeOf(zeroOnImage.data)?.height === 4 && !zeroOnImage.notes.some(note => note.includes('the crop [')), messageOf(zeroOnImage))
  const text = join(fixtures, 'zero.txt')
  writeFileSync(text, 'plain\n')
  const zeroOnText = await read({ file_path: text, crop: [0, 0, 0, 0] })
  check('D2 on a text file the zero box reads the file with no "crop ignored" note (there was no crop to ignore)', zeroOnText.ok && (zeroOnText.data as unknown as { type: string }).type === 'text' && !zeroOnText.notes.some(note => note.includes('crop ignored')), messageOf(zeroOnText))
  const threeZeros = await read({ file_path: small, crop: [0, 0, 0] })
  check('D3 three zeros are not the zero box: still refused (the box is four numbers)', !threeZeros.ok, messageOf(threeZeros))
  const emptyNonZero = await read({ file_path: small, crop: [2, 2, 2, 4] })
  check('D4 an empty box with real coordinates is still refused (B4 holds: only the all-zero box is a placeholder)', !emptyNonZero.ok && emptyNonZero.message.includes('is inverted or empty'), messageOf(emptyNonZero))
}

section('C. unresolved merge-conflict blocks in the lines returned are counted in one line, the bytes untouched')
{
  const conflicted = join(fixtures, 'merge.ts')
  const body = ['const a = 1', '<<<<<<< HEAD', 'const b = 2', '=======', 'const b = 3', '>>>>>>> feature', 'const c = 4', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> other', 'tail'].join('\n') + '\n'
  writeFileSync(conflicted, body)
  const whole = await read({ file_path: conflicted })
  const text = whole.ok ? (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(whole.data, 'toolu_c').content as string : ''
  check('C1 two blocks are counted in one line after the numbered lines', text.includes('\n[2 unresolved merge-conflict blocks (<<<<<<< ======= >>>>>>>) in the lines returned — resolve them before relying on this content]'), text)
  const numbered = text.split('\n').filter(line => /^\d+\t/.test(line)).map(line => line.replace(/^\d+\t/, ''))
  check('C2 the returned lines are the file\'s bytes, markers included, nothing altered', numbered.join('\n') + '\n' === body, JSON.stringify(numbered))
  const window = await read({ file_path: conflicted, offset: 7, limit: 1 })
  const windowText = window.ok ? (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(window.data, 'toolu_w').content as string : ''
  check('C3 a window that carries no block carries no count line', !windowText.includes('unresolved merge-conflict'), windowText)
  const one = await read({ file_path: conflicted, offset: 1, limit: 7 })
  const oneText = one.ok ? (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(one.data, 'toolu_o').content as string : ''
  check('C4 a window with one whole block says one block, singular', oneText.includes('[1 unresolved merge-conflict block (<<<<<<< ======= >>>>>>>) in the lines returned'), oneText)
  check('C5 the counter needs the closing marker: an opener alone is not a block, and seven characters inside a line are not a marker', unresolvedConflictBlocks('<<<<<<< HEAD\nbody\n') === 0 && unresolvedConflictBlocks('a <<<<<<< b\n=======\n>>>>>>> c\n') === 0 && unresolvedConflictBlocks('<<<<<<<\n=\n>>>>>>>\n') === 1)
  const clean = join(fixtures, 'clean.ts')
  writeFileSync(clean, 'const ok = true\n')
  const cleanRead = await read({ file_path: clean })
  const cleanText = cleanRead.ok ? (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(cleanRead.data, 'toolu_k').content as string : ''
  check('C6 a clean file reads as before (the control)', cleanText.startsWith('1\tconst ok = true') && !cleanText.includes('merge-conflict'), cleanText)
}

rmSync(fixtures, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  console.log('RED: prove-read-crop-and-conflicts.ts')
  process.exit(1)
}
console.log('\nALL GREEN')
