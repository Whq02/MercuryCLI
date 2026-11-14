import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../tools/readViewKit.js'

isolatedHome(import.meta.filename)
const { runArtifactArena, grabScreens, sendStamp } = await import('../streaming/artifactArena.js')
let passed = 0, failed = 0
const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`) }
const NOTE = 'Not checkpointed: a rewind will not restore this row.'
const run = await runArtifactArena({
  cols: 120, rows: 40, seconds: 40, keep: true,
  ...(process.env.MERCURY_PROOF_DIST ? { distPath: process.env.MERCURY_PROOF_DIST } : {}),
  turns: cwd => [
    { kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'notes.txt') } },
    { kind: 'tool_use', name: 'Write', input: { file_path: join(cwd, 'notes.txt'), content: 'second text\n' } },
    { kind: 'tool_use', name: 'Read', input: { file_path: `${join(cwd, 'data.sqlite')}:items/1` } },
    { kind: 'tool_use', name: 'Write', input: { file_path: `${join(cwd, 'data.sqlite')}:items/1`, content: '{"value":"changed"}' } },
    { kind: 'tool_use', name: 'Read', input: { file_path: `${join(cwd, 'data.sqlite')}:items/2` } },
    { kind: 'tool_use', name: 'Write', input: { file_path: `${join(cwd, 'data.sqlite')}:items/2#delete`, content: 'DELETE' } },
    { kind: 'text', text: 'The row requests are complete.' },
  ],
  seedHome: (_config, cwd) => {
    writeFileSync(join(cwd, 'notes.txt'), 'first text\n')
    const db = new Database(join(cwd, 'data.sqlite'))
    db.run("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'first value'),(2,'second value'),(3,'third value')")
    db.close()
  },
  sends: ['after:Type a prompt:200:hello', 'after:hello:400:\\r', 'after:overwrite:1600:\\r', 'after:Do you want to create:1600:\\r', 'after:Delete this row?:1600:\\r'],
  anchor: { needle: 'Delete this row?', atMs: 14000 },
})
try {
  const frameAt = (needle: string, offset: number): string => {
    const send = run.sendLog.find(entry => entry.after === needle)
    return send ? grabScreens(run, 120, 40, [sendStamp(run, send) + offset])[0]!.rows.join('\n') : ''
  }
  const writeCard = frameAt('Do you want to create', -500), deleteCard = frameAt('Delete this row?', -500), after = frameAt('Delete this row?', 5000)
  console.log(`ROW WRITE CARD\n${writeCard}\nDELETE CARD\n${deleteCard}\nAFTER\n${after}`)
  check('the row write card says before approval that a rewind will not restore the row', writeCard.includes(NOTE), writeCard)
  check('the deletion card says the same above its question', deleteCard.includes(NOTE) && deleteCard.indexOf(NOTE) < deleteCard.indexOf('Delete this row?'), deleteCard)
  check('the plain file card says nothing of it', !frameAt('overwrite', -500).includes('checkpointed') && frameAt('overwrite', -500).includes('notes.txt'))
  check('the screen result of the row write and of the deletion each say not checkpointed', (after.match(/· not checkpointed/g) ?? []).length === 2 && after.includes('Deleted one SQLite row'), after)
  const history = join(run.paths.home, '.mercury', 'file-history')
  const kept = existsSync(history) ? (readdirSync(history, { recursive: true }) as string[]).map(name => join(history, name)).filter(file => statSync(file).isFile()) : []
  const size = statSync(join(run.paths.cwd, 'data.sqlite')).size
  check('the plain file is checkpointed as before', kept.length === 1 && statSync(kept[0]!).size === 'first text\n'.length, kept.map(file => `${file} ${statSync(file).size}`).join(' '))
  check('no copy of the database is in the file history', !kept.some(file => statSync(file).size === size), kept.map(file => `${file} ${statSync(file).size}`).join(' '))
  const answers = (run.fixture.messageRequests() as { body: { messages: { content: unknown }[] } }[]).at(-1)!.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter((part: { type?: string }) => part.type === 'tool_result').map((part: { content?: unknown }) => typeof part.content === 'string' ? part.content : JSON.stringify(part.content))
  const updated = answers.find(answer => answer.includes('has been updated successfully') && answer.includes('items/1')) ?? '', deleted = answers.find(answer => answer.includes('Deleted one SQLite row')) ?? '', plain = answers.find(answer => answer.includes('notes.txt') && answer.includes('updated successfully')) ?? ''
  check('the row write answer says it and repeats the row as it was', updated.includes(`${NOTE} The row was:\\n{\\n  "id": 1,\\n  "value": "first value"\\n}`) || updated.includes(`${NOTE} The row was:\n{\n  "id": 1,\n  "value": "first value"\n}`), updated)
  check('the deletion answer says it and repeats the row as it was', deleted.includes(`the row is absent on read-back. ${NOTE} The row was:`) && deleted.includes('"value": "second value"'), deleted)
  check('the plain file answer is unchanged', plain !== '' && !plain.includes('checkpointed') && !plain.includes('The row was'), plain)
  const db = new Database(join(run.paths.cwd, 'data.sqlite'), { readonly: true })
  const rows = JSON.stringify(db.query('SELECT * FROM items ORDER BY id').all())
  db.close()
  check('both row changes were applied', rows === '[{"id":1,"value":"changed"},{"id":3,"value":"third value"}]', rows)
} finally { run.cleanup() }
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
