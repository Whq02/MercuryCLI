import { Database } from 'bun:sqlite'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const outside = join(home, '..', `outside-${process.pid}`)
mkdirSync(outside, { recursive: true })
const database = (file: string) => { const db = new Database(file); db.run("CREATE TABLE ledger(id INTEGER PRIMARY KEY, holder TEXT, amount INTEGER); INSERT INTO ledger VALUES(1,'first',10),(2,'second',20)"); db.close() }
const rows = (file: string): string => { const db = new Database(file, { readonly: true }); try { return JSON.stringify(db.query('SELECT * FROM ledger ORDER BY id').all()) } finally { db.close() } }
const kept = join(home, 'kept.sqlite'), far = join(outside, 'far.sqlite'), open = join(home, 'open.sqlite')
for (const file of [kept, far, open]) database(file)
symlinkSync(far, join(home, 'link.sqlite'))
const before = rows(kept)
const client = await readViewMcp(home, [`Read(/${kept})`, `Read(/${far})`])
try {
  for (const [label, file, sentence] of [['a database a Read rule names', kept, `Reading ${kept} is denied by a rule`], ['a link to a database a Read rule names', join(home, 'link.sqlite'), `Reading ${join(home, 'link.sqlite')} is denied by a rule`]] as const) {
    const answers: [string, string][] = [
      ['deletion of a row', await client.call('Write', { file_path: `${file}:ledger/1#delete`, content: 'DELETE' })],
      ['deletion by a column that does not exist', await client.call('Write', { file_path: `${file}:ledger/nothing=1#delete`, content: 'DELETE' })],
      ['deletion in a table that does not exist', await client.call('Write', { file_path: `${file}:nothing/1#delete`, content: 'DELETE' })],
      ['deletion of a missing row', await client.call('Write', { file_path: `${file}:ledger/99#delete`, content: 'DELETE' })],
      ['a row write by a column that does not exist', await client.call('Write', { file_path: `${file}:ledger/nothing=1`, content: '{"holder":"x"}' })],
      ['a row write naming a column that does not exist', await client.call('Write', { file_path: `${file}:ledger/1`, content: '{"nothing":"x"}' })],
      ['a row write of a new row', await client.call('Write', { file_path: `${file}:ledger/7`, content: '{"holder":"made"}' })],
      ['a row edit', await client.call('Edit', { file_path: `${file}:ledger/1`, old_string: 'first', new_string: 'changed' })],
    ]
    for (const [name, answer] of answers) kit.check(`${label}: ${name} answers with Read's own sentence and no schema`, answer.includes(sentence) && !/holder|amount|not found|no column|Row not found|"type"/.test(answer), `${answer} — a Write or Edit on a database row that a Read deny rule names must return only the Read refusal before any row or schema lookup: look at sqliteRowReadRefusal in src/tools/write/structuredTargets.ts and where Write and Edit call it`)
  }
  kit.check('the database a Read rule names is unchanged', rows(kept) === before && rows(far) === before, `${rows(kept)} ${rows(far)} — a refused row write or delete changed a database a Read rule names: the refusal in sqliteRowReadRefusal (src/tools/write/structuredTargets.ts) must come before the row is touched`)
  const unread = await client.call('Write', { file_path: `${open}:ledger/1#delete`, content: 'DELETE' })
  kit.check('a database no rule names still asks for the prior read', unread.includes('was not read in this session'), `${unread} — Write on a row of a database no rule names should still ask for a prior Read: the Read-deny refusal in src/tools/write/structuredTargets.ts must not replace that ask`)
  await client.call('Read', { file_path: `${open}:ledger/1` })
  const deleted = await client.call('Write', { file_path: `${open}:ledger/1#delete`, content: 'DELETE' })
  const written = await client.call('Write', { file_path: `${open}:ledger/7`, content: '{"holder":"made"}' })
  kit.check('a database no rule names is deleted from and written as before', deleted.includes('"type":"delete"') && written.includes('"type":"create"') && rows(open) === '[{"id":2,"holder":"second","amount":20},{"id":7,"holder":"made","amount":null}]', `${deleted} ${written} ${rows(open)} — row delete and row write on an unnamed database stopped working after a prior Read: check the Read-deny refusal in src/tools/write/structuredTargets.ts and the sqlite row paths in src/tools/write/call/call.ts`)
} finally { await client.close() }
kit.finish()
