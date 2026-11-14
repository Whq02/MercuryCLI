import { Database } from 'bun:sqlite'
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
    { kind: 'tool_use', name: 'Read', input: { file_path: `${join(cwd, 'data.sqlite')}:items/1` } },
    { kind: 'tool_use', name: 'Write', input: { file_path: `${join(cwd, 'data.sqlite')}:items/1`, content: '{"value":"changed"}' } },
    { kind: 'tool_use', name: 'Write', input: { file_path: `${join(cwd, 'data.sqlite')}:items/9`, content: '{"value":"ninth"}' } },
    { kind: 'text', text: 'The row requests are complete.' },
  ],
  seedHome: (_config, cwd) => {
    const db = new Database(join(cwd, 'data.sqlite'))
    db.run("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'first value'),(2,'second value')")
    db.close()
  },
  sends: ['after:Type a prompt:200:hello', 'after:hello:400:\\r', 'after:items/1:2600:\\r', 'after:items/9:2600:\\r'],
  anchor: { needle: 'items/9', atMs: 12000 },
})
try {
  const frameAt = (needle: string, offset: number): string => {
    const send = run.sendLog.find(entry => entry.after === needle)
    return send ? grabScreens(run, 120, 40, [sendStamp(run, send) + offset])[0]!.rows.join('\n') : ''
  }
  const card = (frame: string): string => frame.slice(frame.lastIndexOf('⦿'))
  const update = card(frameAt('items/1', -300)), insert = card(frameAt('items/9', -300))
  console.log(`UPDATE CARD\n${update}\nNEW ROW CARD\n${insert}`)
  for (const [name, frame, address, json] of [['the update of an existing row', update, 'data.sqlite:items/1', '{"value":"changed"}'], ['a new row', insert, 'data.sqlite:items/9', '{"value":"ninth"}']] as const) {
    check(`${name}: the card is titled Write SQLite row`, frame.includes('⦿ Write SQLite row'), frame)
    check(`${name}: the card asks Write this row?`, frame.includes('Write this row?'), frame)
    check(`${name}: the card does not call the row a file`, !frame.includes('Create file') && !frame.includes('Overwrite file') && !/Do you want to (?:create|overwrite)/.test(frame), frame)
    const at = { address: frame.indexOf(address), json: frame.indexOf(json), note: frame.indexOf(NOTE), question: frame.indexOf('Write this row?') }
    check(`${name}: the address, the JSON and the rewind line stand above the question as they did`, at.address >= 0 && at.json > at.address && at.note > at.json && at.question > at.note, JSON.stringify(at))
    check(`${name}: the three choices stand`, frame.includes('1. Yes') && frame.includes('2. Yes, allow all edits for this session') && frame.includes('3. No, and tell Mercury what to do differently'), frame)
  }
  const db = new Database(join(run.paths.cwd, 'data.sqlite'), { readonly: true })
  const rows = JSON.stringify(db.query('SELECT * FROM items ORDER BY id').all())
  db.close()
  check('both rows were written after their approvals', rows === '[{"id":1,"value":"changed"},{"id":2,"value":"second value"},{"id":9,"value":"ninth"}]', rows)
} finally { run.cleanup() }
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
