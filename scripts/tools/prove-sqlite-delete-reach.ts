import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const { FileWriteTool } = await import(`${kit.src}/tools/FileWriteTool/FileWriteTool.ts`)
const { previewSqliteDeletion } = await import(`${kit.src}/tools/FileWriteTool/structuredTargets.ts`)
const file = join(home, 'reach.sqlite')
const seed = new Database(file)
seed.run(`PRAGMA foreign_keys=ON;
CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id) ON DELETE CASCADE);
CREATE TABLE notes(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id) ON DELETE SET NULL);
CREATE TABLE guarded(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id) ON DELETE RESTRICT);
CREATE TABLE grandchild(id INTEGER PRIMARY KEY, child INTEGER REFERENCES child(id) ON DELETE CASCADE);
INSERT INTO parent VALUES(1,'one'),(2,'two'),(3,'three'),(4,'four');
INSERT INTO child VALUES(10,1),(11,1),(12,2),(13,4);
INSERT INTO grandchild VALUES(100,10),(101,10),(102,11),(103,12);
INSERT INTO notes VALUES(20,1),(21,2);
INSERT INTO guarded VALUES(30,3);
CREATE TABLE logged(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO logged VALUES(1,'first'),(2,'second');
CREATE TABLE audit(line TEXT); CREATE TABLE spare(id INTEGER PRIMARY KEY); INSERT INTO spare VALUES(1);
CREATE TRIGGER audit_delete AFTER DELETE ON logged BEGIN INSERT INTO audit VALUES('deleted ' || old.id); DELETE FROM spare; END;
CREATE TRIGGER audit_update AFTER UPDATE ON logged BEGIN INSERT INTO audit VALUES('updated'); END;
CREATE TABLE lonely(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO lonely VALUES(1,'alone'),(2,'kept');
CREATE TABLE hub(id INTEGER PRIMARY KEY); INSERT INTO hub VALUES(1);
CREATE TABLE spoke_a(hub INTEGER REFERENCES hub(id) ON DELETE CASCADE); CREATE TABLE spoke_b(hub INTEGER REFERENCES hub(id) ON DELETE CASCADE);
CREATE TABLE spoke_c(hub INTEGER REFERENCES hub(id) ON DELETE SET DEFAULT); CREATE TABLE spoke_d(hub INTEGER REFERENCES hub(id) ON DELETE CASCADE);
CREATE TABLE spoke_e(hub INTEGER REFERENCES hub(id) ON DELETE CASCADE);`)
seed.close()
const NOTE = 'Not checkpointed: a rewind will not restore this row.'
const stored = (sql: string): string => { const db = new Database(file, { readonly: true }); try { return JSON.stringify(db.query(sql).values()) } finally { db.close() } }
const reach = (target: string): string => { try { return String(previewSqliteDeletion(`${file}:${target}#delete`).reach) } catch (error) { return String(error) } }
const client = await readViewMcp(home)
const remove = async (target: string): Promise<{ data: string; answer: string }> => {
  await client.call('Read', { file_path: `${file}:${target}` })
  const data = await client.call('Write', { file_path: `${file}:${target}#delete`, content: 'DELETE' })
  try { return { data, answer: String(FileWriteTool.mapToolResultToToolResultBlockParam(JSON.parse(data), 'row').content) } } catch { return { data, answer: data } }
}
try {
  kit.check('the card names a cascade, a chained cascade and a SET NULL key, and no restricting one', reach('parent/1') === 'Other rows may change with it: foreign keys in child, notes and grandchild.', reach('parent/1'))
  kit.check('the card names a DELETE trigger and no other trigger', reach('logged/1') === 'Other rows may change with it: trigger audit_delete.', reach('logged/1'))
  kit.check('the card names three tables and counts the rest', reach('hub/1') === 'Other rows may change with it: foreign keys in spoke_a, spoke_b, spoke_c and 2 more.', reach('hub/1'))
  kit.check('a table nothing hangs from adds no line to the card', reach('lonely/1') === '', reach('lonely/1'))
  kit.check('a missing row adds no line to the card', reach('parent/99') === '', reach('parent/99'))
  const cascade = await remove('parent/1')
  kit.check('a cascade, its chain and a SET NULL key are counted in the answer', cascade.answer.startsWith(`Deleted one SQLite row at ${file}:parent/1; the row is absent on read-back. 6 other rows changed with it through foreign keys or triggers. ${NOTE} The row was:`), cascade.answer)
  kit.check('exactly those rows changed', stored('SELECT id FROM child ORDER BY id') === '[[12],[13]]' && stored('SELECT id FROM grandchild') === '[[103]]' && stored('SELECT id, parent FROM notes ORDER BY id') === '[[20,null],[21,2]]' && stored('SELECT id FROM parent ORDER BY id') === '[[2],[3],[4]]', `${stored('SELECT id FROM child')} ${stored('SELECT id FROM grandchild')} ${stored('SELECT id, parent FROM notes')}`)
  const single = await remove('parent/4')
  kit.check('one other row is said in the singular', single.answer.includes('read-back. 1 other row changed with it through foreign keys or triggers. '), single.answer)
  const trigger = await remove('logged/1')
  kit.check("a trigger's rows are counted in the answer", trigger.answer.includes('read-back. 2 other rows changed with it through foreign keys or triggers. ') && stored('SELECT line FROM audit') === '[["deleted 1"]]' && stored('SELECT count(*) FROM spare') === '[[0]]', trigger.answer)
  const restricted = await remove('parent/3')
  kit.check('a restricting key still refuses and rolls back', restricted.data === 'FOREIGN KEY constraint failed' && stored('SELECT id FROM parent ORDER BY id') === '[[2],[3]]' && stored('SELECT id FROM guarded') === '[[30]]', `${restricted.data} ${stored('SELECT id FROM parent')}`)
  const alone = await remove('lonely/1')
  kit.check('a row nothing hangs from is answered with no count', alone.answer === `Deleted one SQLite row at ${file}:lonely/1; the row is absent on read-back. ${NOTE} The row was:\n{\n  "id": 1,\n  "value": "alone"\n}` && JSON.parse(alone.data).content === '', alone.answer)
} finally { await client.close() }
kit.finish()
