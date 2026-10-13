import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RenderableMessage } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'withheld-turns-'))
process.env.MERCURY_CONFIG_DIR = home
const { withheldThinkingDisclosure } = await import('../../src/components/messages/withheldThinkingDisclosure.ts')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const row = (uuid: string, type: string, content: unknown[]): RenderableMessage => ({ uuid, type, message: { content } }) as RenderableMessage
const thinking = (uuid: string, text = '', signature = 'signed'): RenderableMessage => row(uuid, 'assistant', [{ type: 'thinking', thinking: text, signature }])
const text = (uuid: string, type = 'assistant'): RenderableMessage => row(uuid, type, [{ type: 'text', text: uuid }])
const input = [text('prompt-1', 'user'), thinking('private-1'), row('work', 'assistant', [{ type: 'tool_use', name: 'Read', id: 'call-1', input: {} }]), row('result', 'user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'read' }]), thinking('private-2'), thinking('visible', 'reasoning'), thinking('streaming', '', ''), text('answer-1'), text('prompt-2', 'user'), thinking('private-3'), text('answer-2')]
const before = JSON.stringify(input)
const disclosure = withheldThinkingDisclosure(input)
check('a user turn with two signed empty blocks has one disclosure on its answer', disclosure.byRow.size === 2 && disclosure.byRow.has('answer-1') && disclosure.byRow.has('answer-2'))
check('only settled private blocks are hidden', [...disclosure.hidden].join(',') === 'private-1,private-2,private-3')
check('the wire rows and their signatures are untouched', JSON.stringify(input) === before)
const workOnly = withheldThinkingDisclosure(input.slice(0, 5))
check('a turn without an answer reveals the fact on its work row', workOnly.byRow.has('result'))
const privateOnly = withheldThinkingDisclosure([thinking('only')])
check('a turn with no visible work retains its transcript disclosure', privateOnly.byRow.has('only') && privateOnly.hidden.has('only'))
const plain = withheldThinkingDisclosure([text('prompt', 'user'), thinking('visible', 'reasoning'), text('answer')])
check('returned reasoning adds no withheld disclosure', plain.hidden.size === 0 && plain.byRow.size === 0)
rmSync(home, { recursive: true, force: true })
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} withheld thinking turn grouping`)
process.exit(failures === 0 ? 0 : 1)
