import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'

const home = isolatedHome(import.meta.filename)
mkdirSync(join(home, 'tmp'), { recursive: true })
const kit = await readViewKit(home)
const { read, check } = kit
const file = join(home, 'large.sqlite')
const db = new Database(file)
db.run('CREATE TABLE work(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO work VALUES(1,\'one\'),(2,\'two\'); CREATE TABLE ballast(data BLOB); INSERT INTO ballast VALUES(zeroblob(50331648)); CREATE TABLE removable(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO removable VALUES(1,\'remove\');')
db.close()
const sourceState = (path: string) => ({ files: readdirSync(home).sort().join('\n'), bytes: ['', '-wal'].map(s => existsSync(path + s) ? createHash('sha256').update(readFileSync(path + s)).digest('hex') : 'absent').join('|') })
const beforeFiles = sourceState(file)
const page = await read(`${file}#read?limit=1&sql=SELECT id FROM work ORDER BY id`)
check('database beyond the old 16 MiB cap returns a small page', statSync(file).size > 48 * 1024 * 1024 && page.includes('1\t[1]'), page)
check('non-WAL query leaves listing, database and WAL bytes unchanged', JSON.stringify(beforeFiles) === JSON.stringify(sourceState(file)))
check('query grants neither database nor row coverage', !kit.context.readFileState.has(file) && !kit.context.readFileState.has(`${file}:work/1`))
const addressedLarge = await read(`${file}:removable/1`)
check('a large database still has an ordinary addressed row Read', addressedLarge.includes('"value": "remove"'), addressedLarge)
const { FileWriteTool } = await import(`${kit.src}/tools/FileWriteTool/FileWriteTool.ts`)
const removal = { file_path: `${file}:removable/1#delete`, content: 'DELETE' }
const allowed = await FileWriteTool.validateInput(removal, kit.context)
const removed = allowed.result ? (await FileWriteTool.call(removal, kit.context)).data.type : allowed.message
check('the large row can be explicitly deleted after that Read', removed === 'delete', String(removed))
const late = await read(`${file}#read?offset=1499&limit=5&sql=WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1505) SELECT x FROM n`)
check('late pages have no thousand-row ceiling', late.includes('1500\t[1500]') && late.includes('1504\t[1504]') && late.includes('continues from there'), late)
const repeated = await read(`${file}#read?sql=SELECT 1 AS x, 2 AS x`)
check('duplicate column identities stay positional', repeated.includes('Columns: ["x","x"]') && repeated.includes('[1,2]'))
const extra = await read(`${file}#read?sql=SELECT 1; SELECT 2`)
check('a second statement is not silently ignored', extra.includes('another statement'))
const literal = await read(`${file}#read?sql=SELECT '?' AS question, ':name' AS name`)
check('quoted parameter punctuation remains data', literal.includes('["?",":name"]'))
const cancelled = new AbortController()
kit.context.abortController = cancelled
const start = Date.now()
const timer = setTimeout(() => cancelled.abort(new Error('sqlite cancelled')), 250)
const stopped = await read(`${file}#read?sql=WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n`)
clearTimeout(timer)
check('native SQLite work can be cancelled', stopped.includes('sqlite cancelled') && Date.now() - start < 2500, stopped)
kit.context.abortController = new AbortController()
check('a query after cancellation opens normally', (await read(`${file}#read?sql=SELECT count(*) FROM work`)).includes('[2]'))
;(kit.context as any).fileReadingLimits = { maxTokens: 1000, maxSizeBytes: 5000 }
const wide = await read(`${file}#read?sql=SELECT printf('%.*c', 20000, 'x') AS long_cell, zeroblob(3000) AS bytes`)
const artifact = /Read\(file_path: ("(?:[^"\\]|\\.)*")\) for the full value/.exec(wide)
check('oversized row names a complete generated artifact', artifact !== null && wide.length < 5000, wide.slice(0, 500))
if (artifact) {
  const body = JSON.parse(readFileSync(JSON.parse(artifact[1]!), 'utf8'))
  check('long cell and blob are complete in artifact', body[0].length === 20000 && Buffer.from(body[1].blob, 'base64').length === 3000)
} else check('long cell and blob are complete in artifact', false)
const { getMercuryTempDir } = await import(`${kit.src}/utils/permissions/filesystem.ts`)
const outputRoot = join(getMercuryTempDir(), 'query-results')
const outputsBefore = existsSync(outputRoot) ? readdirSync(outputRoot).sort().join('\n') : ''
const failedOutput = await read(`${file}#read?sql=WITH vals(id) AS (VALUES(1),(2)) SELECT printf('%.*c',20000,'x'), CASE WHEN id=2 THEN abs(-9223372036854775808) ELSE 0 END FROM vals`)
check('mid-query error removes its owned generated output', failedOutput.includes('integer overflow') && outputsBefore === (existsSync(outputRoot) ? readdirSync(outputRoot).sort().join('\n') : ''), failedOutput)
delete (kit.context as any).fileReadingLimits
const live = join(home, 'live.sqlite')
const writer = new Database(live)
writer.run('PRAGMA journal_mode=WAL; CREATE TABLE recent(id INTEGER); INSERT INTO recent VALUES(7);')
const before = sourceState(live)
try {
  check('live WAL rows are visible', (await read(`${live}#read?sql=SELECT * FROM recent`)).includes('[7]'))
  check('live WAL read preserves listing, database and WAL bytes', JSON.stringify(before) === JSON.stringify(sourceState(live)))
  const orphan = join(home, 'orphan.sqlite')
  copyFileSync(live, orphan)
  copyFileSync(`${live}-wal`, `${orphan}-wal`)
  const orphanBefore = sourceState(orphan)
  const orphanRead = await read(`${orphan}#read?sql=SELECT * FROM recent`)
  check('missing shared-memory sidecar is handled privately and named', orphanRead.includes('[7]') && orphanRead.includes('source-mode: private copy of leftover WAL') && !existsSync(`${orphan}-shm`))
  check('leftover WAL read preserves listing, database and WAL bytes', JSON.stringify(orphanBefore) === JSON.stringify(sourceState(orphan)))
  kit.deny('Read(live.sqlite-wal)')
  check('WAL cannot evade its own Read deny', !(await read(`${live}#read?sql=SELECT * FROM recent`)).includes('target: SQLite query'))
} finally { writer.close() }
const clean = join(home, 'clean.sqlite')
const closedWriter = new Database(clean)
closedWriter.run('PRAGMA journal_mode=WAL; CREATE TABLE closed(id); INSERT INTO closed VALUES(9)')
closedWriter.close()
const cleanBefore = sourceState(clean)
check('cleanly closed WAL returns the main-file data', (await read(`${clean}#read?sql=SELECT * FROM closed`)).includes('[9]'))
check('cleanly closed WAL read preserves listing, database and WAL bytes', JSON.stringify(cleanBefore) === JSON.stringify(sourceState(clean)))
if (process.platform !== 'win32') {
  const { remoteWorld, enterWorld } = await import('../remote-files/remoteKit.js')
  const world = await remoteWorld('local', 0, { clientHome: home })
  const leave = enterWorld(world)
  try {
    const remoteFile = join(world.data, 'remote.sqlite')
    copyFileSync(file, remoteFile)
    const source = `ssh://box${remoteFile}`
    const remote = await read(`${source}#read?limit=1&sql=SELECT id FROM work ORDER BY id`)
    check('large remote query is evaluated here after transfer', remote.includes('1\t[1]') && remote.includes(source) && remote.includes('copied here'), remote)
    check('SQL is never a remote command or path', !world.argvLines().some(line => line.includes('SELECT id') || line.includes('#read?')))
    const { closeRemoteConnections } = await import(`${kit.src}/services/remoteFiles/connection.ts`)
    await closeRemoteConnections()
  } finally { leave(); await world.stop() }
}
kit.finish()
