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
  (process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'image-refusal-teams-'))),
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
  console.log('\nTIMEOUT — the image refusal prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const limitsMod = await import('../../src/constants/apiLimits.ts')
const resizer = await import('../../src/utils/imageResizer.ts')
const validation = await import('../../src/utils/imageValidation.ts')
const planMod = await import('../../src/utils/messages/apiPlan.ts')
const viewMod = await import('../../src/utils/messages/apiView.ts')
const errorsMod = await import('../../src/services/api/errors.ts')
const refusalMod = await import('../../src/services/api/mediaRefusal.ts').catch(() => null)
const { APIError } = await import('@anthropic-ai/sdk')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
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
  check('openai: no per-image byte ceiling (the provider caps the request, never the image)', OPENAI.maxBase64Bytes === null, j(OPENAI.maxBase64Bytes))
  check('openai: 30,000 patches of 32 px per image', OPENAI.maxPatchesPerImage?.patchPx === 32 && OPENAI.maxPatchesPerImage.count === 30_000, j(OPENAI.maxPatchesPerImage))
  check('openai: 512 MB per request · 1,500 images per request', OPENAI.maxRequestBytes === 512 * MiB && OPENAI.maxImagesPerRequest === 1500)
  check('openai: the images-vision guide is cited', OPENAI.doc === 'https://developers.openai.com/api/docs/guides/images-vision')
  check('anthropic: unchanged — 10 MB base64 per image, no patch rule, 100 images, 32 MB request', ANTHROPIC.maxBase64Bytes === 10 * MiB && (ANTHROPIC.maxPatchesPerImage ?? null) === null && ANTHROPIC.maxImagesPerRequest === 100 && ANTHROPIC.maxRequestBytes === 32 * MiB)
  check('the strictest per-image base64 ceiling is still the generic family\'s 5 MB', limitsMod.STRICTEST_IMAGE_MAX_BASE64_BYTES === 5 * MiB, String(limitsMod.STRICTEST_IMAGE_MAX_BASE64_BYTES))
  check('the 6000x6000 fixture really is over the patch rule (35,344 patches)', patches(6000, 6000) === 35_344 && patches(6000, 6000) > 30_000)
}

section('§2 the ladder shrinks to the patch rule on the OpenAI family and leaves the Anthropic family as it was')
{
  const out = await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { limits: OPENAI as never })
  const outDims = await dims(out.buffer)
  check('a 6000x6000 PNG shrinks under 30,000 patches for the OpenAI family', patches(outDims.width, outDims.height) <= 30_000, `${outDims.width}x${outDims.height} = ${patches(outDims.width, outDims.height)} patches`)
  check('…and no further than the rule asks (above 29,000 patches, the long side above 5,400 px)', patches(outDims.width, outDims.height) > 29_000 && outDims.width > 5_400, `${outDims.width}x${outDims.height}`)
  check('…the record names the original and the displayed size', out.dimensions?.originalWidth === 6000 && out.dimensions.displayWidth === outDims.width)
  const kept = await resizer.maybeResizeAndDownsampleImageBuffer(fits, fits.length, 'png', { limits: OPENAI as never })
  check('a 4000x3000 PNG (11,750 patches) passes through byte-identical', kept.buffer.equals(fits))
  const anthropicOut = await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { limits: ANTHROPIC as never })
  check('anthropic: the same 6000x6000 PNG passes through unchanged (within 8000 px and 10 MB)', anthropicOut.buffer.equals(big))
  let words = ''
  try {
    await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { limits: { ...OPENAI, maxRequestBytes: 64 } as never })
  } catch (err) {
    words = err instanceof Error ? err.message : String(err)
  }
  check('the ladder\'s one refusal names the patch rule and the per-request byte cap for the OpenAI family', /30,000 patches of 32 px per image/.test(words) && /per request as base64/.test(words) && /openai limits/.test(words), words.slice(0, 300))
  let anthropicWords = ''
  try {
    await resizer.maybeResizeAndDownsampleImageBuffer(big, big.length, 'png', { limits: { ...ANTHROPIC, maxBase64Bytes: 64 } as never })
  } catch (err) {
    anthropicWords = err instanceof Error ? err.message : String(err)
  }
  check('anthropic: the refusal words are as they were (per image as base64, no patch words)', /per image as base64/.test(anthropicWords) && !/patches/.test(anthropicWords) && /anthropic limits/.test(anthropicWords), anthropicWords.slice(0, 300))
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
  check('openai: a 6000x6000 image is refused before the wire', words !== '', 'no refusal')
  check('…the words name the image, its patch count and the provider\'s per-image patch limit', words === "Image 1 is 6000x6000 px (35,344 patches of 32 px), which exceeds openai's 30,000-patch per-image limit. Resize the image before sending it.", words)
  check('…typed as the patch rule', rule === 'patches', rule)
  let okWords = ''
  try {
    validation.validateImagesForAPI([{ type: 'user', message: { role: 'user', content: [imageBlock(fits)] } }], 'gpt-5.6-sol')
  } catch (err) {
    okWords = err instanceof Error ? err.message : String(err)
  }
  check('openai: a 4000x3000 image passes', okWords === '', okWords)
  let bytesWords = ''
  try {
    validation.validateImagesForAPI([{ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(11 * MiB) } }] } }], 'gpt-5.6-sol')
  } catch (err) {
    bytesWords = err instanceof Error ? err.message : String(err)
  }
  check('openai: 11 MB of base64 is not refused per image (no per-image byte cap on this route)', bytesWords === '', bytesWords)
  const find = (validation as { findOversizedImages?: (messages: unknown[], limits: unknown) => { rule: string; limit: number; oversized: Array<{ index: number; size: number }> } | null }).findOversizedImages
  const total = find?.(
    [{ type: 'user', message: { role: 'user', content: [imageBlock(small), imageBlock(small)] } }],
    { ...OPENAI, maxRequestBytes: 100 },
  )
  const requestWords = total ? new validation.ImageSizeError(total.oversized, total.limit, 'openai', total.rule as never).message : ''
  check('openai: the request cap is a per-request rule and its words say so', total?.rule === 'request' && /^2 images total 392 bytes as base64, which exceeds openai's 100 bytes per-request limit\. Remove or resize images before sending them\.$/.test(requestWords), requestWords)
  let anthropicWords = ''
  try {
    validation.validateImagesForAPI([{ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(10 * MiB + 4) } }] } }], 'claude-sonnet-5')
  } catch (err) {
    anthropicWords = err instanceof Error ? err.message : String(err)
  }
  check('anthropic: unchanged — the 10 MB per-image words', /^Image 1 is 10MB as base64, which exceeds anthropic's 10MB per-image limit\. Resize the image before sending it\.$/.test(anthropicWords), anthropicWords)
  let anthropicBig = ''
  try {
    validation.validateImagesForAPI(bigRow, 'claude-sonnet-5')
  } catch (err) {
    anthropicBig = err instanceof Error ? err.message : String(err)
  }
  check('anthropic: unchanged — the 6000x6000 image passes (no patch rule on that family)', anthropicBig === '', anthropicBig)
}

section('§4 the Anthropic route\'s recovery, unchanged: the refusal row strips the refused attachment on the next request')
{
  const attachment = userRow([{ type: 'text', text: 'Result of reading the file' }, imageBlock(small)], true)
  const wireSentence = 'messages.1.content.1.image.source.base64.data: image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes'
  const err = new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: wireSentence } } as never, undefined, undefined as never)
  const row = errorsMod.getAssistantMessageFromError(err, 'claude-opus-4-8') as unknown as AnyMsg
  const rowText = ((row.message as { content: Array<{ text?: string }> }).content[0]?.text ?? '')
  check('the Anthropic 400 for an oversized image mints the row the plan reads', row.isApiErrorMessage === true && rowText === errorsMod.getImageTooLargeErrorMessage(), rowText)
  const history = [userRow('describe the file'), attachment, row]
  const wire = viewMod.normalizeMessagesForAPI(history as never) as unknown as AnyMsg[]
  const wireHasImage = wire.some(m => Array.isArray((m.message as { content?: unknown }).content) && ((m.message as { content: Array<{ type: string }> }).content).some(b => b.type === 'image'))
  check('the next Anthropic request carries no image block', !wireHasImage, j(wire.map(m => (m.message as { content?: unknown }).content)).slice(0, 300))
  check('…and the refused attachment\'s text stays', wire.some(m => j((m.message as { content?: unknown }).content).includes('Result of reading the file')))
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
  check('the first request reached the Responses wire carrying the image', request1?.dialect === 'responses' && hasInputImage(request1.body), j(request1?.body).slice(0, 200))
  const row = first.errors[0]
  const rowText = row ? ((row.message as { content: Array<{ text?: string }> }).content[0]?.text ?? '') : ''
  check('the refusal settles as the route\'s error row with its words unchanged', row !== undefined && rowText.startsWith('API Error: OpenAI stream failed (openai-invalid_image)') && rowText.includes('Invalid image'), rowText)
  const stamp = refusalMod?.mediaRefusalOf(row as never) ?? null
  check('the row carries the typed media refusal (the stamp the plan reads)', stamp !== null && stamp.blockTypes.includes('image'), j(row))
  const targets = (planMod as { errorDrivenStripTargets?: (messages: unknown[]) => Map<string, Set<string>> }).errorDrivenStripTargets?.([...history, row]) ?? null
  check('the plan marks the refused attachment row for an image strip', targets?.get(String(attachment.uuid))?.has('image') === true, targets ? j([...targets.entries()].map(([k, v]) => [k, [...v]])) : 'no errorDrivenStripTargets export')

  fixture.script([{ text: 'the next answer' }])
  const second = await callLane('gpt-5.6-sol', [...history, row as AnyMsg, userRow('and now?')])
  const request2 = fixture.captured[before + 1]
  check('the next request reached the wire', request2?.dialect === 'responses' && second.thrown === undefined, String(second.thrown))
  check('the next request carries no image', request2 !== undefined && !hasInputImage(request2.body), j(request2?.body).slice(0, 300))
  check('…and the refused attachment\'s text still rides', request2 !== undefined && j(request2.body).includes('Result of reading the file'))

  const resumed = JSON.parse(JSON.stringify([...history, row, userRow('after a resume')])) as AnyMsg[]
  fixture.script([{ text: 'the resumed answer' }])
  const third = await callLane('gpt-5.6-sol', resumed)
  const request3 = fixture.captured[before + 2]
  check('after a resume (the rows read back from their record) the request carries no image', request3 !== undefined && third.thrown === undefined && !hasInputImage(request3.body), j(request3?.body).slice(0, 300))
  check('the stamp survives the record round trip', refusalMod !== null && refusalMod.mediaRefusalOf(resumed[2] as never) !== null)

  fixture.script([{ error: { status: 400, body: { error: { message: 'Unsupported parameter: temperature', type: 'invalid_request_error', param: 'temperature', code: 'unsupported_parameter' } } } }])
  const poison = await callLane('gpt-5.6-sol', history)
  const poisonRow = poison.errors[0]
  check('a 400 that does not name the image carries no stamp', poisonRow !== undefined && (refusalMod?.mediaRefusalOf(poisonRow as never) ?? null) === null, j(poisonRow).slice(0, 300))
}

section('§6 the pre-send check on the OpenAI route: an image over the rule never reaches the wire')
{
  const attachment = userRow([{ type: 'text', text: 'Result of reading the big file' }, imageBlock(big)], true)
  fixture.script([{ text: 'never sent' }])
  const before = fixture.captured.length
  const run = await callLane('gpt-5.6-sol', [userRow('describe the big file'), attachment])
  const thrownWords = run.thrown instanceof Error ? run.thrown.message : ''
  check('the route refuses before the request leaves', run.thrown instanceof validation.ImageSizeError, run.thrown ? thrownWords : `no refusal; ${fixture.captured.length - before} request(s) reached the wire`)
  check('…with the words naming the patch limit', /35,344 patches of 32 px/.test(thrownWords) && /openai's 30,000-patch per-image limit/.test(thrownWords), thrownWords)
  const reached = fixture.captured[before]
  check('nothing reached the wire', fixture.captured.length === before, reached ? `the wire saw an input_image of ${j(inputImageDims(reached.body))}` : '')
}

section('§7 the OpenAI route: a pasted image and an attached file leave the request after the stamped refusal')
{
  const pasted = userRow([{ type: 'text', text: 'what is this?' }, imageBlock(small)])
  fixture.script([{ error: { status: 400, body: REFUSAL_BODY } }, { text: 'after the paste' }])
  const before = fixture.captured.length
  const first = await callLane('gpt-5.6-sol', [pasted])
  const request1 = fixture.captured[before]
  check('the pasted image rode the operator\'s own row to the wire', request1 !== undefined && hasInputImage(request1.body))
  const row = first.errors[0] as AnyMsg
  const second = await callLane('gpt-5.6-sol', [pasted, row, userRow('and now?')])
  const request2 = fixture.captured[before + 1]
  check('after the refusal the pasted image leaves the request while its words stay', request2 !== undefined && second.thrown === undefined && !hasInputImage(request2.body) && j(request2.body).includes('what is this?'), j(request2?.body).slice(0, 300))

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
  check('an attached file\'s image is projected onto the wire at request time', request3 !== undefined && hasInputImage(request3.body) && j(request3.body).includes('photo.png'), j(request3?.body).slice(0, 300))
  const attachmentRow = third.errors[0] as AnyMsg
  check('…and the refusal row is stamped', (refusalMod?.mediaRefusalOf(attachmentRow as never) ?? null) !== null)
  const fourth = await callLane('gpt-5.6-sol', [userRow('describe @/fixture/photo.png'), attachment, attachmentRow, userRow('and now?')])
  const request4 = fixture.captured[at + 1]
  check('after the refusal the attached image leaves every later request, the file name still named', request4 !== undefined && fourth.thrown === undefined && !hasInputImage(request4.body) && j(request4.body).includes('photo.png'), j(request4?.body).slice(0, 300))
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
  check('the owner strips a refused image nested in a tool result, the text kept', resultBlocks?.[0]?.type === 'tool_result' && resultBlocks[0].content?.length === 1 && resultBlocks[0].content[0]?.type === 'text', j(resultBlocks ?? null).slice(0, 300))
  const untouched = stripper?.([pasted, userRow('plain')]) as AnyMsg[] | undefined
  check('without a stamped row nothing changes (the same rows by reference)', untouched !== undefined && untouched[0] === pasted)
}

await fixture.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-image-refusal-recovery: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
