import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const folder = (name: string): string => { mkdirSync(join(home, name)); return join(home, name, 'log.sqlite') }
const live = folder('live')
const writer = new Database(live)
writer.run("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'in the database')")
writer.run('PRAGMA wal_checkpoint(TRUNCATE)')
writer.run("INSERT INTO items VALUES(2,'only in the log')")
const sidecars = (file: string, names: string[]) => { for (const name of names) copyFileSync(`${live}${name}`, `${file}${name}`) }
const leftover = folder('leftover'), leftoverBun = folder('leftover-bun'), both = folder('both'), empty = folder('empty')
sidecars(leftover, ['', '-wal']); sidecars(leftoverBun, ['', '-wal']); sidecars(both, ['', '-wal', '-shm']); sidecars(empty, [''])
writeFileSync(`${empty}-wal`, '')
const digest = (file: string): string => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent'
const state = (file: string): string => JSON.stringify([readdirSync(join(file, '..')).sort(), digest(file), digest(`${file}-wal`), existsSync(`${file}-shm`) ? statSync(`${file}-shm`).size : 'absent'])
const bunRead = async (path: string): Promise<string> => {
  try { return (await kit.FileReadTool.call({ file_path: path }, kit.context)).data.file.content }
  catch (error) { return String(error) }
}
const client = await readViewMcp(home)
try {
  for (const [runtime, file, read] of [['Node', leftover, (path: string) => client.call('Read', { file_path: path })], ['Bun', leftoverBun, bunRead]] as const) {
    const before = state(file)
    const row = await read(`${file}:items/2`), table = await read(`${file}:items`), listing = await read(file)
    kit.check(`${runtime}: a keyed read of a database with a leftover log reads the row the log holds`, row.includes('"value": "only in the log"'), row)
    kit.check(`${runtime}: its table read includes that row`, table.includes('only in the log') && table.includes('in the database'), table)
    kit.check(`${runtime}: the database listing answers`, listing.includes('items'), listing)
    kit.check(`${runtime}: nothing new stands beside the database and its bytes and its log are unchanged`, state(file) === before && !existsSync(`${file}-shm`), `${before} → ${state(file)}`)
  }
  const bothBefore = state(both)
  const kept = await client.call('Read', { file_path: `${both}:items/2` })
  kit.check('Node: a shared-memory file that was there stays, with the database and the log unchanged', kept.includes('only in the log') && state(both) === bothBefore, `${bothBefore} → ${state(both)}`)
  const emptyBefore = state(empty)
  const plain = await client.call('Read', { file_path: `${empty}:items/1` })
  kit.check('Node: an empty log leaves no shared-memory file either', plain.includes('in the database') && state(empty) === emptyBefore, `${emptyBefore} → ${state(empty)}`)
  const liveBefore = state(live)
  const held = await client.call('Read', { file_path: `${live}:items/2` })
  kit.check('Node: a database another connection holds open is read with its files unchanged', held.includes('only in the log') && state(live) === liveBefore, `${liveBefore} → ${state(live)}`)
  writer.run("INSERT INTO items VALUES(3,'written while open')")
  const later = await client.call('Read', { file_path: `${live}:items/3` })
  kit.check('Node: it sees what that connection wrote since', later.includes('written while open'), later)
} finally { await client.close(); writer.close() }
kit.finish()
