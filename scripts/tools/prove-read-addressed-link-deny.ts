import { Database } from 'bun:sqlite'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'
import { readViewMcp } from './readViewMcp.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const outside = join(home, '..', `outside-${process.pid}`)
mkdirSync(outside, { recursive: true })
const zipOf = (name: string, text: string): Buffer => {
  const data = Buffer.from(text), file = Buffer.from(name), crc = Bun.hash.crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + file.length, 12); end.writeUInt32LE(30 + file.length + data.length, 16)
  return Buffer.concat([local, file, data, central, file, end])
}
const database = (file: string, word: string) => { const db = new Database(file); db.run(`CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES(1,'${word}')`); db.close() }
writeFileSync(join(outside, 'kept.txt'), 'KEPT line one\nline two\nline three\n')
database(join(outside, 'kept.db'), 'KEPT')
writeFileSync(join(outside, 'kept.zip'), zipOf('inner.txt', 'KEPT in the archive\n'))
database(join(outside, 'open.db'), 'open')
database(join(home, 'inside.db'), 'KEPT')
for (const name of ['kept.txt', 'kept.db', 'kept.zip', 'open.db']) symlinkSync(join(outside, name), join(home, `link-${name}`))
symlinkSync(join(home, 'link-kept.db'), join(home, 'chain.db'))
symlinkSync(join(home, 'inside.db'), join(home, 'link-inside.db'))
const client = await readViewMcp(home, [...['kept.txt', 'kept.db', 'kept.zip'].map(name => `Read(/${join(outside, name)})`), `Read(/${join(home, 'inside.db')})`])
try {
  for (const target of ['link-kept.txt', 'link-kept.db', 'link-kept.zip']) {
    const answer = await client.call('Read', { file_path: join(home, target) })
    kit.check(`the whole file through a link is refused as before: ${target}`, answer.includes('is denied by a rule') && !answer.includes('KEPT'), answer)
  }
  for (const target of ['link-kept.txt:1-2', 'link-kept.db:t', 'link-kept.db:t/1', 'link-kept.db:t/v=KEPT', 'chain.db:t', 'chain.db:t/1', 'link-inside.db:t', 'link-kept.zip:inner.txt', 'link-kept.zip!inner.txt', 'link-kept.db:t#read?limit=1', 'link-kept.db#read?sql=SELECT * FROM t', 'link-kept.db#read?table=t']) {
    const answer = await client.call('Read', { file_path: join(home, target) })
    kit.check(`an addressed read through a link meets the rule on what the link names: ${target}`, answer.includes('is denied by a rule') && !answer.includes('KEPT'), answer)
  }
  const allowed = await client.call('Read', { file_path: `${join(home, 'link-open.db')}:t/1` })
  kit.check('a link to a database no rule names is still read by its address', allowed.includes('"v": "open"'), allowed)
  const range = await client.call('Read', { file_path: `${join(outside, 'open.db')}:t` })
  kit.check('a database no rule names is still read by its table', range.includes('open'), range)
} finally { await client.close() }
const decision = async (file_path: string): Promise<string> => (await kit.FileReadTool.checkPermissions({ file_path }, kit.context)).behavior
const direct = await decision(join(outside, 'open.db'))
kit.check('a database outside the working folder is not read without a decision', direct === 'ask', direct)
for (const target of ['link-open.db', 'link-open.db:t', 'link-open.db:t/1', 'link-open.db:t#read?limit=1']) {
  const linked = await decision(join(home, target))
  kit.check(`a link inside the working folder to that database meets the same decision: ${target}`, linked === direct, linked)
}
kit.check('a file inside the working folder keeps its decision, with or without an address', await decision(join(home, 'inside.db')) === 'allow' && await decision(`${join(home, 'inside.db')}:t/1`) === 'allow' && await decision(`${join(home, 'plain.txt')}:3-4`) === 'allow')
kit.finish()
