import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { at, exportFixture, fixtureId, longResult, thought } from './exportFixture.js'

let failures = 0
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const fixture = await exportFixture()
const before = JSON.stringify(fixture.messages)
try {
  const { receipt, view } = await fixture.write('chat.json')
  const path = join(fixture.scratch, 'chat.json')
  check('/export chat.json writes JSON, not chat.txt', existsSync(path) && !existsSync(join(fixture.scratch, 'chat.txt')))
  check('the receipt names the session workspace JSON file', receipt === `Conversation exported to: ${path}` && view === null)
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    const doc = JSON.parse(raw)
    check('one pretty-printed UTF-8 document with a trailing newline', raw === JSON.stringify(doc, null, 2) + '\n' && raw.includes('café'))
    check('session facts come from this session and its transcript', doc.session.id === fixtureId && doc.session.cwd === fixture.scratch && doc.session.started === at(1) && JSON.stringify(doc.session.models) === '["fixture-model"]' && !('cost' in doc.session))
    check('plain document keys and ordered text turns', Object.keys(doc).join(',') === 'session,messages' && doc.messages.length === 3 && doc.messages.map((m: any) => m.role).join(',') === 'user,assistant,assistant' && doc.messages[0].at === at(1) && doc.messages[0].text === 'Please check café.' && doc.messages[2].text === 'Both files checked.')
    const tools = doc.messages[1].tools
    check('both calls retain structured inputs and join results by id', tools.length === 2 && tools[0].name === 'Read' && tools[0].input.file_path === 'first.txt' && tools[0].result === 'First file.' && tools[1].input.file_path === 'second.txt')
    check('the long result keeps 2000 characters and states the omitted count', tools[1].result === longResult.slice(0, 2000) + '… [truncated 8000 characters]')
    check('thinking, signatures and encrypted reasoning are absent', ![thought, 'private-signature', 'private-reasoning-ciphertext'].some(value => raw.includes(value)))
    check('every message uses role, at, text and tools', doc.messages.every((m: any) => Object.keys(m).join(',') === 'role,at,text,tools'))
    const { transcriptExport, truncateExportResults } = await import('../../src/commands/export/transcript.js')
    const source = JSON.parse(before)
    source[2].message.content.unshift({ type: 'tool_result', tool_use_id: 'unknown_call', content: { status: 'orphan preserved' } })
    source[3].message.model = 'fixture-second-model'
    source[3].message.content.push({ type: 'tool_use', id: 'pending_call', name: 'Read', input: {} })
    source.push({ ...source[0], isMeta: true, message: { role: 'user', content: 'hidden metadata' } })
    const edge = transcriptExport(source, { id: fixtureId, cwd: fixture.scratch })
    check('orphan results retain their position and structured content', edge.messages[2]?.role === 'tool' && edge.messages[2]?.text === '{"status":"orphan preserved"}' && edge.messages[3]?.role === 'assistant')
    check('pending results remain null and all recorded models survive', edge.messages[3]?.tools[0]?.result === null && edge.session.models.join(',') === 'fixture-model,fixture-second-model')
    check('hidden metadata stays out', !JSON.stringify(edge).includes('hidden metadata'))
    edge.messages[1]!.tools[0]!.result = '𝄞'.repeat(2001)
    check('the character budget never splits a Unicode character', truncateExportResults(edge).messages[1]?.tools[0]?.result === '𝄞'.repeat(2000) + '… [truncated 1 characters]')
    check('an empty transcript reports no invented start or models', JSON.stringify(transcriptExport([], { id: fixtureId, cwd: fixture.scratch }).session) === JSON.stringify({ id: fixtureId, started: null, cwd: fixture.scratch, models: [] }))
  }
  await fixture.write('chat.txt')
  const text = readFileSync(join(fixture.scratch, 'chat.txt'), 'utf8')
  check('text also omits thinking and caps each tool result', !text.includes(thought) && !text.includes(longResult) && text.includes('… [truncated 8000 characters]'))
  await fixture.write('chat.other')
  check('non-JSON filenames still normalize to txt', existsSync(join(fixture.scratch, 'chat.txt')) && !existsSync(join(fixture.scratch, 'chat.other')))
  const dialog = await fixture.write('')
  check('no argument still offers text copy or save', dialog.view !== null && (dialog.view as any).props.defaultFilename.endsWith('.txt'))
  check('export never mutates transcript rows', JSON.stringify(fixture.messages) === before)
} finally {
  fixture.close()
}
console.log(failures === 0 ? 'prove-export-json: ALL LAWS HOLD' : `prove-export-json: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
