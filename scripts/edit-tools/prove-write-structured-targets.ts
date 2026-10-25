#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { Database } from 'bun:sqlite'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'write-structured-targets-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.NODE_ENV

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { _resetSeenLinesForTesting } = await import(`${SRC}/services/changeTransaction/seenLines.ts`)
const { FileEditTool } = await import(`${SRC}/tools/FileEditTool/FileEditTool.ts`)
const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { FileWriteTool } = await import(`${SRC}/tools/FileWriteTool/FileWriteTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { createFileStateCacheWithSizeLimit } = await import(`${SRC}/utils/fileStateCache.ts`)
const structured = (await import(`${SRC}/tools/FileWriteTool/structuredTargets.ts`).catch(() => null)) as null | {
  parseStructuredWriteTarget: (raw: string) => { kind: string; hostPath: string; reason?: string } | null
  STRUCTURED_EDIT_MODES_NOTE: string
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 600 ? `${detail.slice(0, 600)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const fixtures = mkdtempSync(join(tmpdir(), 'write-structured-targets-fixtures-'))

type ZipSpec = { name: string; content: Buffer | string; stored?: boolean; extra?: Buffer; claimedSize?: number; comment?: Buffer; flags?: number; externalAttrs?: number; disk?: number }
function buildZip(entries: ZipSpec[], archiveComment = Buffer.alloc(0)): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8')
    const raw = typeof e.content === 'string' ? Buffer.from(e.content, 'utf8') : e.content
    const payload = e.stored ? raw : deflateRawSync(raw)
    const method = e.stored ? 0 : 8
    const sum = crc32(raw) >>> 0
    const extra = e.extra ?? Buffer.alloc(0)
    const comment = e.comment ?? Buffer.alloc(0)
    const usize = e.claimedSize ?? raw.length
    const flags = e.flags ?? 0x0800
    const extAttrs = e.externalAttrs ?? 0x81a40000

    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0)
    loc.writeUInt16LE(20, 4)
    loc.writeUInt16LE(flags, 6)
    loc.writeUInt16LE(method, 8)
    loc.writeUInt16LE(0x6a3c, 10)
    loc.writeUInt16LE(0x5a21, 12)
    loc.writeUInt32LE(sum, 14)
    loc.writeUInt32LE(payload.length, 18)
    loc.writeUInt32LE(usize, 22)
    loc.writeUInt16LE(nameBytes.length, 26)
    loc.writeUInt16LE(extra.length, 28)
    localParts.push(loc, nameBytes, extra, payload)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(0x031e, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(flags, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(0x6a3c, 12)
    cen.writeUInt16LE(0x5a21, 14)
    cen.writeUInt32LE(sum, 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(usize, 24)
    cen.writeUInt16LE(nameBytes.length, 28)
    cen.writeUInt16LE(extra.length, 30)
    cen.writeUInt16LE(comment.length, 32)
    cen.writeUInt16LE(e.disk ?? 0, 34)
    cen.writeUInt32LE(extAttrs, 38)
    cen.writeUInt32LE(offset, 42)
    centralParts.push(cen, nameBytes, extra, comment)

    offset += loc.length + nameBytes.length + extra.length + payload.length
  }
  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(archiveComment.length, 20)
  return Buffer.concat([...localParts, cd, eocd, archiveComment])
}

type ZipRecord = { name: string; method: number; crc: number; usize: number; central: Buffer; local: Buffer; data: Buffer }
function listZip(buf: Buffer): { records: ZipRecord[]; comment: string } {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('no EOCD')
  const total = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const commentLen = buf.readUInt16LE(eocd + 20)
  const comment = buf.subarray(eocd + 22, eocd + 22 + commentLen).toString('utf8')
  const records: ZipRecord[] = []
  let pos = cdOffset
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central header')
    const method = buf.readUInt16LE(pos + 10)
    const crc = buf.readUInt32LE(pos + 16)
    const csize = buf.readUInt32LE(pos + 20)
    const usize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const cmtLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    const central = Buffer.from(buf.subarray(pos, pos + 46 + nameLen + extraLen + cmtLen))
    central.writeUInt32LE(0, 42)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const local = Buffer.from(buf.subarray(localOffset, dataStart))
    const data = Buffer.from(buf.subarray(dataStart, dataStart + csize))
    records.push({ name, method, crc, usize, central, local, data })
    pos += 46 + nameLen + extraLen + cmtLen
  }
  return { records, comment }
}
function zipText(buf: Buffer, name: string): string | null {
  const rec = listZip(buf).records.find(r => r.name === name)
  if (!rec) return null
  const raw = rec.method === 0 ? rec.data : inflateRawSync(rec.data, { maxOutputLength: 8 * 1024 * 1024 })
  if ((crc32(raw) >>> 0) !== rec.crc) throw new Error(`crc mismatch for ${name}`)
  return raw.toString('utf8')
}

type Entry = { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }
type Ctx = { readFileState: Map<string, Entry> }
function makeContext(denyRules: string[] = [], mode: 'default' | 'implement' | 'sovereign' = 'default'): Ctx {
  const perm = getEmptyToolPermissionContext()
  perm.alwaysDenyRules.cliArg = denyRules
  perm.mode = mode
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({ toolPermissionContext: perm }),
  } as never as Ctx
}

let serial = 0
type Verdict = { ok: true; text: string; isError: boolean; data: Record<string, unknown> } | { ok: false; message: string }
async function run(tool: unknown, input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> {
  serial++
  const t = tool as { validateInput?: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  try {
    if (t.validateInput) {
      const verdict = await t.validateInput(input, ctx)
      if (verdict.result === false) return { ok: false, message: String(verdict.message) }
    }
    const out = await t.call(input, ctx, null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_${serial}` } })
    const block = t.mapToolResultToToolResultBlockParam(out.data, `toolu_${serial}`)
    return { ok: true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), isError: block.is_error === true, data: out.data }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const read = (input: Record<string, unknown>, ctx: Ctx) => run(FileReadTool, input, ctx)
const write = (input: Record<string, unknown>, ctx: Ctx) => run(FileWriteTool, input, ctx)
const edit = (input: Record<string, unknown>, ctx: Ctx) => run(FileEditTool, input, ctx)
const words = (v: Verdict): string => (v.ok ? v.text : v.message)
const bytesOf = (p: string): Buffer => readFileSync(p)

section('S0. The grammar is the Read side\'s; a path that merely carries !, :: or : stays a plain file (the control)')
{
  _resetSeenLinesForTesting()
  const plain = ['notes!entry.txt', 'draft::entry.txt', 'todo:users', 'report.txt:3']
  for (const [idx, suffix] of plain.entries()) {
    const ctx = makeContext()
    const target = join(fixtures, suffix)
    const w = await write({ file_path: target, content: `alpha-${idx}\n` }, ctx)
    const e = await edit({ file_path: target, old_string: `alpha-${idx}`, new_string: `beta-${idx}` }, ctx)
    check(
      `S0.${idx + 1} Write and Edit on "${suffix}" operate on the literal file (no container in the name)`,
      w.ok && e.ok && existsSync(target) && readFileSync(target, 'utf8') === `beta-${idx}\n` && structured?.parseStructuredWriteTarget(target) === null,
      !w.ok ? w.message : !e.ok ? e.message : readFileSync(target, 'utf8'),
    )
  }
  const spellings = ['bundle.zip:README.txt', 'bundle.zip!README.txt', 'bundle.zip::README.txt', 'bundle.zip!/README.txt']
  const parsed = spellings.map(s => structured?.parseStructuredWriteTarget(join(fixtures, s)) ?? null)
  check(
    'S0.5 the four delimiter spellings the Read side accepts (":", "!", "::", "!/") name the same zip entry on the write side',
    parsed.every(p => p !== null && p.kind === 'zip-entry' && p.hostPath === join(fixtures, 'bundle.zip')),
    JSON.stringify(parsed),
  )
  check(
    'S0.6 a Windows drive-letter plain path "C:\\\\dir\\\\file.txt" is not treated as a container target',
    structured !== null && structured.parseStructuredWriteTarget('C:\\dir\\file.txt') === null,
    JSON.stringify(structured?.parseStructuredWriteTarget('C:\\dir\\file.txt')),
  )
}

section('S1. A zip entry: Read, then Write and Edit, siblings and headers byte-identical')
const zipPath = join(fixtures, 'bundle.zip')
{
  _resetSeenLinesForTesting()
  const extra = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x03, 0x01, 0x02, 0x03, 0x04])
  writeFileSync(
    zipPath,
    buildZip(
      [
        { name: 'README.txt', content: 'line one\nline two\nline three\n', extra, comment: Buffer.from('readme note') },
        { name: 'config/app.json', content: '{\n  "port": 3000\n}\n', extra, comment: Buffer.from('kept') },
        { name: 'stored.txt', content: 'stored as is\n', stored: true, extra },
      ],
      Buffer.from('archive comment stays'),
    ),
  )
  const before = bytesOf(zipPath)
  const ctx = makeContext()

  const unread = await write({ file_path: `${zipPath}:README.txt`, content: 'replaced without reading\n' }, ctx)
  check(
    'S1.1 overwriting an existing entry without a Read is refused by the read-before-overwrite law; the archive and the host folder are untouched',
    !unread.ok && /read/i.test(unread.message) && bytesOf(zipPath).equals(before) && !existsSync(`${zipPath}:README.txt`),
    words(unread),
  )

  const readme = await read({ file_path: `${zipPath}:README.txt` }, ctx)
  check(
    'S1.2 Read of the entry returns its text and records the read under the entry key (host:entry), never under the host path',
    readme.ok && readme.text.includes('line two') && ctx.readFileState.get(`${zipPath}:README.txt`)?.content === 'line one\nline two\nline three\n' && ctx.readFileState.get(zipPath) === undefined,
    `${words(readme)} keys=${[...ctx.readFileState.keys()].join(',')}`,
  )

  const written = await write({ file_path: `${zipPath}:README.txt`, content: 'line one\nline updated\nline three\n' }, ctx)
  const afterWrite = bytesOf(zipPath)
  const beforeList = listZip(before)
  const afterList = listZip(afterWrite)
  const sibling = (name: string) => ({ b: beforeList.records.find(r => r.name === name)!, a: afterList.records.find(r => r.name === name)! })
  const cfg = sibling('config/app.json')
  const sto = sibling('stored.txt')
  check(
    'S1.3 after the Read, Write replaces the entry; config/app.json and stored.txt keep their local headers, central records, extra fields and data byte for byte; the archive comment survives',
    written.ok &&
      zipText(afterWrite, 'README.txt') === 'line one\nline updated\nline three\n' &&
      cfg.a.local.equals(cfg.b.local) && cfg.a.central.equals(cfg.b.central) && cfg.a.data.equals(cfg.b.data) &&
      sto.a.local.equals(sto.b.local) && sto.a.central.equals(sto.b.central) && sto.a.data.equals(sto.b.data) &&
      afterList.comment === 'archive comment stays' &&
      afterList.records.find(r => r.name === 'README.txt')!.central.subarray(46 + 10, 46 + 10 + 11).toString() === 'readme note',
    words(written),
  )

  const edited = await edit({ file_path: `${zipPath}:README.txt`, old_string: 'line updated', new_string: 'line edited' }, ctx)
  check(
    'S1.4 Edit after the Write replaces the string inside the entry and the result shows the change',
    edited.ok && edited.text.includes('line edited') && zipText(bytesOf(zipPath), 'README.txt') === 'line one\nline edited\nline three\n',
    words(edited),
  )

  const ctx2 = makeContext()
  const reread = await read({ file_path: `${zipPath}:README.txt` }, ctx2)
  const editAgain = await edit({ file_path: `${zipPath}:README.txt`, old_string: 'line edited', new_string: 'line read-then-edited' }, ctx2)
  check(
    'S1.5 a fresh session reads the entry through Read and edits it with the bytes Read showed (one representation on both roads)',
    reread.ok && reread.text.includes('2\tline edited') && editAgain.ok && zipText(bytesOf(zipPath), 'README.txt') === 'line one\nline read-then-edited\nline three\n',
    `${words(reread)} / ${words(editAgain)}`,
  )

  const created = await write({ file_path: `${zipPath}:docs/NEW.txt`, content: 'brand new entry\n' }, ctx)
  check(
    'S1.6 Write creates a new entry without a prior Read; the three earlier entries stay',
    created.ok && zipText(bytesOf(zipPath), 'docs/NEW.txt') === 'brand new entry\n' && listZip(bytesOf(zipPath)).records.map(r => r.name).join(',') === 'README.txt,config/app.json,stored.txt,docs/NEW.txt',
    words(created),
  )

  const same = await write({ file_path: `${zipPath}:docs/NEW.txt`, content: 'brand new entry\n' }, ctx)
  check('S1.7 writing the exact bytes again settles as no-change', same.ok && /No changes were made/.test(same.text), words(same))

  const unzip = Bun.which('unzip')
  if (unzip !== null) {
    const test = Bun.spawnSync([unzip, '-tq', zipPath])
    check('S1.8 the system unzip verifies the rewritten archive', test.exitCode === 0, `${test.stdout.toString()}${test.stderr.toString()}`)
  }

  const fresh = makeContext()
  writeFileSync(join(fixtures, 'brand.zip:x'), '')
  const brandNew = await write({ file_path: `${join(fixtures, 'brand.zip')}:notes/first.txt`, content: 'first\n' }, fresh)
  check(
    'S1.9 Write to an entry of an archive that does not exist yet creates the archive with that one entry',
    brandNew.ok && existsSync(join(fixtures, 'brand.zip')) && zipText(bytesOf(join(fixtures, 'brand.zip')), 'notes/first.txt') === 'first\n',
    words(brandNew),
  )
}

section('S2. A SQLite row: Read, then Write and Edit, one JSON representation on both roads')
const dbPath = join(fixtures, 'app.sqlite')
{
  _resetSeenLinesForTesting()
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
    INSERT INTO users (id, name, role) VALUES (1, 'Ada', 'admin');
    CREATE TABLE logs (msg TEXT, level TEXT);
    INSERT INTO logs (msg, level) VALUES ('boot', 'info'), ('ready', 'info');
    CREATE TABLE comp (a TEXT, b TEXT, note TEXT, PRIMARY KEY (a, b));
    INSERT INTO comp (a, b, note) VALUES ('x', 'y', 'first');
    CREATE TABLE items (id INTEGER PRIMARY KEY, payload BLOB, big INTEGER, score REAL, maybe TEXT, word TEXT, note TEXT);
    INSERT INTO items (id, payload, big, score, maybe, word, note) VALUES (1, X'010203', 9007199254740993, 3.14159, NULL, 'null', 'keep');
    INSERT INTO items (id, payload, big, score, maybe, word, note) VALUES (9007199254740993, NULL, 9007199254740995, 1.5, 'null', NULL, 'line 1\n"quoted" line 2');
    CREATE VIEW admins AS SELECT * FROM users WHERE role = 'admin';
    CREATE VIRTUAL TABLE docs USING fts5(title, body);
    INSERT INTO docs (title, body) VALUES ('hello', 'world');
  `)
  db.close()
  const query = <T>(sql: string, ...params: unknown[]): T[] => {
    const d = new Database(dbPath, { readonly: true })
    try {
      return d.prepare(sql).all(...(params as never[])) as T[]
    } finally {
      d.close()
    }
  }
  const ctx = makeContext()

  const unread = await write({ file_path: `${dbPath}:users/1`, content: JSON.stringify({ id: 1, name: 'Ada Lovelace', role: 'owner' }) }, ctx)
  check(
    'S2.1 overwriting an existing row without a Read is refused; the row is untouched and no host file appeared',
    !unread.ok && /read/i.test(unread.message) && query<{ name: string }>('SELECT name FROM users WHERE id = 1')[0]?.name === 'Ada' && !existsSync(`${dbPath}:users/1`),
    words(unread),
  )

  const rowRead = await read({ file_path: `${dbPath}:users/1` }, ctx)
  const expectedRow = '{\n  "id": 1,\n  "name": "Ada",\n  "role": "admin"\n}\n'
  check(
    'S2.2 Read of users/1 renders the row as one JSON object and records it under the row key',
    rowRead.ok && rowRead.text.includes('"name": "Ada"') && ctx.readFileState.get(`${dbPath}:users/1`)?.content === expectedRow,
    `${words(rowRead)} keys=${[...ctx.readFileState.keys()].join(',')}`,
  )

  const edited = await edit({ file_path: `${dbPath}:users/1`, old_string: '"role": "admin"', new_string: '"role": "owner"' }, ctx)
  check(
    'S2.3 Edit on the row updates the one column through a parameterised UPDATE; the database agrees',
    edited.ok && edited.text.includes('"role": "owner"') && query<{ role: string }>('SELECT role FROM users WHERE id = 1')[0]?.role === 'owner',
    words(edited),
  )

  const ctx2 = makeContext()
  const reread = await read({ file_path: `${dbPath}:users/1` }, ctx2)
  check(
    'S2.4 Read after the Edit shows the same bytes the Edit wrote (the write road and the read road render one representation)',
    reread.ok && ctx2.readFileState.get(`${dbPath}:users/1`)?.content === '{\n  "id": 1,\n  "name": "Ada",\n  "role": "owner"\n}\n',
    words(reread),
  )

  const inserted = await write({ file_path: `${dbPath}:users/2`, content: JSON.stringify({ name: "Bob'); DROP TABLE users; --", role: 'member' }) }, ctx)
  const rows = query<{ id: number; name: string; role: string }>('SELECT id, name, role FROM users ORDER BY id')
  check(
    'S2.5 Write to a row that does not exist inserts it with the key from the selector; SQL metacharacters in values bind as text',
    inserted.ok && rows.length === 2 && rows[1]?.id === 2 && rows[1]?.name === "Bob'); DROP TABLE users; --" && rows[1]?.role === 'member',
    `${words(inserted)} rows=${JSON.stringify(rows)}`,
  )

  const byColumn = await write({ file_path: `${dbPath}:users/name=Zed`, content: JSON.stringify({ role: 'guest' }) }, ctx)
  const zed = query<{ id: number; name: string; role: string }>("SELECT id, name, role FROM users WHERE name = 'Zed'")[0]
  check(
    'S2.5b a column=value selector that matches no row inserts one carrying that column; the key comes from the table and the result keeps the selector spelling',
    byColumn.ok && zed !== undefined && zed.id === 3 && zed.role === 'guest' && byColumn.text.includes(`${dbPath}:users/name=Zed`),
    `${words(byColumn)} row=${JSON.stringify(zed)}`,
  )
  const sameValues = await write({ file_path: `${dbPath}:users/2`, content: JSON.stringify({ id: 2, name: "Bob'); DROP TABLE users; --", role: 'member' }) }, ctx)
  check('S2.6 writing the values the row already holds settles as no-change', sameValues.ok && /No changes were made/.test(sameValues.text), words(sameValues))

  const keyOnly = await write({ file_path: `${dbPath}:users/2`, content: JSON.stringify({ id: 2 }) }, ctx)
  check(
    'S2.7 a write carrying only the key column is a no-op the result says so (nothing silently succeeds)',
    keyOnly.ok && /No changes were made/.test(keyOnly.text) && keyOnly.data.type === 'no-change',
    words(keyOnly),
  )

  const logRead = await read({ file_path: `${dbPath}:logs/2` }, ctx)
  const logEdit = await edit({ file_path: `${dbPath}:logs/2`, old_string: '"msg": "ready"', new_string: '"msg": "ready for work"' }, ctx)
  const logs = query<{ rowid: number; msg: string }>('SELECT rowid, msg FROM logs ORDER BY rowid')
  check(
    'S2.8 a table without a primary key is addressed by rowid on both roads: Read shows "rowid", Edit updates that row in place (no duplicate)',
    logRead.ok && logRead.text.includes('"rowid": 2') && logEdit.ok && logs.length === 2 && logs[1]?.msg === 'ready for work',
    `${words(logRead)} / ${words(logEdit)} / ${JSON.stringify(logs)}`,
  )

  const compBare = await read({ file_path: `${dbPath}:comp/x` }, ctx)
  const compRead = await read({ file_path: `${dbPath}:comp/a=x` }, ctx)
  const compEdit = await edit({ file_path: `${dbPath}:comp/a=x`, old_string: '"note": "first"', new_string: '"note": "second"' }, ctx)
  check(
    'S2.9 a composite primary key refuses the bare key form on Read with the column=value form named; column=value reads and edits the row',
    !compBare.ok && /composite primary key/.test(compBare.message) && compRead.ok && compEdit.ok && query<{ note: string }>("SELECT note FROM comp WHERE a = 'x'")[0]?.note === 'second',
    `${words(compBare)} / ${words(compRead)} / ${words(compEdit)}`,
  )

  const moveRead = await read({ file_path: `${dbPath}:users/2` }, ctx)
  const moved = await edit({ file_path: `${dbPath}:users/2`, old_string: '"id": 2', new_string: '"id": 5' }, ctx)
  const ids = query<{ id: number }>('SELECT id FROM users ORDER BY id').map(r => r.id)
  check(
    'S2.10 editing the key column moves the row and the result says where it now lives',
    moveRead.ok && moved.ok && ids.join(',') === '1,3,5' && moved.text.includes(`:users/id=5`),
    `${words(moved)} ids=${ids.join(',')}`,
  )

  const itemRead = await read({ file_path: `${dbPath}:items/1` }, ctx)
  const itemEdit = await edit({ file_path: `${dbPath}:items/1`, old_string: '"note": "keep"', new_string: '"note": "kept"' }, ctx)
  const item = query<{ payload: Uint8Array; big: bigint; note: string }>('SELECT payload, big, note FROM items WHERE id = 1')[0]
  check(
    'S2.11 a blob renders as a placeholder and a big integer as a string; editing another column leaves both bytes intact in the database',
    itemRead.ok && itemRead.text.includes('"payload": "<BLOB 3B>"') && itemRead.text.includes('"big": "9007199254740993"') && itemEdit.ok &&
      item !== undefined && Buffer.from(item.payload).equals(Buffer.from([1, 2, 3])) && item.note === 'kept' &&
      query<{ big: string }>('SELECT CAST(big AS TEXT) AS big FROM items WHERE id = 1')[0]?.big === '9007199254740993',
    `${words(itemRead)} / ${words(itemEdit)} / ${JSON.stringify(item, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`,
  )

  const bigEdit = await edit({ file_path: `${dbPath}:items/1`, old_string: '"big": "9007199254740993"', new_string: '"big": "9007199254740995"' }, ctx)
  const bigKeyRead = await read({ file_path: `${dbPath}:items/9007199254740993` }, ctx)
  const bigKeyEdit = await edit({
    file_path: `${dbPath}:items/9007199254740993`,
    old_string: '"big": "9007199254740995",\n  "score": 1.5,\n  "maybe": "null",\n  "word": null,\n  "note": "line 1\\n\\"quoted\\" line 2"',
    new_string: '"big": 9007199254740999,\n  "score": 2.71828,\n  "maybe": null,\n  "word": "null",\n  "note": "line A\\n\\"quoted\\" line B"',
  }, ctx)
  const bigKeyReread = await read({ file_path: `${dbPath}:items/9007199254740993` }, makeContext())
  const bigRows = query<{ id: string; big: string; t: string; score: number; maybe: string | null; word: string | null; note: string }>(
    'SELECT CAST(id AS TEXT) AS id, CAST(big AS TEXT) AS big, typeof(big) AS t, score, maybe, word, note FROM items ORDER BY id',
  )
  check(
    'S2.12 64-bit big integers in keys and values (quoted or unquoted), NULL vs "null", floats, and text with newlines and quotes round-trip without rounding on a STRICT table',
    bigEdit.ok && bigKeyRead.ok && bigKeyEdit.ok && bigKeyReread.ok &&
      bigRows[0]?.big === '9007199254740995' && bigRows[0]?.t === 'integer' &&
      bigRows[1]?.id === '9007199254740993' && bigRows[1]?.big === '9007199254740999' && bigRows[1]?.t === 'integer' &&
      bigRows[1]?.score === 2.71828 && bigRows[1]?.maybe === null && bigRows[1]?.word === 'null' &&
      bigRows[1]?.note === 'line A\n"quoted" line B' &&
      bigKeyReread.text.includes('"big": "9007199254740999"') &&
      bigKeyReread.text.includes('"maybe": null') &&
      bigKeyReread.text.includes('"word": "null"') &&
      bigKeyReread.text.includes('"note": "line A\\n\\"quoted\\" line B"'),
    `${words(bigEdit)} / ${words(bigKeyEdit)} / rows=${JSON.stringify(bigRows)}`,
  )
}

section('refusals. Every way to abuse or break the row, driven and refused')
{
  _resetSeenLinesForTesting()
  const hostBytes = bytesOf(zipPath)
  const folderBefore = readdirSync(fixtures).sort().join(',')
  const escapes: Array<[string, RegExp]> = [
    [`${zipPath}:../escaped.txt`, /climbs out of the archive/],
    [`${zipPath}:a/../escaped.txt`, /climbs out of the archive/],
    [`${zipPath}:%2e%2e/escaped.txt`, /climbs out of the archive/],
    [`${zipPath}:a/%2E%2E/b.txt`, /climbs out of the archive/],
    [`${zipPath}:%2e%2e%2fescaped.txt`, /climbs out of the archive/],
    [`${zipPath}:/etc/passwd`, /absolute/],
    [`${zipPath}:C:/evil.txt`, /drive letter/],
    [`${zipPath}:dir\\evil.txt`, /backslash/],
    [`${zipPath}:a/./b.txt`, /empty or "\." segment/],
    [`${zipPath}:dir/`, /names a directory/],
    [`${zipPath}:`, /no entry or row inside it/],
    [`${zipPath}!../escaped.txt`, /climbs out of the archive/],
    [`${zipPath}::../escaped.txt`, /climbs out of the archive/],
    [`${zipPath}!//etc/passwd`, /absolute/],
  ]
  for (const [idx, [target, reason]] of escapes.entries()) {
    const ctx = makeContext()
    const w = await write({ file_path: target, content: 'x\n' }, ctx)
    const e = await edit({ file_path: target, old_string: 'a', new_string: 'b' }, ctx)
    check(
      `R1.${idx + 1} "${target.slice(fixtures.length + 1)}": Write and Edit refuse with the reason; nothing is written on the host`,
      !w.ok && reason.test(w.message) && !e.ok && reason.test(e.message) && bytesOf(zipPath).equals(hostBytes) && readdirSync(fixtures).sort().join(',') === folderBefore,
      `${words(w)} / ${words(e)}`,
    )
  }
  {
    const ctx = makeContext()
    const nul = await write({ file_path: `${zipPath}:ok\u0000.txt`, content: 'x\n' }, ctx)
    check('R1.15 a NUL byte in the entry name is refused as a path', !nul.ok && /NUL|null byte|not allowed/i.test(nul.message), words(nul))
    const tar = await write({ file_path: `${join(fixtures, 'x.tar')}:a.txt`, content: 'x\n' }, ctx)
    check('R1.16 writing inside a .tar archive is refused by name, never a plain file named "x.tar:a.txt"', !tar.ok && /\.tar archive is not supported/.test(tar.message) && !existsSync(`${join(fixtures, 'x.tar')}:a.txt`), words(tar))
  }

  for (const mode of ['default', 'implement', 'sovereign'] as const) {
    const ctx = makeContext([], mode)
    const w = await write({ file_path: `${zipPath}:../escaped.txt`, content: 'x\n' }, ctx)
    const wp = await write({ file_path: `${zipPath}:%2e%2e/escaped.txt`, content: 'x\n' }, ctx)
    const ws = await write({ file_path: `${dbPath}:users/name='Ada'`, content: '{"role": "x"}' }, ctx)
    check(
      `R2 the escaping-name and SQL/quote-selector refusals hold in ${mode} mode (a ward in validateInput, never a host or DB write)`,
      !w.ok && /climbs out of the archive/.test(w.message) && !wp.ok && /climbs out of the archive/.test(wp.message) && !ws.ok && /never SQL/.test(ws.message) && !existsSync(join(fixtures, 'escaped.txt')),
      `${words(w)} / ${words(wp)} / ${words(ws)}`,
    )
  }

  const sqlSelectors: Array<[string, RegExp]> = [
    [`${dbPath}:users;DROP TABLE users/1`, /not a table name/],
    [`${dbPath}:users/id=1;DROP TABLE users`, /never SQL/],
    [`${dbPath}:users/name='Ada'`, /never SQL/],
    [`${dbPath}:users/name="Ada"`, /never SQL/],
    [`${dbPath}:users/1' OR '1'='1`, /never SQL/],
    [`${dbPath}:users/1--comment`, /never SQL/],
    [`${dbPath}:users/na"me=1`, /not a column name/],
    [`${dbPath}:users/`, /row selector after "users\/" is empty/],
    [`${dbPath}:users`, /address one row/],
    [`${dbPath}:`, /no entry or row inside it/],
  ]
  for (const [idx, [target, reason]] of sqlSelectors.entries()) {
    const ctx = makeContext()
    const w = await write({ file_path: target, content: '{"name": "x", "role": "y"}' }, ctx)
    const e = await edit({ file_path: target, old_string: 'a', new_string: 'b' }, ctx)
    check(
      `R3.${idx + 1} selector "${target.slice(dbPath.length)}": Write and Edit refuse in validateInput with the reason; the table is intact`,
      !w.ok && reason.test(w.message) && !e.ok && reason.test(e.message) && new Database(dbPath, { readonly: true }).query('SELECT COUNT(*) AS c FROM users').get() !== null,
      `${words(w)} / ${words(e)}`,
    )
  }
  {
    const ctx = makeContext()
    const injected = await write({ file_path: `${dbPath}:users/1 OR 1=1`, content: '{"name": "x", "role": "y"}' }, ctx)
    const rows = new Database(dbPath, { readonly: true }).query('SELECT id, name FROM users ORDER BY id').all() as Array<{ id: number; name: string }>
    check(
      'R3.11 a selector value with SQL clauses ("1 OR 1=1") is refused in validateInput; every row is as it was',
      !injected.ok && /never SQL/.test(injected.message) && rows.map(r => `${r.id}:${r.name}`).join(',') === "1:Ada,3:Zed,5:Bob'); DROP TABLE users; --",
      `${words(injected)} rows=${JSON.stringify(rows)}`,
    )
    const noDb = await write({ file_path: `${join(fixtures, 'missing.sqlite')}:users/1`, content: '{"name": "x"}' }, ctx)
    check('R3.12 a row write never creates a database', !noDb.ok && /never creates a database/.test(noDb.message) && !existsSync(join(fixtures, 'missing.sqlite')), words(noDb))
    const view = await write({ file_path: `${dbPath}:admins/1`, content: '{"name": "x"}' }, ctx)
    let viewEditNoThrow = false
    try {
      const v = await (FileEditTool as { validateInput: Function }).validateInput({ file_path: `${dbPath}:admins/1`, old_string: 'a', new_string: 'b' }, ctx)
      viewEditNoThrow = v.result === false && /view/.test(String(v.message))
    } catch {}
    const viewEdit = await edit({ file_path: `${dbPath}:admins/1`, old_string: 'a', new_string: 'b' }, ctx)
    check('R3.13 a view has no writable rows on Write or Edit (and validateInput returns a refusal without throwing)', !view.ok && /view/.test(view.message) && !viewEdit.ok && /view/.test(viewEdit.message) && viewEditNoThrow, `${words(view)} / ${words(viewEdit)} noThrow=${viewEditNoThrow}`)
    const vtabWrite = await write({ file_path: `${dbPath}:docs/1`, content: '{"title": "x", "body": "y"}' }, ctx)
    const vtabEdit = await edit({ file_path: `${dbPath}:docs/1`, old_string: 'hello', new_string: 'bye' }, ctx)
    const vtabRead = await read({ file_path: `${dbPath}:docs/1` }, ctx)
    check(
      'R3.14 a virtual table (fts5) is refused on row Read, Write and Edit',
      !vtabWrite.ok && /virtual table/i.test(vtabWrite.message) &&
        !vtabEdit.ok && /virtual table/i.test(vtabEdit.message) &&
        !vtabRead.ok && /virtual table/i.test(vtabRead.message),
      `${words(vtabWrite)} / ${words(vtabEdit)} / ${words(vtabRead)}`,
    )
    await read({ file_path: `${dbPath}:items/1` }, ctx)
    const blobOverwrite = await edit({ file_path: `${dbPath}:items/1`, old_string: '"payload": "<BLOB 3B>"', new_string: '"payload": "plain"' }, ctx)
    const blobPlaceholderInsert = await write({
      file_path: `${dbPath}:items/2`,
      content: JSON.stringify({ payload: '<BLOB 3B>', big: 1, score: 1.0, maybe: null, word: 'ok', note: 'no' }),
    }, ctx)
    check(
      'R3.15 overwriting a blob column or writing the "<BLOB nB>" placeholder is refused',
      !blobOverwrite.ok && /binary data|BLOB/i.test(blobOverwrite.message) &&
        !blobPlaceholderInsert.ok && /binary data|BLOB/i.test(blobPlaceholderInsert.message),
      `${words(blobOverwrite)} / ${words(blobPlaceholderInsert)}`,
    )
  }

  {
    const ctx = makeContext()
    const huge = join(fixtures, 'huge.zip')
    const fd = openSync(huge, 'w')
    ftruncateSync(fd, 17 * 1024 * 1024)
    closeSync(fd)
    const overVal = await (FileWriteTool as { validateInput: Function }).validateInput({ file_path: `${huge}:a.txt`, content: 'x\n' }, ctx)
    const over = await write({ file_path: `${huge}:a.txt`, content: 'x\n' }, ctx)
    check('R4.1 an archive over the 16 MiB container ceiling is refused by stat in validateInput before it is read', overVal.result === false && !over.ok && /exceeds the maximum allowed container size/.test(over.message) && statSync(huge).size === 17 * 1024 * 1024, `${JSON.stringify(overVal)} / ${words(over)}`)

    const bombPayload = Buffer.alloc(5 * 1024 * 1024, 0x41)
    const claimed = join(fixtures, 'claimed-bomb.zip')
    writeFileSync(claimed, buildZip([{ name: 'bomb.txt', content: bombPayload }]))
    const claimedRes = await write({ file_path: `${claimed}:bomb.txt`, content: 'x\n' }, ctx)
    check('R4.2 an entry whose header claims more than 4 MiB is refused before inflating', !claimedRes.ok && /exceeds the maximum allowed entry size/.test(claimedRes.message), words(claimedRes))

    const spoofed = join(fixtures, 'spoofed-bomb.zip')
    writeFileSync(spoofed, buildZip([{ name: 'bomb.txt', content: bombPayload, claimedSize: 128 }]))
    const spoofedBytes = bytesOf(spoofed)
    const spoofedRes = await write({ file_path: `${spoofed}:bomb.txt`, content: 'x\n' }, ctx)
    check('R4.3 an entry with a spoofed small header that inflates past 4 MiB is refused by the inflation ceiling; the archive is untouched', !spoofedRes.ok && /inflated past the maximum allowed entry size/.test(spoofedRes.message) && bytesOf(spoofed).equals(spoofedBytes), words(spoofedRes))

    const big = await write({ file_path: `${zipPath}:big.txt`, content: 'y'.repeat(4 * 1024 * 1024 + 1) }, ctx)
    check('R4.4 content over the 4 MiB entry ceiling is refused', !big.ok && /exceeds the maximum allowed entry size/.test(big.message), words(big))

    const corrupt = join(fixtures, 'corrupt.zip')
    writeFileSync(corrupt, Buffer.from('this is not a zip file at all'))
    const corruptRes = await write({ file_path: `${corrupt}:a.txt`, content: 'x\n' }, ctx)
    check('R4.5 a malformed archive answers a reason, never a confident rewrite', !corruptRes.ok && /no zip central directory|Invalid or corrupt zip/.test(corruptRes.message) && readFileSync(corrupt, 'utf8') === 'this is not a zip file at all', words(corruptRes))

    const binZip = join(fixtures, 'bin.zip')
    writeFileSync(binZip, buildZip([{ name: 'image.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]) }, { name: 'raw.txt', content: Buffer.from([0, 1, 2, 3]) }]))
    const binBytes = bytesOf(binZip)
    const png = await write({ file_path: `${binZip}:image.png`, content: 'text\n' }, ctx)
    const raw = await write({ file_path: `${binZip}:raw.txt`, content: 'text\n' }, ctx)
    check('R4.6 a binary entry (by extension or by its bytes) is never overwritten through the text road', !png.ok && /binary file/.test(png.message) && !raw.ok && /binary content/.test(raw.message) && bytesOf(binZip).equals(binBytes), `${words(png)} / ${words(raw)}`)

    const z64Zip = join(fixtures, 'z64.zip')
    const z64Buf = buildZip([{ name: 'a.txt', content: 'hi\n' }])
    z64Buf.writeUInt16LE(0xffff, z64Buf.length - 12)
    writeFileSync(z64Zip, z64Buf)
    const diskZip = join(fixtures, 'disk.zip')
    writeFileSync(diskZip, buildZip([{ name: 'a.txt', content: 'hi\n', disk: 1 }]))
    const dupZip = join(fixtures, 'dup-names.zip')
    writeFileSync(dupZip, buildZip([{ name: 'dup.txt', content: 'one\n' }, { name: 'dup.txt', content: 'two\n' }]))
    const encZip = join(fixtures, 'enc.zip')
    writeFileSync(encZip, buildZip([{ name: 'secret.txt', content: 'cipher\n', flags: 0x0801 }]))
    const z64Res = await write({ file_path: `${z64Zip}:a.txt`, content: 'x\n' }, ctx)
    const diskRes = await write({ file_path: `${diskZip}:a.txt`, content: 'x\n' }, ctx)
    const dupDirect = await write({ file_path: `${dupZip}:dup.txt`, content: 'x\n' }, ctx)
    const dupSibling = await write({ file_path: `${dupZip}:other.txt`, content: 'x\n' }, ctx)
    const encRes = await write({ file_path: `${encZip}:secret.txt`, content: 'x\n' }, ctx)
    check(
      'R4.7 Zip64, multi-disk, duplicate-entry (on the entry or a sibling) and encrypted archives are refused with reasons',
      !z64Res.ok && /Zip64/i.test(z64Res.message) &&
        !diskRes.ok && /more than one disk/i.test(diskRes.message) &&
        !dupDirect.ok && /appears/i.test(dupDirect.message) &&
        !dupSibling.ok && /appears/i.test(dupSibling.message) &&
        !encRes.ok && /encrypted/i.test(encRes.message),
      `${words(z64Res)} / ${words(diskRes)} / ${words(dupDirect)} / ${words(dupSibling)} / ${words(encRes)}`,
    )

    const symZip = join(fixtures, 'sym.zip')
    const symMode = (0o120777 << 16) >>> 0
    writeFileSync(symZip, buildZip([{ name: 'link.txt', content: '../outside.txt', stored: true, externalAttrs: symMode }, { name: 'symdir', content: '/etc', stored: true, externalAttrs: symMode }]))
    const symBytes = bytesOf(symZip)
    const symWrite = await write({ file_path: `${symZip}:link.txt`, content: 'overwritten\n' }, ctx)
    const symEdit = await edit({ file_path: `${symZip}:link.txt`, old_string: 'outside', new_string: 'inside' }, ctx)
    const symChildWrite = await write({ file_path: `${symZip}:symdir/child.txt`, content: 'through symlink\n' }, ctx)
    check(
      'R4.8 a symlink entry (direct or an ancestor segment) inside a zip archive is never written through or overwritten',
      !symWrite.ok && /symbolic link|symlink/i.test(symWrite.message) &&
        !symEdit.ok && /symbolic link|symlink/i.test(symEdit.message) &&
        !symChildWrite.ok && /symbolic link|symlink/i.test(symChildWrite.message) &&
        bytesOf(symZip).equals(symBytes),
      `${words(symWrite)} / ${words(symEdit)} / ${words(symChildWrite)}`,
    )
  }

  {
    const ctx = makeContext()
    const a = await write({ file_path: `${zipPath}:docs/another.txt`, content: 'another\n' }, ctx)
    const sibling = await write({ file_path: `${zipPath}:config/app.json`, content: '{}\n' }, ctx)
    const siblingEdit = await edit({ file_path: `${zipPath}:config/app.json`, old_string: '3000', new_string: '4000' }, ctx)
    check(
      'R5.1 writing one entry unlocks nothing else: an unread sibling entry still refuses Write and Edit',
      a.ok && !sibling.ok && /read/i.test(sibling.message) && !siblingEdit.ok && /Read the file before editing/.test(siblingEdit.message) && zipText(bytesOf(zipPath), 'config/app.json') === '{\n  "port": 3000\n}\n',
      `${words(sibling)} / ${words(siblingEdit)}`,
    )
    const insert = await write({ file_path: `${dbPath}:users/7`, content: '{"name": "Grace", "role": "member"}' }, ctx)
    const row1 = await write({ file_path: `${dbPath}:users/1`, content: '{"name": "Nobody", "role": "none"}' }, ctx)
    const row1Edit = await edit({ file_path: `${dbPath}:users/1`, old_string: '"role": "owner"', new_string: '"role": "none"' }, ctx)
    const ada = new Database(dbPath, { readonly: true }).query('SELECT name, role FROM users WHERE id = 1').get() as { name: string; role: string }
    check(
      'R5.2 inserting one row unlocks nothing else: an unread sibling row still refuses Write and Edit',
      insert.ok && !row1.ok && /read/i.test(row1.message) && !row1Edit.ok && /Read the file before editing/.test(row1Edit.message) && ada.name === 'Ada' && ada.role === 'owner',
      `${words(row1)} / ${words(row1Edit)}`,
    )
    const hostEvidence = makeContext()
    hostEvidence.readFileState.set(zipPath, { content: 'whatever', timestamp: Date.now() + 1000 })
    const viaHost = await write({ file_path: `${zipPath}:config/app.json`, content: '{}\n' }, hostEvidence)
    check('R5.3 read evidence recorded against the host archive path unlocks no entry', !viaHost.ok && /read/i.test(viaHost.message), words(viaHost))
    const tableCtx = makeContext()
    const overview = await read({ file_path: dbPath }, tableCtx)
    const wholeTable = await read({ file_path: `${dbPath}:users` }, tableCtx)
    const rowWriteAfterTable = await write({ file_path: `${dbPath}:users/1`, content: '{"name": "Nobody", "role": "none"}' }, tableCtx)
    const rowEditAfterTable = await edit({ file_path: `${dbPath}:users/1`, old_string: '"role": "owner"', new_string: '"role": "none"' }, tableCtx)
    check(
      'R5.4 reading the database overview or the whole table never unlocks Write or Edit on one row',
      overview.ok && wholeTable.ok && !rowWriteAfterTable.ok && /read/i.test(rowWriteAfterTable.message) && !rowEditAfterTable.ok && /Read the file before editing/.test(rowEditAfterTable.message),
      `${words(rowWriteAfterTable)} / ${words(rowEditAfterTable)}`,
    )
  }

  {
    const ctx = makeContext()
    writeFileSync(zipPath, buildZip([{ name: 'dup.txt', content: 'same\nsame\nother\n' }, { name: 'blank.txt', content: '  \n' }, { name: 'config/app.json', content: '{\n  "port": 3000\n}\n' }]))
    const plainPath = join(fixtures, 'dup.txt')
    writeFileSync(plainPath, 'same\nsame\nother\n')
    await read({ file_path: `${zipPath}:dup.txt` }, ctx)
    await read({ file_path: plainPath }, ctx)
    const inZip = await edit({ file_path: `${zipPath}:dup.txt`, old_string: 'same', new_string: 'different' }, ctx)
    const inPlain = await edit({ file_path: plainPath, old_string: 'same', new_string: 'different' }, ctx)
    const lead = (m: string) => m.split('\n')[0]!.replace(/ in [^ ]+/, ' in <path>')
    check(
      'R6 a non-unique old_string is refused inside the archive with the same sentence the plain road speaks; the entry is untouched',
      !inZip.ok && !inPlain.ok && /2 (?:matches|occurrences)|matches at|not unique|more than once/i.test(inZip.message) && lead(inZip.message) === lead(inPlain.message) && zipText(bytesOf(zipPath), 'dup.txt') === 'same\nsame\nother\n',
      `${words(inZip)}\n---\n${words(inPlain)}`,
    )
    const before = bytesOf(zipPath)
    const modes: Array<[string, Record<string, unknown>]> = [
      ['hunks', { hunks: [{ lines: '1', replace: 'gone' }] }],
      ['append', { append: 'more\n' }],
      ['section', { section: '## Head', new_string: 'x' }],
    ]
    for (const [name, extra] of modes) {
      const refused = await edit({ file_path: `${zipPath}:dup.txt`, ...extra }, ctx)
      check(
        `R7 Edit mode "${name}" is refused by name on a zip entry and the entry keeps its bytes`,
        !refused.ok && (structured === null || refused.message === structured.STRUCTURED_EDIT_MODES_NOTE) && bytesOf(zipPath).equals(before) && zipText(bytesOf(zipPath), 'dup.txt') === 'same\nsame\nother\n',
        words(refused),
      )
    }
    const emptyOld = await edit({ file_path: `${zipPath}:dup.txt`, old_string: '', new_string: '' }, ctx)
    const emptyOldBlank = await edit({ file_path: `${zipPath}:blank.txt`, old_string: '', new_string: '' }, ctx)
    const emptyOldRow = await edit({ file_path: `${dbPath}:users/1`, old_string: '', new_string: '' }, ctx)
    check(
      'R7.4 an empty old_string on an existing entry (including whitespace-only) or row refuses and never wipes it',
      !emptyOld.ok && /already exists/.test(emptyOld.message) &&
        !emptyOldBlank.ok && /already exists/.test(emptyOldBlank.message) &&
        !emptyOldRow.ok && /already exists/.test(emptyOldRow.message) &&
        zipText(bytesOf(zipPath), 'dup.txt') === 'same\nsame\nother\n' &&
        zipText(bytesOf(zipPath), 'blank.txt') === '  \n',
      `${words(emptyOld)} / ${words(emptyOldBlank)} / ${words(emptyOldRow)}`,
    )
  }

  {
    const walDir = join(fixtures, 'wal')
    mkdirSync(walDir)
    const walPath = join(walDir, 'wal.sqlite')
    const seed = new Database(walPath)
    seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (id, body) VALUES (1, 'in the main file');")
    seed.close()
    const holder = new Database(walPath)
    holder.exec("INSERT INTO notes (id, body) VALUES (2, 'lives in the wal')")
    const filesBefore = readdirSync(walDir).sort().join(',')
    const ctx = makeContext()
    const walWrite = await write({ file_path: `${walPath}:notes/3`, content: '{"body": "written through sqlite"}' }, ctx)
    const walRead2 = await read({ file_path: `${walPath}:notes/2` }, ctx)
    const walEdit2 = await edit({ file_path: `${walPath}:notes/2`, old_string: '"body": "lives in the wal"', new_string: '"body": "edited in the wal"' }, ctx)
    const walRead1 = await read({ file_path: `${walPath}:notes/1` }, ctx)
    holder.exec("UPDATE notes SET body = 'updated in wal by holder' WHERE id = 1")
    const walStaleWrite = await write({ file_path: `${walPath}:notes/1`, content: '{"body": "clobber"}' }, ctx)
    const walStaleEdit = await edit({ file_path: `${walPath}:notes/1`, old_string: '"id": 1', new_string: '"id": 1,\n  "body": "clobber"' }, ctx)
    const integrity = holder.query('PRAGMA integrity_check').get() as { integrity_check: string }
    const bodies = (holder.query('SELECT id, body FROM notes ORDER BY id').all() as Array<{ id: number; body: string }>).map(r => `${r.id}:${r.body}`).join(',')
    holder.close()
    check(
      'R8.1 a database in WAL mode with a live -wal beside it is read and written through SQLite\'s own API: Read sees wal-resident rows, stale rows changed in the WAL refuse, integrity ok',
      walWrite.ok && walRead2.ok && walEdit2.ok && walRead1.ok &&
        !walStaleWrite.ok && /changed on disk after your last read/.test(walStaleWrite.message) &&
        !walStaleEdit.ok && /changed on disk after your last read/.test(walStaleEdit.message) &&
        filesBefore.includes('wal.sqlite-wal') && integrity.integrity_check === 'ok' &&
        bodies === '1:updated in wal by holder,2:edited in the wal,3:written through sqlite',
      `${words(walWrite)} / ${words(walRead2)} / ${words(walEdit2)} / ${words(walStaleWrite)} / ${words(walStaleEdit)} rows=${bodies}`,
    )
    await read({ file_path: `${dbPath}:users/1` }, ctx)
    const locker = new Database(dbPath)
    locker.exec('BEGIN IMMEDIATE')
    const locked = await write({ file_path: `${dbPath}:users/8`, content: '{"name": "Late", "role": "member"}' }, ctx)
    const lockedEdit = await edit({ file_path: `${dbPath}:users/1`, old_string: '"role": "owner"', new_string: '"role": "locked"' }, ctx)
    locker.exec('ROLLBACK')
    const count = (locker.query('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
    const lockedIntegrity = (locker.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
    locker.close()
    check(
      'R8.2 a database another connection holds locked refuses both Write and Edit with the reason; nothing is written and the file is intact',
      !locked.ok && /locked/i.test(locked.message) && !lockedEdit.ok && /locked/i.test(lockedEdit.message) && count === 4 && lockedIntegrity === 'ok',
      `${words(locked)} / ${words(lockedEdit)} count=${count}`,
    )
  }

  {
    const sealedDir = join(fixtures, 'sealed')
    mkdirSync(sealedDir)
    const sealedZip = join(sealedDir, 'sealed.zip')
    writeFileSync(sealedZip, buildZip([{ name: 'a.txt', content: 'alpha\n' }]))
    const before = bytesOf(sealedZip)
    const ctx = makeContext()
    await read({ file_path: `${sealedZip}:a.txt` }, ctx)
    chmodSync(sealedDir, 0o555)
    let failed: Verdict
    try {
      failed = await write({ file_path: `${sealedZip}:a.txt`, content: 'beta\n' }, ctx)
    } finally {
      chmodSync(sealedDir, 0o755)
    }
    let renameFailedOk = true
    const chflags = Bun.which('chflags')
    if (chflags !== null) {
      const lock = Bun.spawnSync([chflags, 'uchg', sealedZip])
      if (lock.exitCode === 0) {
        try {
          const mid = await write({ file_path: `${sealedZip}:a.txt`, content: 'gamma\n' }, ctx)
          renameFailedOk = !mid.ok && bytesOf(sealedZip).equals(before) && readdirSync(sealedDir).join(',') === 'sealed.zip'
        } finally {
          Bun.spawnSync([chflags, 'nouchg', sealedZip])
        }
      }
    }
    check(
      'R9 a rewrite that cannot complete (in an unwritable folder or on a failed rename mid-rewrite) leaves the original archive byte-identical and no temporary file behind',
      !failed.ok && renameFailedOk && bytesOf(sealedZip).equals(before) && readdirSync(sealedDir).join(',') === 'sealed.zip',
      `${words(failed)} renameFailedOk=${renameFailedOk} files=${readdirSync(sealedDir).join(',')}`,
    )
  }

  {
    const rules: Array<[string, string, 'zip' | 'db' | 'both']> = [
      [`Edit(/${zipPath})`, 'the archive path', 'zip'],
      [`Edit(/${fixtures}/**)`, 'the folder', 'both'],
      [`Edit(/${fixtures}/*.sqlite)`, 'the extension', 'db'],
    ]
    const usersBefore = (new Database(dbPath, { readonly: true }).query('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
    for (const [rule, what, covers] of rules) {
      for (const mode of ['default', 'sovereign'] as const) {
        const ctx = makeContext([rule], mode)
        const denied = (v: Verdict) => !v.ok && /deny|rule/i.test(v.message)
        const zipOk =
          covers === 'db' ||
          (denied(await write({ file_path: `${zipPath}:docs/denied.txt`, content: 'no\n' }, ctx)) &&
            denied(await edit({ file_path: `${zipPath}:dup.txt`, old_string: 'other', new_string: 'changed' }, ctx)) &&
            zipText(bytesOf(zipPath), 'docs/denied.txt') === null)
        const dbOk =
          covers === 'zip' ||
          (denied(await write({ file_path: `${dbPath}:users/9`, content: '{"name": "x", "role": "y"}' }, ctx)) &&
            denied(await edit({ file_path: `${dbPath}:users/1`, old_string: '"role": "owner"', new_string: '"role": "none"' }, ctx)) &&
            (new Database(dbPath, { readonly: true }).query('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c === usersBefore)
        check(`R10 a deny rule on ${what} (${rule.replace(fixtures, '<fixtures>')}) refuses the inner Write and Edit in ${mode} mode`, zipOk && dbOk, `${rule} ${mode}`)
      }
    }
  }

  {
    const ctx = makeContext()
    writeFileSync(zipPath, buildZip([{ name: 'stale.txt', content: 'keep\nv1\n' }]))
    const st0 = statSync(zipPath)
    await read({ file_path: `${zipPath}:stale.txt` }, ctx)
    writeFileSync(zipPath, buildZip([{ name: 'stale.txt', content: 'keep\nv2 from elsewhere\n' }]))
    utimesSync(zipPath, st0.atime, st0.mtime)
    const stale = await write({ file_path: `${zipPath}:stale.txt`, content: 'v3\n' }, ctx)
    const staleEdit = await edit({ file_path: `${zipPath}:stale.txt`, old_string: 'keep', new_string: 'clobbered' }, ctx)
    await read({ file_path: `${zipPath}:stale.txt` }, ctx)
    const staleAnchor = await edit({ file_path: `${zipPath}:stale.txt`, old_string: 'keep', new_string: 'clobbered', expected_anchor: 'fa:000000000000' }, ctx)
    check(
      'R11 an entry changed since the Read (even within the same mtime tick) or given a stale expected_anchor refuses Write and Edit as modified-since-read',
      !stale.ok && /changed on disk after your last read/.test(stale.message) &&
        !staleEdit.ok && /changed on disk after your last read/.test(staleEdit.message) &&
        !staleAnchor.ok && /changed on disk after your last read/.test(staleAnchor.message) &&
        zipText(bytesOf(zipPath), 'stale.txt') === 'keep\nv2 from elsewhere\n',
      `${words(stale)} / ${words(staleEdit)} / ${words(staleAnchor)}`,
    )
  }

  {
    const ctx = makeContext()
    const noRow = await read({ file_path: `${dbPath}:users/404` }, ctx)
    const noTable = await read({ file_path: `${dbPath}:ghosts/1` }, ctx)
    const viewRow = await read({ file_path: `${dbPath}:admins/1` }, ctx)
    const badCol = await read({ file_path: `${dbPath}:users/nope=1` }, ctx)
    const table = await read({ file_path: `${dbPath}:users` }, ctx)
    check(
      'R12 the Read side refuses a missing row, a missing table, a view row and an unknown column with reasons, and the table render keeps its shape',
      !noRow.ok && /No row of table "users" has id = 404/.test(noRow.message) &&
        !noTable.ok && /not found/.test(noTable.message) &&
        !viewRow.ok && /view/.test(viewRow.message) &&
        !badCol.ok && /no column "nope"/.test(badCol.message) &&
        table.ok && /\(database: sqlite · table: users · rows: \d+\)/.test(table.text) && table.text.includes('id\tname\trole') && ctx.readFileState.get(`${dbPath}:users`) === undefined,
      `${words(noRow)} / ${words(noTable)} / ${words(viewRow)} / ${words(badCol)} / ${words(table)}`,
    )
  }

  {
    const ladder = async (tool: unknown, filePath: string, ctx: Ctx): Promise<{ behavior: string; message: string }> => {
      const d = await (tool as { checkPermissions: Function }).checkPermissions({ file_path: filePath, content: 'x', old_string: 'a', new_string: 'b' }, ctx)
      return { behavior: String(d.behavior), message: String(d.message ?? '') }
    }
    const outside = join(fixtures, 'ladder.zip')
    for (const [mode, rules, expected] of [
      ['default', [], 'ask'],
      ['implement', [], 'ask'],
      ['default', [`Edit(/${fixtures}/**)`], 'deny'],
      ['sovereign', [`Edit(/${fixtures}/**)`], 'deny'],
    ] as Array<['default' | 'implement' | 'sovereign', string[], string]>) {
      const ctx = makeContext(rules, mode)
      const entry = await ladder(FileWriteTool, `${outside}:notes/x.txt`, ctx)
      const row = await ladder(FileEditTool, `${dbPath}:users/1`, ctx)
      const host = await ladder(FileWriteTool, outside, ctx)
      const dbHost = await ladder(FileEditTool, dbPath, ctx)
      check(
        `R13 the permission ladder judges a ${expected === 'deny' ? 'denied' : 'new, out-of-project'} entry or row by its HOST path in ${mode} mode: the same ${expected} the host archive or database itself gets, naming the host`,
        entry.behavior === expected && row.behavior === expected && entry.message === host.message && row.message === dbHost.message && entry.message.includes(outside) && !entry.message.includes('notes/x.txt'),
        `${JSON.stringify(entry)} vs host ${JSON.stringify(host)}; ${JSON.stringify(row)} vs ${JSON.stringify(dbHost)}`,
      )
    }
  }
}

section('S3. The host archive keeps its mode and its symlink; a partial Read covers an edit at the entry\'s final newline; a quoted SQLite identifier binds')
{
  _resetSeenLinesForTesting()
  const { lstatSync: lstat, symlinkSync } = await import('node:fs')
  if (process.platform !== 'win32') {
    const strict = join(fixtures, 'strict.zip')
    writeFileSync(strict, buildZip([{ name: 'secret.txt', content: 'top\n' }]))
    chmodSync(strict, 0o600)
    const ctx = makeContext()
    await read({ file_path: `${strict}:secret.txt` }, ctx)
    const rewritten = await write({ file_path: `${strict}:secret.txt`, content: 'top secret\n' }, ctx)
    check(
      'S3.1 rewriting an entry of a 0600 archive keeps the archive 0600 (the temp file takes the archive\'s mode before the rename)',
      rewritten.ok && (statSync(strict).mode & 0o777) === 0o600 && zipText(bytesOf(strict), 'secret.txt') === 'top secret\n',
      `${words(rewritten)} mode=${(statSync(strict).mode & 0o777).toString(8)}`,
    )

    const real = join(fixtures, 'real.zip')
    const link = join(fixtures, 'link.zip')
    writeFileSync(real, buildZip([{ name: 'a.txt', content: 'one\n' }]))
    symlinkSync(real, link)
    const ctx2 = makeContext()
    await read({ file_path: `${link}:a.txt` }, ctx2)
    const throughLink = await write({ file_path: `${link}:a.txt`, content: 'two\n' }, ctx2)
    check(
      'S3.2 writing an entry through a symlinked archive writes THROUGH the link: the link stays a link and the real archive carries the entry',
      throughLink.ok && lstat(link).isSymbolicLink() && zipText(bytesOf(real), 'a.txt') === 'two\n',
      `${words(throughLink)} link=${lstat(link).isSymbolicLink()} real=${JSON.stringify(zipText(bytesOf(real), 'a.txt'))}`,
    )
  }

  const tenZip = join(fixtures, 'ten.zip')
  const tenLines = Array.from({ length: 10 }, (_, i) => `v${i + 1}\n`).join('')
  writeFileSync(tenZip, buildZip([{ name: 'ten.txt', content: tenLines }]))
  const ctx3 = makeContext()
  const window = await read({ file_path: `${tenZip}:ten.txt`, offset: 8, limit: 3 }, ctx3)
  const lastLine = await edit({ file_path: `${tenZip}:ten.txt`, old_string: 'v10\n', new_string: 'v10 — last\n' }, ctx3)
  check(
    'S3.3 after Read(offset 8, limit 3) of a 10-line entry, an Edit whose old_string ends at the final newline touches lines 8–10 only and lands (no phantom line 11)',
    window.ok && lastLine.ok && zipText(bytesOf(tenZip), 'ten.txt') === `${tenLines.slice(0, -'v10\n'.length)}v10 — last\n`,
    `${words(window)} / ${words(lastLine)}`,
  )

  const quotedDb = join(fixtures, 'quoted.sqlite')
  {
    const db = new Database(quotedDb)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, "we""ird" TEXT); INSERT INTO t (id, "we""ird") VALUES (1, \'a\');')
    db.close()
  }
  const ctx4 = makeContext()
  const inserted = await write({ file_path: `${quotedDb}:t/2`, content: JSON.stringify({ 'we"ird': 'b' }) }, ctx4)
  const rowRead = await read({ file_path: `${quotedDb}:t/1` }, ctx4)
  const updated = await edit({ file_path: `${quotedDb}:t/1`, old_string: '"we\\"ird": "a"', new_string: '"we\\"ird": "c"' }, ctx4)
  const rows = ((): Array<Record<string, unknown>> => {
    const d = new Database(quotedDb, { readonly: true })
    try {
      return d.prepare('SELECT id, "we""ird" AS w FROM t ORDER BY id').all() as Array<Record<string, unknown>>
    } finally {
      d.close()
    }
  })()
  check(
    'S3.4 a column whose name holds a double quote is quoted with the quote doubled: the INSERT and the UPDATE both land',
    inserted.ok && rowRead.ok && updated.ok && JSON.stringify(rows) === JSON.stringify([{ id: 1, w: 'c' }, { id: 2, w: 'b' }]),
    `${words(inserted)} / ${words(rowRead)} / ${words(updated)} rows=${JSON.stringify(rows)}`,
  )
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
