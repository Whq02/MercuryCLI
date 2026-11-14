import { Database } from 'bun:sqlite'
import { mkdirSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const file = join(home, 'delete.sqlite')
const seed = new Database(file)
seed.run(`PRAGMA foreign_keys=ON;
CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT);
INSERT INTO items VALUES(1,'one'),(2,'two'),(3,'three'),(4,'four');
CREATE TABLE plain(value TEXT); INSERT INTO plain VALUES('plain');
CREATE TABLE wide_key(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO wide_key VALUES(9223372036854775807,'wide');
CREATE TABLE text_key(id TEXT PRIMARY KEY,value TEXT); INSERT INTO text_key VALUES('named','text');
CREATE TABLE blobrow(id INTEGER PRIMARY KEY,payload BLOB); INSERT INTO blobrow VALUES(1,X'0102');
CREATE TABLE typedrow(id INTEGER PRIMARY KEY,payload); INSERT INTO typedrow VALUES(1,1),(2,1),(3,NULL),(4,''),(5,9223372036854775807);
CREATE TABLE ordered("2" TEXT,"1" TEXT,id INTEGER PRIMARY KEY); INSERT INTO ordered VALUES('two','one',1);
CREATE TABLE shadow(rowid INTEGER, value TEXT); INSERT INTO shadow VALUES(8,'first'),(8,'second');
CREATE TABLE generated(value TEXT, ROWID INTEGER GENERATED ALWAYS AS (8)); INSERT INTO generated(value) VALUES('first'),('second');
CREATE TABLE all_shadow(rowid INTEGER, _rowid_ INTEGER, oid INTEGER); INSERT INTO all_shadow VALUES(1,1,1),(1,1,1);
CREATE TABLE composite(a INTEGER,b INTEGER,PRIMARY KEY(a,b)); INSERT INTO composite VALUES(1,1),(1,2);
CREATE TABLE restricted(id INTEGER PRIMARY KEY, item INTEGER REFERENCES items(id) ON DELETE RESTRICT); INSERT INTO restricted VALUES(1,2);
CREATE TABLE cascading(id INTEGER PRIMARY KEY, item INTEGER REFERENCES items(id) ON DELETE CASCADE); INSERT INTO cascading VALUES(1,3);`)
seed.close()
const kit = await readViewKit(home)
const { check } = kit
let client = await readViewMcp(home)
const read = (path: string) => client.call('Read', { file_path: path })
const del = (path: string, content = 'DELETE') => client.call('Write', { file_path: `${path}#delete`, content })
const count = (sql: string) => { const db = new Database(file, { readonly: true }); try { return db.query(sql).get() as Record<string, unknown> } finally { db.close() } }
try {
  const protectedFile = join(home, '.mercury', '.credentials.json.corrupt.fixture.sqlite')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  const protectedDb = new Database(protectedFile)
  protectedDb.run('CREATE TABLE restricted_columns(secret_column_alpha INTEGER, secret_column_beta INTEGER, PRIMARY KEY(secret_column_alpha,secret_column_beta))')
  protectedDb.close()
  const protectedRead = await read(protectedFile)
  check('the protected fixture is denied to an ordinary Read', /den|refus|protected/i.test(protectedRead) && !protectedRead.includes('secret_column_alpha'), protectedRead)
  const protectedDelete = await del(`${protectedFile}:restricted_columns/1`)
  check('a protected path is refused before deletion preview reads schema', /den|refus|protected/i.test(protectedDelete) && !protectedDelete.includes('secret_column_alpha') && !protectedDelete.includes('restricted_columns'), protectedDelete)
  if (process.platform !== 'win32') {
    const alias = join(home, 'protected-alias.sqlite')
    symlinkSync(protectedFile, alias)
    const throughLink = await del(`${alias}:restricted_columns/1`)
    check('the same floor precedes a linked database preview', /den|refus|protected/i.test(throughLink) && !throughLink.includes('secret_column_alpha') && !throughLink.includes('restricted_columns'), throughLink)
  }
  const wide = await read(`${file}:wide_key/9223372036854775807`)
  check('release keyed Read preserves the full SQLite integer key', wide.includes('9223372036854775807') && wide.includes('"value": "wide"'), wide)
  check('release deletion addresses a full-width integer key', (await del(`${file}:wide_key/9223372036854775807`)).includes('"type":"delete"') && count('SELECT count(*) AS n FROM wide_key').n === 0)
  await read(`${file}:text_key/named`)
  check('release deletion addresses a text primary key', (await del(`${file}:text_key/named`)).includes('"type":"delete"') && count('SELECT count(*) AS n FROM text_key').n === 0)
  await read(`${file}:blobrow/1`)
  const blobChange = new Database(file); blobChange.run("UPDATE blobrow SET payload=X'0304' WHERE id=1"); blobChange.close()
  const staleBlob = await del(`${file}:blobrow/1`)
  check('same-size blob replacement is stale row data', /changed|modified/i.test(staleBlob) && count('SELECT count(*) AS n FROM blobrow').n === 1, staleBlob)
  for (const [id, label, value] of [[1,'INTEGER against TEXT',"'1'"],[2,'INTEGER against REAL','1.0'],[3,'NULL against empty text',"''"],[4,'empty text against empty blob',"X''"],[5,'wide INTEGER against matching TEXT',"'9223372036854775807'"]] as const) {
    await read(`${file}:typedrow/${id}`)
    const changed = new Database(file); changed.run(`UPDATE typedrow SET payload=${value} WHERE id=${id}`); changed.close()
    const result = await del(`${file}:typedrow/${id}`)
    check(`typed identity distinguishes ${label}`, /changed|modified/i.test(result) && count(`SELECT count(*) AS n FROM typedrow WHERE id=${id}`).n === 1, result)
  }
  await read(`${file}:ordered/1`)
  const reordered = new Database(file)
  reordered.run('ALTER TABLE ordered RENAME TO old_ordered; CREATE TABLE ordered("1" TEXT,"2" TEXT,id INTEGER PRIMARY KEY); INSERT INTO ordered SELECT "1","2",id FROM old_ordered; DROP TABLE old_ordered;')
  reordered.close()
  const orderResult = await del(`${file}:ordered/1`)
  check('row identity uses table column order, not JavaScript key order', /changed|modified/i.test(orderResult) && count('SELECT count(*) AS n FROM ordered').n === 1, orderResult)
  const ownWrite = await client.call('Write', { file_path: `${file}:items/55`, content: '{"value":"own"}' })
  check('a verified row Write still counts as reading that row', ownWrite.includes('"type":"create"') && (await del(`${file}:items/55`)).includes('"type":"delete"'))
  const plain = await read(`${file}:plain/1`)
  check('unshadowed ordinary row is byte-identical on parent and tip', plain === '{\n  "rowid": 1,\n  "value": "plain"\n}\n', JSON.stringify(plain))
  await read(`${file}:items/1`)
  const blank = await client.call('Write', { file_path: `${file}:items/1`, content: '' })
  check('blank row content never deletes', /parse|JSON/.test(blank) && count('SELECT count(*) AS n FROM items WHERE id=1').n === 1)
  const blankDelete = await del(`${file}:items/1`, '')
  check('delete suffix still needs the explicit DELETE content', !blankDelete.includes('"type":"delete"') && count('SELECT count(*) AS n FROM items WHERE id=1').n === 1)
  const deleted = await del(`${file}:items/1`)
  check('release Node explicitly deletes one addressed row', deleted.includes('"type":"delete"') && count('SELECT count(*) AS n FROM items WHERE id=1').n === 0, deleted)
  check('deleted result grants no empty file anchor', !deleted.includes('anchor'))
  const missing = await del(`${file}:items/1`)
  check('missing row is a distinct verified no-op', missing.includes('"type":"not-found"'), missing)
  const queryOnly = await read(`${file}#read?sql=SELECT * FROM items WHERE id=4`)
  const unread = await del(`${file}:items/4`)
  check('query view is not prior row coverage for deletion', queryOnly.includes('SQLite query') && /read.*before|not.*read/i.test(unread) && count('SELECT count(*) AS n FROM items WHERE id=4').n === 1, unread)
  await read(`${file}:items/4`)
  const modify = new Database(file); modify.run("UPDATE items SET value='changed' WHERE id=4"); modify.close()
  const stale = await del(`${file}:items/4`)
  check('stale prior row changes nothing', /changed|modified/i.test(stale) && count('SELECT count(*) AS n FROM items WHERE id=4').n === 1, stale)
  await read(`${file}:items/2`)
  const constrained = await del(`${file}:items/2`)
  check('foreign-key restriction rolls deletion back', /FOREIGN KEY/i.test(constrained) && count('SELECT count(*) AS n FROM items WHERE id=2').n === 1, constrained)
  await read(`${file}:items/3`)
  const cascade = await del(`${file}:items/3`)
  check('declared cascade is enforced', cascade.includes('"type":"delete"') && count('SELECT count(*) AS n FROM cascading').n === 0)
  const shadow = await read(`${file}:shadow/1`)
  check('declared rowid does not shadow the hidden identity', shadow.includes('"_rowid_": 1') && shadow.includes('"rowid": 8'), shadow)
  const shadowDeleted = await del(`${file}:shadow/1`)
  check('hidden-rowid deletion removes only the addressed twin', shadowDeleted.includes('"type":"delete"') && count('SELECT count(*) AS n FROM shadow').n === 1 && count('SELECT value FROM shadow').value === 'second', shadowDeleted)
  await read(`${file}:generated/1`)
  check('generated case-folded rowid shadows are respected', (await del(`${file}:generated/1`)).includes('"type":"delete"') && count('SELECT count(*) AS n FROM generated').n === 1)
  const hidden = await del(`${file}:all_shadow/1`)
  check('all shadowed aliases cannot delete multiple rows', /shadows|shadowed/i.test(hidden) && count('SELECT count(*) AS n FROM all_shadow').n === 2, hidden)
  const composite = await del(`${file}:composite/1`)
  check('composite shorthand is refused without mutation', composite.includes('composite primary key') && count('SELECT count(*) AS n FROM composite').n === 2, composite)
  const ordinary = join(home, 'ordinary.txt')
  writeFileSync(ordinary, 'keep the file\n')
  await read(ordinary)
  await client.call('Write', { file_path: ordinary, content: '' })
  check('empty ordinary Write keeps an empty file', statSync(ordinary).isFile() && readFileSync(ordinary).length === 0)
  await client.close()
  client = await readViewMcp(home, ['Write(delete.sqlite)'])
  const denied = await del(`${file}:items/4`)
  check('delete suffix cannot evade a Write deny', /den|PermissionRefused/i.test(denied) && !denied.includes('items') && count('SELECT count(*) AS n FROM items WHERE id=4').n === 1, denied)
} finally { await client.close() }
const { FileWriteTool } = await import(`${kit.src}/tools/FileWriteTool/FileWriteTool.ts`)
const readBack = await kit.read(`${file}:items/4`)
const remembered = kit.context.readFileState.get(`${file}:items/4`)?.sqliteRowIdentity
check('row identity is retained without being printed', typeof remembered === 'string' && /^[a-f0-9]{64}$/.test(remembered) && !readBack.includes(remembered), readBack)
const snapshot = JSON.parse(JSON.stringify(kit.context.readFileState.dump()))
kit.context.readFileState.clear()
kit.context.readFileState.load(snapshot)
check('row identity survives read-state serialization', kit.context.readFileState.get(`${file}:items/4`)?.sqliteRowIdentity === remembered && remembered !== undefined)
const input = { file_path: `${file}:items/4#delete`, content: 'DELETE' }
const valid = await FileWriteTool.validateInput(input, kit.context)
const schemaChange = new Database(file); schemaChange.run('CREATE INDEX changed_schema ON items(value)'); schemaChange.close()
let schemaResult = ''
try { const result = await FileWriteTool.call(input, kit.context); schemaResult = String(FileWriteTool.mapToolResultToToolResultBlockParam(result.data, 'delete').content) } catch (error) { schemaResult = String(error) }
check('schema is revalidated after validation before application', valid.result && /changed|modified/i.test(schemaResult) && count('SELECT count(*) AS n FROM items WHERE id=4').n === 1, schemaResult)
const legacyRead = kit.context.readFileState.get(`${file}:items/4`)
if (legacyRead) delete legacyRead.sqliteRowIdentity
let legacyResult = ''
try { await FileWriteTool.call(input, kit.context) } catch (error) { legacyResult = String(error) }
check('an old read without identity uses the existing unread answer', /read.*before|not.*read/i.test(legacyResult) && count('SELECT count(*) AS n FROM items WHERE id=4').n === 1, legacyResult)
kit.context.abortController.abort(new Error('delete cancelled'))
let cancelled = ''
try { await FileWriteTool.call(input, kit.context) } catch (error) { cancelled = String(error) }
check('cancelled deletion makes no change and closes its connection', cancelled.includes('delete cancelled') && count('SELECT count(*) AS n FROM items WHERE id=4').n === 1, cancelled)
kit.finish()
