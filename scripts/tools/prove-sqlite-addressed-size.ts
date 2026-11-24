import { Database } from 'bun:sqlite'
import { closeSync, copyFileSync, ftruncateSync, mkdirSync, openSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const small = join(home, 'small.sqlite'), large = join(home, 'large.sqlite')
const seed = new Database(small)
seed.run('CREATE TABLE work(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO work VALUES(1,\'one\'); CREATE TABLE widevalue(id INTEGER PRIMARY KEY, body TEXT, payload BLOB);')
seed.query('INSERT INTO widevalue VALUES(1,?,zeroblob(24000))').run('x'.repeat(30000) + 'TAIL_SENTINEL')
seed.close()
copyFileSync(small, large)
const ballast = new Database(large)
ballast.run('CREATE TABLE ballast(data BLOB); INSERT INTO ballast VALUES(zeroblob(50331648));')
ballast.close()
const client = await readViewMcp(home)
const resident = (pid: number) => process.platform === 'win32'
  ? Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8', windowsHide: true }).trim())
  : Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024
try {
  const expected = '{\n  "id": 1,\n  "body": "one"\n}\n'
  const smallNode = await client.call('Read', { file_path: `${small}:work/1` })
  const nodeSmallRss = resident(client.pid)
  const largeNode = await client.call('Read', { file_path: `${large}:work/1` })
  const nodeLargeRss = resident(client.pid)
  kit.check('Node: a small addressed row keeps its previous bytes', smallNode === expected, `${smallNode} | an addressed row (path:table/key) must render through renderSqliteTarget in src/tools/read/readRichFormats.ts exactly as before`)
  kit.check('Node: the same row in a 48 MiB database is readable', largeNode === expected, `${largeNode} | an addressed row must not hit the whole-container size gate; see renderSqliteTarget in src/tools/read/readRichFormats.ts`)
  const dataRead = async (path: string) => { try { return (await kit.ReadTool.call({ file_path: path }, kit.context)).data.file.content } catch (error) { return String(error) } }
  const smallBun = await dataRead(`${small}:work/1`)
  const bunSmallRss = process.memoryUsage().rss
  const largeBun = await dataRead(`${large}:work/1`)
  const bunLargeRss = process.memoryUsage().rss
  kit.check('Bun: a small addressed row keeps its previous bytes', smallBun === expected, `${smallBun} | an addressed row (path:table/key) must render through renderSqliteTarget in src/tools/read/readRichFormats.ts exactly as before`)
  kit.check('Bun: the same row in a 48 MiB database is readable', largeBun === expected, `${largeBun} | an addressed row must not hit the whole-container size gate; see renderSqliteTarget in src/tools/read/readRichFormats.ts`)
  const tempNames = ['TMPDIR', 'TEMP', 'TMP'] as const
  const tempBefore = tempNames.map(name => process.env[name])
  const noFolder = join(home, 'no-folder-here')
  closeSync(openSync(noFolder, 'w'))
  for (const name of tempNames) process.env[name] = noFolder
  const inPlace = await dataRead(`${small}:work/1`)
  tempNames.forEach((name, i) => { if (tempBefore[i] === undefined) delete process.env[name]; else process.env[name] = tempBefore[i] })
  kit.check('Bun: a database with no log is read where it stands, with no private copy (for this one read the temp folder is no folder)', inPlace === expected, `${inPlace} | a database with no -wal must be opened where it stands, with no copy into the temp folder; see renderSqliteTarget in src/tools/read/readRichFormats.ts`)
  console.log(`resident bytes: Node small=${nodeSmallRss}, large=${nodeLargeRss}; Bun small=${bunSmallRss}, large=${bunLargeRss}`)
  kit.check('Node: a row read does not retain a database-sized buffer', nodeLargeRss - nodeSmallRss < 16 * 1024 * 1024, 'an addressed row read must not load the whole database into memory; see renderSqliteTarget in src/tools/read/readRichFormats.ts')
  kit.check('Bun: a row read does not retain a database-sized buffer', bunLargeRss - bunSmallRss < 16 * 1024 * 1024, 'an addressed row read must not load the whole database into memory; see renderSqliteTarget in src/tools/read/readRichFormats.ts')
  const wrote = await client.call('Write', { file_path: `${large}:work/1`, content: '{"body":"updated"}' })
  kit.check('Node: a keyed row Write has no whole-database size gate', wrote.includes('"type":"update"') && (await client.call('Read', { file_path: `${large}:work/1` })).includes('"body": "updated"'), `${wrote} | a keyed row Write to a large database must not be refused by a whole-database size limit`)
  const long = await kit.read(`${large}:widevalue/1`)
  kit.check('long text uses the existing clipped-line words', long.includes('[truncated ') && long.length < 8000 && !long.includes('TAIL_SENTINEL'), `${long.slice(0, 700)} | a long cell must be clipped with the truncated marker and without its tail when an addressed row is rendered; see renderSqliteTarget in src/tools/read/readRichFormats.ts`)
  kit.check('blob display remains bounded and truthful', long.includes('<BLOB 24000B>'), 'a blob cell must print as <BLOB nB> with its byte size when an addressed row is rendered; see renderSqliteTarget in src/tools/read/readRichFormats.ts')
  kit.check('whole database listing retains its existing limit', (await kit.read(large)).includes('maximum allowed container size'), 'reading the whole large database must still be refused with the container size message; see the container size check in src/tools/read/readRichFormats.ts')
  kit.check('whole table view retains its existing limit', (await kit.read(`${large}:work`)).includes('maximum allowed container size'), 'reading a whole table of the large database must still be refused with the container size message; see the container size check in src/tools/read/readRichFormats.ts')
  const archive = join(home, 'large.zip')
  const fd = openSync(archive, 'w'); ftruncateSync(fd, 20 * 1024 * 1024); closeSync(fd)
  kit.check('archive container limit is unchanged', (await kit.read(archive)).includes('maximum allowed container size'), 'a 20 MiB archive must still be refused with the container size message; see the container size check in src/tools/read/readRichFormats.ts')
  const directory = join(home, 'directory.sqlite'); mkdirSync(directory)
  const { renderSqliteTarget } = await import(`${kit.src}/tools/read/readRichFormats.ts`)
  let notRegular = ''
  try { await renderSqliteTarget(directory, 'work/1') } catch (error) { notRegular = String(error) }
  kit.check('addressed SQLite keeps the regular-file check', notRegular.includes('Not a regular file'), `${notRegular} | renderSqliteTarget in src/tools/read/readRichFormats.ts must still throw Not a regular file for a directory`)
} finally { await client.close() }
kit.finish()
