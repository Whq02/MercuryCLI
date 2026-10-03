#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_HOME', 'MERCURY_THINKING_BINDING', 'MERCURY_PREFIX_INDUCE_EDIT']) {
  delete process.env[ambient]
}
process.env.MERCURY_IMAGE_PROCESSOR = 'javascript'
const HOMES = [
  (process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'e004-sizer-home-'))),
  (process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'e004-sizer-daemon-'))),
  (process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'e004-sizer-crews-'))),
]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const note = (label: string): void => console.log(`  [NOTE] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — exceeded 280s')
  process.exit(1)
}, 280_000)
watchdog.unref?.()

const { startOverflowFixture } = await import(join(ROOT, 'scripts/compact/overflowFixture.ts'))
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const bootstrap = await import(join(ROOT, 'src/bootstrap/state.ts'))
bootstrap.setIsInteractive(false)
const errorsMod = await import(join(ROOT, 'src/services/api/errors.ts'))
const { APIError } = await import(join(ROOT, 'src/services/api/sdkErrors.ts'))
const { routedCallModel } = await import(join(ROOT, 'src/services/providers/callModelRouter.ts'))
const { asSystemPrompt } = await import(join(ROOT, 'src/utils/systemPromptType.ts'))
const { createUserMessage, createAssistantMessage } = await import(join(ROOT, 'src/utils/messages.ts'))
const { getEmptyToolPermissionContext } = await import(join(ROOT, 'src/Tool.ts'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(ROOT, 'src/utils/fileStateCache.ts'))
const { createContentReplacementState } = await import(join(ROOT, 'src/utils/toolResultStorage.ts'))
const { FileReadTool } = await import(join(ROOT, 'src/tools/FileReadTool/FileReadTool.ts'))
const { call: compactCommand } = await import(join(ROOT, 'src/commands/compact/compact.ts'))
const { recordSentRequest, resetSentRequestsForTests } = await import(join(ROOT, 'src/utils/forkedAgent.ts'))
const { processOwnerForLane, rosterOwnerFromToolUseContext } = await import(join(ROOT, 'src/services/run/resolveOwner.ts'))
const OWNER = String(processOwnerForLane(null))
const resizer = await import(join(ROOT, 'src/utils/imageResizer.ts'))
const { createAttachmentMessage } = await import(join(ROOT, 'src/utils/attachments/orchestrator.ts'))
const { describeImageProcessor, imageProcessorState } = await import(join(ROOT, 'src/tools/FileReadTool/imageProcessor.ts'))
const sharp = (await import('sharp')).default

type AnyMsg = Record<string, unknown> & { type?: string; uuid?: string }
type WireImage = { message: number; path: string; width: number; height: number; data: string; mime: string }
const MODEL_A = 'claude-opus-5-5'
const MODEL_B = 'claude-sonnet-5'
const SINGLE_CAP = 8000
const MANY_CAP = 2000
const MANY_THRESHOLD = 20

function dimsOf(buf: Buffer): { width: number; height: number; mime: string } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'png' }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) {
        o++
        continue
      }
      const m = buf[o + 1]!
      if (m === 0xff) {
        o++
        continue
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        o += 2
        continue
      }
      const len = buf.readUInt16BE(o + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7), mime: 'jpeg' }
      if (m === 0xda || m === 0xd9) break
      o += 2 + len
    }
  }
  return null
}

const flatPng = (w: number, h: number, interlace = false): Promise<Buffer> =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 24, g: 26, b: 31 } } })
    .png({ compressionLevel: 9, progressive: interlace })
    .toBuffer()
const flatJpeg = (w: number, h: number): Promise<Buffer> =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 24, g: 26, b: 31 } } }).jpeg({ quality: 70 }).toBuffer()
const imageBlock = (buffer: Buffer, mime: string): Record<string, unknown> => ({ type: 'image', source: { type: 'base64', media_type: `image/${mime}`, data: buffer.toString('base64') } })
const userRow = (content: unknown): AnyMsg => createUserMessage({ content: content as never }) as unknown as AnyMsg
const assistantRow = (content: unknown, model: string): AnyMsg => {
  const row = createAssistantMessage({ content: content as never }) as unknown as AnyMsg
  const message = row.message as Record<string, unknown>
  return { ...row, message: { ...message, model } }
}
const toolPair = (id: string, name: string, input: Record<string, unknown>, result: unknown, model: string): AnyMsg[] => [
  assistantRow([{ type: 'tool_use', id, name, input }], model),
  userRow([{ type: 'tool_result', tool_use_id: id, content: result }]),
]

function wireImages(body: Record<string, unknown>): WireImage[] {
  const out: WireImage[] = []
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return
    ;(message.content as Array<Record<string, unknown>>).forEach((block, at) => {
      const take = (candidate: Record<string, unknown>, path: string): void => {
        if (candidate.type !== 'image') return
        const source = candidate.source as { type?: string; data?: string } | undefined
        if (source?.type !== 'base64' || typeof source.data !== 'string') return
        const dims = dimsOf(Buffer.from(source.data, 'base64')) ?? { width: 0, height: 0, mime: '?' }
        out.push({ message: index, path, ...dims, data: source.data })
      }
      take(block, `content.${at}`)
      if (block.type === 'tool_result' && Array.isArray(block.content)) (block.content as Array<Record<string, unknown>>).forEach((inner, k) => take(inner, `content.${at}.content.${k}`))
    })
  })
  return out
}
function wireTexts(body: Record<string, unknown> | null): string[] {
  if (body === null) return []
  const out: string[] = []
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
      if (block.type === 'tool_result' && Array.isArray(block.content)) for (const inner of block.content as Array<Record<string, unknown>>) if (inner.type === 'text' && typeof inner.text === 'string') out.push(inner.text)
    }
  }
  return out
}

const refusals: string[] = []
fixture.script(request => {
  if (request.dialect !== 'anthropic') return { text: 'answered (non-anthropic dialect)' }
  const images = wireImages(request.body)
  const single = images.find(i => Math.max(i.width, i.height) > SINGLE_CAP)
  if (single !== undefined) {
    const s = `messages.${single.message}.${single.path}.image.source.base64.data: image dimensions exceed max allowed size: ${Math.max(single.width, single.height)} pixels > ${SINGLE_CAP} pixels`
    refusals.push(s)
    return { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: s } } } }
  }
  const many = images.length > MANY_THRESHOLD ? images.find(i => Math.max(i.width, i.height) > MANY_CAP) : undefined
  if (many !== undefined) {
    const s = `messages.${many.message}.${many.path}.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: ${MANY_CAP} pixels`
    refusals.push(s)
    return { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: s } } } }
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
  const cut = setTimeout(() => control.abort(), 60_000)
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
const largest = (body: Record<string, unknown> | null): number => (body === null ? 0 : Math.max(0, ...wireImages(body).map(i => Math.max(i.width, i.height))))
const imagesOf = (rows: AnyMsg[]): string[] =>
  rows.flatMap(row => {
    if (row.type !== 'user') return []
    const content = (row.message as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    return (content as Array<Record<string, unknown>>).flatMap(b => {
      if (b.type === 'image') return [(b.source as { data: string }).data]
      if (b.type === 'tool_result' && Array.isArray(b.content)) return (b.content as Array<Record<string, unknown>>).flatMap(x => (x.type === 'image' ? [(x.source as { data: string }).data] : []))
      return []
    })
  })
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

type Arm = { name: string; history: AnyMsg[]; images: number; unsizable: { width: number; height: number } }
async function buildArm(name: 'jsjpeg' | 'jspng' | 'jsmany'): Promise<Arm> {
  const history: AnyMsg[] = []
  if (name === 'jsmany') {
    const screen = await flatPng(1280, 720)
    const jpeg = await flatJpeg(3000, 2000)
    for (let i = 0; i < MANY_THRESHOLD + 1; i++) {
      const isJpeg = i === 10
      history.push(...toolPair(`toolu_${name}_${i}`, 'Read', { file_path: `D:/cutroom/cache/install/tui/screen-${i}.${isJpeg ? 'jpg' : 'png'}` }, [imageBlock(isJpeg ? jpeg : screen, isJpeg ? 'jpeg' : 'png')], MODEL_A))
      history.push(assistantRow([{ type: 'text', text: `looked at screen ${i + 1}` }], MODEL_A))
    }
    history.push(userRow('checking the colours and layout on the key ones'))
    return { name, history, images: MANY_THRESHOLD + 1, unsizable: { width: 3000, height: 2000 } }
  }
  const big = name === 'jsjpeg' ? await flatJpeg(9000, 1200) : await flatPng(1600, 9000, true)
  const d = dimsOf(big)!
  history.push(userRow('capture the thirteen screens'))
  history.push(...toolPair(`toolu_${name}_bash`, 'Bash', { command: 'python tools/capture_mercury_tui.py guide' }, [{ type: 'text', text: '13 screens -> install.tui.json' }], MODEL_A))
  history.push(...toolPair(`toolu_${name}_read`, 'Read', { file_path: 'D:/cutroom/cache/install/tui/session.png' }, [imageBlock(big, name === 'jsjpeg' ? 'jpeg' : 'png')], MODEL_A))
  history.push(assistantRow([{ type: 'text', text: 'Thirteen real screens saved. Checking the colours and layout.' }], MODEL_A))
  history.push(userRow('im confused now what?'))
  return { name, history, images: 1, unsizable: { width: d.width, height: d.height } }
}

section('§0 the road: the JavaScript image processor is forced, and the health row says it warns')
{
  const state = await imageProcessorState()
  check('the product is on the JavaScript image road (MERCURY_IMAGE_PROCESSOR=javascript)', state.road === 'javascript', j(state))
  const described = await describeImageProcessor()
  check('/health\'s words for that road say an image it cannot size is left out of the request', described.ready === false && /left out of the request/.test(described.detail ?? ''), j(described))
  const health = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
  check('the "Image processor" row is warn, not info, when the JavaScript road serves', health.includes("return { status: road.ready ? ('ok' as const) : ('warn' as const), evidence: road.line"), 'the row still reads info')
}

section('§1 the refusal sentences say what is true now')
{
  const many = errorsMod.getAssistantMessageFromError(
    new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.43.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels' } } as never, undefined, undefined as never),
    MODEL_A,
  ) as unknown as AnyMsg
  const manyWords = rowText(many)
  note(`many-image refusal: ${manyWords}`)
  check('the many-image sentence names the 2000 px limit, the next send, the transcript, and the image left out of the request', manyWords.includes('2000') && /at the next send/.test(manyWords) && /nothing is dropped from the transcript/.test(manyWords) && /cannot be sized is left out of the request/.test(manyWords) && !/on retry/.test(manyWords), manyWords)
  const single = errorsMod.getAssistantMessageFromError(
    new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.3.content.1.content.0.image.source.base64.data: image dimensions exceed max allowed size: 9000 pixels > 8000 pixels' } } as never, undefined, undefined as never),
    MODEL_A,
  ) as unknown as AnyMsg
  const singleWords = rowText(single)
  note(`single-image refusal: ${singleWords}`)
  check('the single-image sentence names 8000px, the next send, the transcript, and the image left out of the request', singleWords.includes('8000px') && /at the next send/.test(singleWords) && /nothing is dropped from the transcript/.test(singleWords) && /cannot be sized is left out of the request/.test(singleWords) && !/on retry/.test(singleWords), singleWords)
}

type LeftOutApi = {
  resetImagesLeftOutForTesting: () => void
  imagesLeftOutMarked: (messages: readonly unknown[]) => boolean
  takeImagesLeftOutReceipt: (owner: string) => { count: number; images: number; sidePx: number } | null
  imagesLeftOutNoticeLine: (receipt: { count: number; images: number; sidePx: number }) => string
}
const leftOutApi: LeftOutApi | null =
  typeof (resizer as Partial<LeftOutApi>).resetImagesLeftOutForTesting === 'function' && typeof (resizer as Partial<LeftOutApi>).takeImagesLeftOutReceipt === 'function' && typeof (resizer as Partial<LeftOutApi>).imagesLeftOutMarked === 'function' && typeof (resizer as Partial<LeftOutApi>).imagesLeftOutNoticeLine === 'function'
    ? (resizer as unknown as LeftOutApi)
    : null
const leftOutMark = { type: 'attachment', attachment: { type: 'images_left_out', count: 1, images: 21, sidePx: 2000 } }

section('§2 the once-per-session notice: the receipt, the transcript mark, the words, the turn machine')
{
  check('the sizer owns the images-left-out receipt, the transcript-mark read and the notice words', leftOutApi !== null, 'the base has no such seam')
  if (leftOutApi !== null) {
    leftOutApi.resetImagesLeftOutForTesting()
    check('a session whose transcript carries the images-left-out mark has been told; one without it has not (the mark, not a process latch, is the once)', leftOutApi.imagesLeftOutMarked([{ type: 'user' }, leftOutMark]) === true && leftOutApi.imagesLeftOutMarked([{ type: 'user' }, { type: 'attachment', attachment: { type: 'dead_thinking', dead: [] } }]) === false && leftOutApi.imagesLeftOutMarked([]) === false)
    check('a receipt is read once and cleared; an owner without one reads null', leftOutApi.takeImagesLeftOutReceipt('owner-a') === null)
    const line = leftOutApi.imagesLeftOutNoticeLine({ count: 1, images: 21, sidePx: 2000 })
    check('the notice names the count, the limit, what the model sees, the transcript and the image processor', /^one image of the 21 in this request/.test(line) && /2000 px/.test(line) && /what the model sees/.test(line) && /transcript keeps the original;/.test(line) && /Image processor/.test(line), line)
    const two = leftOutApi.imagesLeftOutNoticeLine({ count: 2, images: 2, sidePx: 8000 })
    check('…and the plural form', /^2 images could not be sized to the API's 8000 px limit and were left out/.test(two) && /originals/.test(two), two)
  }
  const turn = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check('the turn machine reads the conversation\'s receipt after the stream settles, paints the notice when the transcript carries no mark yet, and writes the mark beside it', turn.includes('takeImagesLeftOutReceipt(owner)') && turn.includes('!imagesLeftOutMarked(iter.messagesForQuery)') && turn.includes('createSystemMessage(imagesLeftOutNoticeLine(leftOut)') && turn.includes("createAttachmentMessage({ type: 'images_left_out'"))
  const chain = readFileSync(join(ROOT, 'src/utils/sessionStorage/chain.ts'), 'utf8')
  const render = readFileSync(join(ROOT, 'src/components/messages/nullRenderingAttachments.ts'), 'utf8')
  const wire = readFileSync(join(ROOT, 'src/utils/messages/attachmentText.ts'), 'utf8')
  check('the mark persists in the transcript (a resume reads it back), renders nothing on screen and projects nothing to the wire', chain.includes("if (att.type === 'images_left_out') return true") && render.includes("'images_left_out'") && /case 'images_left_out':\n\s*return \[\]/.test(wire))
  for (const road of ['anthropic/streamCore.ts', 'openaicompat/compatChatCallModel.ts', 'openai/openaiCallModel.ts', 'zai/zaiCallModel.ts']) {
    const source = readFileSync(join(ROOT, 'src/services/providers', road), 'utf8')
    check(`${road} fits the request's images under the conversation's owner, so the receipt lands on the right conversation`, /fitImagesToRequestCap\([^)]*owner: /.test(source), road)
  }
}

for (const armName of ['jsjpeg', 'jspng', 'jsmany'] as const) {
  const arm = await buildArm(armName)
  const originals = imagesOf(arm.history)
  const originalsHash = sha(originals.join('|'))
  section(`§3 arm ${arm.name}: ${arm.images} image(s), one of ${arm.unsizable.width}x${arm.unsizable.height} the JavaScript road cannot size`)
  leftOutApi?.resetImagesLeftOutForTesting()
  const session: AnyMsg[] = [...arm.history]
  const sends: Array<{ label: string; model: string; prompt: string }> = [
    { label: 'S1 the turn', model: MODEL_A, prompt: 'so now what?' },
    { label: 'S2 the next send', model: MODEL_A, prompt: 'okay so if it exceeds whats the solution?' },
    { label: 'S3 after /model switch', model: MODEL_B, prompt: 'say pong and standby' },
  ]
  let receipts = 0
  let noticesPainted = 0
  for (const step of sends) {
    if (step.label === 'S2 the next send' && leftOutApi !== null) check(`${arm.name}: the mark the first turn wrote is on the session, so no later turn paints the notice again`, leftOutApi.imagesLeftOutMarked(session))
    session.push(userRow(step.prompt))
    const run = await send(step.model, session)
    const texts = wireTexts(run.body)
    const noteOnWire = texts.filter(text => /could not be sized to this request's \d+ px limit and was left out of the request/.test(text))
    const wireCount = run.body === null ? -1 : wireImages(run.body).length
    check(`${step.label}: answered (largest image on the wire ${largest(run.body)} px, ${wireCount} image(s))`, answered(run), `errors=${j(run.errors.map(rowText))} thrown=${String(run.thrown)}`)
    check(`${step.label}: the unsizable image rides as ONE text note in its place, the other image(s) still on the wire`, noteOnWire.length === 1 && noteOnWire[0]!.includes(`${arm.unsizable.width}x${arm.unsizable.height}`) && wireCount === arm.images - 1, `notes=${j(noteOnWire)} images=${wireCount}`)
    const receipt = leftOutApi?.takeImagesLeftOutReceipt(OWNER) ?? null
    if (receipt !== null) {
      receipts++
      check(`${step.label}: the request's receipt names one image left out of ${arm.images} at the ${receipt.sidePx} px limit`, receipt.count === 1 && receipt.images === arm.images && receipt.sidePx === (arm.images > MANY_THRESHOLD ? MANY_CAP : SINGLE_CAP), j(receipt))
      if (leftOutApi !== null && !leftOutApi.imagesLeftOutMarked(session)) {
        noticesPainted++
        session.push(createAttachmentMessage({ type: 'images_left_out', count: receipt.count, images: receipt.images, sidePx: receipt.sidePx } as never) as unknown as AnyMsg)
      }
    }
    for (const row of run.rows) session.push({ ...row, message: { ...(row.message as Record<string, unknown>), model: step.model } })
  }
  check('every send of the arm left a receipt for the conversation, and the transcript mark let exactly one notice through', receipts === sends.length && noticesPainted === 1, `receipts=${receipts} notices=${noticesPainted}`)

  section(`/compact on the ${arm.name} session as it stands`)
  {
    const before = fixture.captured.length
    const refusedBefore = refusals.length
    let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
    const ctx: Record<string, unknown> = {
      abortController: new AbortController(),
      options: {
        commands: [], tools: [FileReadTool], engineModel: MODEL_A, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
        isNonInteractiveSession: false, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      getAppState: () => appState,
      setAppState: (f: (prev: never) => never): void => {
        appState = f(appState as never) as unknown as Record<string, unknown>
      },
      messages: session,
      readFileState: createFileStateCacheWithSizeLimit(100),
      contentReplacementState: createContentReplacementState(),
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
      agentId: undefined,
    }
    resetSentRequestsForTests()
    recordSentRequest(String(rosterOwnerFromToolUseContext(ctx as never)), session as never)
    let threw: string | undefined
    try {
      await compactCommand('', { ...ctx, setMessages: () => {}, onChangeAPIKey: () => {} } as never)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    const wire = fixture.captured.slice(before).filter(e => e.dialect === 'anthropic')
    note(`/compact made ${wire.length} Anthropic request(s); fixture refusals during it: ${refusals.length - refusedBefore}${threw !== undefined ? `; threw: ${threw.slice(0, 200)}` : ''}`)
    check('/compact is not refused for the image limit', threw === undefined || !/exceeds the API/.test(threw), threw ?? '')
  }

  section(`the ${arm.name} transcript`)
  {
    const now = imagesOf(session)
    check('every stored image still holds the bytes it was written with (the wire carried a note in its place, the transcript keeps the original)', now.length === originals.length && sha(now.join('|')) === originalsHash, `${now.length} stored vs ${originals.length} originals`)
  }
}

section('§4 an image whose size cannot be read fails closed over the many-image threshold, and rides as it is under it')
{
  leftOutApi?.resetImagesLeftOutForTesting()
  const unreadable = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x10]), Buffer.alloc(4096, 0x5a)])
  check('the header reader cannot size the fixture image (the dims-null road)', resizer.imageDimensionsOfBase64(unreadable.toString('base64')) === null)
  const small = await flatPng(8, 8)
  const over = userRow([imageBlock(unreadable, 'jpeg'), ...Array.from({ length: MANY_THRESHOLD }, () => imageBlock(small, 'png')), { type: 'text', text: 'twenty-one images' }])
  const fitOver = await resizer.fitImagesToRequestCap([over], { model: MODEL_A, owner: 'f2-over' })
  const overTexts = wireTexts({ messages: fitOver.messages.map(row => row.message) })
  const overNote = overTexts.find(text => /whose size could not be read was left out of this request of 21 images/.test(text))
  check(`over the threshold (${MANY_THRESHOLD + 1} images): the unreadable image is left out as a one-line note naming the request's size and the ${MANY_CAP} px cap, the other images ride`, fitOver.leftOut === 1 && overNote !== undefined && overNote.includes(`${MANY_CAP} px`) && wireImages({ messages: fitOver.messages.map(row => row.message) }).length === MANY_THRESHOLD, j({ leftOut: fitOver.leftOut, notes: overTexts.filter(t => t.startsWith('[An image')) }))
  check('…and the receipt names it under the owner', j(leftOutApi?.takeImagesLeftOutReceipt('f2-over') ?? null).includes('"count":1'))
  const under = userRow([imageBlock(unreadable, 'jpeg'), imageBlock(small, 'png'), { type: 'text', text: 'two images' }])
  const fitUnder = await resizer.fitImagesToRequestCap([under], { model: MODEL_A, owner: 'f2-under' })
  check('under the threshold nothing says the image is over the cap: it rides as it is and no receipt is written', fitUnder.leftOut === 0 && fitUnder.firstEdited === -1 && leftOutApi?.takeImagesLeftOutReceipt('f2-under') === null, j({ leftOut: fitUnder.leftOut, firstEdited: fitUnder.firstEdited }))
}

section('§5 driven: a real run paints the notice and writes its mark once; a real --resume <id> in a new process paints no second notice and writes no second mark (both image roads)')
{
  const chainMod = await import(join(ROOT, 'src/utils/sessionStorage/chain.ts'))
  const stamp = '2026-10-02T05:25:14.233Z'
  const tied = [
    { uuid: 'reply', parentUuid: 'prompt', timestamp: '2026-10-02T05:25:14.227Z' },
    { uuid: 'notice', parentUuid: 'reply', timestamp: stamp },
    { uuid: 'mark', parentUuid: 'notice', timestamp: stamp },
  ]
  check('the leaf rule: a trailing row written in the same millisecond as its parent (the images mark, the dead-thinking marks) is the newer row — file order breaks the tie, so the resume chain starts from the mark', chainMod.findLatestMessage(tied, () => true)?.uuid === 'mark', `picked ${chainMod.findLatestMessage(tied, () => true)?.uuid}`)
  check('the leaf rule: a later stamp still wins whatever the file order', chainMod.findLatestMessage([tied[2]!, tied[1]!, { uuid: 'later', parentUuid: 'mark', timestamp: '2026-10-02T05:25:14.234Z' }, tied[0]!], () => true)?.uuid === 'later')
  const DIST = process.env.MERCURY_PROOF_BUNDLE ?? join(ROOT, 'dist', 'mercury.mjs')
  const nodeBin = Bun.which('node')
  check('the bundle is built and a node binary is on PATH (bun run build.ts; MERCURY_PROOF_BUNDLE points elsewhere)', existsSync(DIST) && nodeBin !== null, DIST)
  const { seedFirstRun } = await import(join(ROOT, 'scripts/lib/firstRunSeed.ts'))
  const unreadable = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x10]), Buffer.alloc(4096, 0x5a)])
  const small = await flatPng(8, 8)
  const driveImages = [imageBlock(unreadable, 'jpeg'), ...Array.from({ length: MANY_THRESHOLD }, () => imageBlock(small, 'png'))]
  const unreadableBase64 = unreadable.toString('base64')
  const NOTICE_WORDS = 'left out of what the model sees'
  const transcriptOf = (configDir: string, sid: string): string | null => {
    const root = join(configDir, 'projects')
    if (!existsSync(root)) return null
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const candidate = join(root, project.name, `${sid}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  const rowsOf = (file: string | null): string[] => (file === null ? [] : readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== ''))
  const marksIn = (rows: string[]): number => rows.filter(line => line.includes('"attachmentType":"images_left_out"')).length
  const noticesIn = (rows: string[]): number => rows.filter(line => line.includes('"kind":"notice"') && line.includes(NOTICE_WORDS)).length
  for (const road of ['javascript', 'native'] as const) {
    if (!existsSync(DIST) || nodeBin === null) break
    const home = mkdtempSync(join(tmpdir(), `e004-sizer-drive-${road}-`))
    HOMES.push(home)
    const configDir = join(home, 'config')
    const cwd = join(home, 'work')
    mkdirSync(cwd, { recursive: true })
    seedFirstRun(configDir, [cwd])
    const env: Record<string, string> = {
      ...fixture.env,
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      NO_COLOR: '1',
      BROWSER: '/usr/bin/true',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREWS_DIR: join(home, 'crews'),
      MERCURY_DAP: '0',
      ...(road === 'javascript' ? { MERCURY_IMAGE_PROCESSOR: 'javascript' } : {}),
    }
    const sid = randomUUID()
    const drive = (args: string[], content: unknown): Promise<{ exit: number | null; stdout: string; stderr: string }> =>
      new Promise(resolvePromise => {
        const child = spawn(nodeBin, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL_B, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
        const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>).map(block => (block.type === 'image' ? { type: 'image', media_type: (block.source as { media_type: string }).media_type, data: (block.source as { data: string }).data } : block)) : content
        child.stdin.end(`${j({ type: 'prompt', content: blocks, id: randomUUID() })}\n`)
      })
    const mainRequests = (): Array<Record<string, unknown>> => fixture.captured.filter(entry => entry.dialect === 'anthropic' && entry.body.model === MODEL_B && j(entry.body).includes(`drive-${road}`)).map(entry => entry.body)
    const first = await drive(['--session-id', sid], [...driveImages, { type: 'text', text: `drive-${road}: twenty-one images, say what you see` }])
    check(`${road}: the first process answers (exit 0) and one main request reached the fixture`, first.exit === 0 && mainRequests().length === 1, `exit=${first.exit} requests=${mainRequests().length} stderr=${first.stderr.slice(-400)}`)
    check(`${road}: the first request carries the ${MANY_THRESHOLD} sizable images and not the unreadable one`, mainRequests().length === 1 && wireImages(mainRequests()[0]!).length === MANY_THRESHOLD && !j(mainRequests()[0]).includes(unreadableBase64), `images=${mainRequests()[0] ? wireImages(mainRequests()[0]!).length : -1}`)
    const transcript = transcriptOf(configDir, sid)
    const before = rowsOf(transcript)
    check(`${road}: the transcript carries the notice once and the mark once, and keeps the unreadable image`, transcript !== null && noticesIn(before) === 1 && marksIn(before) === 1 && before.some(line => line.includes(unreadableBase64)), `transcript=${transcript} notices=${noticesIn(before)} marks=${marksIn(before)}`)
    const second = await drive(['--resume', sid], `drive-${road}: and again, in a new process`)
    const after = rowsOf(transcript)
    check(`${road}: a new process resumes the session by id and answers (exit 0, a second main request)`, second.exit === 0 && mainRequests().length === 2, `exit=${second.exit} requests=${mainRequests().length} stderr=${second.stderr.slice(-400)}`)
    check(`${road}: the resumed request still leaves the unreadable image out and carries the ${MANY_THRESHOLD} others`, mainRequests().length === 2 && wireImages(mainRequests()[1]!).length === MANY_THRESHOLD && !j(mainRequests()[1]).includes(unreadableBase64), `images=${mainRequests()[1] ? wireImages(mainRequests()[1]!).length : -1}`)
    check(`${road}: THE ONCE — after the resume the transcript still carries one notice and one mark (the mark written in the notice's millisecond stays on the resume chain, so the resumed process is not told again)`, noticesIn(after) === 1 && marksIn(after) === 1, `notices ${noticesIn(before)} → ${noticesIn(after)}, marks ${marksIn(before)} → ${marksIn(after)}`)
  }
}

note(`fixture refusals issued in this run: ${refusals.length}${refusals.length > 0 ? ` — first: ${refusals[0]}` : ''}`)
await fixture.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-field-e004-image-sizer: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
