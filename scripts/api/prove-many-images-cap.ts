#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_HOME',
  'MERCURY_THINKING_BINDING', 'MERCURY_PREFIX_INDUCE_EDIT',
]) {
  delete process.env[ambient]
}
const HOMES = [
  (process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'many-images-cap-home-'))),
  (process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'many-images-cap-daemon-'))),
]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const note = (label: string): void => console.log(`  [NOTE] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the many-images cap prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const limitsMod = await import('../../src/constants/apiLimits.ts')
const errorsMod = await import('../../src/services/api/errors.ts')
const { APIError } = await import('../../src/services/api/sdkErrors.js')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const sharp = (await import('sharp')).default

type AnyMsg = Record<string, unknown> & { type?: string; uuid?: string }
type WireImage = { message: number; block: number; width: number; height: number; data: string; nested: boolean }
const MODEL = 'claude-opus-5-5'
const RULE = limitsMod.ANTHROPIC_IMAGE_LIMITS.manyImages
const THRESHOLD = RULE?.threshold ?? 20
const CAP = RULE?.maxSidePx ?? 2000
const SINGLE_CAP = limitsMod.ANTHROPIC_IMAGE_LIMITS.maxSidePx ?? 8000

const flat = (width: number, height: number, tone = 240): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: tone, g: tone, b: tone - 8 } } }).png({ compressionLevel: 9 }).toBuffer()
const pngDims = (data: string): { width: number; height: number } | null => {
  const header = Buffer.from(data.slice(0, 64), 'base64')
  if (header.length < 24 || header[0] !== 0x89 || header[1] !== 0x50) return null
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}
const imageBlock = (buffer: Buffer): Record<string, unknown> => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') } })
const userRow = (content: unknown): AnyMsg => createUserMessage({ content: content as never }) as unknown as AnyMsg
const assistantRow = (content: unknown, model = MODEL): AnyMsg => {
  const row = createAssistantMessage({ content: content as never }) as unknown as AnyMsg
  const message = row.message as Record<string, unknown>
  return { ...row, message: { ...message, model } }
}
const thinkingBlock = (text: string): Record<string, unknown> => ({ type: 'thinking', thinking: text, signature: `fixture-signature-${text.length}` })

function wireImages(body: Record<string, unknown>): WireImage[] {
  const out: WireImage[] = []
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return
    ;(message.content as Array<Record<string, unknown>>).forEach((block, at) => {
      const take = (candidate: Record<string, unknown>, nested: boolean): void => {
        if (candidate.type !== 'image') return
        const source = candidate.source as { type?: string; data?: string } | undefined
        if (source?.type !== 'base64' || typeof source.data !== 'string') return
        const dims = pngDims(source.data) ?? { width: 0, height: 0 }
        out.push({ message: index, block: at, ...dims, data: source.data, nested })
      }
      take(block, false)
      if (block.type === 'tool_result' && Array.isArray(block.content)) for (const inner of block.content as Array<Record<string, unknown>>) take(inner, true)
    })
  })
  return out
}
function wireThinking(body: Record<string, unknown>): Array<{ message: number; text: string }> {
  const out: Array<{ message: number; text: string }> = []
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === 'thinking') out.push({ message: index, text: String(block.thinking ?? '') })
    }
  })
  return out
}

async function send(model: string, messages: AnyMsg[]): Promise<{ errors: AnyMsg[]; texts: string[]; thrown: unknown; body: Record<string, unknown> | null }> {
  const errors: AnyMsg[] = []
  const texts: string[] = []
  let thrown: unknown
  const before = fixture.captured.length
  const control = new AbortController()
  const cut = setTimeout(() => control.abort(), 30_000)
  cut.unref?.()
  try {
    const stream = routedCallModel({
      messages: messages as never,
      systemPrompt: asSystemPrompt(['fixture system prompt']),
      thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
      tools: [] as never,
      signal: control.signal,
      options: {
        model,
        querySource: 'sdk',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        enablePromptCaching: false,
        async getToolPermissionContext() {
          return getEmptyToolPermissionContext()
        },
      } as never,
    })
    for await (const ev of stream) {
      const m = ev as AnyMsg
      if (m.type !== 'assistant') continue
      if (m.isApiErrorMessage === true) errors.push(m)
      const content = (m.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
      if (Array.isArray(content)) for (const block of content) if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  } catch (err) {
    thrown = err
  } finally {
    clearTimeout(cut)
  }
  const captured = fixture.captured.slice(before).find(entry => entry.dialect === 'anthropic')
  return { errors, texts, thrown, body: captured?.body ?? null }
}

const small = await flat(64, 48)
const wide = await flat(3500, 1960)
const retina = await flat(2880, 1800)
const huge = await flat(SINGLE_CAP + 412, 120)

function history(images: Buffer[], options: { thinkingAfter?: number } = {}): AnyMsg[] {
  const rows: AnyMsg[] = []
  images.forEach((image, index) => {
    rows.push(userRow([{ type: 'text', text: `image ${index + 1} of ${images.length}` }, imageBlock(image)]))
    const reasoning = options.thinkingAfter !== undefined && index >= options.thinkingAfter - 1 ? [thinkingBlock(`reasoning after image ${index + 1}`)] : []
    rows.push(assistantRow([...reasoning, { type: 'text', text: `noted image ${index + 1}` }]))
  })
  rows.push(userRow('and the next step?'))
  return rows
}

const srcFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...srcFiles(path))
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const withoutCacheControl = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'cache_control').map(([key, part]) => [key, withoutCacheControl(part)]))
}
const wireMessages = (body: Record<string, unknown> | null): unknown[] => (Array.isArray(body?.messages) ? (body!.messages as unknown[]) : [])

section('§1 the wolf-fence: the many-images bound lives in the resizer and applies from an image\'s first send, never from the count')
{
  const resizer = readFileSync(join(ROOT, 'src/utils/imageResizer.ts'), 'utf8')
  const sidePxSource = /export function requestImageSidePx\([\s\S]*?\n\}/.exec(resizer)?.[0] ?? ''
  check('requestImageSidePx reads the family\'s many-images bound and never the request\'s image count', sidePxSource.includes('manyImageSidePx(limits)') && !sidePxSource.includes('imagesInRequest'), sidePxSource.slice(0, 200))
  check('the Anthropic table: 3000 px per side for a request with more than 20 images (the vision page, read 2026-11-02), above every tier\'s native long edge', RULE !== null && THRESHOLD === 20 && CAP === 3000 && CAP > limitsMod.ANTHROPIC_IMAGE_LIMITS.nativeLongEdgePx.highResolution, j(RULE))
  check('the count still reaches the resizer for the one rule that needs it: an image whose size cannot be read is left out only over the threshold', resizer.includes('overManyImagesThreshold(limits, imagesInRequest)'))
  const routes: Array<[string, string]> = [
    ['anthropic', 'src/services/providers/anthropic/streamCore.ts'],
    ['openai', 'src/services/providers/openai/openaiCallModel.ts'],
    ['openai-compat', 'src/services/providers/openaicompat/compatChatCallModel.ts'],
    ['zai', 'src/services/providers/zai/zaiCallModel.ts'],
  ]
  for (const [route, file] of routes) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    check(`the ${route} route fits its request's images to the bound at composition`, text.includes('fitImagesToRequestCap('), `${file} never calls the composition owner`)
  }
}

section('§2 the wire: twenty images, then twenty-one — the twenty-first image changes nothing before it')
{
  const twenty = Array.from({ length: THRESHOLD }, (_, index) => (index === 5 ? wide : small))
  const rowsTwenty = history(twenty, { thinkingAfter: 3 })
  fixture.script(() => ({ text: 'seen' }))
  const first = await send(MODEL, rowsTwenty)
  check(`the ${THRESHOLD}-image request reached the Anthropic wire and settled`, first.body !== null && first.thrown === undefined && first.errors.length === 0, `thrown=${String(first.thrown)} errors=${j(first.errors.map(e => j(e.message).slice(0, 160)))}`)
  const seenTwenty = first.body === null ? [] : wireImages(first.body)
  const sizedAtTwenty = seenTwenty.find(image => image.width === CAP || image.height === CAP)
  check(`at ${THRESHOLD} images the 3500x1960 image already rides at the bound, keeping its shape (3000x1680): the bound applies from the first send`, seenTwenty.length === THRESHOLD && sizedAtTwenty !== undefined && sizedAtTwenty.width === 3000 && sizedAtTwenty.height === 1680, seenTwenty.map(i => `${i.width}x${i.height}`).join(' '))

  const rowsTwentyOne = [
    ...rowsTwenty.slice(0, -1),
    userRow([{ type: 'text', text: `image ${THRESHOLD + 1} of ${THRESHOLD + 1}` }, imageBlock(small)]),
    assistantRow([thinkingBlock(`reasoning after image ${THRESHOLD + 1}`), { type: 'text', text: `noted image ${THRESHOLD + 1}` }]),
    userRow('and the next step?'),
  ]
  fixture.script(() => ({ text: 'seen' }))
  const run = await send(MODEL, rowsTwentyOne)
  check(`the ${THRESHOLD + 1}-image request reached the Anthropic wire and settled`, run.body !== null && run.thrown === undefined && run.errors.length === 0, `thrown=${String(run.thrown)} errors=${j(run.errors.map(e => j(e.message).slice(0, 160)))}`)
  const seen = run.body === null ? [] : wireImages(run.body)
  check(`the wire carried all ${THRESHOLD + 1} images (nothing dropped)`, seen.length === THRESHOLD + 1, `${seen.length} images`)
  const over = seen.filter(image => Math.max(image.width, image.height) > CAP)
  check(`every image on the wire is within ${CAP} px a side`, seen.length > 0 && over.length === 0, over.map(image => `message ${image.message} block ${image.block}: ${image.width}x${image.height}`).join(', ') || 'no image on the wire')
  const shared = THRESHOLD * 2
  const before = wireMessages(first.body).slice(0, shared).map(withoutCacheControl)
  const after = wireMessages(run.body).slice(0, shared).map(withoutCacheControl)
  const firstDifferent = before.findIndex((row, index) => j(row) !== j(after[index]))
  check(`the ${shared} messages before the twenty-first image ride byte-identical across the crossing: the cached prefix holds (no messages_changed)`, before.length === shared && firstDifferent === -1, `first differing message ${firstDifferent}`)
  const untouched = seen.filter(image => image.width === 64 && image.data === small.toString('base64'))
  check('the twenty small images ride byte-identical', untouched.length === THRESHOLD, `${untouched.length} untouched`)
  const originalOnRows = rowsTwentyOne.filter(row => row.type === 'user').some(row => j(row.message).includes(wide.toString('base64').slice(0, 200)))
  check('the history rows still hold the original 3500x1960 bytes (the wire carries copies)', originalOnRows)
  const thinking = run.body === null ? [] : wireThinking(run.body)
  check('the reasoning minted after the crossing is on the wire', thinking.some(block => block.text === `reasoning after image ${THRESHOLD + 1}`), j(thinking.map(block => block.text)))
}

section('§3 an image above the native long edge and within the bound rides as it is at any count: the API does its own downscale')
{
  const images = Array.from({ length: THRESHOLD + 1 }, (_, index) => (index === 5 ? retina : small))
  fixture.script(() => ({ text: 'seen' }))
  const run = await send(MODEL, history(images))
  const seen = run.body === null ? [] : wireImages(run.body)
  const kept = seen.find(image => image.width === 2880 && image.height === 1800)
  check(`a ${THRESHOLD + 1}-image request carries the 2880x1800 image untouched (2880 is under the 3000 bound and over the 2576 native long edge)`, seen.length === THRESHOLD + 1 && kept !== undefined && kept.data === retina.toString('base64'), `${seen.length} images; ${seen.map(i => `${i.width}x${i.height}`).join(' ')}`)
}

section('§4 the per-side ceiling at composition: an image over 8000 px in a short request is sized to the bound, never refused')
{
  fixture.script(() => ({ text: 'seen' }))
  const run = await send(MODEL, history([small, huge, small]))
  const seen = run.body === null ? [] : wireImages(run.body)
  const big = seen.find(image => image.width > CAP * 0.9)
  check(`the ${SINGLE_CAP + 412} px image rides within ${CAP} px a side, at the bound or a rounding below it`, big !== undefined && big.width <= CAP && big.width >= CAP * 0.99, big ? `${big.width}x${big.height}` : seen.map(i => `${i.width}x${i.height}`).join(' '))
}

section('§5 the refusal words name the limit the provider stated, and the next send fits to it')
{
  const resizerMod = await import('../../src/utils/imageResizer.ts')
  const manyImageSentence = 'messages.11.content.1.image.source.base64.data: image dimensions exceed max allowed size for many-image requests: 2500x1400 pixels > 2000x2000 pixels'
  const manyImageSentenceAtBound = 'messages.11.content.1.image.source.base64.data: image dimensions exceed max allowed size for many-image requests: 3500x1960 pixels > 3000x3000 pixels'
  const singleImageSentence = 'messages.5.content.237.image.source.base64.data: image dimensions exceed max allowed size: 8412 pixels > 8000 pixels'
  const rowFor = (sentence: string): string => {
    const err = new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: sentence } } as never, undefined, undefined as never)
    const row = errorsMod.getAssistantMessageFromError(err, MODEL) as unknown as AnyMsg
    return (row.message as { content: Array<{ text?: string }> }).content[0]?.text ?? ''
  }
  check(`before any refusal the bound is the documented ${CAP} px`, resizerMod.manyImageSidePx(limitsMod.ANTHROPIC_IMAGE_LIMITS) === CAP)
  const atBound = rowFor(manyImageSentenceAtBound)
  check('a refusal stating the documented bound names it (3000-pixel) and leaves the bound where it is', atBound.includes('3000-pixel') && /more than 20 images/.test(atBound) && resizerMod.manyImageSidePx(limitsMod.ANTHROPIC_IMAGE_LIMITS) === CAP, atBound)
  const many = rowFor(manyImageSentence)
  check('a refusal stating 2000 pixels names that limit for a request with more than 20 images', many.includes('2000-pixel') && /more than 20 images|many images/.test(many), many)
  check('…and never the 8000 px single-image label', !many.includes('8000'), many)
  check('…and the next send fits to the limit the provider stated (2000 px), not to the documented bound', resizerMod.manyImageSidePx(limitsMod.ANTHROPIC_IMAGE_LIMITS) === 2000 && resizerMod.requestImageSidePx(limitsMod.ANTHROPIC_IMAGE_LIMITS) === 2000)
  resizerMod.resetStatedManyImageBoundForTesting()
  check('the stated limit is forgotten with the process state, the documented bound stands again', resizerMod.requestImageSidePx(limitsMod.ANTHROPIC_IMAGE_LIMITS) === CAP)
  const single = rowFor(singleImageSentence)
  check('the single-image refusal still names the 8000 px per-side limit', single.includes('8000px on any side'), single)
  check('both sentences read as media-size errors', errorsMod.isMediaSizeError(manyImageSentence) && errorsMod.isMediaSizeError(singleImageSentence))
  check('the many-image sentence classifies as image_too_large', errorsMod.classifyAPIError(new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: manyImageSentence } } as never, undefined, undefined as never)) === 'image_too_large')
}

await fixture.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-many-images-cap: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
