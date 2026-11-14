import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const file = join(home, 'integers.sqlite')
const seed = new Database(file)
seed.run(`CREATE TABLE typed(id INTEGER PRIMARY KEY, negative INTEGER, zero INTEGER, whole_real REAL, missing TEXT, numeric_text TEXT, bytes BLOB);
INSERT INTO typed VALUES(1,-7,0,2.0,NULL,'42',X'0011FF'),(0,-1,0,1.0,NULL,'0',X''),(-2,-3,0,3.0,NULL,'-2',X'FE');
CREATE TABLE pkbig(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO pkbig VALUES(9223372036854775807,'pkbig');
CREATE TABLE rowidbig(value TEXT); INSERT INTO rowidbig(rowid,value) VALUES(9223372036854775807,'rowidbig');
CREATE TABLE withoutbig(id INTEGER PRIMARY KEY,value TEXT) WITHOUT ROWID; INSERT INTO withoutbig VALUES(9223372036854775807,'withoutbig');`)
seed.close()
const client = await readViewMcp(home)
const bunRead = async (path: string): Promise<string> => {
  try { return (await kit.FileReadTool.call({ file_path: path }, kit.context)).data.file.content }
  catch (error) { return String(error) }
}
try {
  for (const [id, negative, real, text, bytes] of [[1,-7,2,'42',3],[0,-1,1,'0',0],[-2,-3,3,'-2',1]] as const) {
    const expected = JSON.stringify({ id, negative, zero: 0, whole_real: real, missing: null, numeric_text: text, bytes: `<BLOB ${bytes}B>` }, null, 2) + '\n'
    const target = `${file}:typed/${id}`
    const node = await client.call('Read', { file_path: target })
    const bun = await bunRead(target)
    kit.check(`Node: ordinary row ${id} keeps every previous byte`, node === expected, node)
    kit.check(`Bun: ordinary row ${id} keeps every previous byte`, bun === expected, bun)
  }
  for (const [table, column] of [['pkbig','id'],['rowidbig','rowid'],['withoutbig','id']] as const) {
    const target = `${file}:${table}/9223372036854775807`
    const node = await client.call('Read', { file_path: target })
    const bun = await bunRead(target)
    const exact = (body: string) => {
      try { return JSON.parse(body)[column] === '9223372036854775807' && !/9\.223372|9223372036854776000/.test(body) } catch { return false }
    }
    kit.check(`Node: ${table} keeps the exact full-width key`, exact(node), node)
    kit.check(`Bun: ${table} keeps the exact full-width key`, exact(bun), bun)
    kit.check(`${table}: both runtimes return identical row bytes`, node === bun)
    const written = await client.call('Write', { file_path: target, content: '{"value":"updated"}' })
    const after = await client.call('Read', { file_path: target })
    kit.check(`${table}: Write names the same row Read showed`, written.includes('"type":"update"') && exact(after) && after.includes('"value": "updated"'), written)
  }
  const sql = await client.call('Read', { file_path: `${file}#read?sql=SELECT id FROM pkbig` })
  kit.check('sql= remains exact on its independent query engine', sql.includes('[9223372036854775807]'), sql)
} finally { await client.close() }
kit.finish()
