import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import {
  recordNoChangeOutcome,
  serializeIntentDigest,
} from '../../services/changeTransaction/repetitionPolicy.js'
import { recordWholeFileSeen, wholeFileSeen } from '../../services/changeTransaction/seenLines.js'
import { mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { runtimeKernel } from '../../services/primitives/runtimeKernel.js'
import { countLinesChanged, getPatchForDisplay, getPatchFromContents } from '../../utils/diff.js'
import { getFileModificationTime } from '../../utils/file.js'
import type { FileState } from '../../utils/fileStateCache.js'
import { expandPath } from '../../utils/path.js'
import type { ToolUseContext } from '../../Tool.js'
import { modifiedSinceReadMessage, unreadExistingWriteMessage, UNREAD_EXISTING_FILE_NOTE } from '../FileEditTool/otherSession.js'
import { buildEditedLines } from '../FileEditTool/editResult.js'
import { findActualString, getPatchForEdit, locateActualString } from '../FileEditTool/utils.js'
import type { FileEditInput, FileEditOutput } from '../FileEditTool/types.js'
import type { Output as FileWriteOutput } from './FileWriteTool.js'
import { checkIntroducedParseError } from './parseCheck.js'

const ZIP_EXTENSIONS = new Set([
  '.zip',
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.epub',
  '.jar',
])

const SQLITE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db'])

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

export type StructuredWriteTarget =
  | {
      kind: 'zip-entry'
      hostPath: string
      entryName: string
      rawPath: string
    }
  | {
      kind: 'sqlite-row'
      hostPath: string
      table: string
      pkFilter?: { column?: string; value: string }
      rawPath: string
    }

export type ZipCentralEntry = {
  name: string
  versionMadeBy: number
  versionNeeded: number
  flags: number
  method: number
  dosTime: number
  dosDate: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  diskNumber: number
  internalAttrs: number
  externalAttrs: number
  localHeaderOffset: number
  extraField: Buffer
  comment: Buffer
  compressedData: Buffer
}

function sha16(content: string): string {
  return runtimeKernel().hash.sha256Hex(content).slice(0, 16)
}

function isFullReadEntry(entry: FileState): boolean {
  return (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined && !entry.isPartialView
}

function normalizeEntryPath(raw: string): string {
  return raw.replaceAll('\\', '/').replace(/^\/+/, '')
}

function splitAtTargetDelimiter(rawPath: string, extensions: Set<string>): { hostRaw: string; rest: string } | null {
  const lower = rawPath.toLowerCase()
  for (const ext of extensions) {
    const bangIdx = lower.indexOf(`${ext}!`)
    if (bangIdx !== -1) {
      const splitPos = bangIdx + ext.length
      return { hostRaw: rawPath.slice(0, splitPos), rest: rawPath.slice(splitPos + 1) }
    }
    const dcolonIdx = lower.indexOf(`${ext}::`)
    if (dcolonIdx !== -1) {
      const splitPos = dcolonIdx + ext.length
      return { hostRaw: rawPath.slice(0, splitPos), rest: rawPath.slice(splitPos + 2) }
    }
    const colonIdx = lower.indexOf(`${ext}:`)
    if (colonIdx !== -1) {
      const splitPos = colonIdx + ext.length
      const rest = rawPath.slice(splitPos + 1)
      if ((rest.length > 0 && !/^[\\/]/.test(rest)) || rest.startsWith('/')) {
        return { hostRaw: rawPath.slice(0, splitPos), rest }
      }
    }
    let searchFrom = 0
    while (searchFrom < lower.length) {
      const slashIdx = lower.indexOf(`${ext}/`, searchFrom)
      if (slashIdx === -1) break
      const splitPos = slashIdx + ext.length
      const candidateHost = expandPath(rawPath.slice(0, splitPos))
      if (existsSync(candidateHost)) {
        return { hostRaw: rawPath.slice(0, splitPos), rest: rawPath.slice(splitPos + 1) }
      }
      searchFrom = splitPos + 1
    }
  }
  return null
}

function parseSqliteSelector(rest: string): { table: string; pkFilter?: { column?: string; value: string } } | null {
  const cleaned = rest.replace(/^\/+/, '').trim()
  if (cleaned === '') return null
  const slashIdx = cleaned.indexOf('/')
  const colonIdx = cleaned.indexOf(':')
  let tablePart = cleaned
  let rowPart: string | undefined
  if (slashIdx !== -1 && (colonIdx === -1 || slashIdx < colonIdx)) {
    tablePart = cleaned.slice(0, slashIdx)
    rowPart = cleaned.slice(slashIdx + 1)
  } else if (colonIdx !== -1) {
    tablePart = cleaned.slice(0, colonIdx)
    rowPart = cleaned.slice(colonIdx + 1)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablePart)) return null
  if (rowPart === undefined || rowPart.trim() === '') {
    return { table: tablePart }
  }
  const trimmedRow = rowPart.trim()
  const eqIdx = trimmedRow.indexOf('=')
  if (eqIdx !== -1) {
    const col = trimmedRow.slice(0, eqIdx).trim()
    const val = trimmedRow.slice(eqIdx + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col) || val === '') return null
    return { table: tablePart, pkFilter: { column: col, value: val } }
  }
  return { table: tablePart, pkFilter: { value: trimmedRow } }
}

export function parseStructuredWriteTarget(rawPath: string): StructuredWriteTarget | null {
  if (existsSync(expandPath(rawPath))) {
    return null
  }
  const zipSplit = splitAtTargetDelimiter(rawPath, ZIP_EXTENSIONS)
  if (zipSplit !== null) {
    const entryName = normalizeEntryPath(zipSplit.rest)
    if (entryName !== '' && !entryName.split('/').includes('..')) {
      return {
        kind: 'zip-entry',
        hostPath: expandPath(zipSplit.hostRaw),
        entryName,
        rawPath,
      }
    }
  }
  const sqliteSplit = splitAtTargetDelimiter(rawPath, SQLITE_EXTENSIONS)
  if (sqliteSplit !== null) {
    const parsed = parseSqliteSelector(sqliteSplit.rest)
    if (parsed !== null) {
      return {
        kind: 'sqlite-row',
        hostPath: expandPath(sqliteSplit.hostRaw),
        table: parsed.table,
        ...(parsed.pkFilter !== undefined ? { pkFilter: parsed.pkFilter } : {}),
        rawPath,
      }
    }
  }
  return null
}

export function hostPathOfWriteTarget(rawPath: string): string {
  const target = parseStructuredWriteTarget(rawPath)
  return target ? target.hostPath : expandPath(rawPath)
}

export function expandStructuredTargetPath(rawPath: string): string {
  const target = parseStructuredWriteTarget(rawPath)
  if (!target) return expandPath(rawPath)
  if (target.kind === 'zip-entry') {
    return `${target.hostPath}!${target.entryName}`
  }
  const suffix = target.pkFilter
    ? `/${target.pkFilter.column ? `${target.pkFilter.column}=` : ''}${target.pkFilter.value}`
    : ''
  return `${target.hostPath}!${target.table}${suffix}`
}

export function readZipCentralEntries(archiveBytes: Buffer): ZipCentralEntry[] {
  const minEocd = 22
  if (archiveBytes.length < minEocd) {
    throw new Error('Invalid zip archive: file is shorter than the end-of-central-directory record.')
  }
  const maxComment = Math.min(0xffff, archiveBytes.length - minEocd)
  let eocdOffset = -1
  for (let commentLen = 0; commentLen <= maxComment; commentLen++) {
    const pos = archiveBytes.length - minEocd - commentLen
    if (archiveBytes.readUInt32LE(pos) === EOCD_SIG) {
      eocdOffset = pos
      break
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid zip archive: end-of-central-directory signature not found.')
  }
  const totalEntries = archiveBytes.readUInt16LE(eocdOffset + 10)
  const cdSize = archiveBytes.readUInt32LE(eocdOffset + 12)
  const cdOffset = archiveBytes.readUInt32LE(eocdOffset + 16)
  if (cdOffset + cdSize > archiveBytes.length) {
    throw new Error('Invalid zip archive: central directory extends past the end of the file.')
  }

  const entries: ZipCentralEntry[] = []
  let ptr = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > archiveBytes.length || archiveBytes.readUInt32LE(ptr) !== CEN_SIG) {
      throw new Error('Invalid zip archive: corrupt central directory file header.')
    }
    const versionMadeBy = archiveBytes.readUInt16LE(ptr + 4)
    const versionNeeded = archiveBytes.readUInt16LE(ptr + 6)
    const flags = archiveBytes.readUInt16LE(ptr + 8)
    const method = archiveBytes.readUInt16LE(ptr + 10)
    const dosTime = archiveBytes.readUInt16LE(ptr + 12)
    const dosDate = archiveBytes.readUInt16LE(ptr + 14)
    const entryCrc = archiveBytes.readUInt32LE(ptr + 16)
    const compressedSize = archiveBytes.readUInt32LE(ptr + 20)
    const uncompressedSize = archiveBytes.readUInt32LE(ptr + 24)
    const nameLen = archiveBytes.readUInt16LE(ptr + 28)
    const extraLen = archiveBytes.readUInt16LE(ptr + 30)
    const commentLen = archiveBytes.readUInt16LE(ptr + 32)
    const diskNumber = archiveBytes.readUInt16LE(ptr + 34)
    const internalAttrs = archiveBytes.readUInt16LE(ptr + 36)
    const externalAttrs = archiveBytes.readUInt32LE(ptr + 38)
    const localHeaderOffset = archiveBytes.readUInt32LE(ptr + 42)

    const nameStart = ptr + 46
    const extraStart = nameStart + nameLen
    const commentStart = extraStart + extraLen
    const nextPtr = commentStart + commentLen
    if (nextPtr > archiveBytes.length) {
      throw new Error('Invalid zip archive: truncated central directory entry.')
    }
    const name = normalizeEntryPath(archiveBytes.subarray(nameStart, extraStart).toString('utf8'))
    const extraField = Buffer.from(archiveBytes.subarray(extraStart, commentStart))
    const comment = Buffer.from(archiveBytes.subarray(commentStart, nextPtr))

    if (localHeaderOffset + 30 > archiveBytes.length || archiveBytes.readUInt32LE(localHeaderOffset) !== LOC_SIG) {
      throw new Error(`Invalid zip archive: local header missing for entry "${name}".`)
    }
    const locNameLen = archiveBytes.readUInt16LE(localHeaderOffset + 26)
    const locExtraLen = archiveBytes.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + locNameLen + locExtraLen
    const dataEnd = dataStart + compressedSize
    if (dataEnd > archiveBytes.length) {
      throw new Error(`Invalid zip archive: compressed data truncated for entry "${name}".`)
    }
    const compressedData = Buffer.from(archiveBytes.subarray(dataStart, dataEnd))

    entries.push({
      name,
      versionMadeBy,
      versionNeeded,
      flags,
      method,
      dosTime,
      dosDate,
      crc32: entryCrc,
      compressedSize,
      uncompressedSize,
      diskNumber,
      internalAttrs,
      externalAttrs,
      localHeaderOffset,
      extraField,
      comment,
      compressedData,
    })
    ptr = nextPtr
  }
  return entries
}

export function decodeZipEntryBuffer(entry: ZipCentralEntry): Buffer {
  if (entry.method === 0) {
    return Buffer.from(entry.compressedData)
  }
  if (entry.method === 8) {
    return inflateRawSync(entry.compressedData)
  }
  throw new Error(`Unsupported zip compression method ${entry.method} for entry "${entry.name}".`)
}

export function readZipEntryText(hostPath: string, entryName: string): { exists: boolean; content: string } {
  if (!existsSync(hostPath)) {
    return { exists: false, content: '' }
  }
  const archiveBytes = readFileSync(hostPath)
  const entries = readZipCentralEntries(archiveBytes)
  const target = normalizeEntryPath(entryName)
  const found = entries.find(e => e.name === target)
  if (!found) return { exists: false, content: '' }
  return { exists: true, content: decodeZipEntryBuffer(found).toString('utf8') }
}

export function buildZipArchiveFromEntries(entries: readonly ZipCentralEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const flags = entry.flags & ~0x0008
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(LOC_SIG, 0)
    localHeader.writeUInt16LE(entry.versionNeeded || 20, 4)
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(entry.method, 8)
    localHeader.writeUInt16LE(entry.dosTime, 10)
    localHeader.writeUInt16LE(entry.dosDate, 12)
    localHeader.writeUInt32LE(entry.crc32 >>> 0, 14)
    localHeader.writeUInt32LE(entry.compressedData.length, 18)
    localHeader.writeUInt32LE(entry.uncompressedSize, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBytes, entry.compressedData)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(CEN_SIG, 0)
    centralHeader.writeUInt16LE(entry.versionMadeBy || 20, 4)
    centralHeader.writeUInt16LE(entry.versionNeeded || 20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(entry.method, 10)
    centralHeader.writeUInt16LE(entry.dosTime, 12)
    centralHeader.writeUInt16LE(entry.dosDate, 14)
    centralHeader.writeUInt32LE(entry.crc32 >>> 0, 16)
    centralHeader.writeUInt32LE(entry.compressedData.length, 20)
    centralHeader.writeUInt32LE(entry.uncompressedSize, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(entry.extraField.length, 30)
    centralHeader.writeUInt16LE(entry.comment.length, 32)
    centralHeader.writeUInt16LE(entry.diskNumber, 34)
    centralHeader.writeUInt16LE(entry.internalAttrs, 36)
    centralHeader.writeUInt32LE(entry.externalAttrs, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, nameBytes, entry.extraField, entry.comment)
    offset += localHeader.length + nameBytes.length + entry.compressedData.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDir, eocd])
}

export function writeZipEntryAtomically(
  hostPath: string,
  entryName: string,
  content: string,
): { created: boolean; previousContent: string | null; writtenBytes: number } {
  const normalizedName = normalizeEntryPath(entryName)
  const existingEntries = existsSync(hostPath) ? readZipCentralEntries(readFileSync(hostPath)) : []
  const rawBytes = Buffer.from(content, 'utf8')
  const compressed = deflateRawSync(rawBytes)
  const useDeflate = compressed.length < rawBytes.length
  const payload = useDeflate ? compressed : rawBytes
  const method = useDeflate ? 8 : 0
  const checksum = crc32(rawBytes) >>> 0

  const idx = existingEntries.findIndex(e => e.name === normalizedName)
  const previousContent = idx >= 0 ? decodeZipEntryBuffer(existingEntries[idx]!).toString('utf8') : null
  const updatedEntry: ZipCentralEntry =
    idx >= 0
      ? {
          ...existingEntries[idx]!,
          method,
          crc32: checksum,
          compressedSize: payload.length,
          uncompressedSize: rawBytes.length,
          compressedData: payload,
        }
      : {
          name: normalizedName,
          versionMadeBy: 20,
          versionNeeded: 20,
          flags: 0x0800,
          method,
          dosTime: 0,
          dosDate: 0x21,
          crc32: checksum,
          compressedSize: payload.length,
          uncompressedSize: rawBytes.length,
          diskNumber: 0,
          internalAttrs: 0,
          externalAttrs: 0,
          localHeaderOffset: 0,
          extraField: Buffer.alloc(0),
          comment: Buffer.alloc(0),
          compressedData: payload,
        }

  const nextEntries =
    idx >= 0
      ? existingEntries.map((entry, i) => (i === idx ? updatedEntry : entry))
      : [...existingEntries, updatedEntry]
  const outArchive = buildZipArchiveFromEntries(nextEntries)
  const tmpPath = `${hostPath}.mercury-zip-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(tmpPath, outArchive)
    renameSync(tmpPath, hostPath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {}
    throw err
  }
  return {
    created: idx === -1,
    previousContent,
    writtenBytes: rawBytes.length,
  }
}

type SqliteColumnInfo = {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

function quoteIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid SQLite identifier: "${ident}".`)
  }
  return `"${ident}"`
}

function toBindableScalar(val: unknown): string | number | bigint | boolean | Uint8Array | null {
  if (
    val === null ||
    typeof val === 'string' ||
    typeof val === 'number' ||
    typeof val === 'bigint' ||
    typeof val === 'boolean' ||
    val instanceof Uint8Array
  ) {
    return val
  }
  if (val === undefined) return null
  return JSON.stringify(val)
}

export async function readSqliteTargetSnapshot(
  hostPath: string,
  table: string,
  pkFilter?: { column?: string; value: string },
): Promise<{ exists: boolean; content: string; primaryKeyColumn: string | null }> {
  if (!existsSync(hostPath)) {
    return { exists: false, content: '', primaryKeyColumn: null }
  }
  const { Database } = await import('bun:sqlite')
  const db = new Database(hostPath, { readonly: true })
  try {
    const columns = db.query(`PRAGMA table_info(${quoteIdent(table)})`).all() as SqliteColumnInfo[]
    if (columns.length === 0) {
      return { exists: false, content: '', primaryKeyColumn: null }
    }
    const pkCol =
      pkFilter?.column ??
      columns.find(c => c.pk > 0)?.name ??
      columns[0]?.name ??
      'rowid'
    if (pkFilter !== undefined) {
      const asNum = Number(pkFilter.value)
      const bindVal = Number.isSafeInteger(asNum) && String(asNum) === pkFilter.value ? asNum : pkFilter.value
      const row = db
        .query(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(pkCol)} = ? LIMIT 1`)
        .get(bindVal) as Record<string, unknown> | null
      if (!row) {
        return { exists: false, content: '', primaryKeyColumn: pkCol }
      }
      return { exists: true, content: `${JSON.stringify(row, null, 2)}\n`, primaryKeyColumn: pkCol }
    }
    const rows = db.query(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[]
    return {
      exists: rows.length > 0,
      content: `${JSON.stringify(rows, null, 2)}\n`,
      primaryKeyColumn: pkCol,
    }
  } finally {
    db.close()
  }
}

export async function writeSqliteRowsParameterised(
  hostPath: string,
  table: string,
  content: string,
  pkFilter?: { column?: string; value: string },
): Promise<{ created: boolean; previousContent: string | null; affectedRows: number; renderedAfter: string }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new Error(
      `SQLite row write expects JSON object or array of row objects in content (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
  const rowList: Record<string, unknown>[] = Array.isArray(parsed)
    ? parsed.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r))
    : typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? [parsed as Record<string, unknown>]
      : []
  if (rowList.length === 0) {
    throw new Error('SQLite row write requires a non-empty JSON object or array of row objects.')
  }

  const beforeSnap = await readSqliteTargetSnapshot(hostPath, table, pkFilter)
  const { Database } = await import('bun:sqlite')
  const db = new Database(hostPath)
  try {
    const columns = db.query(`PRAGMA table_info(${quoteIdent(table)})`).all() as SqliteColumnInfo[]
    if (columns.length === 0) {
      throw new Error(`SQLite table "${table}" does not exist in ${hostPath}.`)
    }
    const validCols = new Set(columns.map(c => c.name))
    const pkCol =
      pkFilter?.column ??
      columns.find(c => c.pk > 0)?.name ??
      null

    let affectedRows = 0
    const tx = db.transaction(() => {
      for (const rawRow of rowList) {
        const row: Record<string, unknown> = { ...rawRow }
        if (pkFilter !== undefined && pkCol !== null && !(pkCol in row)) {
          const asNum = Number(pkFilter.value)
          row[pkCol] = Number.isSafeInteger(asNum) && String(asNum) === pkFilter.value ? asNum : pkFilter.value
        }
        const keys = Object.keys(row).filter(k => validCols.has(k))
        if (keys.length === 0) {
          throw new Error(
            `None of the provided JSON keys match columns of table "${table}" (${[...validCols].join(', ')}).`,
          )
        }
        const matchCol = pkCol !== null && (pkCol in row || pkFilter !== undefined) ? pkCol : null
        const rawMatch = matchCol !== null ? (matchCol in row ? row[matchCol] : pkFilter?.value) : null
        const matchVal =
          typeof rawMatch === 'string' && Number.isSafeInteger(Number(rawMatch)) && String(Number(rawMatch)) === rawMatch
            ? Number(rawMatch)
            : toBindableScalar(rawMatch)
        const existing =
          matchCol !== null && matchVal !== null
            ? db
                .query(`SELECT 1 FROM ${quoteIdent(table)} WHERE ${quoteIdent(matchCol)} = ? LIMIT 1`)
                .get(matchVal)
            : null
        if (existing) {
          const updateCols = keys.filter(k => k !== matchCol)
          if (updateCols.length > 0) {
            const assignments = updateCols.map(col => `${quoteIdent(col)} = ?`).join(', ')
            const values = updateCols.map(col => toBindableScalar(row[col]))
            const res = db
              .prepare(`UPDATE ${quoteIdent(table)} SET ${assignments} WHERE ${quoteIdent(matchCol!)} = ?`)
              .run(...values, matchVal)
            affectedRows += res.changes
          }
        } else {
          const colList = keys.map(quoteIdent).join(', ')
          const placeholders = keys.map(() => '?').join(', ')
          const values = keys.map(col => toBindableScalar(row[col]))
          const res = db
            .prepare(`INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${placeholders})`)
            .run(...values)
          affectedRows += res.changes
        }
      }
    })
    tx()
    const afterSnap = await readSqliteTargetSnapshot(hostPath, table, pkFilter)
    return {
      created: !beforeSnap.exists,
      previousContent: beforeSnap.exists ? beforeSnap.content : null,
      affectedRows,
      renderedAfter: afterSnap.content,
    }
  } finally {
    db.close()
  }
}

function hasReadEvidenceForStructuredTarget(
  context: ToolUseContext,
  target: StructuredWriteTarget,
  canonicalTargetPath: string,
  currentContent: string,
): { ok: true } | { ok: false; stale: boolean } {
  const candidates = [canonicalTargetPath, expandPath(target.rawPath), target.rawPath, target.hostPath]
  const owner = ownerFromToolUseContext(context)
  for (const key of candidates) {
    const entry = context.readFileState.get(key)
    if (entry && !entry.isPartialView) {
      if (existsSync(target.hostPath)) {
        const mtime = getFileModificationTime(target.hostPath)
        if (mtime > entry.timestamp && !(isFullReadEntry(entry) && entry.content === currentContent)) {
          return { ok: false, stale: true }
        }
      }
      return { ok: true }
    }
    if (wholeFileSeen(owner, key, currentContent)) {
      return { ok: true }
    }
  }
  return { ok: false, stale: false }
}

export async function callStructuredWriteTarget(
  target: StructuredWriteTarget,
  content: string,
  context: ToolUseContext,
  startedAt: number,
): Promise<{
  data: FileWriteOutput
  effect: {
    outcome: 'succeeded' | 'no-change'
    operation: 'file.write'
    changedPaths: string[]
    evidence: string
    startedAt: number
    completedAt: number
    details?: { digest: string; bytes: number }
  }
}> {
  const canonicalPath = expandStructuredTargetPath(target.rawPath)
  const owner = ownerFromToolUseContext(context)

  if (target.kind === 'zip-entry') {
    const before = readZipEntryText(target.hostPath, target.entryName)
    if (before.exists && before.content === content) {
      const verdict = recordNoChangeOutcome(owner, {
        operation: 'file.write',
        path: canonicalPath,
        revision: mintFileAnchor(before.content),
        intentDigest: serializeIntentDigest([content]),
        displayPath: target.rawPath,
      })
      return {
        data: {
          type: 'no-change',
          filePath: canonicalPath,
          content,
          structuredPatch: [],
          originalFile: before.content,
          noChange: { streak: verdict.streak, stop: verdict.atCeiling, guidance: verdict.guidance },
        },
        effect: {
          outcome: 'no-change',
          operation: 'file.write',
          changedPaths: [],
          evidence: 'the zip entry already holds the exact bytes; nothing was written',
          startedAt,
          completedAt: Date.now(),
        },
      }
    }
    if (before.exists) {
      const ev = hasReadEvidenceForStructuredTarget(context, target, canonicalPath, before.content)
      if (!ev.ok) {
        throw new Error(ev.stale ? modifiedSinceReadMessage() : unreadExistingWriteMessage())
      }
    }
    const written = writeZipEntryAtomically(target.hostPath, target.entryName, content)
    const writtenAt = existsSync(target.hostPath) ? getFileModificationTime(target.hostPath) : Date.now()
    const normalizedWritten = content.replaceAll('\r\n', '\n')
    for (const key of [canonicalPath, expandPath(target.rawPath), target.rawPath]) {
      context.readFileState.set(key, {
        content: normalizedWritten,
        timestamp: writtenAt,
        offset: undefined,
        limit: undefined,
      })
    }
    recordWholeFileSeen(owner, canonicalPath, `zip:${sha16(normalizedWritten)}`, normalizedWritten)
    const parseError = checkIntroducedParseError(
      target.entryName,
      before.exists ? before.content : null,
      normalizedWritten,
    )
    if (before.exists) {
      const patch = getPatchForDisplay({
        filePath: canonicalPath,
        fileContents: before.content,
        edits: [{ old_string: before.content, new_string: normalizedWritten }],
      })
      countLinesChanged(patch)
      return {
        data: {
          type: 'update',
          filePath: canonicalPath,
          content,
          structuredPatch: patch,
          originalFile: before.content,
          ...(parseError !== undefined ? { parseError } : {}),
        },
        effect: {
          outcome: 'succeeded',
          operation: 'file.write',
          changedPaths: [target.hostPath],
          evidence: `updated zip entry ${target.entryName} in ${target.hostPath} (${written.writtenBytes} bytes)`,
          startedAt,
          completedAt: Date.now(),
          details: { digest: sha16(normalizedWritten), bytes: written.writtenBytes },
        },
      }
    }
    countLinesChanged([], normalizedWritten)
    return {
      data: {
        type: 'create',
        filePath: canonicalPath,
        content,
        structuredPatch: [],
        originalFile: null,
        ...(parseError !== undefined ? { parseError } : {}),
      },
      effect: {
        outcome: 'succeeded',
        operation: 'file.write',
        changedPaths: [target.hostPath],
        evidence: `created zip entry ${target.entryName} in ${target.hostPath} (${written.writtenBytes} bytes)`,
        startedAt,
        completedAt: Date.now(),
        details: { digest: sha16(normalizedWritten), bytes: written.writtenBytes },
      },
    }
  }

  const beforeSnap = await readSqliteTargetSnapshot(target.hostPath, target.table, target.pkFilter)
  if (beforeSnap.exists) {
    const ev = hasReadEvidenceForStructuredTarget(context, target, canonicalPath, beforeSnap.content)
    if (!ev.ok) {
      throw new Error(ev.stale ? modifiedSinceReadMessage() : unreadExistingWriteMessage())
    }
  }
  const written = await writeSqliteRowsParameterised(target.hostPath, target.table, content, target.pkFilter)
  const writtenAt = existsSync(target.hostPath) ? getFileModificationTime(target.hostPath) : Date.now()
  for (const key of [canonicalPath, expandPath(target.rawPath), target.rawPath, target.hostPath]) {
    context.readFileState.set(key, {
      content: written.renderedAfter,
      timestamp: writtenAt,
      offset: undefined,
      limit: undefined,
    })
  }
  recordWholeFileSeen(owner, canonicalPath, `sqlite:${sha16(written.renderedAfter)}`, written.renderedAfter)
  const bytes = Buffer.byteLength(written.renderedAfter, 'utf8')
  if (beforeSnap.exists) {
    const patch = getPatchForDisplay({
      filePath: canonicalPath,
      fileContents: beforeSnap.content,
      edits: [{ old_string: beforeSnap.content, new_string: written.renderedAfter }],
    })
    countLinesChanged(patch)
    return {
      data: {
        type: 'update',
        filePath: canonicalPath,
        content: written.renderedAfter,
        structuredPatch: patch,
        originalFile: beforeSnap.content,
      },
      effect: {
        outcome: 'succeeded',
        operation: 'file.write',
        changedPaths: [target.hostPath],
        evidence: `updated ${written.affectedRows} row(s) in ${target.table} of ${target.hostPath}`,
        startedAt,
        completedAt: Date.now(),
        details: { digest: sha16(written.renderedAfter), bytes },
      },
    }
  }
  countLinesChanged([], written.renderedAfter)
  return {
    data: {
      type: 'create',
      filePath: canonicalPath,
      content: written.renderedAfter,
      structuredPatch: [],
      originalFile: null,
    },
    effect: {
      outcome: 'succeeded',
      operation: 'file.write',
      changedPaths: [target.hostPath],
      evidence: `inserted ${written.affectedRows} row(s) into ${target.table} of ${target.hostPath}`,
      startedAt,
      completedAt: Date.now(),
      details: { digest: sha16(written.renderedAfter), bytes },
    },
  }
}

export async function validateStructuredEditTarget(
  target: StructuredWriteTarget,
  input: FileEditInput,
  context: ToolUseContext,
): Promise<{ result: true } | { result: false; behavior: 'ask'; message: string; errorCode: number }> {
  const canonicalPath = expandStructuredTargetPath(target.rawPath)
  const oldString = input.old_string ?? ''
  const newString = input.new_string ?? ''
  if (oldString !== '' && oldString === newString) {
    return {
      result: false,
      behavior: 'ask',
      message: 'old_string and new_string are identical — there is no edit to apply.',
      errorCode: 1,
    }
  }
  const current =
    target.kind === 'zip-entry'
      ? readZipEntryText(target.hostPath, target.entryName)
      : await readSqliteTargetSnapshot(target.hostPath, target.table, target.pkFilter)
  if (!current.exists) {
    if (oldString === '') return { result: true }
    return {
      result: false,
      behavior: 'ask',
      message: `Target not found: ${target.rawPath}`,
      errorCode: 4,
    }
  }
  const ev = hasReadEvidenceForStructuredTarget(context, target, canonicalPath, current.content)
  if (!ev.ok) {
    return {
      result: false,
      behavior: 'ask',
      message: ev.stale ? modifiedSinceReadMessage() : UNREAD_EXISTING_FILE_NOTE,
      errorCode: ev.stale ? 7 : 6,
    }
  }
  const located = locateActualString(current.content, oldString)
  if (located.kind === 'none') {
    return {
      result: false,
      behavior: 'ask',
      message: `The old_string was not found in the file.\nString: ${oldString}`,
      errorCode: 8,
    }
  }
  return { result: true }
}

export async function callStructuredEditTarget(
  target: StructuredWriteTarget,
  input: FileEditInput,
  context: ToolUseContext,
  startedAt: number,
): Promise<{
  data: FileEditOutput
  effect: {
    outcome: 'succeeded'
    operation: 'file.edit'
    changedPaths: string[]
    evidence: string
    startedAt: number
    completedAt: number
    details: { digest: string; bytes: number; anchorChecked: boolean }
  }
}> {
  const canonicalPath = expandStructuredTargetPath(target.rawPath)
  const oldString = input.old_string ?? ''
  const newString = input.new_string ?? ''
  const replaceAll = input.replace_all === true
  const current =
    target.kind === 'zip-entry'
      ? readZipEntryText(target.hostPath, target.entryName)
      : await readSqliteTargetSnapshot(target.hostPath, target.table, target.pkFilter)
  const freshContent = current.content
  const actualOld = oldString === '' ? '' : (findActualString(freshContent, oldString) ?? oldString)
  const editRes =
    oldString === ''
      ? { updatedFile: newString, patch: getPatchFromContents({ filePath: canonicalPath, oldContent: '', newContent: newString }) }
      : getPatchForEdit({
          filePath: canonicalPath,
          fileContents: freshContent,
          oldString: actualOld,
          newString,
          replaceAll,
        })
  const updatedFile = editRes.updatedFile
  const patch = editRes.patch

  let finalContent = updatedFile
  if (target.kind === 'zip-entry') {
    writeZipEntryAtomically(target.hostPath, target.entryName, updatedFile)
  } else {
    const res = await writeSqliteRowsParameterised(target.hostPath, target.table, updatedFile, target.pkFilter)
    finalContent = res.renderedAfter
  }

  const writtenAt = existsSync(target.hostPath) ? getFileModificationTime(target.hostPath) : Date.now()
  const owner = ownerFromToolUseContext(context)
  for (const key of [canonicalPath, expandPath(target.rawPath), target.rawPath, target.hostPath]) {
    context.readFileState.set(key, {
      content: finalContent,
      timestamp: writtenAt,
      offset: undefined,
      limit: undefined,
    })
  }
  recordWholeFileSeen(owner, canonicalPath, `struct:${sha16(finalContent)}`, finalContent)

  const lines = finalContent === '' ? [] : finalContent.replace(/\n$/, '').split('\n')
  const built = await buildEditedLines({
    written: finalContent,
    patch,
    what: oldString === '' ? 'file created' : '1 occurrence replaced',
    occurrences: 1,
    path: canonicalPath,
    readWindow: async (start, count) => lines.slice(start - 1, start - 1 + count),
  })
  const parseError =
    target.kind === 'zip-entry'
      ? checkIntroducedParseError(target.entryName, current.exists ? freshContent : null, finalContent)
      : undefined
  return {
    data: {
      filePath: canonicalPath,
      oldString,
      newString,
      originalFile: freshContent,
      structuredPatch: patch,
      userModified: Boolean(context.userModifiedInput),
      replaceAll,
      ...(parseError !== undefined ? { parseError } : {}),
      editedLines: built.editedLines,
    },
    effect: {
      outcome: 'succeeded',
      operation: 'file.edit',
      changedPaths: [target.hostPath],
      evidence: `edited structured target ${canonicalPath}`,
      startedAt,
      completedAt: Date.now(),
      details: {
        digest: sha16(finalContent),
        bytes: Buffer.byteLength(finalContent, 'utf8'),
        anchorChecked: false,
      },
    },
  }
}
