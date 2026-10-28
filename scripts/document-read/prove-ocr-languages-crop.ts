import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'ocr-languages-crop-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_PACK_DIR = resolve(import.meta.dir, '../../vendor/desktop', `${process.platform}-${process.arch}`)
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getImageProcessor } = await import('../../src/tools/FileReadTool/imageProcessor.ts')
const { resolveOcrEngine } = await import('../../src/utils/ocr.ts')
const context = () => ({ options: { engineModel: 'claude-sonnet-5-5' }, abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(100), messages: [], getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }) as never
const normalise = (s: string) => s.normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640\u200e\u200f\u202a-\u202e\u2066-\u2069\s.،]/g, '')
try {
  const sharp = await getImageProcessor()
  const arabic = 'هذه وثيقة ملكية الأرض'
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="500"><rect width="1800" height="500" fill="white"/><text x="1700" y="220" font-size="110" font-family="Geeza Pro" direction="rtl" text-anchor="start" fill="black">${arabic}</text></svg>`)
  const bytes = await sharp(svg).png().toBuffer()
  const path = join(root, 'arabic.png')
  writeFileSync(path, bytes)
  const crop = [100, 50, 900, 450]
  const image = await FileReadTool.call({ file_path: path, crop, scale: 2 }, context())
  assert.equal(image.data.type, 'image')
  assert.equal(image.newMessages?.length ?? 0, 0)
  const block = FileReadTool.mapToolResultToToolResultBlockParam(image.data, 'crop-call')
  assert.ok(Array.isArray(block.content))
  const caption = block.content.find((part: any) => part.type === 'text') as any
  assert.match(caption?.text ?? '', /This image is the crop \[100, 50, 900, 450\]/)
  assert.match(caption.text, /scaled by 2/)
  const pic = block.content.find((part: any) => part.type === 'image') as any
  const metadata = await sharp(Buffer.from(pic.source.data, 'base64')).metadata()
  assert.equal(metadata.width, 1600)
  assert.equal(metadata.height, 800)
  const persisted = FileReadTool.outputSchema.parse(JSON.parse(JSON.stringify(image.data)))
  assert.deepEqual(FileReadTool.mapToolResultToToolResultBlockParam(persisted, 'crop-call'), block)
  if (process.platform === 'darwin') {
    const engine = await resolveOcrEngine()
    assert.equal(engine.kind, 'native')
    assert.ok(engine.languages.includes('ar-SA'))
    const text = await FileReadTool.call({ file_path: path, ocr: true }, context())
    assert.equal(text.data.type, 'text')
    assert.match(text.data.file.content, /languages:.*ar-SA/)
    const recognised = text.data.file.content.split('\n').slice(1).join('\n')
    assert.equal(normalise(recognised), normalise(arabic))
    console.log(`PASS real Arabic Vision OCR: ${recognised}`)
  }
  console.log('PASS crop metadata stays inside the tool result, scale doubles pixels, caption survives persistence and language sets are named')
} finally { rmSync(root, { recursive: true, force: true }) }
