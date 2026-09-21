#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const HOME = mkdtempSync(join(tmpdir(), 'mercury-readback-assembly-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'

const store = await import('../../src/utils/imageStore.ts')
const messages = await import('../../src/utils/messages.ts')
const sharp = (await import('sharp')).default

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const REF = store.STORED_IMAGE_SOURCE_TYPE
const carriesReference = (value: unknown): boolean => JSON.stringify(value).includes(REF)

const one = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } }).png().toBuffer()
const two = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer()
const oneBase64 = one.toString('base64')
const paste = (id: number, bytes: Buffer) => ({ id, type: 'image' as const, content: bytes.toString('base64'), mediaType: 'image/png', filename: `image-${id}.png` })
const pathOne = await store.storeImage(paste(1, one))
const pathTwo = await store.storeImage(paste(2, two))
const refOne = store.storedImageRefBlock(paste(1, one))
const refTwo = store.storedImageRefBlock(paste(2, two))
check('two pastes sit in the store and dispatch as references', pathOne !== null && pathTwo !== null && refOne !== null && refTwo !== null)
if (pathOne === null || pathTwo === null || refOne === null || refTwo === null) {
  rmSync(HOME, { recursive: true, force: true })
  process.exit(1)
}
rmSync(pathTwo)
const outside = { type: 'image' as const, source: { type: REF, path: join(HOME, 'elsewhere.png'), media_type: 'image/png', sha256: 'a'.repeat(64), imageId: 9 } }
const plainImage = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: two.toString('base64') } }
const words = messages.createUserMessage({ content: 'first task' })
const direct = messages.createUserMessage({ content: [{ type: 'text', text: '[Image #1] look at this' }, refOne] })
const queued = {
  type: 'attachment' as const,
  uuid: '00000000-0000-4000-8000-00000000aa01',
  timestamp: '2026-06-19T12:00:03.000Z',
  attachment: {
    type: 'queued_command' as const,
    prompt: [{ type: 'text' as const, text: '[Image #2] and this' }, refTwo, outside, plainImage],
    source_uuid: '00000000-0000-4000-8000-00000000aa02',
  },
}
const plain = messages.createUserMessage({ content: [{ type: 'text', text: 'plain words' }] })
type Conversation = Parameters<typeof store.readStoredImageRefsForRequest>[0]
const conversation = [words, direct, queued, plain] as unknown as Conversation

section('§1 the request pass reads every reference back and leaves the history alone')
const request = await store.readStoredImageRefsForRequest(conversation)
check('one row out per row in', request.length === conversation.length, `${request.length}`)
check('a row without a reference keeps its identity', request[0] === conversation[0] && request[3] === conversation[3])
const directOut = request[1] as { message: { content: { type: string; source?: { type?: string; data?: string } }[] } }
check('a user row\'s reference becomes the file\'s bytes as base64', directOut.message.content[1]?.type === 'image' && directOut.message.content[1]?.source?.type === 'base64' && directOut.message.content[1]?.source?.data === oneBase64)
const queuedOut = request[2] as { attachment: { prompt: { type: string; text?: string; source?: { type?: string } }[] } }
const [qText, qGone, qOutside, qPlain] = queuedOut.attachment.prompt
check('a queued command\'s prompt keeps its words', qText?.type === 'text' && qText.text === '[Image #2] and this')
check('a reference whose file has gone becomes the words that name the path', qGone?.type === 'text' && (qGone.text ?? '').includes(pathTwo) && /\[Image #2\]/.test(qGone.text ?? ''), qGone?.text ?? String(qGone?.type))
check('a reference outside the store becomes the refusal words', qOutside?.type === 'text' && /not in the image store/.test(qOutside.text ?? ''), qOutside?.text ?? String(qOutside?.type))
check('a base64 block rides untouched', qPlain === plainImage)
check('no reference survives the pass', !carriesReference(request))
check('the history still carries its references (the transcript keeps them)', carriesReference(conversation) && (direct.message.content as unknown[])[1] === refOne && queued.attachment.prompt[1] === refTwo)
rmSync(pathOne)
const again = await store.readStoredImageRefsForRequest(conversation)
const againOut = again[1] as { message: { content: { source?: { data?: string } }[] } }
check('a later request reads the same bytes once the file is gone (read once, kept for the session)', againOut.message.content[1]?.source?.data === oneBase64)

section('§2 every road\'s projection carries the bytes')
const anthropicRows = messages.normalizeMessagesForAPI(request as never)
check('the Anthropic projection carries base64 image blocks and no reference', !carriesReference(anthropicRows) && JSON.stringify(anthropicRows).includes(oneBase64.slice(0, 40)))
const routedRows = messages.healWalkableForWire(request as never)
check('the routed families\' projection carries base64 image blocks and no reference', !carriesReference(routedRows) && JSON.stringify(routedRows).includes(oneBase64.slice(0, 40)))
check('the projections alone leave the reference on the wire (the pass must run first)', carriesReference(messages.normalizeMessagesForAPI(conversation as never)) && carriesReference(messages.healWalkableForWire(conversation as never)))

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ the stored-image read-back holds at the request' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
