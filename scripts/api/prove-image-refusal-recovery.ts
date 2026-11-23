#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_HOME',
]) {
  delete process.env[ambient]
}
const HOMES = [
  (process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'image-refusal-home-'))),
  (process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'image-refusal-daemon-'))),
]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the image refusal prover exceeded 180s; the last section header printed above names the stuck part, and the requests wait on the fixture server in scripts/compact/overflowFixture.ts')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const limitsMod = await import('../../src/models/roads/mediaLimits.ts')
const resizer = await import('../../src/platform/images/imageResizer.ts')
const validation = await import('../../src/engine/requests/imageValidation.ts')
const planMod = await import('../../src/engine/messages/apiPlan.ts')
const viewMod = await import('../../src/engine/messages/apiView.ts')
const errorsMod = await import('../../src/engine/requests/apiErrorRows.ts')
const refusalMod = await import('../../src/engine/request-parts/mediaRefusal.ts').catch(() => null)
const { APIError } = await import('../../src/engine/request-parts/sdkErrors.js')
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const sharp = (await import('sharp')).default

type AnyMsg = Record<string, unknown> & { type?: string; uuid?: string; isMeta?: boolean }
type Limits = typeof limitsMod.OPENAI_IMAGE_LIMITS
const MiB = 1024 * 1024
const OPENAI = limitsMod.OPENAI_IMAGE_LIMITS as Limits & { maxPatchesPerImage?: { patchPx: number; count: number } | null }
const ANTHROPIC = limitsMod.ANTHROPIC_IMAGE_LIMITS as Limits & { maxPatchesPerImage?: { patchPx: number; count: number } | null }
const patches = (w: number, h: number): number => Math.ceil(w / 32) * Math.ceil(h / 32)

const flat = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 244, g: 244, b: 240 } } }).png({ compressionLevel: 9 }).toBuffer()
const big = await flat(6000, 6000)
const fits = await flat(4000, 3000)
const small = await flat(64, 48)
const dims = async (buffer: Buffer): Promise<{ width: number; height: number }> => {
  const meta = await sharp(buffer).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}
const imageBlock = (buffer: Buffer): Record<string, unknown> => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') } })
const userRow = (content: unknown, isMeta = false): AnyMsg =>
  createUserMessage({ content: content as never, ...(isMeta ? { isMeta: true as const } : {}) }) as unknown as AnyMsg
const hasInputImage = (body: Record<string, unknown>): boolean => {
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  return input.some(item => {
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined
    return Array.isArray(parts) && parts.some(part => (part as { type?: string }).type === 'input_image')
  })
}
const inputImageDims = (body: Record<string, unknown>): { width: number; height: number } | null => {
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  for (const item of input) {
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined
    if (!Array.isArray(parts)) continue
    for (const part of parts as Array<{ type?: string; image_url?: string }>) {
      if (part.type !== 'input_image' || typeof part.image_url !== 'string') continue
      const data = part.image_url.replace(/^data:[^,]*,/, '')
      const header = Buffer.from(data.slice(0, 64), 'base64')
      if (header.length >= 24) return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    }
  }
  return null
}

section('§1 the limits at their one home: the provider\'s rule per family')
{
  check('openai: no per-image byte ceiling (the provider caps the request, never the image)', OPENAI.maxBase64Bytes === null, j(OPENAI.maxBase64Bytes) + ' — set maxBase64Bytes to null in OPENAI_IMAGE_LIMITS, src/models/roads/mediaLimits.ts')
  check('openai: 30,000 patches of 32 px per image', OPENAI.maxPatchesPerImage?.patchPx === 32 && OPENAI.maxPatchesPerImage.count === 30_000, j(OPENAI.maxPatchesPerImage) + ' — OPENAI_IMAGE_LIMITS.maxPatchesPerImage in src/models/roads/mediaLimits.ts must be patchPx 32, count 30000')
  check('openai: 512 MB per request · 1,500 images per request', OPENAI.maxRequestBytes === 512 * MiB && OPENAI.maxImagesPerRequest === 1500, 'OPENAI_IMAGE_LIMITS in src/models/roads/mediaLimits.ts must carry maxRequestBytes 512 MiB and maxImagesPerRequest 1500')
  check('openai: the images-vision guide is cited', OPENAI.doc === 'https://developers.openai.com/api/docs/guides/images-vision', 'set doc in OPENAI_IMAGE_LIMITS, src/models/roads/mediaLimits.ts')
  check('anthropic: 10 MB base64 per image, no patch rule, up to 600 images, 128 MB request', ANTHROPIC.maxBase64Bytes === 10 * MiB && (ANTHROPIC.maxPatchesPerImage ?? null) === null && ANTHROPIC.maxImagesPerRequest === 600 && ANTHROPIC.maxRequestBytes === 128 * MiB, 'ANTHROPIC_IMAGE_LIMITS in src/models/roads/mediaLimits.ts must carry 10 MiB per image, no patch rule, 600 images and a 128 MiB request')
  check('the strictest per-image base64 ceiling is still the generic family\'s 5 MB', limitsMod.STRICTEST_IMAGE_MAX_BASE64_BYTES === 5 * MiB, String(limitsMod.STRICTEST_IMAGE_MAX_BASE64_BYTES) + ' — STRICTEST_IMAGE_MAX_BASE64_BYTES in src/models/roads/mediaLimits.ts is derived from the per-family limits; check the generic family')
  check('the 6000x6000 fixture really is over the patch rule (35,344 patches)', patches(6000, 6000) === 35_344 && patches(6000, 6000) > 30_000, 'the fixture size or the patches() helper in this script no longer matches the 32 px patch rule')
}

section('§2 the ladder follows the OpenAI patch rule and Anthropic first-send sizing')
{
  const out = await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { limits: OPENAI as never })
  const outDims = await dims(out.buffer)
  check('a 6000x6000 PNG shrinks under 30,000 patches for the OpenAI family', patches(outDims.width, outDims.height) <= 30_000, `${outDims.width}x${outDims.height} = ${patches(outDims.width, outDims.height)} patches`)
  check('…and no further than the rule asks (above 29,000 patches, the long side above 5,400 px)', patches(outDims.width, outDims.height) > 29_000 && outDims.width > 5_400, `${outDims.width}x${outDims.height} — maybeResizeAndDownsampleImageBuffer in src/platform/images/imageResizer.ts must shrink under the patch rule and no further`)
  check('…the record names the original and the displayed size', out.dimensions?.originalWidth === 6000 && out.dimensions.displayWidth === outDims.width, 'maybeResizeAndDownsampleImageBuffer in src/platform/images/imageResizer.ts must return dimensions naming the original and displayed size')
  const kept = await resizer.maybeResizeAndDownsampleImageBuffer(fits, fits.length, 'png', { limits: OPENAI as never })
  check('a 4000x3000 PNG (11,750 patches) passes through byte-identical', kept.buffer.equals(fits), 'maybeResizeAndDownsampleImageBuffer in src/platform/images/imageResizer.ts must return an image within the patch rule byte-identical')
  const anthropicOut = await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { limits: ANTHROPIC as never })
  const anthropicDims = await dims(anthropicOut.buffer)
  check('anthropic: the 6000x6000 PNG is sized to exactly 3000x3000 from its first send', anthropicDims.width === 3000 && anthropicDims.height === 3000, j(anthropicDims) + ' — the Anthropic first-send sizing in maybeResizeAndDownsampleImageBuffer, src/platform/images/imageResizer.ts')
  check('anthropic: the sizing record retains the 6000x6000 original and 3000x3000 display', anthropicOut.dimensions?.originalWidth === 6000 && anthropicOut.dimensions.originalHeight === 6000 && anthropicOut.dimensions.displayWidth === 3000 && anthropicOut.dimensions.displayHeight === 3000, j(anthropicOut.dimensions) + ' — the dimensions record returned by maybeResizeAndDownsampleImageBuffer, src/platform/images/imageResizer.ts')
  const anthropicKept = await resizer.maybeResizeAndDownsampleImageBuffer(small, small.length, 'png', { limits: ANTHROPIC as never })
  check('anthropic: an image within the first-send bounds stays byte-identical', anthropicKept.buffer.equals(small), 'maybeResizeAndDownsampleImageBuffer in src/platform/images/imageResizer.ts must leave an image within the Anthropic first-send bounds unchanged')
  let words = ''
  try {
    await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { limits: { ...OPENAI, maxRequestBytes: 64 } as never })
  } catch (err) {
    words = err instanceof Error ? err.message : String(err)
  }
  check('the ladder\'s one refusal names the patch rule and the per-request byte cap for the OpenAI family', /30,000 patches of 32 px per image/.test(words) && /per request as base64/.test(words) && /openai limits/.test(words), words.slice(0, 300) + ' — the refusal text thrown by maybeResizeAndDownsampleImageBuffer, src/platform/images/imageResizer.ts')
  let anthropicWords = ''
  try {
    await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { limits: { ...ANTHROPIC, maxBase64Bytes: 64 } as never })
  } catch (err) {
    anthropicWords = err instanceof Error ? err.message : String(err)
  }
  check('anthropic: the refusal words are as they were (per image as base64, no patch words)', /per image as base64/.test(anthropicWords) && !/patches/.test(anthropicWords) && /anthropic limits/.test(anthropicWords), anthropicWords.slice(0, 300) + ' — the refusal text thrown by maybeResizeAndDownsampleImageBuffer, src/platform/images/imageResizer.ts')
}

section('§3 the last-chance check refuses at the real limit and its words name it')
{
  const bigRow = [{ type: 'user', message: { role: 'user', content: [imageBlock(big)] } }]
  let words = ''
  let rule = ''
  try {
    validation.validateImagesForAPI(bigRow, 'gpt-5.6-sol')
  } catch (err) {
    words = err instanceof Error ? err.message : String(err)
    rule = String((err as { rule?: unknown }).rule ?? '')
  }
  check('openai: a 6000x6000 image is refused before the wire', words !== '', 'no refusal — validateImagesForAPI in src/engine/requests/imageValidation.ts must throw for an image over the model family\'s limit')
  check('…the words name the image, its patch count and the provider\'s per-image patch limit', words === "Image 1 is 6000x6000 px (35,344 patches of 32 px), which exceeds openai's 30,000-patch per-image limit. Resize the image before sending it.", words + ' — the message of ImageSizeError in src/engine/requests/imageValidation.ts')
  check('…typed as the patch rule', rule === 'patches', rule + ' — validateImagesForAPI in src/engine/requests/imageValidation.ts must throw an ImageSizeError typed with rule patches')
  let okWords = ''
  try {
    validation.validateImagesForAPI([{ type: 'user', message: { role: 'user', content: [imageBlock(fits)] } }], 'gpt-5.6-sol')
  } catch (err) {
    okWords = err instanceof Error ? err.message : String(err)
  }
  check('openai: a 4000x3000 image passes', okWords === '', okWords + ' — validateImagesForAPI in src/engine/requests/imageValidation.ts refused an image within the patch rule')
  let bytesWords = ''
  try {
    validation.validateImagesForAPI([{ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(11 * MiB) } }] } }], 'gpt-5.6-sol')
  } catch (err) {
    bytesWords = err instanceof Error ? err.message : String(err)
  }
  check('openai: 11 MB of base64 is not refused per image (no per-image byte cap on this route)', bytesWords === '', bytesWords + ' — validateImagesForAPI in src/engine/requests/imageValidation.ts must not apply a per-image byte cap for OpenAI (maxBase64Bytes null in src/models/roads/mediaLimits.ts)')
  const find = (validation as { findOversizedImages?: (messages: unknown[], limits: unknown) => { rule: string; limit: number; oversized: Array<{ index: number; size: number }> } | null }).findOversizedImages
  const total = find?.(
    [{ type: 'user', message: { role: 'user', content: [imageBlock(small), imageBlock(small)] } }],
    { ...OPENAI, maxRequestBytes: 100 },
  )
  const requestWords = total ? new validation.ImageSizeError(total.oversized, total.limit, 'openai', total.rule as never).message : ''
  check('openai: the request cap is a per-request rule and its words say so', total?.rule === 'request' && /^2 images total 392 bytes as base64, which exceeds openai's 100 bytes per-request limit\. Remove or resize images before sending them\.$/.test(requestWords), requestWords + ' — findOversizedImages and ImageSizeError in src/engine/requests/imageValidation.ts')
  let anthropicWords = ''
  try {
    validation.validateImagesForAPI([{ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(10 * MiB + 4) } }] } }], 'claude-sonnet-5')
  } catch (err) {
    anthropicWords = err instanceof Error ? err.message : String(err)
  }
  check('anthropic: unchanged — the 10 MB per-image words', /^Image 1 is 10MB as base64, which exceeds anthropic's 10MB per-image limit\. Resize the image before sending it\.$/.test(anthropicWords), anthropicWords + ' — the Anthropic words of ImageSizeError in src/engine/requests/imageValidation.ts')
  let anthropicBig = ''
  try {
    validation.validateImagesForAPI(bigRow, 'claude-sonnet-5')
  } catch (err) {
    anthropicBig = err instanceof Error ? err.message : String(err)
  }
  check('anthropic: unchanged — the 6000x6000 image passes (no patch rule on that family)', anthropicBig === '', anthropicBig + ' — validateImagesForAPI in src/engine/requests/imageValidation.ts must apply no patch rule to the Anthropic family')
}

section('§4 the Anthropic route\'s recovery, unchanged: the refusal row strips the refused attachment on the next request')
{
  const attachment = userRow([{ type: 'text', text: 'Result of reading the file' }, imageBlock(small)], true)
  const wireSentence = 'messages.1.content.1.image.source.base64.data: image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes'
  const err = new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: wireSentence } } as never, undefined, undefined as never)
  const row = errorsMod.getAssistantMessageFromError(err, 'claude-opus-4-8') as unknown as AnyMsg
  const rowText = ((row.message as { content: Array<{ text?: string }> }).content[0]?.text ?? '')
  check('the Anthropic 400 for an oversized image mints the row the plan reads', row.isApiErrorMessage === true && rowText === errorsMod.getImageTooLargeErrorMessage(), rowText + ' — getAssistantMessageFromError in src/engine/requests/apiErrorRows.ts must mint the image-too-large row for this 400')
  const history = [userRow('describe the file'), attachment, row]
  const wire = viewMod.normalizeMessagesForAPI(history as never) as unknown as AnyMsg[]
  const wireHasImage = wire.some(m => Array.isArray((m.message as { content?: unknown }).content) && ((m.message as { content: Array<{ type: string }> }).content).some(b => b.type === 'image'))
  check('the next Anthropic request carries no image block', !wireHasImage, j(wire.map(m => (m.message as { content?: unknown }).content)).slice(0, 300) + ' — normalizeMessagesForAPI in src/engine/messages/apiView.ts and the strip targets in src/engine/messages/apiPlan.ts')
  check('…and the refused attachment\'s text stays', wire.some(m => j((m.message as { content?: unknown }).content).includes('Result of reading the file')), 'the strip in src/engine/messages/apiPlan.ts must remove the image block and keep the attachment text')
}

section('§5 the OpenAI route: the provider refuses the image, the next request and a resumed one carry it no more')
async function callLane(model: string, messages: AnyMsg[]): Promise<{ errors: AnyMsg[]; thrown: unknown }> {
  const errors: AnyMsg[] = []
  let thrown: unknown
  const control = new AbortController()
  const cut = setTimeout(() => control.abort(), 20_000)
  cut.unref?.()
  try {
    const stream = routedCallModel({
      messages: messages as never,
      systemPrompt: asSystemPrompt(['fixture system prompt']),
      thinkingConfig: { type: 'disabled' },
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
      if (m.type === 'assistant' && m.isApiErrorMessage === true) errors.push(m)
    }
  } catch (err) {
    thrown = err
  } finally {
    clearTimeout(cut)
  }
  return { errors, thrown }
}
const REFUSAL_BODY = {
  error: {
    message: 'Invalid image: the image exceeds the maximum number of patches (30000) allowed for this model.',
    type: 'invalid_request_error',
    param: 'input',
    code: 'invalid_image',
  },
}
{
  const attachment = userRow([{ type: 'text', text: 'Result of reading the file' }, imageBlock(small)], true)
  const history = [userRow('describe the file'), attachment]
  fixture.script([{ error: { status: 400, body: REFUSAL_BODY } }])
  const before = fixture.captured.length
  const first = await callLane('gpt-5.6-sol', history)
  const request1 = fixture.captured[before]
  check('the first request reached the Responses wire carrying the image', request1?.dialect === 'responses' && hasInputImage(request1.body), j(request1?.body).slice(0, 200) + ' — the first request must reach the Responses wire (src/models/roads/callModelRouter.ts) with the image block intact')
  const row = first.errors[0]
  const rowText = row ? ((row.message as { content: Array<{ text?: string }> }).content[0]?.text ?? '') : ''
  check('the refusal settles as the route\'s error row with its words unchanged', row !== undefined && rowText.startsWith('API Error: OpenAI stream failed (openai-invalid_image)') && rowText.includes('Invalid image'), rowText + ' — the OpenAI error row is minted from the fixture 400 by the OpenAI road behind routedCallModel, src/models/roads/callModelRouter.ts')
  const stamp = refusalMod?.mediaRefusalOf(row as never) ?? null
  check('the row carries the typed media refusal (the stamp the plan reads)', stamp !== null && stamp.blockTypes.includes('image'), j(row) + ' — mediaRefusalOf in src/engine/request-parts/mediaRefusal.ts reads the stamp the OpenAI error row must carry')
  const targets = (planMod as { errorDrivenStripTargets?: (messages: unknown[]) => Map<string, Set<string>> }).errorDrivenStripTargets?.([...history, row]) ?? null
  check('the plan marks the refused attachment row for an image strip', targets?.get(String(attachment.uuid))?.has('image') === true, targets ? j([...targets.entries()].map(([k, v]) => [k, [...v]])) + ' — errorDrivenStripTargets in src/engine/messages/apiPlan.ts must mark the refused attachment row for image' : 'no errorDrivenStripTargets export in src/engine/messages/apiPlan.ts')

  fixture.script([{ text: 'the next answer' }])
  const second = await callLane('gpt-5.6-sol', [...history, row as AnyMsg, userRow('and now?')])
  const request2 = fixture.captured[before + 1]
  check('the next request reached the wire', request2?.dialect === 'responses' && second.thrown === undefined, String(second.thrown) + ' — the request after a refusal must reach the Responses wire without throwing')
  check('the next request carries no image', request2 !== undefined && !hasInputImage(request2.body), j(request2?.body).slice(0, 300) + ' — the plan in src/engine/messages/apiPlan.ts must strip images from a stamped-refused row')
  check('…and the refused attachment\'s text still rides', request2 !== undefined && j(request2.body).includes('Result of reading the file'), 'the strip in src/engine/messages/apiPlan.ts must keep the attachment text')

  const resumed = JSON.parse(JSON.stringify([...history, row, userRow('after a resume')])) as AnyMsg[]
  fixture.script([{ text: 'the resumed answer' }])
  const third = await callLane('gpt-5.6-sol', resumed)
  const request3 = fixture.captured[before + 2]
  check('after a resume (the rows read back from their record) the request carries no image', request3 !== undefined && third.thrown === undefined && !hasInputImage(request3.body), j(request3?.body).slice(0, 300) + ' — the stamp must survive the JSON round trip and the plan in src/engine/messages/apiPlan.ts must still strip the image')
  check('the stamp survives the record round trip', refusalMod !== null && refusalMod.mediaRefusalOf(resumed[2] as never) !== null, 'the stamp read by mediaRefusalOf in src/engine/request-parts/mediaRefusal.ts must be plain JSON on the row')

  fixture.script([{ error: { status: 400, body: { error: { message: 'Unsupported parameter: temperature', type: 'invalid_request_error', param: 'temperature', code: 'unsupported_parameter' } } } }])
  const poison = await callLane('gpt-5.6-sol', history)
  const poisonRow = poison.errors[0]
  check('a 400 that does not name the image carries no stamp', poisonRow !== undefined && (refusalMod?.mediaRefusalOf(poisonRow as never) ?? null) === null, j(poisonRow).slice(0, 300) + ' — only a 400 naming the image may be stamped (src/engine/request-parts/mediaRefusal.ts)')
}

section('§6 the pre-send check on the OpenAI route: an image over the rule never reaches the wire')
{
  const attachment = userRow([{ type: 'text', text: 'Result of reading the big file' }, imageBlock(big)], true)
  fixture.script([{ text: 'never sent' }])
  const before = fixture.captured.length
  const run = await callLane('gpt-5.6-sol', [userRow('describe the big file'), attachment])
  const thrownWords = run.thrown instanceof Error ? run.thrown.message : ''
  check('the route refuses before the request leaves', run.thrown instanceof validation.ImageSizeError, run.thrown ? thrownWords : `no refusal; ${fixture.captured.length - before} request(s) reached the wire — validateImagesForAPI in src/engine/requests/imageValidation.ts must run before the OpenAI request leaves`)
  check('…with the words naming the patch limit', /35,344 patches of 32 px/.test(thrownWords) && /openai's 30,000-patch per-image limit/.test(thrownWords), thrownWords + ' — the message of ImageSizeError in src/engine/requests/imageValidation.ts')
  const reached = fixture.captured[before]
  check('nothing reached the wire', fixture.captured.length === before, reached ? `the wire saw an input_image of ${j(inputImageDims(reached.body))} — validateImagesForAPI in src/engine/requests/imageValidation.ts must refuse it first` : '')
}

section('§7 the OpenAI route: a pasted image and an attached file leave the request after the stamped refusal')
{
  const pasted = userRow([{ type: 'text', text: 'what is this?' }, imageBlock(small)])
  fixture.script([{ error: { status: 400, body: REFUSAL_BODY } }, { text: 'after the paste' }])
  const before = fixture.captured.length
  const first = await callLane('gpt-5.6-sol', [pasted])
  const request1 = fixture.captured[before]
  check('the pasted image rode the operator\'s own row to the wire', request1 !== undefined && hasInputImage(request1.body), 'a pasted image must reach the Responses wire on the operator\'s own row (src/models/roads/callModelRouter.ts)')
  const row = first.errors[0] as AnyMsg
  const second = await callLane('gpt-5.6-sol', [pasted, row, userRow('and now?')])
  const request2 = fixture.captured[before + 1]
  check('after the refusal the pasted image leaves the request while its words stay', request2 !== undefined && second.thrown === undefined && !hasInputImage(request2.body) && j(request2.body).includes('what is this?'), j(request2?.body).slice(0, 300) + ' — the plan in src/engine/messages/apiPlan.ts must strip the pasted image after a stamped refusal and keep its text')

  const attachment = {
    type: 'attachment',
    uuid: '00000000-0000-4000-a000-00000000a7a7',
    timestamp: new Date().toISOString(),
    attachment: {
      type: 'file',
      filename: '/fixture/photo.png',
      content: { type: 'image', file: { base64: small.toString('base64'), type: 'image/png', originalSize: small.length } },
    },
  } as AnyMsg
  fixture.script([{ error: { status: 400, body: REFUSAL_BODY } }, { text: 'after the attachment' }])
  const at = fixture.captured.length
  const third = await callLane('gpt-5.6-sol', [userRow('describe @/fixture/photo.png'), attachment])
  const request3 = fixture.captured[at]
  check('an attached file\'s image is projected onto the wire at request time', request3 !== undefined && hasInputImage(request3.body) && j(request3.body).includes('photo.png'), j(request3?.body).slice(0, 300) + ' — attachment images are projected at request time by the plan in src/engine/messages/apiPlan.ts')
  const attachmentRow = third.errors[0] as AnyMsg
  check('…and the refusal row is stamped', (refusalMod?.mediaRefusalOf(attachmentRow as never) ?? null) !== null, 'the OpenAI error row must carry the stamp read by mediaRefusalOf in src/engine/request-parts/mediaRefusal.ts')
  const fourth = await callLane('gpt-5.6-sol', [userRow('describe @/fixture/photo.png'), attachment, attachmentRow, userRow('and now?')])
  const request4 = fixture.captured[at + 1]
  check('after the refusal the attached image leaves every later request, the file name still named', request4 !== undefined && fourth.thrown === undefined && !hasInputImage(request4.body) && j(request4.body).includes('photo.png'), j(request4?.body).slice(0, 300) + ' — the plan in src/engine/messages/apiPlan.ts must strip the attached file image after a stamped refusal and keep the file name')
  const stripper = (planMod as { stripImagesRefusedByStamp?: (rows: unknown[]) => unknown[] }).stripImagesRefusedByStamp
  const toolRound = [
    userRow('read it'),
    { type: 'assistant', uuid: '00000000-0000-4000-a000-00000000b1b1', timestamp: new Date().toISOString(), message: { id: 'msg_read', type: 'message', role: 'assistant', model: 'gpt-5.6-sol', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: '/fixture/photo.png' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } as AnyMsg,
    userRow([{ type: 'tool_result', tool_use_id: 'call_read', content: [{ type: 'text', text: 'the photo' }, imageBlock(small)] }]),
    attachmentRow,
  ]
  const stripped = stripper?.(toolRound) as AnyMsg[] | undefined
  const resultRow = stripped?.[2]
  const resultBlocks = (resultRow?.message as { content?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> } | undefined)?.content
  check('a refused tool-result image leaves its marker and original text', resultBlocks?.[0]?.type === 'tool_result' && resultBlocks[0].content?.length === 2 && resultBlocks[0].content[0]?.text === 'the photo' && resultBlocks[0].content[1]?.text === 'image elided from this request; Read it again if needed', j(resultBlocks ?? null).slice(0, 300) + ' — stripImagesRefusedByStamp in src/engine/messages/apiPlan.ts must leave the marker text and the original text')
  const untouched = stripper?.([pasted, userRow('plain')]) as AnyMsg[] | undefined
  check('without a stamped row nothing changes (the same rows by reference)', untouched !== undefined && untouched[0] === pasted, 'stripImagesRefusedByStamp in src/engine/messages/apiPlan.ts must return the same row objects when no row is stamped')
}

await fixture.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-image-refusal-recovery: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
