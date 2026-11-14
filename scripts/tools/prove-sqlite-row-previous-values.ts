import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const { FileWriteTool } = await import(`${kit.src}/tools/FileWriteTool/FileWriteTool.ts`)
const { FileEditTool } = await import(`${kit.src}/tools/FileEditTool/FileEditTool.ts`)
const file = join(home, 'rows.sqlite')
const long = 'long text '.repeat(500)
const seed = new Database(file)
seed.run('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT, payload BLOB)')
seed.prepare('INSERT INTO items VALUES(?, ?, ?)').run(1, 'short', null)
seed.prepare('INSERT INTO items VALUES(?, ?, ?)').run(2, long, null)
seed.prepare('INSERT INTO items VALUES(?, ?, ?)').run(3, 'with bytes', new Uint8Array([1, 2, 255]))
seed.prepare('INSERT INTO items VALUES(?, ?, ?)').run(4, 'edited by Edit', null)
seed.close()
const NOTE = 'Not checkpointed: a rewind will not restore this row.'
const client = await readViewMcp(home)
const answer = (tool: { mapToolResultToToolResultBlockParam(data: unknown, id: string): { content: unknown } }, data: string): string => {
  try { return String(tool.mapToolResultToToolResultBlockParam(JSON.parse(data), 'row').content) } catch { return data }
}
const keptAt = (text: string): string => /kept whole at (.+?)\.$/m.exec(text)?.[1] ?? ''
try {
  await client.call('Read', { file_path: `${file}:items/1` })
  const short = answer(FileWriteTool, await client.call('Write', { file_path: `${file}:items/1`, content: '{"value":"shorter"}' }))
  kit.check('a row write repeats a short previous row in its answer', short.includes(`${NOTE} The row was:\n{\n  "id": 1,\n  "value": "short",\n  "payload": null\n}\n(anchor: `), short)
  await client.call('Read', { file_path: `${file}:items/2` })
  const overwritten = answer(FileWriteTool, await client.call('Write', { file_path: `${file}:items/2`, content: '{"value":"replaced"}' }))
  const kept = keptAt(overwritten)
  kit.check('a previous row too long to repeat is named with its length and its kept copy', overwritten.includes(`${NOTE} The row was ${`{\n  "id": 2,\n  "value": "${long}",\n  "payload": null\n}\n`.length.toLocaleString('en-US')} characters: kept whole at `) && !overwritten.includes('long text long text'), overwritten.slice(0, 600))
  kit.check('the kept copy holds the whole previous row', kept !== '' && existsSync(kept) && JSON.parse(readFileSync(kept, 'utf8')).value === long && JSON.parse(readFileSync(kept, 'utf8')).id === 2 && (statSync(kept).mode & 0o077) === 0, kept)
  await client.call('Read', { file_path: `${file}:items/3` })
  const deleted = answer(FileWriteTool, await client.call('Write', { file_path: `${file}:items/3#delete`, content: 'DELETE' }))
  const bytes = keptAt(deleted)
  kit.check('a deleted row that held bytes is kept whole, bytes included', deleted.includes(`the row is absent on read-back. ${NOTE} The row was `) && bytes !== '' && existsSync(bytes) && JSON.stringify(JSON.parse(readFileSync(bytes, 'utf8'))) === '{"id":3,"value":"with bytes","payload":{"blob":"AQL/","bytes":3}}', `${deleted} ${bytes && existsSync(bytes) ? readFileSync(bytes, 'utf8') : ''}`)
  const made = answer(FileWriteTool, await client.call('Write', { file_path: `${file}:items/9`, content: '{"value":"made"}' }))
  kit.check('a new row says a rewind will not remove it and repeats no previous row', made.includes('Not checkpointed: a rewind will not remove this row.') && !made.includes('The row was'), made)
  const missing = answer(FileWriteTool, await client.call('Write', { file_path: `${file}:items/77#delete`, content: 'DELETE' }))
  kit.check('a missing row says nothing of a rewind', missing.startsWith('Row not found at') && !missing.includes('checkpointed'), missing)
  await kit.read(`${file}:items/4`)
  const edit = { file_path: `${file}:items/4`, old_string: 'edited by Edit', new_string: 'edited' }
  const valid = await FileEditTool.validateInput(edit, kit.context)
  const edited = valid.result ? String(FileEditTool.mapToolResultToToolResultBlockParam((await FileEditTool.call(edit, kit.context, undefined, { uuid: 'row' })).data, 'row').content) : String(valid.message)
  kit.check('a row edit says it and repeats the row as it was', edited.includes(`${NOTE} The row was:\n{\n  "id": 4,\n  "value": "edited by Edit",\n  "payload": null\n}`), edited)
  const archive = answer(FileWriteTool, await client.call('Write', { file_path: `${join(home, 'notes.zip')}:inner.txt`, content: 'an entry\n' }))
  kit.check('an archive entry and its answer are untouched', archive.includes('File created successfully at') && !archive.includes('checkpointed'), archive)
} finally { await client.close() }
kit.finish()
