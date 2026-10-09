import { resolve } from 'node:path'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const { getQueuedCommandAttachments } = await import(`${root}/src/utils/attachments/queuedCommands.ts`)
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const tinyGif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const command = (extra: Record<string, unknown>) => ({ uuid: 'q-1', value: 'look at these', mode: 'prompt', origin: { kind: 'user' }, isMeta: false, ...extra })

const none = await getQueuedCommandAttachments([command({})])
check('a command without pastes keeps a string prompt', none[0]?.prompt === 'look at these')

const empties = await getQueuedCommandAttachments([command({ pastedContents: { 1: { id: 1, type: 'text', content: 'pasted words' }, 2: { id: 2, type: 'image', content: '', mediaType: 'image/png' } } })])
check('text pastes and empty image pastes make no image block', empties[0]?.prompt === 'look at these')

const pasted = await getQueuedCommandAttachments([command({ pastedContents: { 3: { id: 3, type: 'image', content: tinyGif, mediaType: 'image/gif' }, 1: { id: 1, type: 'image', content: tinyPng, mediaType: 'image/png' }, 2: { id: 2, type: 'image', content: tinyPng } } })])
const blocks = pasted[0]?.prompt
check('image pastes ride as blocks after the text, in paste order', Array.isArray(blocks) && blocks.length === 4 && blocks[0].type === 'text' && blocks[0].text === 'look at these' && blocks.slice(1).every((b: { type: string }) => b.type === 'image'), JSON.stringify(blocks?.map?.((b: { type: string }) => b.type)))
check('each block is base64 with the paste\'s media type, image/png when the paste names none', Array.isArray(blocks) && blocks[1].source.media_type === 'image/png' && blocks[2].source.media_type === 'image/png' && blocks[3].source.media_type === 'image/gif' && blocks.slice(1).every((b: { source: { type: string } }) => b.source.type === 'base64'), JSON.stringify(blocks?.slice?.(1).map((b: { source: { media_type: string } }) => b.source.media_type)))
check('the paste ids ride with the attachment', JSON.stringify(pasted[0]?.imagePasteIds) === JSON.stringify([1, 2, 3]), JSON.stringify(pasted[0]?.imagePasteIds))

console.log(`${failures ? 'FAIL' : 'PASS'} pasted image blocks: ${failures} failures`)
process.exit(failures ? 1 : 0)
