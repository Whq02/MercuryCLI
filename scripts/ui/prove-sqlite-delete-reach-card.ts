import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { isolatedHome } from '../tools/readViewKit.js'

isolatedHome(import.meta.filename)
const { runArtifactArena, grabScreens, sendStamp } = await import('../streaming/artifactArena.js')
let passed = 0, failed = 0
const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`) }
const REACH = 'Other rows may change with it: foreign keys in child and notes; trigger audit_delete.'
for (const [table, reaches] of [['parent', true], ['lonely', false]] as const) {
  const run = await runArtifactArena({
    cols: 120, rows: 40, seconds: 26, keep: true,
    ...(process.env.MERCURY_PROOF_DIST ? { distPath: process.env.MERCURY_PROOF_DIST } : {}),
    turns: cwd => [
      { kind: 'tool_use', name: 'Read', input: { file_path: `${join(cwd, 'data.sqlite')}:${table}/1` } },
      { kind: 'tool_use', name: 'Write', input: { file_path: `${join(cwd, 'data.sqlite')}:${table}/1#delete`, content: 'DELETE' } },
      { kind: 'text', text: 'The row request is complete.' },
    ],
    seedHome: (_config, cwd) => {
      const db = new Database(join(cwd, 'data.sqlite'))
      db.run(`PRAGMA foreign_keys=ON;
CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO parent VALUES(1,'the one shown');
CREATE TABLE child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id) ON DELETE CASCADE); INSERT INTO child VALUES(10,1),(11,1);
CREATE TABLE notes(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id) ON DELETE SET NULL); INSERT INTO notes VALUES(20,1);
CREATE TABLE audit(line TEXT);
CREATE TRIGGER audit_delete AFTER DELETE ON parent BEGIN INSERT INTO audit VALUES('deleted'); END;
CREATE TABLE lonely(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO lonely VALUES(1,'the one shown');`)
      db.close()
    },
    sends: ['after:Type a prompt:200:hello', 'after:hello:400:\\r', 'after:Delete this row?:1600:\\r'],
    anchor: { needle: 'Delete this row?', atMs: 8000 },
  })
  try {
    const approval = run.sendLog.find(send => send.after === 'Delete this row?')
    const [card, after] = approval ? grabScreens(run, 120, 40, [sendStamp(run, approval) - 500, sendStamp(run, approval) + 5000]).map(screen => screen.rows.join('\n')) : ['', '']
    console.log(`CARD ${table}\n${card}\nAFTER ${table}\n${after}`)
    const flat = after.replace(/\s+/g, ' ')
    if (reaches) {
      check('the card says what else may change, under the row and above the question', card.includes(REACH) && card.includes('the one shown') && card.indexOf('the one shown') < card.indexOf(REACH) && card.indexOf(REACH) < card.indexOf('Delete this row?'), card)
      check('the result line counts the other rows that changed', flat.includes('Deleted one SQLite row') && flat.includes('4 other rows changed with it'), after)
    } else {
      check('a row nothing hangs from has no such line on its card', card.includes('the one shown') && card.includes('Delete this row?') && !card.includes('Other rows'), card)
      check('its result line counts nothing', flat.includes('Deleted one SQLite row') && !flat.includes('other row'), after)
    }
  } finally { run.cleanup() }
}
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
