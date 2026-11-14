import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isolatedHome } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const file = join(home, 'work.sqlite')
const db = new Database(file)
db.run('CREATE TABLE teams(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE work(id INTEGER PRIMARY KEY, team INTEGER, name TEXT, payload BLOB); INSERT INTO teams VALUES(1,\'tools\'),(2,\'docs\'); INSERT INTO work VALUES(1,1,\'a&b?%+\',X\'0011FF\'),(2,1,\'second\',NULL),(3,2,\'third\',NULL);')
db.close()
let client = await readViewMcp(home)
let passed = 0, failed = 0
const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`) }
const read = (target: string) => client.call('Read', { file_path: target })
const digest = () => createHash('sha256').update(readFileSync(file)).digest('hex')
try {
  const sql = "SELECT work.id,teams.name,work.name FROM work JOIN teams ON teams.id=work.team ORDER BY work.id"
  const first = await read(`${file}#read?offset=0&limit=2&sql=${sql}`)
  check('release Node executes a projected join', first.includes('target: SQLite query') && first.includes('[1,"tools","a&b?%+"]') && first.includes('[2,"tools","second"]'), first)
  check('columns preserve positional identity', first.includes('Columns: ["id","name","name"]'))
  check('query view grants no source anchor', !first.includes('(anchor:'))
  check('live continuation is not called a snapshot', first.includes('live result') && first.includes('not a snapshot'))
  const next = /Read\(file_path: ("(?:[^"\\]|\\.)*")\) continues/.exec(first)
  const second = next ? await read(JSON.parse(next[1]!)) : ''
  check('continuation preserves SQL and reaches row three', second.includes('[3,"docs","third"]') && !second.includes('[1,"tools"'), second)
  const cte = await read(`${file}#read?limit=1&sql=WITH n AS (SELECT id FROM work LIMIT 2) SELECT * FROM n; -- keep internal limit`)
  check('CTE and internal limit/trailing comment remain valid', cte.includes('[1]') && cte.includes('continues from there'), cte)
  check('PRAGMA introspection pages', (await read(`${file}#read?limit=1&sql=PRAGMA table_info(work)`)).includes('continues from there'))
  check('EXPLAIN pages', (await read(`${file}#read?limit=1&sql=EXPLAIN SELECT * FROM work`)).includes('continues from there'))
  check('table filter/order page works', (await read(`${file}#read?table=work&order=id DESC&where=id>1&limit=1`)).includes('[3,2,"third",null]'))
  check('table source spelling retains meaning', (await read(`${file}:work#read?order=id DESC&where=id>1&limit=1`)).includes('[3,2,"third",null]'))
  check('quoted semicolon is a filter value', (await read(`${file}#read?table=work&where=name='x;y'`)).includes('state: complete'))
  check('filter cannot replace its page syntax', !(await read(`${file}#read?table=work&where=1) LIMIT 1 --`)).includes('state: complete'))
  check('missing parameter is not silently null', (await read(`${file}#read?sql=SELECT ? AS missing`)).includes('parameter'))
  check('malformed SQL reports engine error', /syntax|incomplete/i.test(await read(`${file}#read?sql=SELECT FROM`)))
  check('missing table reports engine error', (await read(`${file}#read?sql=SELECT * FROM absent`)).includes('no such table'))
  const before = digest()
  const mutation = await read(`${file}#read?sql=DELETE FROM work RETURNING id`)
  check('engine itself refuses Read mutation', /readonly|read.only|not authorized/i.test(mutation), mutation)
  check('Read mutation leaves bytes unchanged', digest() === before)
  const other = join(home, 'elsewhere.sqlite')
  writeFileSync(other, readFileSync(file))
  check('engine authorizer blocks extra-file attachment', /not authorized/i.test(await read(`${file}#read?sql=ATTACH DATABASE '${other.replaceAll("'", "''")}' AS stolen`)))
  check('extensions cannot load', /not authorized|disabled/i.test(await read(`${file}#read?sql=SELECT load_extension('absent')`)))
  check('exact large integer survives', (await read(`${file}#read?sql=SELECT 9223372036854775807 AS value`)).includes('[9223372036854775807]'))
  check('blob bytes have a full representation', (await read(`${file}#read?sql=SELECT payload FROM work WHERE id=1`)).includes('ABH/'))
  const listing = await read(file)
  check('database listing discovers exact SQL spelling', listing.includes(`${file}#read?sql=SELECT * FROM sqlite_schema`))
  const row = await read(`${file}:work/1`)
  check('ordinary keyed Read retains row content', row.includes('a&b?%+') && row.includes('"id": 1'), row)
  const wrote = await client.call('Write', { file_path: `${file}:work/1`, content: '{"name":"changed"}' })
  check('release Node can update an addressed SQLite row', wrote.includes('"type":"update"'), wrote)
  const afterWrite = new Database(file, { readonly: true })
  check('release Write changed exactly the requested value', afterWrite.query('SELECT name FROM work WHERE id=1').get()?.name === 'changed')
  afterWrite.close()
  await client.close()
  client = await readViewMcp(home, ['Read(work.sqlite)'])
  check('query does not evade a source deny', !(await read(`${file}#read?sql=SELECT * FROM work`)).includes('target: SQLite query'))
  if (process.platform !== 'win32') {
    const link = join(home, 'alias.sqlite')
    symlinkSync(file, link)
    check('alias does not evade source deny', !(await read(`${link}#read?sql=SELECT * FROM work`)).includes('target: SQLite query'))
  }
} finally { await client.close() }
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
