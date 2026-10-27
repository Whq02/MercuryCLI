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
  (process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fitted-images-thinking-home-'))),
  (process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'fitted-images-thinking-daemon-'))),
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
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the fitted-images prover exceeded 240s')
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
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const wireEdits = await import('../../src/utils/messages/wireEdits.ts').catch(() => null)
const resizer = await import('../../src/utils/imageResizer.ts')
const fitImagesToRequestCap = resizer.fitImagesToRequestCap
const resetWireEditsForTesting = wireEdits?.resetWireEditsForTesting ?? ((): void => {})
const resetFittedImagesForTesting = (resizer as { resetFittedImagesForTesting?: () => void }).resetFittedImagesForTesting ?? ((): void => {})
const sharp = (await import('sharp')).default

type AnyMsg = Record<string, unknown> & { type: string; uuid?: string }
type WireImage = { message: number; width: number; height: number; data: string }
const MODEL = 'claude-opus-5-5'
const RULE = limitsMod.ANTHROPIC_IMAGE_LIMITS.manyImages
const THRESHOLD = RULE?.threshold ?? 20
const CAP = RULE?.maxSidePx ?? 2000

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
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'image') continue
      const source = block.source as { type?: string; data?: string } | undefined
      if (source?.type !== 'base64' || typeof source.data !== 'string') continue
      out.push({ message: index, ...(pngDims(source.data) ?? { width: 0, height: 0 }), data: source.data })
    }
  })
  return out
}
function wireThinking(body: Record<string, unknown>): string[] {
  const out: string[] = []
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Array<Record<string, unknown>>) if (block.type === 'thinking') out.push(String(block.thinking ?? ''))
  }
  return out
}

async function send(messages: AnyMsg[], ownerKey: string): Promise<{ errors: AnyMsg[]; thrown: unknown; body: Record<string, unknown> | null }> {
  const errors: AnyMsg[] = []
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
        model: MODEL,
        querySource: 'sdk',
        ownerKey,
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
  const captured = fixture.captured.slice(before).find(entry => entry.dialect === 'anthropic')
  return { errors, thrown, body: captured?.body ?? null }
}

const small = await flat(64, 48)
const wide = await flat(2500, 1400)

function history(images: Buffer[], thinkingAfter: number): AnyMsg[] {
  const rows: AnyMsg[] = []
  images.forEach((image, index) => {
    rows.push(userRow([{ type: 'text', text: `image ${index + 1} of ${images.length}` }, imageBlock(image)]))
    const reasoning = index >= thinkingAfter - 1 ? [thinkingBlock(`reasoning before the fit, after image ${index + 1}`)] : []
    rows.push(assistantRow([...reasoning, { type: 'text', text: `noted image ${index + 1}` }]))
  })
  rows.push(userRow('and the next step?'))
  return rows
}

section('§1 pure: an edit already on the wire strips only the blocks that stood after it when it was first applied')
check('the wire-edit memory exists (src/utils/messages/wireEdits.ts)', wireEdits !== null)
if (wireEdits !== null) {
  const { settleWireEdits } = wireEdits
  resetWireEditsForTesting()
  const rows: AnyMsg[] = [
    userRow([{ type: 'text', text: 'the image' }]),
    assistantRow([thinkingBlock('signed against the unedited row'), { type: 'text', text: 'a' }]),
    userRow('next'),
  ]
  const first = settleWireEdits('owner-pure', rows, [{ index: 0, key: 'image:one' }])
  check('the first application reports the edited row (the caller strips from it)', first.firstEdited === 0 && first.messages === rows, j(first.firstEdited))
  const later: AnyMsg[] = [
    ...rows,
    assistantRow([thinkingBlock('minted after the edit'), { type: 'text', text: 'b' }]),
    userRow('and then'),
  ]
  const second = settleWireEdits('owner-pure', later, [{ index: 0, key: 'image:one' }])
  const thinking = (list: AnyMsg[]): string[] => list.flatMap(row => (row.type === 'assistant' ? (row.message as { content: Array<{ type: string; thinking?: string }> }).content.filter(b => b.type === 'thinking').map(b => b.thinking ?? '') : []))
  check('the same edit on the next request is not a new edit', second.firstEdited === -1, j(second.firstEdited))
  check('the block that stood after the row at the first application leaves the wire; the block minted after stays', j(thinking(second.messages)) === j(['minted after the edit']), j(thinking(second.messages)))
  const other = settleWireEdits('owner-pure', later, [{ index: 0, key: 'image:one' }, { index: 2, key: 'image:two' }])
  check('a new edit on a later row is reported as new while the known one keeps its range', other.firstEdited === 2 && j(thinking(other.messages)) === j(['minted after the edit']), `${other.firstEdited} ${j(thinking(other.messages))}`)
  const folded: AnyMsg[] = [userRow('summary'), assistantRow([thinkingBlock('after the fold'), { type: 'text', text: 'c' }]), userRow('next')]
  const refolded = settleWireEdits('owner-pure', folded, [{ index: 0, key: 'image:one' }])
  check('when the request no longer carries the row the edit was first applied against, the edit is applied afresh', refolded.firstEdited === 0, j(refolded.firstEdited))
  const bare = settleWireEdits(undefined, later, [{ index: 0, key: 'image:one' }])
  check('without an owner the edit is new every time (the caller strips from it, as before)', bare.firstEdited === 0 && bare.messages === later)
}

section('§2 the composition owner: a fitted image is a new edit once; the thinking minted after survives')
{
  resetWireEditsForTesting()
  resetFittedImagesForTesting()
  const limits = limitsMod.ANTHROPIC_IMAGE_LIMITS
  const images = Array.from({ length: THRESHOLD + 1 }, (_, index) => (index === 5 ? wide : small))
  const rows = history(images, 3)
  const first = await fitImagesToRequestCap(rows, { limits, model: MODEL, owner: 'owner-fit' })
  const wideRow = rows.findIndex(row => j(row).includes(wide.toString('base64').slice(0, 100)))
  check(`the first request sizes the wide image (row ${wideRow}) and reports it as the first edited row`, first.firstEdited === wideRow && first.sized === 1, `${first.firstEdited} sized ${first.sized}`)
  const later = [...rows.slice(0, -1), assistantRow([thinkingBlock('minted after the fit'), { type: 'text', text: 'go on' }]), userRow('and then?')]
  const second = await fitImagesToRequestCap(later, { limits, model: MODEL, owner: 'owner-fit' })
  const thinkingOf = (list: AnyMsg[]): string[] => list.flatMap(row => (row.type === 'assistant' ? (row.message as { content: Array<{ type: string; thinking?: string }> }).content.filter(b => b.type === 'thinking').map(b => b.thinking ?? '') : []))
  check('the second request reports no new edit', second.firstEdited === -1 && second.sized === 1, `${second.firstEdited} sized ${second.sized}`)
  const kept = thinkingOf(second.messages)
  check('the blocks that stood after the wide image at the first fit leave the wire; the block minted after the fit stays', kept.includes('minted after the fit') && kept.length === 4 && kept.every(text => text === 'minted after the fit' || /after image [345]$/.test(text)), j(kept))
  const fewer = [...later.slice(0, 12), ...later.slice(26)]
  const refit = await fitImagesToRequestCap(fewer, { limits, model: MODEL, owner: 'owner-fit' })
  const wideOnWire = (refit.messages as AnyMsg[]).flatMap(row => {
    const content = (row.message as { content?: unknown } | undefined)?.content
    if (row.type !== 'user' || !Array.isArray(content)) return []
    return (content as Array<Record<string, unknown>>).filter(b => b.type === 'image').map(b => pngDims(String((b.source as { data: string }).data)))
  })
  check(`a later request below the ${THRESHOLD}-image threshold keeps the once-fitted image at ${CAP} px (its bytes never change back)`, wideOnWire.some(d => d !== null && d.width === CAP && d.height === 1120) && refit.firstEdited === -1, `${j(wideOnWire)} firstEdited ${refit.firstEdited}`)
}

section('§3 the wire: twenty-one images, then five turns — the cap holds and the thinking minted after the 21st image rides')
{
  resetWireEditsForTesting()
  resetFittedImagesForTesting()
  const owner = 'owner-wire'
  const images = Array.from({ length: THRESHOLD + 1 }, (_, index) => (index === 5 ? wide : small))
  let rows = history(images, 3)
  fixture.script(() => ({ text: 'seen' }))
  const first = await send(rows, owner)
  check('the 21-image request settled', first.body !== null && first.thrown === undefined && first.errors.length === 0, `thrown=${String(first.thrown)} errors=${j(first.errors.map(e => j(e.message).slice(0, 160)))}`)
  const seenFirst = first.body === null ? [] : wireImages(first.body)
  check(`every image is within ${CAP} px a side`, seenFirst.length === THRESHOLD + 1 && seenFirst.every(image => Math.max(image.width, image.height) <= CAP), seenFirst.map(i => `${i.width}x${i.height}`).join(' '))
  const sizedFirst = seenFirst.find(image => image.width === CAP)
  const firstThinking = first.body === null ? [] : wireThinking(first.body)
  check('on the first fitted request the reasoning after the sized image leaves the wire (the edited-prefix law)', sizedFirst !== undefined && firstThinking.every(text => /after image [1-5]$/.test(text)), j(firstThinking))
  const minted: string[] = []
  for (let turn = 1; turn <= 5; turn++) {
    const text = `minted after the fit, turn ${turn}`
    minted.push(text)
    rows = [...rows, assistantRow([thinkingBlock(text), { type: 'text', text: `turn ${turn}` }]), userRow(`turn ${turn}: and then?`)]
    fixture.script(() => ({ text: 'seen' }))
    const run = await send(rows, owner)
    const seen = run.body === null ? [] : wireImages(run.body)
    const thinking = run.body === null ? [] : wireThinking(run.body)
    const sized = seen.find(image => image.width === CAP)
    check(`turn ${turn}: the request settled, the ${THRESHOLD + 1} images still ride within the cap, the sized image rides the same bytes`, run.body !== null && run.errors.length === 0 && seen.length === THRESHOLD + 1 && seen.every(image => Math.max(image.width, image.height) <= CAP) && sized !== undefined && sized.data === sizedFirst?.data, `${seen.length} images; ${seen.map(i => `${i.width}x${i.height}`).join(' ')}`)
    check(`turn ${turn}: every thinking block minted after the fit is on the wire`, minted.every(text => thinking.includes(text)), j(thinking))
    check(`turn ${turn}: the blocks that stood after the sized image before the fit stay off the wire`, thinking.every(text => minted.includes(text) || /after image [1-5]$/.test(text)), j(thinking))
  }
}

section('§4 the screenshot retirement follows the same law: a retired screenshot is a new edit once')
{
  resetWireEditsForTesting()
  const retention = await import('../../src/services/desktop/screenshotRetention.ts')
  const desktop = await import('../../src/services/desktop/desktopSession.ts')
  const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
  const lane = processOwnerForLane(null)
  const owner = 'owner-screens'
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64')
  const shot = (id: string, n: number): AnyMsg[] => {
    desktop.noteScreenshot(lane, id, `/shots/desktop-shots/${1000 + n}-shot.png`)
    return [
      assistantRow([thinkingBlock(`reasoning before shot ${n}`), { type: 'tool_use', id, name: 'Computer', input: { action: 'screenshot' } }]),
      userRow([{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `screenshot: /shots/desktop-shots/${1000 + n}-shot.png — display 1` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }]),
    ]
  }
  let rows: AnyMsg[] = [userRow('drive the editor')]
  for (let n = 1; n <= 13; n++) rows = [...rows, ...shot(`toolu_shot_${n}`, n)]
  const thinkingOf = (list: unknown[]): string[] => (list as AnyMsg[]).flatMap(row => (row.type === 'assistant' ? ((row.message as { content: Array<{ type: string; thinking?: string }> }).content).filter(b => b.type === 'thinking').map(b => b.thinking ?? '') : []))
  const first = retention.retireOlderScreenshots(rows as never, undefined, undefined, owner)
  check('thirteen live screenshots: the oldest ten retire and the first retired row is reported as the first edit', first.firstEdited === 2 && first.messages.filter(row => j(row).includes('"image"')).length === 3, `${first.firstEdited}`)
  const later: AnyMsg[] = [...rows, assistantRow([thinkingBlock('minted after the retirement'), { type: 'text', text: 'next' }]), userRow('go on')]
  const second = retention.retireOlderScreenshots(later as never, undefined, undefined, owner)
  const kept = thinkingOf(second.messages)
  check('the same retirements on the next request are not new edits', second.firstEdited === -1, `${second.firstEdited}`)
  check('the reasoning that stood after the first retired row leaves the wire; the reasoning minted after stays', j(kept) === j(['reasoning before shot 1', 'minted after the retirement']), j(kept))
  const fourteen: AnyMsg[] = [...later, ...shot('toolu_shot_14', 14)]
  const third = retention.retireOlderScreenshots(fourteen as never, undefined, undefined, owner)
  check('a fourteenth screenshot retires one more: that retirement is the new edit, at its own row', third.firstEdited === 22, `${third.firstEdited}`)
}

await fixture.close()
for (const home of HOMES) rmSync(home, { recursive: true, force: true })
console.log(`\nprove-fitted-images-keep-later-thinking: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
