#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-image-types-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME

const { transformMCPResult } = await import('../../src/integrations/mcp/client.ts')
const sharp = (await import('sharp')).default

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
type Block = { type?: string; text?: string; source?: { media_type?: string; data?: string } }
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
const imagesOf = (content: unknown): Block[] => blocksOf(content).filter(b => b.type === 'image')
const textsOf = (content: unknown): string[] => blocksOf(content).filter(b => b.type === 'text').map(b => b.text ?? '')
const savedPath = (text: string): string | null => /saved to (\S+)$/.exec(text)?.[1] ?? null
const image = (data: Buffer, mimeType: string) => ({ type: 'image', data: data.toString('base64'), mimeType })

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const JPEG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toBuffer()
const WEBP = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } }).webp().toBuffer()
const WIDE = await sharp({ create: { width: 3200, height: 120, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer()

console.log('MCP image blocks: only what the model APIs accept rides as an image; the rest is saved and named')

console.log('\n[1] media types the APIs refuse are saved to disk with their own extension, never forwarded as an image')
const refused: Array<[string, Buffer, string]> = [
  ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'), 'svg'],
  ['image/tiff', Buffer.from('II*\0' + 'x'.repeat(60)), 'tiff'],
  ['image/heic', Buffer.from('....ftypheic' + 'x'.repeat(60)), 'heic'],
  ['image/bmp', Buffer.from('BM' + 'x'.repeat(60)), 'bmp'],
  ['image/x-weird', Buffer.from('garbage-not-an-image-' + 'z'.repeat(60)), 'bin'],
]
for (const [mime, bytes, ext] of refused) {
  const out = await transformMCPResult({ content: [image(bytes, mime)] }, 'shot', 'srv')
  const texts = textsOf(out.content)
  const path = savedPath(texts[0] ?? '')
  check(`${mime}: no image block, isImage false`, imagesOf(out.content).length === 0 && out.isImage !== true, `${JSON.stringify(out.content).slice(0, 160)} — pushImage and forwardableImage in src/integrations/mcp/client/results.ts must send a media type outside IMAGE_MIME_TYPES to persistBlob, never forward it as an image block`)
  check(`${mime}: one text block names the source, the type, the size and the saved path`, texts.length === 1 && texts[0]!.startsWith('Image from srv: binary content (') && texts[0]!.includes(mime) && path !== null, `${texts[0]} — the saved-blob text must read Image from <server>: binary content (<type>, <size>) saved to <path>; see persistBlob and pushImage in src/integrations/mcp/client/results.ts and the text built in src/integrations/mcp/mcpOutputStorage.ts`)
  check(`${mime}: the file is on disk as .${ext} with the bytes the server sent`, path !== null && path.endsWith(`.${ext}`) && existsSync(path) && readFileSync(path).equals(bytes), `${path ?? 'no path'} — persistBlob in src/integrations/mcp/client/results.ts (with src/integrations/mcp/mcpOutputStorage.ts) must write the exact bytes the server sent under an extension that matches the media type`)
}

console.log('\n[2] undecodable bytes behind an accepted label are saved too, never forwarded')
{
  const out = await transformMCPResult({ content: [image(Buffer.from('not a png at all, just text' + 'q'.repeat(40)), 'image/png')] }, 'shot', 'srv')
  check('garbage labelled image/png is not forwarded as an image', imagesOf(out.content).length === 0 && textsOf(out.content).some(t => t.startsWith('Image from srv: binary content (image/png')), `${JSON.stringify(out.content).slice(0, 160)} — forwardableImage in src/integrations/mcp/client/results.ts must return null for bytes that cannot be decoded so pushImage saves them`)
}

console.log('\n[3] accepted images ride as images, with the type the bytes really are')
{
  for (const [label, bytes, mime, expected] of [
    ['a PNG', PNG, 'image/png', 'image/png'],
    ['a JPEG', JPEG, 'image/jpeg', 'image/jpeg'],
    ['a WebP', WEBP, 'image/webp', 'image/webp'],
    ['PNG bytes labelled image/jpeg', PNG, 'image/jpeg', 'image/png'],
    ['PNG bytes labelled image/x-weird', PNG, 'image/x-weird', 'image/png'],
  ] as const) {
    const out = await transformMCPResult({ content: [image(bytes, mime)] }, 'shot', 'srv')
    const img = imagesOf(out.content)
    check(`${label} rides as ${expected}`, img.length === 1 && img[0]!.source?.media_type === expected && out.isImage === true, `${JSON.stringify(out.content).slice(0, 120)} — resizedImageBlock and forwardableImage in src/integrations/mcp/client/results.ts must forward an accepted image with the media type the bytes really are`)
  }
}

console.log('\n[4] the image note counts the images that ride, not the blocks that were saved')
{
  const out = await transformMCPResult({ content: [image(refused[0]![1], 'image/svg+xml'), image(WIDE, 'image/png'), image(refused[1]![1], 'image/tiff'), { type: 'text', text: 'done' }] }, 'shot', 'srv')
  const img = imagesOf(out.content)
  const notes = textsOf(out.content).filter(t => t.startsWith('[Image '))
  check('one image rides, two blobs are saved, the server text stays', img.length === 1 && textsOf(out.content).filter(t => t.startsWith('Image from srv')).length === 2 && textsOf(out.content).includes('done'), `${JSON.stringify(out.content).slice(0, 200)} — pushImage in src/integrations/mcp/client/results.ts must forward only the accepted image and save the other two, keeping the server text`)
  check('the note, if the wide image was resized, says Image 1 of 1', notes.length === 0 || notes.every(n => n.startsWith('[Image 1 of 1:')), `${notes.join(' | ')} — the image count passed to createImageMetadataText in src/integrations/mcp/client/results.ts must count only forwarded images, not saved blobs`)
  check('the result is marked as carrying an image', out.isImage === true, 'transformMCPResult in src/integrations/mcp/client/results.ts must set isImage when any block in the result is an image')
}

console.log(failures === 0 ? '\nPASS prove-image-block-media-types' : `\nFAIL prove-image-block-media-types (${failures})`)
process.exit(failures === 0 ? 0 : 1)
