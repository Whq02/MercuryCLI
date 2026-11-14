import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const file = join(home, 'keys.sqlite')
const seed = new Database(file)
seed.run(`CREATE TABLE textkey(k TEXT PRIMARY KEY, v TEXT); INSERT INTO textkey VALUES('42','plain digits'),('042','leading zero'),('x','letters');
CREATE TABLE intkey(k INTEGER PRIMARY KEY, v TEXT); INSERT INTO intkey VALUES(42,'integer'),(9007199254740993,'wide');
CREATE TABLE realkey(k REAL PRIMARY KEY, v TEXT); INSERT INTO realkey VALUES(42.5,'real');
CREATE TABLE cells(id INTEGER PRIMARY KEY, t TEXT, n, r REAL);`)
seed.close()
const client = await readViewMcp(home)
const bunRead = async (path: string): Promise<string> => {
  try { return (await kit.FileReadTool.call({ file_path: path }, kit.context)).data.file.content }
  catch (error) { return String(error) }
}
const stored = (sql: string): string => {
  const db = new Database(file, { readonly: true })
  try { return JSON.stringify(db.query(sql).all()) } finally { db.close() }
}
try {
  for (const [target, key, value] of [['textkey/42', '"42"', 'plain digits'], ['textkey/k=42', '"42"', 'plain digits'], ['textkey/042', '"042"', 'leading zero'], ['textkey/x', '"x"', 'letters'], ['intkey/42', '42', 'integer'], ['intkey/9007199254740993', '"9007199254740993"', 'wide'], ['realkey/42.5', '42.5', 'real']] as const) {
    const expected = `{\n  "k": ${key},\n  "v": "${value}"\n}\n`
    const node = await client.call('Read', { file_path: `${file}:${target}` })
    const bun = await bunRead(`${file}:${target}`)
    kit.check(`Node: ${target} finds the row whose key is ${key}`, node === expected, node)
    kit.check(`Bun: ${target} finds the row whose key is ${key}`, bun === expected, bun)
  }
  const created = await client.call('Write', { file_path: `${file}:textkey/77`, content: '{"v":"made"}' })
  kit.check('Node: a row made at a TEXT key of digits holds those digits as its key', created.includes('"type":"create"') && stored("SELECT k, typeof(k) AS kind FROM textkey WHERE v = 'made'") === '[{"k":"77","kind":"text"}]', stored("SELECT k, typeof(k) AS kind FROM textkey WHERE v = 'made'"))
  const cells = await client.call('Write', { file_path: `${file}:cells/1`, content: '{"t":6,"n":8,"r":2}' })
  kit.check('Node: a whole number written to TEXT, untyped and REAL columns is stored as SQLite stores an integer there', cells.includes('"type":"create"') && stored('SELECT t, typeof(t) AS tt, n, typeof(n) AS tn, r, typeof(r) AS tr FROM cells') === '[{"t":"6","tt":"text","n":8,"tn":"integer","r":2,"tr":"real"}]', stored('SELECT t, typeof(t) AS tt, n, typeof(n) AS tn, r, typeof(r) AS tr FROM cells'))
  await client.call('Read', { file_path: `${file}:textkey/42` })
  const deleted = await client.call('Write', { file_path: `${file}:textkey/42#delete`, content: 'DELETE' })
  kit.check('Node: deleting the TEXT key 42 removes that row and leaves 042', deleted.includes('"type":"delete"') && stored('SELECT k FROM textkey ORDER BY k') === '[{"k":"042"},{"k":"77"},{"k":"x"}]', `${deleted} ${stored('SELECT k FROM textkey ORDER BY k')}`)
} finally { await client.close() }
kit.finish()
