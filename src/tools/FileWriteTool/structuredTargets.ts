import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { crc32, deflateRawSync } from 'node:zlib'

import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { recordNoChangeOutcome, serializeIntentDigest } from '../../services/changeTransaction/repetitionPolicy.js'
import { checkAnchor, mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { runtimeKernel } from '../../services/primitives/runtimeKernel.js'
import { countLinesChanged, getPatchForDisplay, getPatchFromContents } from '../../utils/diff.js'
import { getFileModificationTime } from '../../utils/file.js'
import type { FileState } from '../../utils/fileStateCache.js'
import { formatFileSize } from '../../utils/format.js'
import { expandPath } from '../../utils/path.js'
import type { ToolUseContext } from '../../Tool.js'
import { modifiedSinceReadMessage, otherLiveSessionsClause, unreadExistingWriteMessage, UNREAD_EXISTING_FILE_NOTE } from '../FileEditTool/otherSession.js'
import { buildEditedLines } from '../FileEditTool/editResult.js'
import { findActualString, getPatchForEdit, locateActualString, type ActualMatchOutcome } from '../FileEditTool/utils.js'
import type { FileEditInput, FileEditOutput } from '../FileEditTool/types.js'
import {
  extractZipEntryBuffer,
  findEocdOffset,
  hasNonTextBytes,
  isNestedArchiveOrBinaryEntry,
  parseRichFormatTarget,
  parseSqliteSubtarget,
  readZipEntries,
  renderSqliteRow,
  renderSqliteValue,
  RICH_ENTRY_MAX_BYTES,
  selectSqliteRows,
  sqliteKeyBinding,
  sqliteRowAmbiguousMessage,
  sqliteTableShape,
  statBoundedContainer,
  type ArchiveEntryMeta,
  type SqliteDb,
  type SqliteRowSelector,
} from '../FileReadTool/readRichFormats.js'
import type { Output as FileWriteOutput } from './FileWriteTool.js'
import { checkIntroducedParseError } from './parseCheck.js'

const LOC_SIG = 0x04034b50
const CEN_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const DESCRIPTOR_SIG = 0x08074b50
const ZIP64_LOCATOR_SIG = 0x07064b50

export const STRUCTURED_EDIT_MODES_NOTE =
  'Edit inside a zip archive or a SQLite database takes old_string and new_string only: hunks, append and section apply to plain files.'

export type StructuredWriteTarget =
  | { kind: 'zip-entry'; hostPath: string; entryName: string; rawPath: string; canonicalPath: string }
  | { kind: 'sqlite-row'; hostPath: string; table: string; selector: SqliteRowSelector; rawPath: string; canonicalPath: string }
  | { kind: 'refused'; hostPath: string; rawPath: string; canonicalPath: string; reason: string }

type WritableTarget = Exclude<StructuredWriteTarget, { kind: 'refused' }>

type Refusal = { result: false; behavior: 'ask'; message: string; errorCode: number }

function sha16(content: string): string {
  return runtimeKernel().hash.sha256Hex(content).slice(0, 16)
}

function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function zipEntryNameRefusal(name: string): string | null {
  const decoded = name.replace(/%[0-9a-fA-F]{2}/g, m => String.fromCharCode(Number.parseInt(m.slice(1), 16)))
  if (/[\u0000-\u001f]/.test(name) || /[\u0000-\u001f]/.test(decoded)) return `The zip entry name "${name}" carries a control character.`
  if (name.includes('\\') || decoded.includes('\\')) return `The zip entry name "${name}" uses a backslash: entry paths inside an archive are separated by "/".`
  if (name.startsWith('/') || decoded.startsWith('/')) return `The zip entry name "${name}" is absolute: an entry path is relative to the archive root.`
  if (/^[A-Za-z]:/.test(name) || /^[A-Za-z]:/.test(decoded)) return `The zip entry name "${name}" starts with a drive letter: an entry path is relative to the archive root.`
  if (name.endsWith('/') || decoded.endsWith('/')) return `The zip entry name "${name}" names a directory: write a file entry (${name}<file>).`
  if (/(?:^|\/)\.\.(?:\/|$)/.test(name) || /(?:^|\/)\.\.(?:\/|$)/.test(decoded)) return `The zip entry name "${name}" climbs out of the archive with "..".`
  if (/(?:^|\/)\.?(?:\/|$)/.test(name) || /(?:^|\/)\.?(?:\/|$)/.test(decoded)) return `The zip entry name "${name}" has an empty or "." segment.`
  if (Buffer.byteLength(name, 'utf8') > 0xffff) return 'The zip entry name is longer than an archive can store (65535 bytes).'
  return null
}

const EMPTY_SUBTARGET = /^(.+?\.(?:tar\.gz|zip|tar|tgz|sqlite3|sqlite|db))(?:::|!\/|!|:)\s*$/i

export function parseStructuredWriteTarget(rawPath: string): StructuredWriteTarget | null {
  const empty = EMPTY_SUBTARGET.exec(rawPath)
  if (empty !== null) {
    const hostPath = expandPath(empty[1]!)
    return {
      kind: 'refused',
      hostPath,
      rawPath,
      canonicalPath: `${hostPath}:`,
      reason: `${rawPath} names a container but no entry or row inside it: write archive.zip:path/inside.txt or db.sqlite:table/key.`,
    }
  }
  const rich = parseRichFormatTarget(rawPath)
  if (rich === null || rich.subtarget === undefined) return null
  const hostPath = expandPath(rich.containerPath)
  const canonicalPath = `${hostPath}:${rich.subtarget}`
  const refuse = (reason: string): StructuredWriteTarget => ({ kind: 'refused', hostPath, rawPath, canonicalPath, reason })
  if (rich.kind === 'archive') {
    if (rich.ext !== 'zip') {
      return refuse(
        `Writing inside a .${rich.ext} archive is not supported: entries can be written inside .zip archives (archive.zip:path/inside.txt) and rows inside SQLite databases (db.sqlite:table/key).`,
      )
    }
    const problem = zipEntryNameRefusal(rich.subtarget)
    if (problem !== null) return refuse(problem)
    return { kind: 'zip-entry', hostPath, entryName: rich.subtarget, rawPath, canonicalPath }
  }
  if (rich.kind === 'sqlite') {
    const parsed = parseSqliteSubtarget(rich.subtarget)
    if (!parsed.ok) return refuse(parsed.reason)
    if (parsed.selector === null) {
      return refuse(
        `Writes inside a SQLite database address one row: name it as ${rich.containerPath}:${parsed.table}/<key> (or ${parsed.table}/<column>=<value>). Read ${rich.containerPath}:${parsed.table} for the table's rows.`,
      )
    }
    return { kind: 'sqlite-row', hostPath, table: parsed.table, selector: parsed.selector, rawPath, canonicalPath }
  }
  return null
}

export function hostPathOfWriteTarget(rawPath: string): string {
  const target = parseStructuredWriteTarget(rawPath)
  return target ? target.hostPath : expandPath(rawPath)
}

export function expandStructuredTargetPath(rawPath: string): string {
  const target = parseStructuredWriteTarget(rawPath)
  return target ? target.canonicalPath : expandPath(rawPath)
}

function hostIsRegularFile(hostPath: string): boolean | null {
  try {
    return statSync(hostPath).isFile()
  } catch {
    return null
  }
}

export function structuredTargetRefusal(target: StructuredWriteTarget, verb: 'write' | 'edit'): Refusal | null {
  if (target.kind === 'refused') {
    return { result: false, behavior: 'ask', message: target.reason, errorCode: 4 }
  }
  const hostKind = hostIsRegularFile(target.hostPath)
  if (hostKind === false) {
    return {
      result: false,
      behavior: 'ask',
      message: `${target.hostPath} is not a regular file, so it holds no ${target.kind === 'zip-entry' ? 'zip entries' : 'SQLite rows'}.`,
      errorCode: 4,
    }
  }
  if (hostKind === true) {
    try {
      statBoundedContainer(target.hostPath)
    } catch (err) {
      return {
        result: false,
        behavior: 'ask',
        message: err instanceof Error ? err.message : String(err),
        errorCode: 4,
      }
    }
  }
  if (hostKind === null && (target.kind === 'sqlite-row' || verb === 'edit')) {
    return {
      result: false,
      behavior: 'ask',
      message:
        target.kind === 'sqlite-row'
          ? `There is no SQLite database at ${target.hostPath}: a row write never creates a database.`
          : `There is no archive at ${target.hostPath}: Write creates an archive with its first entry; Edit needs an existing one.`,
      errorCode: 4,
    }
  }
  return null
}

type ZipArchive = { bytes: Buffer; entries: ArchiveEntryMeta[]; eocd: number }

function readZipArchive(hostPath: string): ZipArchive {
  statBoundedContainer(hostPath)
  const bytes = readFileSync(hostPath)
  const eocd = findEocdOffset(bytes)
  if (eocd === -1) {
    throw new Error(`${hostPath} has no zip central directory, so it cannot be rewritten safely.`)
  }
  const totalEntries = bytes.readUInt16LE(eocd + 10)
  const zip64Marks =
    (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) ||
    totalEntries === 0xffff ||
    bytes.readUInt32LE(eocd + 12) === 0xffffffff ||
    bytes.readUInt32LE(eocd + 16) === 0xffffffff
  if (zip64Marks) {
    throw new Error(`${hostPath} is a Zip64 archive, which the entry writer does not rewrite.`)
  }
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) {
    throw new Error(`${hostPath} spans more than one disk, which the entry writer does not rewrite.`)
  }
  const entries = readZipEntries(bytes, hostPath)
  if (entries.length !== totalEntries) {
    throw new Error(
      `${hostPath} lists ${totalEntries} entries in its central directory but only ${entries.length} could be read, so it cannot be rewritten safely.`,
    )
  }
  const seenNames = new Set<string>()
  for (const entry of entries) {
    if (entry.central === undefined) {
      throw new Error(`${hostPath} lists "${entry.name}" outside its central directory, so it cannot be rewritten safely.`)
    }
    if (bytes.readUInt16LE(entry.central.offset + 34) !== 0) {
      throw new Error(`${hostPath} spans more than one disk, which the entry writer does not rewrite.`)
    }
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      throw new Error(`${hostPath} is a Zip64 archive, which the entry writer does not rewrite.`)
    }
    if (entry.localHeaderOffset + 30 > bytes.length || bytes.readUInt32LE(entry.localHeaderOffset) !== LOC_SIG) {
      throw new Error(`${hostPath} has no local header for "${entry.name}", so it cannot be rewritten safely.`)
    }
    if (seenNames.has(entry.name)) {
      throw new Error(`"${entry.name}" appears more than once in ${hostPath}, so the entry writer cannot tell which to replace.`)
    }
    seenNames.add(entry.name)
  }
  return { bytes, entries, eocd }
}

function localRecordEnd(archive: ZipArchive, entry: ArchiveEntryMeta): number {
  const { bytes } = archive
  const header = entry.localHeaderOffset
  const nameLen = bytes.readUInt16LE(header + 26)
  const extraLen = bytes.readUInt16LE(header + 28)
  let end = header + 30 + nameLen + extraLen + entry.compressedSize
  if (end > bytes.length) {
    throw new Error(`The compressed bytes of "${entry.name}" run past the end of the archive, so it cannot be rewritten safely.`)
  }
  if (((entry.central?.flags ?? 0) & 0x0008) !== 0) {
    end += end + 4 <= bytes.length && bytes.readUInt32LE(end) === DESCRIPTOR_SIG ? 16 : 12
    if (end > bytes.length) {
      throw new Error(`The data descriptor of "${entry.name}" runs past the end of the archive, so it cannot be rewritten safely.`)
    }
  }
  return end
}

function dosDateTime(now: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, now.getFullYear()))
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  }
}

function buildEntryRecords(
  name: string,
  rawBytes: Buffer,
  previous: { bytes: Buffer; central: { offset: number; length: number } } | null,
  localOffset: number,
): { local: Buffer; central: Buffer } {
  const deflated = deflateRawSync(rawBytes)
  const useDeflate = deflated.length < rawBytes.length
  const payload = useDeflate ? deflated : rawBytes
  const method = useDeflate ? 8 : 0
  const checksum = crc32(rawBytes) >>> 0
  const nameBytes = Buffer.from(name, 'utf8')
  const stamp = dosDateTime(new Date())
  const flags = 0x0800

  const local = Buffer.alloc(30)
  local.writeUInt32LE(LOC_SIG, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(stamp.time, 10)
  local.writeUInt16LE(stamp.date, 12)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(rawBytes.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28)

  const old = previous === null ? null : previous.bytes.subarray(previous.central.offset, previous.central.offset + previous.central.length)
  const oldNameLen = old === null ? 0 : old.readUInt16LE(28)
  const oldExtraLen = old === null ? 0 : old.readUInt16LE(30)
  const oldCommentLen = old === null ? 0 : old.readUInt16LE(32)
  const comment = old === null ? Buffer.alloc(0) : old.subarray(46 + oldNameLen + oldExtraLen, 46 + oldNameLen + oldExtraLen + oldCommentLen)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(CEN_SIG, 0)
  central.writeUInt16LE(old === null ? 20 : old.readUInt16LE(4), 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(flags, 8)
  central.writeUInt16LE(method, 10)
  central.writeUInt16LE(stamp.time, 12)
  central.writeUInt16LE(stamp.date, 14)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(payload.length, 20)
  central.writeUInt32LE(rawBytes.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(comment.length, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(old === null ? 0 : old.readUInt16LE(36), 36)
  central.writeUInt32LE(old === null ? 0 : old.readUInt32LE(38), 38)
  central.writeUInt32LE(localOffset, 42)

  return {
    local: Buffer.concat([local, nameBytes, payload]),
    central: Buffer.concat([central, nameBytes, comment]),
  }
}

function rebuildZipArchive(archive: ZipArchive | null, entryName: string, rawBytes: Buffer): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  let replaced = false
  for (const entry of archive?.entries ?? []) {
    if (entry.name === entryName) {
      const records = buildEntryRecords(entryName, rawBytes, { bytes: archive!.bytes, central: entry.central! }, offset)
      localParts.push(records.local)
      centralParts.push(records.central)
      offset += records.local.length
      replaced = true
      continue
    }
    const local = archive!.bytes.subarray(entry.localHeaderOffset, localRecordEnd(archive!, entry))
    const central = Buffer.from(archive!.bytes.subarray(entry.central!.offset, entry.central!.offset + entry.central!.length))
    central.writeUInt32LE(offset, 42)
    localParts.push(local)
    centralParts.push(central)
    offset += local.length
  }
  if (!replaced) {
    const records = buildEntryRecords(entryName, rawBytes, null, offset)
    localParts.push(records.local)
    centralParts.push(records.central)
    offset += records.local.length
  }
  const centralDir = Buffer.concat(centralParts)
  const count = (archive?.entries.length ?? 0) + (replaced ? 0 : 1)
  const eocd = archive === null ? Buffer.alloc(22) : Buffer.from(archive.bytes.subarray(archive.eocd))
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  if (archive === null) eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDir, eocd])
}

function replaceFileAtomically(hostPath: string, bytes: Buffer): void {
  const tmpPath = `${hostPath}.mercury-${process.pid}-${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(tmpPath, bytes)
    renameSync(tmpPath, hostPath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}

type ZipEntryState =
  | { exists: false; archive: ZipArchive | null }
  | { exists: true; archive: ZipArchive; entry: ArchiveEntryMeta; text: string }

function isZipSymlink(entry: ArchiveEntryMeta): boolean {
  return (((entry.central?.externalAttrs ?? 0) >>> 16) & 0o170000) === 0o120000
}

function readZipEntryState(hostPath: string, entryName: string): ZipEntryState {
  if (!existsSync(hostPath)) return { exists: false, archive: null }
  const archive = readZipArchive(hostPath)
  for (const e of archive.entries) {
    if (!isZipSymlink(e)) continue
    const prefix = e.name.endsWith('/') ? e.name : `${e.name}/`
    if (e.name === entryName || entryName.startsWith(prefix)) {
      throw new Error(`"${e.name}" in ${hostPath} is a symbolic link entry; the entry writer never writes through a symlink.`)
    }
  }
  const matching = archive.entries.filter(e => e.name === entryName)
  if (matching.length > 1) {
    throw new Error(`"${entryName}" appears ${matching.length} times in ${hostPath}, so the entry writer cannot tell which to replace.`)
  }
  const entry = matching[0]
  if (entry === undefined) return { exists: false, archive }
  if (entry.isDirectory) {
    throw new Error(`"${entryName}" is a directory entry of ${hostPath}, not a file.`)
  }
  if (((entry.central?.flags ?? 0) & 0x0001) !== 0) {
    throw new Error(`"${entryName}" in ${hostPath} is encrypted; the entry writer does not rewrite encrypted entries.`)
  }
  const special = isNestedArchiveOrBinaryEntry(entry.name)
  if (special !== null) {
    throw new Error(
      `"${entryName}" in ${hostPath} is a ${special.kind === 'nested-archive' ? 'nested archive' : 'binary file'} (.${special.ext}); the text road does not overwrite it.`,
    )
  }
  const data = extractZipEntryBuffer(archive.bytes, entry)
  if (hasNonTextBytes(data)) {
    throw new Error(`"${entryName}" in ${hostPath} holds binary content; the text road does not overwrite it.`)
  }
  return { exists: true, archive, entry, text: data.toString('utf8') }
}

function writeZipEntry(hostPath: string, entryName: string, content: string, state: ZipEntryState): number {
  const rawBytes = Buffer.from(content, 'utf8')
  if (rawBytes.length > RICH_ENTRY_MAX_BYTES) {
    throw new Error(
      `The entry content (${formatFileSize(rawBytes.length)}) exceeds the maximum allowed entry size (${formatFileSize(RICH_ENTRY_MAX_BYTES)}).`,
    )
  }
  replaceFileAtomically(hostPath, rebuildZipArchive(state.archive, entryName, rawBytes))
  return rawBytes.length
}

type SqliteWriteDb = SqliteDb & {
  run(sql: string, ...params: unknown[]): unknown
  transaction<T>(fn: () => T): () => T
}

async function openSqliteForWrite(hostPath: string): Promise<SqliteWriteDb> {
  statBoundedContainer(hostPath)
  const bunSqlite = 'bun:sqlite'
  const { Database } = (await import(bunSqlite)) as {
    Database: new (file: string, opts?: { readwrite?: boolean; create?: boolean }) => SqliteWriteDb
  }
  return new Database(hostPath, { readwrite: true, create: false })
}

type SqliteRowState = {
  shape: ReturnType<typeof sqliteTableShape>
  matchColumn: string
  row: Record<string, unknown> | null
  text: string
}

function readSqliteRowState(db: SqliteWriteDb, hostPath: string, table: string, selector: SqliteRowSelector): SqliteRowState {
  const object = db.prepare(`SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`).all(table)[0] as
    | { type: string; sql: string | null }
    | undefined
  if (object === undefined) throw new Error(`SQLite table "${table}" not found in ${hostPath}.`)
  if (object.type === 'view') throw new Error(`"${table}" is a view of ${hostPath}: a view has no writable rows.`)
  if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(object.sql ?? '')) {
    throw new Error(`"${table}" is a virtual table of ${hostPath}: a virtual table has no writable rows.`)
  }
  const shape = sqliteTableShape(db, table)
  const { matchColumn, rows } = selectSqliteRows(db, table, shape, selector)
  if (rows.length > 1) throw new Error(sqliteRowAmbiguousMessage(table, matchColumn, selector.value))
  const row = rows[0] ?? null
  return { shape, matchColumn, row, text: row === null ? '' : renderSqliteRow(row) }
}

const BIGINT_TOKEN_PREFIX = '__mercury_bigint__:'

function parseRowObject(text: string): Record<string, unknown> {
  const safeText = text.replace(/"(?:\\.|[^"\\])*"|(-?\b\d{16,20}\b)/g, (m, int: string | undefined) =>
    int !== undefined ? JSON.stringify(`${BIGINT_TOKEN_PREFIX}${int}`) : m,
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(safeText)
  } catch (err) {
    throw new Error(
      `A SQLite row is written as one JSON object of column values; the content does not parse: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A SQLite row is written as one JSON object of column values (one row per target).')
  }
  const obj = parsed as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (typeof val === 'string' && val.startsWith(BIGINT_TOKEN_PREFIX)) {
      try {
        obj[key] = BigInt(val.slice(BIGINT_TOKEN_PREFIX.length))
      } catch {
        obj[key] = val.slice(BIGINT_TOKEN_PREFIX.length)
      }
    }
  }
  return obj
}

function bindable(value: unknown, integerColumn = false): string | number | bigint | null {
  if (value === null) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    if (integerColumn && /^-?\d{16,20}$/.test(value)) {
      try {
        const big = BigInt(value)
        if (big >= -9223372036854775808n && big <= 9223372036854775807n) return big
      } catch {}
    }
    return value
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

type RowChange = { column: string; value: string | number | bigint | null }

function plannedRowChanges(state: SqliteRowState, table: string, wanted: Record<string, unknown>): RowChange[] {
  const columnNames = state.shape.columns.map(c => c.name)
  const writable = new Set(columnNames)
  if (state.shape.address.kind === 'rowid') writable.add('rowid')
  const changes: RowChange[] = []
  for (const column of Object.keys(wanted)) {
    if (!writable.has(column)) {
      throw new Error(`Table "${table}" has no column "${column}" (columns: ${columnNames.join(', ')}).`)
    }
    const next = wanted[column]
    const current = state.row === null ? undefined : state.row[column]
    if (state.row !== null) {
      if (renderSqliteValue(next) === renderSqliteValue(current)) continue
      if (current instanceof Uint8Array || Buffer.isBuffer(current)) {
        throw new Error(`Column "${column}" of table "${table}" holds binary data; the text road does not overwrite it.`)
      }
    }
    if (typeof next === 'string' && /^<BLOB \d+B>$/.test(next)) {
      throw new Error(`Column "${column}" of table "${table}" cannot be written with the "<BLOB …>" placeholder; the text road does not write binary data.`)
    }
    const colInfo = state.shape.columns.find(c => c.name === column)
    const intCol = typeof current === 'bigint' || column === 'rowid' || (colInfo !== undefined && /int/i.test(colInfo.type))
    changes.push({ column, value: bindable(next, intCol) })
  }
  return changes
}

function applyRowChanges(
  db: SqliteWriteDb,
  table: string,
  state: SqliteRowState,
  selector: SqliteRowSelector,
  changes: RowChange[],
): { inserted: boolean; keyAfter: string | number | bigint | null } {
  const q = (name: string) => `"${name}"`
  const keyBefore = state.row === null ? null : bindable(state.row[state.matchColumn])
  const keyChange = changes.find(c => c.column === state.matchColumn)
  const keyAfter = keyChange !== undefined ? keyChange.value : keyBefore
  const run = db.transaction(() => {
    if (state.row !== null) {
      const assignments = changes.map(c => `${q(c.column)} = ?`).join(', ')
      const result = db.run(
        `UPDATE ${q(table)} SET ${assignments} WHERE ${q(state.matchColumn)} = ?`,
        ...changes.map(c => c.value),
        keyBefore,
      ) as { changes: number }
      if (result.changes !== 1) throw new Error(`The update touched ${result.changes} rows of "${table}" instead of one; rolled back.`)
      return
    }
    const columns = changes.map(c => c.column)
    const values = changes.map(c => c.value)
    const addressed = selector.column ?? state.matchColumn
    if (!columns.includes(addressed)) {
      columns.push(addressed)
      values.push(sqliteKeyBinding(selector.value))
    }
    db.run(`INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...values)
  })
  run()
  return { inserted: state.row === null, keyAfter }
}

function fullReadEntry(entry: FileState): boolean {
  return (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined && !entry.isPartialView
}

function lineSpanOf(content: string, needle: string): { start: number; end: number } | null {
  const at = content.indexOf(needle)
  if (at === -1 || needle === '') return null
  const start = content.slice(0, at).split('\n').length
  return { start, end: start + needle.split('\n').length - 1 }
}

type ReadEvidence = 'known' | 'stale' | 'unread'

function structuredReadEvidence(
  context: ToolUseContext,
  target: WritableTarget,
  currentText: string,
  touched: { start: number; end: number } | null,
  road: 'write' | 'edit',
  expectedAnchor?: string,
): ReadEvidence {
  const current = normalizeNewlines(currentText)
  if (expectedAnchor !== undefined && expectedAnchor.startsWith('fa:')) {
    return checkAnchor(expectedAnchor, current, target.canonicalPath).ok ? 'known' : 'stale'
  }
  const entry = context.readFileState.get(target.canonicalPath)
  if (entry === undefined || entry.isPartialView) return 'unread'
  if (fullReadEntry(entry)) {
    return entry.content === current ? 'known' : 'stale'
  }
  const start = Math.max(1, entry.offset ?? 1)
  const count = entry.content === '' ? 0 : entry.content.split('\n').length
  const window = current.split('\n').slice(start - 1, start - 1 + count).join('\n')
  if (window !== entry.content) return 'stale'
  if (road === 'write') return 'known'
  if (touched === null) return 'unread'
  return touched.start >= start && touched.end <= start + count - 1 ? 'known' : 'unread'
}

function unreadEditMessage(displayPath: string): string {
  return `Read the file before editing it — ${UNREAD_EXISTING_FILE_NOTE}; the edit needs a prior read of the current content (a Read of the lines it touches, or expected_anchor from a full Read of the file as it stands).${otherLiveSessionsClause()} No lines of ${displayPath} were read this session — a Read of the file shows what stands.`
}

function recordWritten(context: ToolUseContext, target: WritableTarget, keys: string[], text: string): void {
  const normalized = normalizeNewlines(text)
  const writtenAt = getFileModificationTime(target.hostPath)
  for (const key of keys) {
    context.readFileState.set(key, { content: normalized, timestamp: writtenAt, offset: undefined, limit: undefined })
  }
}

type WriteEffect = {
  outcome: 'succeeded' | 'no-change'
  operation: 'file.write'
  changedPaths: string[]
  evidence: string
  startedAt: number
  completedAt: number
  details?: { digest: string; bytes: number }
}

function noChangeWrite(
  context: ToolUseContext,
  target: WritableTarget,
  currentText: string,
  content: string,
  startedAt: number,
  evidence: string,
): { data: FileWriteOutput; effect: WriteEffect } {
  const verdict = recordNoChangeOutcome(ownerFromToolUseContext(context), {
    operation: 'file.write',
    path: target.canonicalPath,
    revision: mintFileAnchor(currentText),
    intentDigest: serializeIntentDigest([content]),
    displayPath: target.rawPath,
  })
  return {
    data: {
      type: 'no-change',
      filePath: target.canonicalPath,
      content,
      structuredPatch: [],
      originalFile: currentText,
      noChange: { streak: verdict.streak, stop: verdict.atCeiling, guidance: verdict.guidance },
    },
    effect: { outcome: 'no-change', operation: 'file.write', changedPaths: [], evidence, startedAt, completedAt: Date.now() },
  }
}

function writtenResult(
  target: WritableTarget,
  resultPath: string,
  before: string | null,
  after: string,
  startedAt: number,
  evidence: string,
  bytes: number,
  parseError: string | undefined,
): { data: FileWriteOutput; effect: WriteEffect } {
  const effect: WriteEffect = {
    outcome: 'succeeded',
    operation: 'file.write',
    changedPaths: [target.hostPath],
    evidence,
    startedAt,
    completedAt: Date.now(),
    details: { digest: sha16(after), bytes },
  }
  if (before !== null) {
    const patch = getPatchForDisplay({
      filePath: resultPath,
      fileContents: before,
      edits: [{ old_string: before, new_string: after }],
    })
    countLinesChanged(patch)
    return {
      data: {
        type: 'update',
        filePath: resultPath,
        content: after,
        structuredPatch: patch,
        originalFile: before,
        ...(parseError !== undefined ? { parseError } : {}),
      },
      effect,
    }
  }
  countLinesChanged([], after)
  return {
    data: {
      type: 'create',
      filePath: resultPath,
      content: after,
      structuredPatch: [],
      originalFile: null,
      ...(parseError !== undefined ? { parseError } : {}),
    },
    effect,
  }
}

function rowAddressAfter(
  target: Extract<WritableTarget, { kind: 'sqlite-row' }>,
  matchColumn: string,
  afterRow: Record<string, unknown>,
): { keys: string[]; resultPath: string; moved: string | null } {
  const keyVal = String(afterRow[matchColumn])
  const moved = `${target.table}/${matchColumn}=${keyVal}`
  const after = `${target.hostPath}:${moved}`
  const bareAfter = `${target.hostPath}:${target.table}/${keyVal}`
  const stillAddressed = String(afterRow[target.selector.column ?? matchColumn]) === target.selector.value
  return stillAddressed
    ? { keys: [target.canonicalPath, after, bareAfter], resultPath: target.canonicalPath, moved: null }
    : { keys: [after, bareAfter], resultPath: after, moved }
}

async function withSqliteRow<T>(
  target: Extract<WritableTarget, { kind: 'sqlite-row' }>,
  body: (db: SqliteWriteDb, state: SqliteRowState) => Promise<T>,
): Promise<T> {
  const db = await openSqliteForWrite(target.hostPath)
  try {
    return await body(db, readSqliteRowState(db, target.hostPath, target.table, target.selector))
  } finally {
    db.close()
  }
}

function settleRow(
  context: ToolUseContext,
  target: Extract<WritableTarget, { kind: 'sqlite-row' }>,
  db: SqliteWriteDb,
  state: SqliteRowState,
  changes: RowChange[],
): { afterText: string; evidence: string; inserted: boolean; resultPath: string } {
  const tx = db.transaction(() => {
    const applied = applyRowChanges(db, target.table, state, target.selector, changes)
    const after = readSqliteRowState(
      db,
      target.hostPath,
      target.table,
      applied.inserted ? target.selector : { column: state.matchColumn, value: String(applied.keyAfter) },
    )
    if (after.row === null) throw new Error(`The row of "${target.table}" could not be read back after the write.`)
    return { applied, after }
  })
  const { applied, after } = tx()
  const address = rowAddressAfter(target, state.matchColumn, after.row!)
  recordWritten(context, target, address.keys, after.text)
  const evidence = applied.inserted
    ? `inserted one row into ${target.table} of ${target.hostPath}`
    : `updated ${changes.length} column${changes.length === 1 ? '' : 's'} of one row in ${target.table} of ${target.hostPath}${address.moved === null ? '' : ` (the row is now ${address.moved})`}`
  return { afterText: after.text, evidence, inserted: applied.inserted, resultPath: address.resultPath }
}

export async function callStructuredWriteTarget(
  target: WritableTarget,
  content: string,
  context: ToolUseContext,
  startedAt: number,
): Promise<{ data: FileWriteOutput; effect: WriteEffect }> {
  if (target.kind === 'zip-entry') {
    const state = readZipEntryState(target.hostPath, target.entryName)
    if (state.exists && state.text === content) {
      return noChangeWrite(context, target, state.text, content, startedAt, 'the zip entry already holds the exact bytes; nothing was written')
    }
    if (state.exists) {
      const evidence = structuredReadEvidence(context, target, state.text, null, 'write')
      if (evidence !== 'known') throw new Error(evidence === 'stale' ? modifiedSinceReadMessage() : unreadExistingWriteMessage())
    }
    const bytes = writeZipEntry(target.hostPath, target.entryName, content, state)
    recordWritten(context, target, [target.canonicalPath], content)
    return writtenResult(
      target,
      target.canonicalPath,
      state.exists ? state.text : null,
      content,
      startedAt,
      `${state.exists ? 'updated' : 'created'} zip entry ${target.entryName} in ${target.hostPath} (${bytes} bytes)`,
      bytes,
      await checkIntroducedParseError(target.canonicalPath, state.exists ? state.text : null, content),
    )
  }

  const wanted = parseRowObject(content)
  return withSqliteRow(target, async (db, state) => {
    const changes = plannedRowChanges(state, target.table, wanted)
    if (state.row !== null && changes.length === 0) {
      return noChangeWrite(context, target, state.text, content, startedAt, 'the row already holds these column values; nothing was written')
    }
    if (state.row !== null) {
      const evidence = structuredReadEvidence(context, target, state.text, null, 'write')
      if (evidence !== 'known') throw new Error(evidence === 'stale' ? modifiedSinceReadMessage() : unreadExistingWriteMessage())
    }
    const settled = settleRow(context, target, db, state, changes)
    return writtenResult(
      target,
      settled.resultPath,
      state.row === null ? null : state.text,
      settled.afterText,
      startedAt,
      settled.evidence,
      Buffer.byteLength(settled.afterText, 'utf8'),
      undefined,
    )
  })
}

export type UniquenessRefusal = (
  currentContent: string,
  oldString: string,
  replaceAll: boolean,
  located: Exclude<ActualMatchOutcome, { kind: 'none' }>,
) => Refusal | null

export async function validateStructuredEditTarget(
  target: StructuredWriteTarget,
  input: FileEditInput,
  context: ToolUseContext,
  uniqueness: UniquenessRefusal,
): Promise<{ result: true } | Refusal> {
  const refusal = structuredTargetRefusal(target, 'edit')
  if (refusal !== null) return refusal
  if (target.kind === 'refused') return { result: false, behavior: 'ask', message: target.reason, errorCode: 4 }
  if ((Array.isArray(input.hunks) && input.hunks.length > 0) || (input.section ?? '') !== '' || (input.append ?? '') !== '') {
    return { result: false, behavior: 'ask', message: STRUCTURED_EDIT_MODES_NOTE, errorCode: 13 }
  }
  if (input.old_string === undefined || input.new_string === undefined) {
    return {
      result: false,
      behavior: 'ask',
      message: 'old_string and new_string are required unless hunks, append or section are provided.',
      errorCode: 13,
    }
  }
  const oldString = input.old_string
  const newString = input.new_string
  if (oldString !== '' && oldString === newString) {
    return { result: false, behavior: 'ask', message: 'old_string and new_string are identical — there is no edit to apply.', errorCode: 1 }
  }
  let current: { exists: boolean; text: string }
  try {
    if (target.kind === 'zip-entry') {
      const state = readZipEntryState(target.hostPath, target.entryName)
      current = state.exists ? { exists: true, text: state.text } : { exists: false, text: '' }
    } else {
      current = await withSqliteRow(target, async (_db, state) => ({ exists: state.row !== null, text: state.text }))
    }
  } catch (err) {
    return {
      result: false,
      behavior: 'ask',
      message: err instanceof Error ? err.message : String(err),
      errorCode: 4,
    }
  }
  if (!current.exists) {
    if (oldString === '') return { result: true }
    return {
      result: false,
      behavior: 'ask',
      message: `There is no ${target.kind === 'zip-entry' ? 'entry' : 'row'} at ${target.rawPath}.`,
      errorCode: 4,
    }
  }
  if (oldString === '') {
    return {
      result: false,
      behavior: 'ask',
      message: 'Cannot create a new file — a file already exists at this path with content in it.',
      errorCode: 3,
    }
  }
  const located = locateActualString(current.text, oldString)
  if (located.kind === 'none') {
    return {
      result: false,
      behavior: 'ask',
      message: `The old_string was not found in the file.\nString: ${oldString}`,
      errorCode: 8,
    }
  }
  const touched = located.kind === 'found' ? lineSpanOf(current.text, located.actual) : null
  const evidence = structuredReadEvidence(context, target, current.text, touched, 'edit', input.expected_anchor)
  if (evidence !== 'known') {
    return {
      result: false,
      behavior: 'ask',
      message: evidence === 'stale' ? modifiedSinceReadMessage() : unreadEditMessage(target.rawPath),
      errorCode: evidence === 'stale' ? 7 : 6,
    }
  }
  const notUnique = uniqueness(current.text, oldString, input.replace_all === true, located)
  if (notUnique !== null) return notUnique
  return { result: true }
}

type EditEffect = {
  outcome: 'succeeded' | 'no-change'
  operation: 'file.edit'
  changedPaths: string[]
  evidence: string
  startedAt: number
  completedAt: number
  details: { digest: string; bytes: number; anchorChecked: boolean }
}

type EditPlan = { updatedFile: string; patch: FileEditOutput['structuredPatch']; occurrences: number }

export async function callStructuredEditTarget(
  target: WritableTarget,
  input: FileEditInput,
  context: ToolUseContext,
  startedAt: number,
): Promise<{ data: FileEditOutput; effect: EditEffect }> {
  const oldString = input.old_string ?? ''
  const newString = input.new_string ?? ''
  const replaceAll = input.replace_all === true
  const planEdit = (freshContent: string): EditPlan => {
    if (oldString === '') {
      return {
        updatedFile: newString,
        patch: getPatchFromContents({ filePath: target.canonicalPath, oldContent: '', newContent: newString }),
        occurrences: 1,
      }
    }
    const actualOld = findActualString(freshContent, oldString) ?? oldString
    const planned = getPatchForEdit({ filePath: target.canonicalPath, fileContents: freshContent, oldString: actualOld, newString, replaceAll })
    return { ...planned, occurrences: replaceAll ? freshContent.split(actualOld).length - 1 : 1 }
  }
  const noChange = (freshContent: string, evidence: string): { data: FileEditOutput; effect: EditEffect } => {
    const verdict = recordNoChangeOutcome(ownerFromToolUseContext(context), {
      operation: 'file.edit',
      path: target.canonicalPath,
      revision: mintFileAnchor(freshContent),
      intentDigest: serializeIntentDigest([oldString, newString, replaceAll]),
      displayPath: target.rawPath,
    })
    return {
      data: {
        filePath: target.canonicalPath,
        oldString,
        newString,
        originalFile: freshContent,
        structuredPatch: [],
        userModified: Boolean(context.userModifiedInput),
        replaceAll,
        noChange: { streak: verdict.streak, stop: verdict.atCeiling, guidance: verdict.guidance },
      },
      effect: {
        outcome: 'no-change',
        operation: 'file.edit',
        changedPaths: [],
        evidence,
        startedAt,
        completedAt: Date.now(),
        details: { digest: sha16(freshContent), bytes: Buffer.byteLength(freshContent, 'utf8'), anchorChecked: false },
      },
    }
  }
  const finish = async (
    resultPath: string,
    freshContent: string,
    existed: boolean,
    finalContent: string,
    plan: EditPlan,
    evidence: string,
    parseError: string | undefined,
  ): Promise<{ data: FileEditOutput; effect: EditEffect }> => {
    const lines = finalContent === '' ? [] : finalContent.replace(/\n$/, '').split('\n')
    const built = await buildEditedLines({
      written: finalContent,
      patch: plan.patch,
      what: existed ? `${plan.occurrences} occurrence${plan.occurrences === 1 ? '' : 's'} replaced` : 'file created',
      occurrences: plan.occurrences,
      path: resultPath,
      readWindow: async (start, count) => lines.slice(start - 1, start - 1 + count),
    })
    return {
      data: {
        filePath: resultPath,
        oldString,
        newString,
        originalFile: freshContent,
        structuredPatch: plan.patch,
        userModified: Boolean(context.userModifiedInput),
        replaceAll,
        ...(parseError !== undefined ? { parseError } : {}),
        editedLines: built.editedLines,
      },
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: [target.hostPath],
        evidence,
        startedAt,
        completedAt: Date.now(),
        details: { digest: sha16(finalContent), bytes: Buffer.byteLength(finalContent, 'utf8'), anchorChecked: false },
      },
    }
  }

  if (target.kind === 'zip-entry') {
    const state = readZipEntryState(target.hostPath, target.entryName)
    const freshContent = state.exists ? state.text : ''
    const plan = planEdit(freshContent)
    if (state.exists && plan.updatedFile === freshContent) {
      return noChange(freshContent, 'exact-string mode: the computed result is byte-identical to the current entry')
    }
    const bytes = writeZipEntry(target.hostPath, target.entryName, plan.updatedFile, state)
    recordWritten(context, target, [target.canonicalPath], plan.updatedFile)
    return finish(
      target.canonicalPath,
      freshContent,
      state.exists,
      plan.updatedFile,
      plan,
      `${state.exists ? 'edited' : 'created'} zip entry ${target.entryName} in ${target.hostPath} (${bytes} bytes)`,
      await checkIntroducedParseError(target.canonicalPath, state.exists ? freshContent : null, plan.updatedFile),
    )
  }

  return withSqliteRow(target, async (db, state) => {
    const plan = planEdit(state.text)
    const changes = plannedRowChanges(state, target.table, parseRowObject(plan.updatedFile))
    if (state.row !== null && changes.length === 0) {
      return noChange(state.text, 'exact-string mode: the edited text changes no column value of the row')
    }
    const settled = settleRow(context, target, db, state, changes)
    return finish(settled.resultPath, state.text, state.row !== null, settled.afterText, plan, settled.evidence, undefined)
  })
}
