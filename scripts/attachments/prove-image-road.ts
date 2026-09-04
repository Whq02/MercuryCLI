#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const JS_ROAD = process.argv.includes('--javascript-road')
const HOME = mkdtempSync(join(tmpdir(), JS_ROAD ? 'mercury-image-road-js-' : 'mercury-image-road-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
if (JS_ROAD) process.env.MERCURY_IMAGE_PROCESSOR = 'javascript'

const limitsMod = await import('../../src/constants/apiLimits.ts')
const resizer = await import('../../src/utils/imageResizer.ts')
const processor = await import('../../src/tools/FileReadTool/imageProcessor.ts')
const jsRoad = await import('../../src/tools/FileReadTool/imageProcessorJs.ts')
const sharp = (await import('sharp')).default

let failures = 0
const tag = JS_ROAD ? '[js-road] ' : ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${tag}${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + tag + t)
const MiB = 1024 * 1024
const base64Len = (raw: number): number => Math.ceil(raw / 3) * 4

const FIX = join(HOME, 'fixtures')
mkdirSync(FIX, { recursive: true })
const flatSvg = Buffer.from(
  `<svg width="4000" height="3000" xmlns="http://www.w3.org/2000/svg"><rect width="4000" height="3000" fill="#f4f4f0"/>` +
    Array.from({ length: 60 }, (_, i) => `<rect x="120" y="${80 + i * 48}" width="${800 + ((i * 137) % 2600)}" height="22" fill="#${i % 3 === 0 ? '2b2b2b' : i % 3 === 1 ? '3355aa' : '777777'}"/>`).join('') +
    `</svg>`,
)
const flat = await sharp(flatSvg).png().toBuffer()
const wide = await sharp({ create: { width: 9000, height: 1000, channels: 3, background: { r: 240, g: 240, b: 235 } } }).png().toBuffer()
const noise = await sharp({ create: { width: 4000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png({ compressionLevel: 6 }).toBuffer()
const noiseJpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).jpeg({ quality: 100 }).toBuffer()
const smallJpeg = await sharp(flatSvg).resize(1200, 900).jpeg({ quality: 85 }).toBuffer()
const tiny = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } }).png().toBuffer()
const dims = async (buffer: Buffer): Promise<{ width: number; height: number; format: string }> => {
  const meta = await sharp(buffer).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0, format: meta.format ?? '' }
}

if (!JS_ROAD) {
  section('§1 the limits table is the providers\' published numbers')
  const A = limitsMod.ANTHROPIC_IMAGE_LIMITS
  check('anthropic: 8000 px per side', A.maxSidePx === 8000)
  check('anthropic: 2000 px per side above 20 images', A.manyImages?.threshold === 20 && A.manyImages.maxSidePx === 2000)
  check('anthropic: 10 MB base64 per image on the Claude API', A.maxBase64Bytes === 10 * MiB)
  check('anthropic: 1568 px standard tier · 2576 px high-resolution tier', A.nativeLongEdgePx.standard === 1568 && A.nativeLongEdgePx.highResolution === 2576)
  check('anthropic: tool results are validated, not downscaled', A.toolResultRejectsAboveNative === true)
  check('anthropic: 100 images per request · 32 MB request', A.maxImagesPerRequest === 100 && A.maxRequestBytes === 32 * MiB)
  check('anthropic: the vision page is cited', A.doc === 'https://platform.claude.com/docs/en/build-with-claude/vision')
  const O = limitsMod.OPENAI_IMAGE_LIMITS
  check('openai: no per-side rejection · 2048 px detail box · 512 MB payload · 1500 images', O.maxSidePx === null && O.nativeLongEdgePx.standard === 2048 && O.maxRequestBytes === 512 * MiB && O.maxImagesPerRequest === 1500)
  check('openai: the images-vision guide is cited', O.doc === 'https://developers.openai.com/api/docs/guides/images-vision')
  const G = limitsMod.GEMINI_IMAGE_LIMITS
  check('gemini: no pixel ceiling · 20 MB inline request · 3600 images · 768 px tiles', G.maxSidePx === null && G.maxBase64Bytes === 20 * MiB && G.maxImagesPerRequest === 3600 && G.nativeLongEdgePx.standard === 768)
  check('gemini: the image-understanding page is cited', G.doc === 'https://ai.google.dev/gemini-api/docs/image-understanding')
  const X = limitsMod.GENERIC_IMAGE_LIMITS
  check('generic: the strictest documented figures (8000 px · 2000 px above 20 · 5 MB partner cap)', X.maxSidePx === 8000 && X.manyImages?.maxSidePx === 2000 && X.maxBase64Bytes === 5 * MiB)
  check('the strictest base64 ceiling is the generic family\'s', limitsMod.STRICTEST_IMAGE_MAX_BASE64_BYTES === 5 * MiB)
  const source = await import('node:fs').then(fs => fs.readFileSync(join(ROOT, 'src', 'constants', 'apiLimits.ts'), 'utf8'))
  check('no harness-invented width survives (no IMAGE_MAX_WIDTH owner)', !/IMAGE_MAX_WIDTH|IMAGE_MAX_HEIGHT/.test(source))

  section('§2 a model id resolves to its family and tier')
  check('claude-sonnet-5 → anthropic', resizer.imageLimitsForModel('claude-sonnet-5').family === 'anthropic')
  check('gpt-5.5 → openai', resizer.imageLimitsForModel('gpt-5.5').family === 'openai')
  check('gemini-2.5-pro → gemini', resizer.imageLimitsForModel('gemini-2.5-pro').family === 'gemini')
  check('an unrecognised id → generic', resizer.imageLimitsForModel('llama-something-odd').family === 'generic')
  check('no id → generic', resizer.imageLimitsForModel(undefined).family === 'generic')
  check('claude-opus-4-7 → high-resolution', resizer.anthropicResolutionTier('claude-opus-4-7') === 'highResolution')
  check('claude-fable-5-1 → high-resolution', resizer.anthropicResolutionTier('claude-fable-5-1') === 'highResolution')
  check('claude-sonnet-4-5 → standard', resizer.anthropicResolutionTier('claude-sonnet-4-5') === 'standard')
  check('claude-haiku-4-5-20251001 → standard', resizer.anthropicResolutionTier('claude-haiku-4-5-20251001') === 'standard')
  check('claude-3-5-sonnet-20241022 → standard', resizer.anthropicResolutionTier('claude-3-5-sonnet-20241022') === 'standard')
  check('an alias without a generation → standard (the conservative clamp)', resizer.anthropicResolutionTier('opus') === 'standard')
}

section('§3 shrink, never refuse')
{
  const A = limitsMod.ANTHROPIC_IMAGE_LIMITS
  const resize = resizer.maybeResizeAndDownsampleImageBuffer
  const flatOut = await resize(flat, flat.length, 'png', { limits: A })
  const flatDims = await dims(flatOut.buffer)
  check('a 4000x3000 PNG within the limits passes through at its own size', flatDims.width === 4000 && flatDims.height === 3000 && flatOut.buffer.equals(flat), `${flatDims.width}x${flatDims.height}`)
  check('…and the dimensions record says so', flatOut.dimensions?.originalWidth === 4000 && flatOut.dimensions.displayWidth === 4000)

  const wideOut = await resize(wide, wide.length, 'png', { limits: A })
  const wideDims = await dims(wideOut.buffer)
  check('a 9000x1000 PNG shrinks to the 8000 px side (never refused)', wideDims.width === 8000 && wideDims.height === Math.round((1000 * 8000) / 9000), `${wideDims.width}x${wideDims.height}`)
  check('…the record names original and displayed sizes', wideOut.dimensions?.originalWidth === 9000 && wideOut.dimensions.displayWidth === wideDims.width)

  const manyOut = await resize(flat, flat.length, 'png', { limits: A, imagesInRequest: 25 })
  const manyDims = await dims(manyOut.buffer)
  check('above 20 images in the request the 2000 px rule applies', manyDims.width <= 2000 && manyDims.height <= 2000 && manyDims.width > 1900, `${manyDims.width}x${manyDims.height}`)
  const fewOut = await resize(flat, flat.length, 'png', { limits: A, imagesInRequest: 20 })
  check('at 20 images it does not', (await dims(fewOut.buffer)).width === 4000)

  const toolHigh = await resize(flat, flat.length, 'png', { limits: A, role: 'tool-result', model: 'claude-sonnet-5' })
  const toolHighDims = await dims(toolHigh.buffer)
  check('a tool result clamps to the high-resolution tier long edge (2576)', Math.max(toolHighDims.width, toolHighDims.height) <= 2576 && toolHighDims.width > 2500, `${toolHighDims.width}x${toolHighDims.height}`)
  const toolStd = await resize(flat, flat.length, 'png', { limits: A, role: 'tool-result', model: 'claude-sonnet-4-5' })
  const toolStdDims = await dims(toolStd.buffer)
  check('…and to the standard tier long edge (1568) for a standard model', Math.max(toolStdDims.width, toolStdDims.height) <= 1568 && toolStdDims.width > 1500, `${toolStdDims.width}x${toolStdDims.height}`)

  check('the noisy 4000x3000 PNG really is over the 10 MB base64 ceiling', base64Len(noise.length) > A.maxBase64Bytes, `${noise.length} bytes`)
  const noiseOut = await resize(noise, noise.length, 'png', { limits: A })
  const noiseDims = await dims(noiseOut.buffer)
  check('an image over the byte ceiling is re-encoded or shrunk until it fits', base64Len(noiseOut.buffer.length) <= A.maxBase64Bytes, `${noiseOut.buffer.length} bytes`)
  check('…its media type is the produced bytes\' real format', noiseOut.mediaType === noiseDims.format, `${noiseOut.mediaType} vs ${noiseDims.format}`)
  check('…and the record says what it was shrunk to', noiseOut.dimensions?.originalWidth === 4000 && (noiseOut.dimensions.displayWidth ?? 0) > 0)

  const openaiOut = await resize(flat, flat.length, 'png', { limits: limitsMod.OPENAI_IMAGE_LIMITS })
  check('openai: no per-side ceiling, the 4000x3000 input passes through', (await dims(openaiOut.buffer)).width === 4000)
  const geminiOut = await resize(flat, flat.length, 'png', { limits: limitsMod.GEMINI_IMAGE_LIMITS })
  check('gemini: no pixel ceiling, the input passes through', (await dims(geminiOut.buffer)).width === 4000)
  const genericWide = await resize(wide, wide.length, 'png', { limits: limitsMod.GENERIC_IMAGE_LIMITS })
  check('generic: the strictest side cap (8000) applies', (await dims(genericWide.buffer)).width <= 8000)

  const tinyOut = await resize(tiny, tiny.length, 'png', { limits: A })
  check('a tiny PNG is byte-identical on the way through', tinyOut.buffer.equals(tiny))

  const jpegOut = await resize(smallJpeg, smallJpeg.length, 'jpeg', { limits: A })
  check('a JPEG within the limits passes through byte-identical', jpegOut.buffer.equals(smallJpeg) && jpegOut.mediaType === 'jpeg' && jpegOut.dimensions?.originalWidth === 1200)
  check('the noisy JPEG really is over the 10 MB base64 ceiling', base64Len(noiseJpeg.length) > A.maxBase64Bytes, `${noiseJpeg.length} bytes`)
  const tightJpeg = A
  try {
    const shrunk = await resize(noiseJpeg, noiseJpeg.length, 'jpeg', { limits: tightJpeg })
    check('a JPEG over the ceiling is re-encoded to fit on the native road', !JS_ROAD && base64Len(shrunk.buffer.length) <= tightJpeg.maxBase64Bytes, `${shrunk.buffer.length} bytes`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    check('a JPEG over the ceiling on the JavaScript road is refused with words that name the missing decoder and the limit', JS_ROAD && /JavaScript road/.test(message) && /per image as base64/.test(message) && /3000x2000 px/.test(message), message.slice(0, 200))
  }

  const impossible = { ...A, maxBase64Bytes: 64 }
  try {
    await resize(flat, flat.length, 'png', { limits: impossible })
    check('an impossible ceiling is refused', false)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    check('the refusal names the image size, the smallest encoding tried and the provider\'s limit', /4000x3000 px/.test(message) && /smallest encoding/.test(message) && /anthropic limits/.test(message) && /platform\.claude\.com/.test(message), message.slice(0, 240))
    check('the refusal is an ImageResizeError', err instanceof resizer.ImageResizeError)
  }
  try {
    await resize(Buffer.alloc(0), 0, 'png', { limits: A })
    check('an empty buffer is refused', false)
  } catch (err) {
    check('an empty buffer is refused before it can reach the wire', err instanceof resizer.ImageResizeError)
  }

  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: wide.toString('base64') } } as never
  const blockOut = await resizer.maybeResizeAndDownsampleImageBlock(block, { limits: A })
  check('the block road shrinks the same way', (await dims(Buffer.from((blockOut.block as { source: { data: string } }).source.data, 'base64'))).width <= 8000)

  section('§9 the doctor names the road')
  const line = await processor.describeImageProcessor()
  const state = await processor.imageProcessorState()
  check(JS_ROAD ? 'the JavaScript road is named, with its reason' : 'the native processor is named with its versions', JS_ROAD ? state.road === 'javascript' && /JavaScript image road/.test(line.line) && !line.ready : state.road === 'native' && /native image processor — sharp \d/.test(line.line) && line.ready, line.line)
  check('the pack directory for this platform is named', state.packDir.includes(join('vendor', 'image-processor', processor.imagePackPlatform())), state.packDir)
  check('the pack platform key is sharp\'s own spelling', /^(darwin|linux|linuxmusl|win32)-(arm64|x64|arm|ia32)$/.test(processor.imagePackPlatform()), processor.imagePackPlatform())
}

section('§4 the JavaScript road\'s codec')
{
  const rgb = await sharp({ create: { width: 33, height: 17, channels: 3, background: { r: 200, g: 30, b: 90 } } }).png().toBuffer()
  const rgba = tiny
  const palette = await sharp(flatSvg).resize(300, 225).png({ palette: true, colors: 16 }).toBuffer()
  const gray = await sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 77, g: 77, b: 77 } } }).grayscale().png().toBuffer()
  for (const [name, buffer, w, h] of [
    ['rgb', rgb, 33, 17],
    ['rgba', rgba, 64, 48],
    ['palette', palette, 300, 225],
    ['gray', gray, 20, 10],
  ] as const) {
    const decoded = jsRoad.decodePng(buffer)
    check(`decodes a ${name} PNG to ${w}x${h} RGBA`, decoded.width === w && decoded.height === h && decoded.data.length === w * h * 4)
  }
  const decodedRgb = jsRoad.decodePng(rgb)
  check('…with the right colour', decodedRgb.data[0] === 200 && decodedRgb.data[1] === 30 && decodedRgb.data[2] === 90 && decodedRgb.data[3] === 255)
  const decodedRgba = jsRoad.decodePng(rgba)
  check('…and the alpha channel', decodedRgba.data[3] !== 255 && decodedRgba.data[3] !== 0)
  const scaled = jsRoad.downscaleRgba(jsRoad.decodePng(flat), 400, 300)
  check('area downscale to 400x300', scaled.width === 400 && scaled.height === 300 && scaled.data.length === 400 * 300 * 4)
  const encoded = jsRoad.encodePng(scaled)
  const reread = await dims(encoded)
  check('encodes a PNG sharp reads back at 400x300', reread.format === 'png' && reread.width === 400 && reread.height === 300)
  const roundTrip = jsRoad.decodePng(jsRoad.encodePng(decodedRgba))
  check('a PNG round trip is lossless', Buffer.from(roundTrip.data).equals(Buffer.from(decodedRgba.data)))
  const bmp = Buffer.concat([
    Buffer.from([0x42, 0x4d, 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 24, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0, 0, 255, 255, 255, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]),
  ])
  const decodedBmp = jsRoad.decodeBmp(bmp)
  check(
    'decodes a 24-bit BMP (bottom-up rows, BGR order)',
    decodedBmp.width === 2 &&
      decodedBmp.height === 2 &&
      decodedBmp.data[0] === 0 && decodedBmp.data[2] === 255 &&
      decodedBmp.data[5] === 255 && decodedBmp.data[4] === 0 &&
      decodedBmp.data[8] === 255 && decodedBmp.data[10] === 0 &&
      decodedBmp.data[12] === 255 && decodedBmp.data[13] === 255 && decodedBmp.data[14] === 255,
    Array.from(decodedBmp.data).join(','),
  )
  const jpegHeader = jsRoad.imageDimensionsFromHeader(noiseJpeg)
  check('reads JPEG dimensions from the header', jpegHeader?.format === 'jpeg' && jpegHeader.width === 3000 && jpegHeader.height === 2000)
  const webp = await sharp(tiny).webp().toBuffer()
  const webpHeader = jsRoad.imageDimensionsFromHeader(webp)
  check('reads WebP dimensions from the header', webpHeader?.format === 'webp' && webpHeader.width === 64 && webpHeader.height === 48, JSON.stringify(webpHeader))
  const gif = await sharp(tiny).gif().toBuffer()
  const gifHeader = jsRoad.imageDimensionsFromHeader(gif)
  check('reads GIF dimensions from the header', gifHeader?.format === 'gif' && gifHeader.width === 64 && gifHeader.height === 48)
  check('reads BMP dimensions from the header', jsRoad.imageDimensionsFromHeader(bmp)?.width === 2)
  const instance = jsRoad.javascriptImageProcessor(noiseJpeg)
  const meta = await instance.metadata()
  check('the road\'s processor answers JPEG metadata from the header', meta.width === 3000 && meta.format === 'jpeg')
  let named = ''
  try {
    await jsRoad.javascriptImageProcessor(noiseJpeg).jpeg().toBuffer()
  } catch (err) {
    named = err instanceof Error ? err.message : String(err)
  }
  check('…and refuses to re-encode a JPEG with a named error', /JPEG image data is not decodable on the JavaScript road/.test(named), named)
  const viaRoad = await jsRoad.javascriptImageProcessor(flat).resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
  const viaRoadDims = await dims(viaRoad)
  check('a JPEG request on the road yields PNG bytes, fit inside the box', viaRoadDims.format === 'png' && viaRoadDims.width === 800 && viaRoadDims.height === 600, `${viaRoadDims.format} ${viaRoadDims.width}x${viaRoadDims.height}`)
}

if (JS_ROAD) {
  console.log(failures === 0 ? '\n✅ [js-road] the JavaScript road holds the same laws' : `\n❌ [js-road] ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

section('§5 one file per paste, the by-reference block, the missing words, the reaper')
{
  const store = await import('../../src/utils/imageStore.ts')
  const { getSessionId } = await import('../../src/bootstrap/state.ts')
  const entry = (id: number, buffer: Buffer) => ({ id, type: 'image' as const, content: buffer.toString('base64'), mediaType: 'image/png', filename: `image-${id}.png` })
  const one = entry(1, tiny)
  const two = entry(2, rgbOrTiny())
  function rgbOrTiny(): Buffer {
    return tiny
  }
  const pathOne = await store.storeImage(one)
  const pathTwo = await store.storeImage(two)
  check('each paste is its own file under <home>/image-cache/<session>/', pathOne !== null && pathTwo !== null && pathOne !== pathTwo && pathOne.startsWith(join(HOME, 'image-cache', getSessionId())) && existsSync(pathOne) && existsSync(pathTwo), `${pathOne} · ${pathTwo}`)
  check('the chip\'s state says present', store.storedImageState(1)?.present === true)
  const ref = store.storedImageRefBlock(one)
  check('the dispatch frame carries a reference, not the body', ref !== null && ref.source.type === store.STORED_IMAGE_SOURCE_TYPE && ref.source.path === pathOne && /^[0-9a-f]{64}$/.test(ref.source.sha256) && ref.source.imageId === 1)
  check('a reference is recognised', store.isStoredImageRef(ref) && !store.isStoredImageRef({ type: 'image', source: { type: 'base64', data: 'x' } }))
  const read = ref === null ? null : await store.readStoredImageRef(ref)
  check('the runner reads the bytes back from the store', read?.kind === 'image' && read.block.source.data === one.content && read.block.source.media_type === 'image/png')
  const outside = { type: 'image' as const, source: { type: store.STORED_IMAGE_SOURCE_TYPE, path: join(HOME, 'elsewhere.png'), media_type: 'image/png', sha256: 'a'.repeat(64), imageId: 9 } }
  const refused = await store.readStoredImageRef(outside)
  check('a reference outside the store is refused in words', refused.kind === 'missing' && /not in the image store/.test(refused.words))
  if (pathOne !== null) rmSync(pathOne)
  const gone = ref === null ? null : await store.readStoredImageRef(ref)
  check('a file that has gone is said in words that name the path', gone?.kind === 'missing' && gone.words.includes(pathOne ?? '?') && /\[Image #1\]/.test(gone.words), gone?.kind === 'missing' ? gone.words : '')
  check('…and the chip\'s state says so', store.storedImageState(1)?.present === false)
  check('a reference for a paste whose file is absent is null (the body rides instead)', store.storedImageRefBlock(one) === null)
  const base = join(HOME, 'image-cache')
  const old = join(base, 'other-old')
  const fresh = join(base, 'other-fresh')
  mkdirSync(old, { recursive: true })
  mkdirSync(fresh, { recursive: true })
  writeFileSync(join(old, '1.png'), tiny)
  writeFileSync(join(fresh, '1.png'), tiny)
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000)
  utimesSync(join(old, '1.png'), fortyDaysAgo, fortyDaysAgo)
  utimesSync(old, fortyDaysAgo, fortyDaysAgo)
  await store.cleanupOldImageCaches(new Date(Date.now() - 30 * 24 * 3600 * 1000))
  check('the reaper removes a store older than the cutoff', !existsSync(old))
  check('…keeps another session\'s store written within the window', existsSync(join(fresh, '1.png')))
  check('…and keeps this session\'s store', existsSync(pathTwo ?? '/nowhere'))
  await store.cleanupOldImageCaches(new Date(Date.now() + 5000))
  check('a cutoff ahead of every store removes every other store and never this session\'s', !existsSync(fresh) && existsSync(pathTwo ?? '/nowhere'))
  console.log(`  stores now: ${readdirSync(base).join(', ')}`)
}

section('§6 the paste road on a fixture clipboard')
{
  const paste = await import('../../src/utils/imagePaste.ts')
  const fixture = join(FIX, 'clipboard.png')
  writeFileSync(fixture, flat)
  process.env.MERCURY_CLIPBOARD_IMAGE_FILE = join(FIX, 'absent.png')
  check('the probe says no image when the fixture file is absent', (await paste.hasImageInClipboard()) === false)
  process.env.MERCURY_CLIPBOARD_IMAGE_FILE = fixture
  check('the probe says yes when the clipboard holds an image', (await paste.hasImageInClipboard()) === true)
  const a = paste.nextPasteArtifactPath()
  const b = paste.nextPasteArtifactPath()
  check('every paste has its own artifact name in this process\'s own directory', a !== b && a.startsWith(paste.pasteArtifactDir()) && paste.pasteArtifactDir().includes(`mercury-paste-${process.pid}`), `${a} · ${b}`)
  const image = await paste.getImageFromClipboard()
  check('the clipboard image attaches with its size', image !== null && image.dimensions?.originalWidth === 4000 && image.dimensions.originalHeight === 3000 && (image.byteLength ?? 0) > 0 && image.mediaType === 'image/png')
  const again = await paste.getImageFromClipboard()
  check('a second paste attaches again (never a stale or shared artifact)', again !== null && again.base64 === image?.base64)
  await new Promise(r => setTimeout(r, 400))
  const leftovers = existsSync(paste.pasteArtifactDir()) ? readdirSync(paste.pasteArtifactDir()) : []
  check('no transient artifact outlives its read', leftovers.length === 0, leftovers.join(', '))
  const pathRead = await paste.tryReadImageFromPath(fixture)
  check('a pasted image path reads and shrinks through the same road, with its size', pathRead !== null && pathRead.path === fixture && pathRead.dimensions?.originalWidth === 4000 && (pathRead.byteLength ?? 0) > 0)
  check('the composer\'s words say the size', resizer.describeAttachedImage(pathRead?.dimensions, pathRead?.byteLength ?? 0).startsWith('4000x3000'))
  check('…and what it was shrunk to when it was', /^4000x3000 shrunk to 2000x1500 · /.test(resizer.describeAttachedImage({ originalWidth: 4000, originalHeight: 3000, displayWidth: 2000, displayHeight: 1500 }, 12345)))
  delete process.env.MERCURY_CLIPBOARD_IMAGE_FILE
}

section('§7 the wire\'s last-chance check names the family\'s limit')
{
  const validation = await import('../../src/utils/imageValidation.ts')
  const big = 'A'.repeat(10 * MiB + 4)
  const messages = [{ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] } }]
  let words = ''
  try {
    validation.validateImagesForAPI(messages, 'claude-sonnet-5')
  } catch (err) {
    words = err instanceof Error ? err.message : String(err)
  }
  check('an over-ceiling image is named with the family\'s figure', /anthropic's 10MB per-image limit/.test(words), words)
  let ok = true
  try {
    validation.validateImagesForAPI([{ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(9 * MiB) } }] } }], 'claude-sonnet-5')
  } catch {
    ok = false
  }
  check('9 MB base64 passes the Claude API\'s 10 MB ceiling', ok)
  let strict = ''
  try {
    validation.validateImagesForAPI([{ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(6 * MiB) } }] } }], 'openrouter/anything')
  } catch (err) {
    strict = err instanceof Error ? err.message : String(err)
  }
  check('a generic route keeps the strictest 5 MB ceiling', /exceeds the 5MB limit/.test(strict), strict)
}

section('§8 the paste chord per platform')
{
  const probe = join(HOME, 'chord-probe.ts')
  writeFileSync(
    probe,
    [
      `Object.defineProperty(process, 'platform', { value: process.argv[2] })`,
      `const { DEFAULT_BINDINGS } = await import(${JSON.stringify(join(ROOT, 'src', 'keybindings', 'defaultBindings.ts'))})`,
      `const chat = DEFAULT_BINDINGS.find(b => b.context === 'Chat')`,
      `const entry = Object.entries(chat?.bindings ?? {}).find(([, action]) => action === 'chat:imagePaste')`,
      `console.log(entry ? entry[0] : 'none')`,
    ].join('\n'),
  )
  const chordOn = (platform: string): string => spawnSync(process.execPath, ['run', probe, platform], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  check('Windows binds alt+v to the image paste', chordOn('win32') === 'alt+v', chordOn('win32'))
  check('macOS binds ctrl+v', chordOn('darwin') === 'ctrl+v', chordOn('darwin'))
  check('Linux binds ctrl+v', chordOn('linux') === 'ctrl+v', chordOn('linux'))
  const hint = await import('node:fs').then(fs => fs.readFileSync(join(ROOT, 'src', 'hooks', 'useClipboardImageHint.ts'), 'utf8'))
  check('the focus-regain hint says the clipboard holds an image and which chord attaches it', /clipboard holds an image — \$\{chordRef\.current\} attaches it/.test(hint))
  const docs = await import('node:fs').then(fs => fs.readFileSync(join(ROOT, 'docs', 'SESSIONS.md'), 'utf8'))
  check('the docs say the key per platform', /ctrl\+v on macOS and Linux/.test(docs) && /alt\+v on Windows/.test(docs))
}

section('the JavaScript road, in a child process with the road forced')
{
  const child = spawnSync(process.execPath, ['run', import.meta.path, '--javascript-road'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MERCURY_IMAGE_PROCESSOR: 'javascript' } })
  process.stdout.write(child.stdout)
  if (child.status !== 0) process.stdout.write(child.stderr.slice(-1500))
  check('the JavaScript road holds the same laws (child exit 0)', child.status === 0, `exit ${child.status}`)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ the image road holds' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
