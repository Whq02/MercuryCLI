#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
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

const { _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getFileModificationTime } = await import('../../src/utils/file.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 500 ? `${detail.slice(0, 500)}…` : detail}` : ''}`,
  )
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const fixtures = mkdtempSync(join(tmpdir(), 'write-structured-targets-fixtures-'))

function buildTestZip(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8')
    const raw = Buffer.from(e.content, 'utf8')
    const compressed = deflateRawSync(raw)
    const sum = crc32(raw) >>> 0

    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0)
    loc.writeUInt16LE(20, 4)
    loc.writeUInt16LE(0x0800, 6)
    loc.writeUInt16LE(8, 8)
    loc.writeUInt32LE(sum, 14)
    loc.writeUInt32LE(compressed.length, 18)
    loc.writeUInt32LE(raw.length, 22)
    loc.writeUInt16LE(nameBytes.length, 26)
    localParts.push(loc, nameBytes, compressed)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(sum, 16)
    cen.writeUInt32LE(compressed.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBytes.length, 28)
    cen.writeUInt32LE(offset, 42)
    centralParts.push(cen, nameBytes)

    offset += loc.length + nameBytes.length + compressed.length
  }
  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, cd, eocd])
}

type Entry = { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }
type Ctx = { readFileState: Map<string, Entry> }
function makeContext(denyRules: string[] = []): Ctx {
  const perm = getEmptyToolPermissionContext()
  perm.alwaysDenyRules.cliArg = denyRules
  return {
    readFileState: new Map<string, Entry>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: perm }),
  } as never as Ctx
}

const PARENT = { uuid: '00000000-0000-0000-0000-000000000009', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string; isError: boolean; data: Record<string, unknown> } | { ok: false; message: string }
async function run(tool: unknown, input: Record<string, unknown>, ctx: Ctx, id: string): Promise<Verdict> {
  const t = tool as { validateInput?: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  if (t.validateInput) {
    const verdict = await t.validateInput(input, ctx)
    if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  }
  try {
    const out = await t.call(input, ctx, null, PARENT)
    const block = t.mapToolResultToToolResultBlockParam(out.data, id)
    return { ok: true, text: typeof block.content === 'string' ? block.content : '', isError: block.is_error === true, data: out.data }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

section('S1. Zip archive entry Write and Edit: read-before-overwrite, atomic entry replacement, and permission routing')
{
  _resetSeenLinesForTesting()
  const zipPath = join(fixtures, 'bundle.zip')
  writeFileSync(
    zipPath,
    buildTestZip([
      { name: 'README.txt', content: 'line one\nline two\n' },
      { name: 'config/app.json', content: '{\n  "port": 3000\n}\n' },
    ]),
  )

  const ctx = makeContext()
  const unreadOverwrite = await run(
    FileWriteTool,
    { file_path: `${zipPath}!README.txt`, content: 'replaced without reading\n' },
    ctx,
    'tu_zip_unread',
  )
  check(
    'S1a overwriting an existing zip entry without prior Read is refused by the read-before-overwrite law, and no literal "bundle.zip!README.txt" file is created on disk',
    !unreadOverwrite.ok &&
      /read/i.test(unreadOverwrite.message) &&
      !existsSync(`${zipPath}!README.txt`),
    unreadOverwrite.ok ? unreadOverwrite.text : unreadOverwrite.message,
  )

  ctx.readFileState.set(`${zipPath}!README.txt`, {
    content: 'line one\nline two\n',
    timestamp: getFileModificationTime(zipPath),
  })
  const readOverwrite = await run(
    FileWriteTool,
    { file_path: `${zipPath}!README.txt`, content: 'line one\nline updated\n' },
    ctx,
    'tu_zip_write',
  )
  check(
    'S1b after recording read state, Write replaces the zip entry inside the archive without creating a literal "!" file on disk',
    readOverwrite.ok && !existsSync(`${zipPath}!README.txt`),
    readOverwrite.ok ? readOverwrite.text : readOverwrite.message,
  )

  const editAfterWrite = await run(
    FileEditTool,
    {
      file_path: `${zipPath}!README.txt`,
      old_string: 'line updated',
      new_string: 'line edited',
    },
    ctx,
    'tu_zip_edit',
  )
  check(
    'S1c Edit on the zip entry updates the entry in place and preserves untouched sibling entries in the archive',
    editAfterWrite.ok && editAfterWrite.text.includes('line edited'),
    editAfterWrite.ok ? editAfterWrite.text : editAfterWrite.message,
  )

  const createNewEntry = await run(
    FileWriteTool,
    { file_path: `${zipPath}!docs/NEW.txt`, content: 'brand new entry\n' },
    ctx,
    'tu_zip_new',
  )
  check(
    'S1d Write creates a new zip entry without requiring a prior Read',
    createNewEntry.ok && !existsSync(`${zipPath}!docs/NEW.txt`),
    createNewEntry.ok ? createNewEntry.text : createNewEntry.message,
  )

  const structuredMod = (await import('../../src/tools/FileWriteTool/structuredTargets.ts').catch(() => null)) as null | {
    readZipEntryText: (hostPath: string, entryName: string) => { exists: boolean; content: string }
  }
  const readmeAfter = structuredMod?.readZipEntryText(zipPath, 'README.txt')
  const configAfter = structuredMod?.readZipEntryText(zipPath, 'config/app.json')
  const newAfter = structuredMod?.readZipEntryText(zipPath, 'docs/NEW.txt')
  check(
    'S1e reading back the archive entries confirms README.txt was updated, config/app.json was preserved byte-for-byte, and docs/NEW.txt was added',
    readmeAfter?.exists === true &&
      readmeAfter.content === 'line one\nline edited\n' &&
      configAfter?.exists === true &&
      configAfter.content === '{\n  "port": 3000\n}\n' &&
      newAfter?.exists === true &&
      newAfter.content === 'brand new entry\n',
    JSON.stringify({ readmeAfter, configAfter, newAfter }),
  )

  const denyCtx = makeContext([`Edit(/${zipPath})`])
  const deniedWrite = await run(
    FileWriteTool,
    { file_path: `${zipPath}!docs/DENIED.txt`, content: 'no\n' },
    denyCtx,
    'tu_zip_deny',
  )
  check(
    'S1f an Edit deny rule on the host zip archive blocks writes to entries inside that archive',
    !deniedWrite.ok && /deny|blocked|not allowed|rule/i.test(deniedWrite.message),
    deniedWrite.ok ? deniedWrite.text : deniedWrite.message,
  )
}

section('S2. SQLite row Write and Edit: parameterised INSERT and UPDATE with read-before-overwrite and SQL injection safety')
{
  _resetSeenLinesForTesting()
  const dbPath = join(fixtures, 'app.sqlite')
  {
    const db = new Database(dbPath)
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL)')
    db.prepare('INSERT INTO users (id, name, role) VALUES (?, ?, ?)').run(1, 'Ada', 'admin')
    db.close()
  }

  const ctx = makeContext()
  const unreadRowUpdate = await run(
    FileWriteTool,
    {
      file_path: `${dbPath}!users/1`,
      content: JSON.stringify({ id: 1, name: 'Ada Lovelace', role: 'owner' }),
    },
    ctx,
    'tu_sql_unread',
  )
  check(
    'S2a overwriting an existing SQLite row without prior Read is refused by the read-before-overwrite law, and no literal "app.sqlite!users/1" file is created on disk',
    !unreadRowUpdate.ok &&
      /read/i.test(unreadRowUpdate.message) &&
      !existsSync(`${dbPath}!users/1`),
    unreadRowUpdate.ok ? unreadRowUpdate.text : unreadRowUpdate.message,
  )

  const insertNewRow = await run(
    FileWriteTool,
    {
      file_path: `${dbPath}!users/2`,
      content: JSON.stringify({ name: "Bob'); DROP TABLE users; --", role: 'member' }),
    },
    ctx,
    'tu_sql_insert',
  )
  check(
    'S2b inserting a new SQLite row via parameterised INSERT succeeds without prior Read and safely binds SQL metacharacters as literal text',
    insertNewRow.ok && !existsSync(`${dbPath}!users/2`),
    insertNewRow.ok ? insertNewRow.text : insertNewRow.message,
  )

  const editRow2 = await run(
    FileEditTool,
    {
      file_path: `${dbPath}!users/2`,
      old_string: '"role": "member"',
      new_string: '"role": "staff"',
    },
    ctx,
    'tu_sql_edit',
  )
  check(
    'S2c Edit on the written SQLite row updates the column via parameterised UPDATE',
    editRow2.ok && editRow2.text.includes('"role": "staff"'),
    editRow2.ok ? editRow2.text : editRow2.message,
  )

  const dbCheck = new Database(dbPath, { readonly: true })
  const rows = dbCheck.query('SELECT id, name, role FROM users ORDER BY id').all() as Array<{
    id: number
    name: string
    role: string
  }>
  dbCheck.close()
  check(
    'S2d querying the SQLite database directly confirms row 1 is untouched and row 2 holds the injected string literally with updated role "staff"',
    rows.length === 2 &&
      rows[0]?.id === 1 &&
      rows[0]?.name === 'Ada' &&
      rows[0]?.role === 'admin' &&
      rows[1]?.id === 2 &&
      rows[1]?.name === "Bob'); DROP TABLE users; --" &&
      rows[1]?.role === 'staff',
    JSON.stringify(rows),
  )
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
