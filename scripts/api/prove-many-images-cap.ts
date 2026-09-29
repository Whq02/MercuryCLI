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
  (process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'many-images-cap-crews-'))),
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
const { APIError } = await import('@anthropic-ai/sdk')
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
const wide = await flat(2500, 1400)
const tall = await flat(1200, 2200)
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

section('§1 the wolf-fence: the many-images rule lives in the resizer behind imagesInRequest, and exactly one owner passes the count')
{
  const resizer = readFileSync(join(ROOT, 'src/utils/imageResizer.ts'), 'utf8')
  check('the resizer applies the family\'s many-images cap only when a caller passes imagesInRequest', resizer.includes('options?.imagesInRequest') && resizer.includes('limits.manyImages'))
  check('the Anthropic table: 2000 px per side once a request carries more than 20 images', RULE !== null && THRESHOLD === 20 && CAP === 2000, j(RULE))
  const passers: string[] = []
  for (const file of srcFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8')
    if (file.endsWith('src/utils/imageResizer.ts')) continue
    if (/imagesInRequest:\s*[A-Za-z_$][\w$.]*/.test(text)) passers.push(file.slice(ROOT.length + 1))
  }
  note(`callers passing imagesInRequest: ${passers.length === 0 ? 'none' : passers.join(', ')}`)
  const ownerPasses = /imagesInRequest:\s*[A-Za-z_$][\w$.]*/.test(resizer)
  check('the count is passed where a request is composed (the resizer\'s own composition owner), so ingestion never has to guess it', ownerPasses, 'no composition owner passes imagesInRequest')
  const routes: Array<[string, string]> = [
    ['anthropic', 'src/services/providers/anthropic/streamCore.ts'],
    ['openai', 'src/services/providers/openai/openaiCallModel.ts'],
    ['openai-compat', 'src/services/providers/openaicompat/compatChatCallModel.ts'],
    ['zai', 'src/services/providers/zai/zaiCallModel.ts'],
  ]
  for (const [route, file] of routes) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    check(`the ${route} route fits its request's images to the cap the count implies at composition`, text.includes('fitImagesToRequestCap('), `${file} never calls the composition owner`)
  }
}

section('§2 the wire: a 21-image request on the Anthropic lane carries every image within the many-images cap')
{
  const images = Array.from({ length: THRESHOLD + 1 }, (_, index) => (index === 5 ? wide : small))
  const rows = history(images, { thinkingAfter: 3 })
  fixture.script(() => ({ text: 'seen' }))
  const run = await send(MODEL, rows)
  check('the request reached the Anthropic wire and settled', run.body !== null && run.thrown === undefined && run.errors.length === 0, `thrown=${String(run.thrown)} errors=${j(run.errors.map(e => j(e.message).slice(0, 160)))}`)
  const seen = run.body === null ? [] : wireImages(run.body)
  check(`the wire carried all ${THRESHOLD + 1} images (nothing dropped)`, seen.length === THRESHOLD + 1, `${seen.length} images`)
  const over = seen.filter(image => Math.max(image.width, image.height) > CAP)
  check(`every image on the wire is within ${CAP} px a side (the many-images cap applied at composition)`, seen.length > 0 && over.length === 0, over.map(image => `message ${image.message} block ${image.block}: ${image.width}x${image.height}`).join(', ') || 'no image on the wire')
  const sized = seen.find(image => image.width === CAP || image.height === CAP)
  check('the 2500x1400 image was sized to the cap keeping its shape (2000x1120)', sized !== undefined && sized.width === 2000 && sized.height === 1120, sized ? `${sized.width}x${sized.height}` : seen.map(i => `${i.width}x${i.height}`).join(' '))
  const untouched = seen.filter(image => image.width === 64 && image.data === small.toString('base64'))
  check('the twenty images already within the cap ride byte-identical', untouched.length === THRESHOLD, `${untouched.length} untouched`)
  const originalOnRows = rows.filter(row => row.type === 'user').some(row => j(row.message).includes(wide.toString('base64').slice(0, 200)))
  check('the history rows still hold the original 2500x1400 bytes (the wire carries copies)', originalOnRows)
  const thinking = run.body === null ? [] : wireThinking(run.body)
  const firstSizedMessage = sized?.message ?? -1
  const before = thinking.filter(block => block.message < firstSizedMessage)
  const after = thinking.filter(block => block.message > firstSizedMessage)
  check('reasoning written before the first sized message stays on the wire (its prefix is intact)', before.length > 0, `${before.length} blocks before message ${firstSizedMessage}`)
  check('reasoning written after the first sized message leaves the wire (the edited-prefix law every history edit follows)', firstSizedMessage >= 0 && after.length === 0, `${after.length} thinking blocks after message ${firstSizedMessage}: ${after.map(block => block.text).join(' | ')}`)
}

section('§3 below the threshold nothing is sized: a 20-image request carries the 2500 px image as it is')
{
  const images = Array.from({ length: THRESHOLD }, (_, index) => (index === 5 ? wide : small))
  fixture.script(() => ({ text: 'seen' }))
  const run = await send(MODEL, history(images))
  const seen = run.body === null ? [] : wireImages(run.body)
  const kept = seen.find(image => image.width === 2500 && image.height === 1400)
  check(`a request of exactly ${THRESHOLD} images keeps the 2500x1400 image untouched (the cap applies past the threshold only)`, seen.length === THRESHOLD && kept !== undefined && kept.data === wide.toString('base64'), `${seen.length} images; ${seen.map(i => `${i.width}x${i.height}`).join(' ')}`)
}

section('§4 the single-image cap at composition: an image over 8000 px in a short request is sized, never refused')
{
  fixture.script(() => ({ text: 'seen' }))
  const run = await send(MODEL, history([small, huge, small]))
  const seen = run.body === null ? [] : wireImages(run.body)
  const big = seen.find(image => image.width > SINGLE_CAP * 0.9)
  check(`the ${SINGLE_CAP + 412} px image rides within ${SINGLE_CAP} px a side (the family's per-side ceiling), at the ceiling or a rounding below it`, big !== undefined && big.width <= SINGLE_CAP && big.width >= SINGLE_CAP * 0.99, big ? `${big.width}x${big.height}` : seen.map(i => `${i.width}x${i.height}`).join(' '))
}

section('§5 the refusal words name the case that happened')
{
  const manyImageSentence = 'messages.11.content.1.image.source.base64.data: image dimensions exceed max allowed size for many-image requests: 2500x1400 pixels > 2000x2000 pixels'
  const singleImageSentence = 'messages.5.content.237.image.source.base64.data: image dimensions exceed max allowed size: 8412 pixels > 8000 pixels'
  const rowFor = (sentence: string): string => {
    const err = new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: sentence } } as never, undefined, undefined as never)
    const row = errorsMod.getAssistantMessageFromError(err, MODEL) as unknown as AnyMsg
    return (row.message as { content: Array<{ text?: string }> }).content[0]?.text ?? ''
  }
  const many = rowFor(manyImageSentence)
  check('the many-images refusal names the 2000-pixel limit for a request with more than 20 images', many.includes('2000') && /more than 20 images|many images/.test(many), many)
  check('…and never the 8000 px single-image label', !many.includes('8000'), many)
  const single = rowFor(singleImageSentence)
  check('the single-image refusal still names the 8000 px per-side limit', single.includes('8000px on any side'), single)
  check('both sentences read as media-size errors', errorsMod.isMediaSizeError(manyImageSentence) && errorsMod.isMediaSizeError(singleImageSentence))
  check('the many-image sentence classifies as image_too_large', errorsMod.classifyAPIError(new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: manyImageSentence } } as never, undefined, undefined as never)) === 'image_too_large')
}

await fixture.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-many-images-cap: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
