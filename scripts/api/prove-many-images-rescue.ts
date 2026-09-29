#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
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
  (process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'many-images-rescue-home-'))),
  (process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'many-images-rescue-daemon-'))),
  (process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'many-images-rescue-crews-'))),
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
  console.log('\nTIMEOUT — the many-images rescue prover exceeded 240s')
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
type WireImage = { message: number; block: number; width: number; height: number; data: string }
const MODEL_A = 'claude-opus-5-5'
const MODEL_B = 'claude-sonnet-5'
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
const assistantRow = (content: unknown, model: string): AnyMsg => {
  const row = createAssistantMessage({ content: content as never }) as unknown as AnyMsg
  const message = row.message as Record<string, unknown>
  return { ...row, message: { ...message, model } }
}

function wireImages(body: Record<string, unknown>): WireImage[] {
  const out: WireImage[] = []
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return
    ;(message.content as Array<Record<string, unknown>>).forEach((block, at) => {
      const take = (candidate: Record<string, unknown>): void => {
        if (candidate.type !== 'image') return
        const source = candidate.source as { type?: string; data?: string } | undefined
        if (source?.type !== 'base64' || typeof source.data !== 'string') return
        const dims = pngDims(source.data) ?? { width: 0, height: 0 }
        out.push({ message: index, block: at, ...dims, data: source.data })
      }
      take(block)
      if (block.type === 'tool_result' && Array.isArray(block.content)) for (const inner of block.content as Array<Record<string, unknown>>) take(inner)
    })
  })
  return out
}

const manyImageSentence = (image: WireImage): string =>
  `messages.${image.message}.content.${image.block}.image.source.base64.data: image dimensions exceed max allowed size for many-image requests: ${image.width}x${image.height} pixels > ${CAP}x${CAP} pixels`
const singleImageSentence = (image: WireImage): string =>
  `messages.${image.message}.content.${image.block}.image.source.base64.data: image dimensions exceed max allowed size: ${Math.max(image.width, image.height)} pixels > ${SINGLE_CAP} pixels`
const refusal = (sentence: string): { error: { status: number; body: unknown } } => ({
  error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: sentence } } },
})
const refusals: string[] = []
fixture.script(request => {
  const images = wireImages(request.body)
  const single = images.find(image => Math.max(image.width, image.height) > SINGLE_CAP)
  if (single !== undefined) {
    refusals.push(singleImageSentence(single))
    return refusal(singleImageSentence(single))
  }
  const many = images.length > THRESHOLD ? images.find(image => Math.max(image.width, image.height) > CAP) : undefined
  if (many !== undefined) {
    refusals.push(manyImageSentence(many))
    return refusal(manyImageSentence(many))
  }
  return { text: `answered a request of ${images.length} images` }
})

async function send(model: string, messages: AnyMsg[]): Promise<{ errors: AnyMsg[]; texts: string[]; rows: AnyMsg[]; thrown: unknown; body: Record<string, unknown> | null }> {
  const errors: AnyMsg[] = []
  const texts: string[] = []
  const rows: AnyMsg[] = []
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
      rows.push(m)
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
  return { errors, texts, rows, thrown, body: captured?.body ?? null }
}
const rowText = (row: AnyMsg | undefined): string => (row === undefined ? '' : ((row.message as { content: Array<{ text?: string }> }).content[0]?.text ?? ''))
const answered = (run: { texts: string[]; errors: AnyMsg[]; thrown: unknown }): boolean => run.thrown === undefined && run.errors.length === 0 && run.texts.some(text => text.startsWith('answered a request of'))

const small = await flat(64, 48)
const wide = await flat(2500, 1400)
const tall = await flat(1200, 2200)
const IMAGES = Array.from({ length: THRESHOLD + 1 }, (_, index) => (index === 5 ? wide : index === 14 ? tall : small))
const ORIGINALS = IMAGES.map(image => image.toString('base64'))

function history(): AnyMsg[] {
  const rows: AnyMsg[] = []
  IMAGES.forEach((image, index) => {
    rows.push(userRow([{ type: 'text', text: `capture ${index + 1} of ${IMAGES.length}` }, imageBlock(image)]))
    rows.push(assistantRow([{ type: 'text', text: `noted capture ${index + 1}` }], MODEL_A))
  })
  return rows
}
const imageDataOf = (rows: AnyMsg[]): string[] =>
  rows.flatMap(row => {
    if (row.type !== 'user') return []
    const content = (row.message as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    return (content as Array<{ type?: string; source?: { data?: string } }>).flatMap(block => (block.type === 'image' && typeof block.source?.data === 'string' ? [block.source.data] : []))
  })

section('§1 the first send of an image-heavy session: 21 images, two over the many-images cap')
const rows = history()
rows.push(userRow('make the paddle move with the arrow keys'))
{
  const run = await send(MODEL_A, rows)
  const seen = run.body === null ? [] : wireImages(run.body)
  note(`the wire saw ${seen.length} images, the largest ${Math.max(0, ...seen.map(image => Math.max(image.width, image.height)))} px a side; fixture refusals so far: ${refusals.length}`)
  check('the first send is answered (every image sized to the cap at composition, nothing refused)', answered(run) && seen.length === THRESHOLD + 1 && seen.every(image => Math.max(image.width, image.height) <= CAP), `errors=${j(run.errors.map(rowText))} thrown=${String(run.thrown)}`)
  if (run.errors.length > 0) note(`the refusal row read: ${rowText(run.errors[0])}`)
}

section('§2 a session already refused (the state a session from the earlier build is in) carries on at its next send, on the same model')
const refused = history()
refused.push(userRow('make the paddle move with the arrow keys'))
const priorRefusal = errorsMod.getAssistantMessageFromError(
  new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: manyImageSentence({ message: 10, block: 1, width: 2500, height: 1400, data: '' }) } } as never, undefined, undefined as never),
  MODEL_A,
) as unknown as AnyMsg
refused.push(priorRefusal)
const refusalWords = rowText(priorRefusal)
note(`the refusal row reads: ${refusalWords}`)
check('the refusal row names the many-images limit, never the 8000 px single-image label', refusalWords.includes('2000') && !refusalWords.includes('8000'), refusalWords)
check('…and says what the next send does: the images in this conversation are sized to that limit, nothing is dropped', /sized to/.test(refusalWords) && /nothing is dropped/.test(refusalWords) && !/removed/.test(refusalWords), refusalWords)
refused.push(userRow('please continue'))
{
  const run = await send(MODEL_A, refused)
  const seen = run.body === null ? [] : wireImages(run.body)
  check(`the next send on ${MODEL_A} is answered — the history's images ride sized to ${CAP} px, no /clear needed`, answered(run) && seen.every(image => Math.max(image.width, image.height) <= CAP), `errors=${j(run.errors.map(rowText))} thrown=${String(run.thrown)} largest=${Math.max(0, ...seen.map(image => Math.max(image.width, image.height)))}`)
  const sizedWide = seen.find(image => image.width === CAP && Math.abs(image.height - 1120) <= 1)
  const sizedTall = seen.find(image => image.height === CAP && Math.abs(image.width - 1091) <= 1)
  check('the two oversized captures were sized to the cap keeping their shape, not dropped (21 images still on the wire)', seen.length === THRESHOLD + 1 && sizedWide !== undefined && sizedTall !== undefined, seen.map(image => `${image.width}x${image.height}`).join(' '))
  check('the earlier refusal row itself never reaches the wire', run.body !== null && !j(run.body).includes(refusalWords.slice(0, 40)))
  for (const row of run.rows) if (row.isApiErrorMessage !== true) refused.push({ ...row, message: { ...(row.message as Record<string, unknown>), model: MODEL_A } })
}

section(`§3 the model switch after the refusal: /model ${MODEL_A} → ${MODEL_B}, the next send is answered too`)
{
  refused.push(userRow('now add the ball'))
  const run = await send(MODEL_B, refused)
  const seen = run.body === null ? [] : wireImages(run.body)
  check(`the next send on ${MODEL_B} is answered with the same history`, answered(run) && seen.length === THRESHOLD + 1 && seen.every(image => Math.max(image.width, image.height) <= CAP), `errors=${j(run.errors.map(rowText))} thrown=${String(run.thrown)} images=${seen.length} largest=${Math.max(0, ...seen.map(image => Math.max(image.width, image.height)))}`)
  check('the request went to the switched model', run.body !== null && String(run.body.model).includes('sonnet'), String(run.body?.model))
}

section('§4 the transcript keeps the originals: every history row still holds the bytes it was written with')
{
  const now = imageDataOf(refused)
  check('the 21 image rows carry their original bytes after three sends (the wire carried sized copies)', now.length === ORIGINALS.length && now.every((data, index) => data === ORIGINALS[index]), `${now.length} rows; first differing row ${now.findIndex((data, index) => data !== ORIGINALS[index])}`)
  const wideStillOriginal = now[5] === wide.toString('base64') && (pngDims(now[5] ?? '')?.width ?? 0) === 2500
  const tallStillOriginal = now[14] === tall.toString('base64') && (pngDims(now[14] ?? '')?.height ?? 0) === 2200
  check('the two oversized captures are still 2500x1400 and 1200x2200 in the history', wideStillOriginal && tallStillOriginal)
  note(`fixture refusals issued in this run: ${refusals.length}${refusals.length > 0 ? ` — first: ${refusals[0]}` : ''}`)
}

await fixture.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-many-images-rescue: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
