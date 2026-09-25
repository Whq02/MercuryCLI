#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
const JS_ROAD = process.argv.includes('--javascript-road')
if (JS_ROAD) process.env.MERCURY_IMAGE_PROCESSOR = 'javascript'

const resizer = await import('../../src/utils/imageResizer.ts')
const { ANTHROPIC_IMAGE_LIMITS } = await import('../../src/constants/apiLimits.ts')
const { imageDimensionsFromHeader } = await import('../../src/tools/FileReadTool/imageProcessorJs.ts')
const sharp = (await import('sharp')).default

let failures = 0
const tag = JS_ROAD ? '[js-road] ' : ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${tag}${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + tag + t)

type Part = { type: string; text?: string; source?: { type: string; media_type: string; data: string } }
type Result = { tool_use_id: string; type: 'tool_result'; content: Part[] }

const EDGE = ANTHROPIC_IMAGE_LIMITS.nativeLongEdgePx.standard
const standardTier = { limits: ANTHROPIC_IMAGE_LIMITS, model: 'claude-sonnet-4-5' }
const png = (width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: rgb } }).png().toBuffer()
const imagePart = (buffer: Buffer): Part => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') } })
const textPart = (text: string): Part => ({ type: 'text', text })
const result = (id: string, ...content: Part[]): Result => ({ tool_use_id: id, type: 'tool_result', content })
const texts = (block: Result): string[] => block.content.filter(part => part.type === 'text').map(part => part.text ?? '')
const images = (block: Result): Part[] => block.content.filter(part => part.type === 'image')
const sizeOf = (part: Part | undefined): { width: number; height: number } | null =>
  part?.source === undefined ? null : imageDimensionsFromHeader(Buffer.from(part.source.data, 'base64'))
const sizeWords = (size: { width: number; height: number } | null): string => (size === null ? 'unreadable' : `${size.width}x${size.height}`)
const shape = (block: Result): string =>
  block.content.map(part => (part.type === 'text' ? `text(${JSON.stringify(part.text)})` : `image(${sizeWords(sizeOf(part))})`)).join(', ')
const longEdge = (part: Part | undefined): number => {
  const size = sizeOf(part)
  return size === null ? Number.NaN : Math.max(size.width, size.height)
}
const atEdge = (part: Part | undefined): boolean => Math.abs(longEdge(part) - EDGE) <= 1
const NOTE = /^\[Image (\d+) of (\d+): (original dimensions: (\d+)x(\d+), displayed at: (\d+)x(\d+), multiply any coordinates you read off this image by [\d.]+ to map them onto the original)\]$/
type Note = { index: number; count: number; tail: string; original: string; delivered: string }
const parseNote = (text: string | undefined): Note | null => {
  const match = text === undefined ? null : NOTE.exec(text)
  if (match === null) return null
  return { index: Number(match[1]), count: Number(match[2]), tail: match[3]!, original: `${match[4]}x${match[5]}`, delivered: `${match[6]}x${match[7]}` }
}
const readRoadTail = (original: { width: number; height: number }, delivered: { width: number; height: number } | null): string => {
  const words = resizer.createImageMetadataText({
    originalWidth: original.width,
    originalHeight: original.height,
    displayWidth: delivered?.width,
    displayHeight: delivered?.height,
  })
  return words === null ? '' : words.slice('[Image: '.length, -1)
}
const countOf = (needle: string, haystack: string[]): number => haystack.reduce((n, text) => n + text.split(needle).length - 1, 0)

const big = await png(3000, 2000, { r: 200, g: 60, b: 60 })
const small = await png(320, 200, { r: 60, g: 60, b: 200 })
const other = await png(640, 400, { r: 60, g: 200, b: 60 })

section('§1 one image over the tool-result long edge gains one note with both pixel sizes')
{
  const block = result('t1', textPart('screenshot captured'), imagePart(big))
  await resizer.clampToolResultImageBlocks(block, standardTier)
  const delivered = images(block)[0]
  check(`the image is clamped to the ${EDGE} px long edge`, atEdge(delivered), sizeWords(sizeOf(delivered)))
  check('the result gains exactly one text part', texts(block).length === 2, `text parts after the clamp: ${texts(block).length} — ${shape(block)}`)
  check('the text part the tool wrote is untouched', texts(block)[0] === 'screenshot captured', shape(block))
  const note = parseNote(texts(block)[1])
  check('the note names image 1 of 1, the original 3000x2000 and the delivered size', note !== null && note.index === 1 && note.count === 1 && note.original === '3000x2000', `note: ${JSON.stringify(texts(block)[1])}`)
  check('the delivered size in the note is the size the block now carries', note !== null && note.delivered === sizeWords(sizeOf(delivered)), `note ${note?.delivered ?? 'none'} vs block ${sizeWords(sizeOf(delivered))}`)
  check('the words after the ordinal are the Read road grammar, byte for byte', note !== null && note.tail === readRoadTail({ width: 3000, height: 2000 }, sizeOf(delivered)), `note tail: ${JSON.stringify(note?.tail)}`)
  check('the note is appended after the image', block.content[1]?.type === 'image' && block.content[2]?.type === 'text', shape(block))
}

section('§2 an image under every cap gains nothing')
{
  const block = result('t2', textPart('captured'), imagePart(small))
  await resizer.clampToolResultImageBlocks(block, standardTier)
  check('the content keeps its two parts', block.content.length === 2 && texts(block).length === 1, shape(block))
  check('the image passes through byte-identical', images(block)[0]?.source?.data === small.toString('base64'))
  const corruptPayload = Buffer.from('not an image at all').toString('base64')
  const corrupt = result('t2c', imagePart(Buffer.from(corruptPayload, 'base64')))
  await resizer.clampToolResultImageBlocks(corrupt, standardTier)
  check('a corrupt image fails open with no note', corrupt.content.length === 1 && corrupt.content[0]?.source?.data === corruptPayload, shape(corrupt))
  const stringContent = { tool_use_id: 't2s', type: 'tool_result', content: 'plain text result' }
  await resizer.clampToolResultImageBlocks(stringContent, standardTier)
  check('a string-content result is untouched', stringContent.content === 'plain text result')
}

section('§3 a re-encode that keeps the pixel size says nothing; a scale-down says so')
{
  const flat = await png(1000, 800, { r: 250, g: 250, b: 240 })
  const tightBytes = { ...ANTHROPIC_IMAGE_LIMITS, maxBase64Bytes: flat.toString('base64').length - 4 }
  const block = result('t3', imagePart(flat))
  await resizer.clampToolResultImageBlocks(block, { limits: tightBytes, model: 'claude-sonnet-4-5' })
  const delivered = images(block)[0]
  const size = sizeOf(delivered)
  const changed = size !== null && (size.width !== 1000 || size.height !== 800)
  check('the image was re-encoded under the byte cap', delivered?.source?.data !== flat.toString('base64') && (delivered?.source?.data.length ?? Infinity) <= tightBytes.maxBase64Bytes, `${delivered?.source?.data.length} base64 chars vs cap ${tightBytes.maxBase64Bytes}`)
  check('a note appears exactly when the pixel size changed', texts(block).length === (changed ? 1 : 0), `delivered ${sizeWords(size)}, ${shape(block)}`)
  if (!JS_ROAD) check('on the native road the palette PNG keeps 1000x800 and gains no note', !changed && texts(block).length === 0, shape(block))
}

section('§4 several images: one line per resized image, naming its ordinal among the images')
{
  const block = result('t4', imagePart(small), textPart('between'), imagePart(big), imagePart(other))
  await resizer.clampToolResultImageBlocks(block, standardTier)
  check('exactly one text part is gained', texts(block).length === 2, `text parts after the clamp: ${texts(block).length} — ${shape(block)}`)
  const note = parseNote(texts(block)[1])
  check('the note names image 2 of 3', note !== null && note.index === 2 && note.count === 3 && note.original === '3000x2000', `note: ${JSON.stringify(texts(block)[1])}`)
  check('the other two images pass through byte-identical', images(block)[0]?.source?.data === small.toString('base64') && images(block)[2]?.source?.data === other.toString('base64'))
  check('the images keep their places and the note comes last', block.content.map(part => part.type).join(',') === 'image,text,image,image,text', shape(block))
  const all = result('t4b', imagePart(big), imagePart(big), imagePart(big))
  await resizer.clampToolResultImageBlocks(all, standardTier)
  const notes = texts(all).map(parseNote)
  check('three oversized images gain three notes, 1 of 3, 2 of 3, 3 of 3, in order', notes.length === 3 && notes.every((n, i) => n !== null && n.index === i + 1 && n.count === 3), shape(all))
}

section('§5 the roads that already speak are not double-noted')
{
  const fixtures = join(proofHome, 'fixtures')
  mkdirSync(fixtures, { recursive: true })
  const { FileReadTool, readImageWithTokenBudget } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const shotPath = join(fixtures, 'shot.png')
  writeFileSync(shotPath, big)
  const read = await readImageWithTokenBudget(shotPath)
  const readWords = read.file.dimensions ? (resizer.createImageMetadataText(read.file.dimensions, shotPath) ?? '') : ''
  const readBlock = FileReadTool.mapToolResultToToolResultBlockParam(read as never, 't5r') as unknown as Result
  check('the Read road maps its image alone and speaks in its own meta message', readBlock.content.length === 1 && readBlock.content[0]?.type === 'image' && readWords.startsWith('[Image: source: '), `${shape(readBlock)} / ${readWords}`)
  await resizer.clampToolResultImageBlocks(readBlock, standardTier)
  check(`the Read result over the long edge is clamped to ${EDGE} px and gains the one note`, atEdge(images(readBlock)[0]) && texts(readBlock).length === 1, shape(readBlock))
  check('across the Read words and the result the pixel sizes are stated once', countOf('original dimensions:', [readWords, ...texts(readBlock)]) === 1, `${readWords} + ${shape(readBlock)}`)

  const smallPath = join(fixtures, 'small.png')
  writeFileSync(smallPath, other)
  const readSmall = await readImageWithTokenBudget(smallPath)
  const smallBlock = FileReadTool.mapToolResultToToolResultBlockParam(readSmall as never, 't5s') as unknown as Result
  await resizer.clampToolResultImageBlocks(smallBlock, standardTier)
  check('a Read result under the caps gains nothing', smallBlock.content.length === 1 && images(smallBlock)[0]?.source?.data === readSmall.file.base64, shape(smallBlock))

  const browserLine = 'screenshot: /captures/page.png (https://example.invalid/, viewport 1280x720) (inlined copy downscaled to the image budget: 900KB on disk, ~120KB inlined)'
  const browser = result('t5b', textPart(browserLine), imagePart(big))
  await resizer.clampToolResultImageBlocks(browser, standardTier)
  check('the Browser byte note stays and the pixel note is stated once, after it', texts(browser)[0] === browserLine && texts(browser).length === 2 && countOf('original dimensions:', texts(browser)) === 1, shape(browser))

  const prepared = await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { role: 'tool-result', ...standardTier })
  const computer = result('t5c', textPart(`screenshot: /shots/display-0.png — display 0 (${sizeWords(sizeOf(imagePart(prepared.buffer)))} px of 1440x900 pt)`), imagePart(prepared.buffer))
  await resizer.clampToolResultImageBlocks(computer, standardTier)
  check('a result already fitted to the tool-result caps (the Computer and MCP roads) gains nothing', computer.content.length === 2 && images(computer)[0]?.source?.data === prepared.buffer.toString('base64'), shape(computer))
}

section('§6 the MCP converter shrinks before the block is minted and says so in the same words')
{
  const { transformResultContent } = await import('../../src/services/mcp/client.ts')
  const mcpImage = (buffer: Buffer): Record<string, unknown> => ({ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' })
  const mcpText = (text: string): Record<string, unknown> => ({ type: 'text', text })
  const mcpBlob = (buffer: Buffer): Record<string, unknown> => ({ type: 'resource', resource: { uri: 'shot://one', blob: buffer.toString('base64'), mimeType: 'image/png' } })
  const one = { tool_use_id: 'm1', type: 'tool_result' as const, content: (await transformResultContent([mcpImage(big), mcpText('a picture')], 'fixture')) as Part[] }
  const delivered = images(one)[0]
  check('the converter shrinks the image to the native long edge before the block is minted', longEdge(delivered) <= ANTHROPIC_IMAGE_LIMITS.nativeLongEdgePx.highResolution && longEdge(delivered) < 3000, sizeWords(sizeOf(delivered)))
  check('the caption stays and the result gains exactly one note', texts(one).length === 2 && texts(one)[0] === 'a picture', shape(one))
  const note = parseNote(texts(one)[1])
  check('the note names image 1 of 1 with the true original 3000x2000 and the delivered size', note !== null && note.index === 1 && note.count === 1 && note.original === '3000x2000' && note.delivered === sizeWords(sizeOf(delivered)), `note: ${JSON.stringify(texts(one)[1])}`)
  check('the words after the ordinal are the Read road grammar, byte for byte', note !== null && note.tail === readRoadTail({ width: 3000, height: 2000 }, sizeOf(delivered)), `note tail: ${JSON.stringify(note?.tail)}`)
  const before = shape(one)
  await resizer.clampToolResultImageBlocks(one, { limits: ANTHROPIC_IMAGE_LIMITS, model: 'claude-sonnet-5' })
  check('the settlement clamp then finds the MCP image fitting and adds no second note', shape(one) === before, shape(one))
  const two = { tool_use_id: 'm2', type: 'tool_result' as const, content: (await transformResultContent([mcpImage(small), mcpText('between'), mcpBlob(big)], 'fixture')) as Part[] }
  const twoNote = parseNote(texts(two)[texts(two).length - 1] ?? '')
  check('an image resource blob counts as an image: the note names 2 of 2 and the resource marker stays', twoNote !== null && twoNote.index === 2 && twoNote.count === 2 && twoNote.original === '3000x2000' && texts(two).some(text => text.startsWith('Resource from fixture at shot://one')) && images(two)[0]?.source?.data === small.toString('base64'), shape(two))
  const under = { tool_use_id: 'm3', type: 'tool_result' as const, content: (await transformResultContent([mcpImage(small), mcpText('a picture')], 'fixture')) as Part[] }
  check('an MCP image under every cap gains nothing', under.content.length === 2 && images(under)[0]?.source?.data === small.toString('base64'), shape(under))
}

if (JS_ROAD) {
  console.log(failures === 0 ? '\n✅ [js-road] the note holds on the JavaScript road' : `\n❌ [js-road] ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

section('§7 the JavaScript road, in a child process with the road forced')
{
  const child = spawnSync(process.execPath, ['run', import.meta.path, '--javascript-road'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MERCURY_IMAGE_PROCESSOR: 'javascript' } })
  process.stdout.write(child.stdout)
  if (child.status !== 0) process.stdout.write(child.stderr.slice(-1500))
  check('the JavaScript road holds the same law (child exit 0)', child.status === 0, `exit ${child.status}`)
}

rmSync(proofHome, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ a downscaled tool-result image says so' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
