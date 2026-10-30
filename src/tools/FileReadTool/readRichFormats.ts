import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { officeWord, officeSlides, officeComments, officeOdf, officeRelationships, officeSheetNames, officeSlideIds, officeSpreadsheet } from './officeText.js'
import { pathToFileURL } from 'node:url'
import { createGunzip, inflateRawSync } from 'node:zlib'
import { hasBinaryExtension } from '../../constants/files.js'
import { formatFileSize } from '../../utils/format.js'

const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'tgz'])
const SQLITE_EXTENSIONS = new Set(['sqlite', 'sqlite3', 'db'])
const DOCUMENT_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'rtf'])

const RICH_CONTAINER_MAX_BYTES = 16 * 1024 * 1024
export const RICH_ENTRY_MAX_BYTES = 4 * 1024 * 1024

type RichFormatKind = 'archive' | 'sqlite' | 'document'

export interface ParsedRichTarget {
  kind: RichFormatKind
  containerPath: string
  ext: string
  subtarget?: string
}

function lowerName(filePath: string): string {
  return (filePath.split(/[\\/]/).pop() ?? '').toLowerCase()
}

function classifyRichFormatExtension(filePath: string): { kind: RichFormatKind; ext: string } | null {
  const name = lowerName(filePath)
  if (name.endsWith('.tar.gz')) return { kind: 'archive', ext: 'tar.gz' }
  const dot = name.lastIndexOf('.')
  if (dot === -1) return null
  const ext = name.slice(dot + 1)
  if (ARCHIVE_EXTENSIONS.has(ext)) return { kind: 'archive', ext }
  if (SQLITE_EXTENSIONS.has(ext)) return { kind: 'sqlite', ext }
  if (DOCUMENT_EXTENSIONS.has(ext)) return { kind: 'document', ext }
  return null
}

export function isRichFormatReadable(filePath: string): boolean {
  return parseRichFormatTarget(filePath) !== null
}

const CONTAINER_SUBTARGET_RE = /^(.+?\.(?:tar\.gz|zip|tar|tgz|sqlite3|sqlite|db))(?:::|!\/|!|:)([\s\S]+)$/i

export function parseRichFormatTarget(filePath: string): ParsedRichTarget | null {
  const m = CONTAINER_SUBTARGET_RE.exec(filePath)
  if (m) {
    const containerPath = m[1]!
    const subtarget = m[2]!.trim()
    if (subtarget !== '') {
      const container = classifyRichFormatExtension(containerPath)
      if (container && (container.kind === 'archive' || container.kind === 'sqlite')) {
        return {
          kind: container.kind,
          containerPath,
          ext: container.ext,
          subtarget,
        }
      }
    }
  }
  const direct = classifyRichFormatExtension(filePath)
  if (direct !== null) {
    return { kind: direct.kind, containerPath: filePath, ext: direct.ext }
  }
  return null
}

export function statBoundedContainer(filePath: string): number {
  const st = statSync(filePath)
  if (!st.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`)
  }
  if (st.size > RICH_CONTAINER_MAX_BYTES) {
    throw new Error(
      `Container file (${formatFileSize(st.size)}) exceeds the maximum allowed container size (${formatFileSize(RICH_CONTAINER_MAX_BYTES)}): ${filePath}`,
    )
  }
  return st.size
}

export interface ArchiveEntryMeta {
  name: string
  uncompressedSize: number
  compressedSize: number
  isDirectory: boolean
  method: number
  localHeaderOffset: number
  data?: Buffer
  central?: { offset: number; length: number; flags: number; crc32: number; externalAttrs: number }
}

export function findEocdOffset(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      return i
    }
  }
  return -1
}

export function readZipEntries(buf: Buffer, filePath = 'archive.zip'): ArchiveEntryMeta[] {
  const eocd = findEocdOffset(buf)
  const entries: ArchiveEntryMeta[] = []
  if (eocd !== -1) {
    const totalEntries = buf.readUInt16LE(eocd + 10)
    const cdSize = buf.readUInt32LE(eocd + 12)
    const cdOffset = buf.readUInt32LE(eocd + 16)
    const corrupt = () => new Error(`${filePath}: corrupt ZIP central directory.`)
    const end = cdOffset + cdSize
    if (end > eocd || eocd + 22 + buf.readUInt16LE(eocd + 20) > buf.length || buf.readUInt16LE(eocd + 8) !== totalEntries) throw corrupt()
    let pos = cdOffset
    for (let i = 0; i < totalEntries; i++) {
      if (pos + 46 > end || buf.readUInt32LE(pos) !== 0x02014b50) throw corrupt()
      const flags = buf.readUInt16LE(pos + 8)
      const method = buf.readUInt16LE(pos + 10)
      const entryCrc = buf.readUInt32LE(pos + 16)
      const compressedSize = buf.readUInt32LE(pos + 20)
      const uncompressedSize = buf.readUInt32LE(pos + 24)
      const nameLen = buf.readUInt16LE(pos + 28)
      const extraLen = buf.readUInt16LE(pos + 30)
      const commentLen = buf.readUInt16LE(pos + 32)
      const externalAttrs = buf.readUInt32LE(pos + 38)
      const localHeaderOffset = buf.readUInt32LE(pos + 42)
      const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
      const length = 46 + nameLen + extraLen + commentLen
      if (pos + length > end || localHeaderOffset + 30 > cdOffset) throw corrupt()
      entries.push({
        name,
        uncompressedSize,
        compressedSize,
        isDirectory: name.endsWith('/'),
        method,
        localHeaderOffset,
        central: { offset: pos, length, flags, crc32: entryCrc, externalAttrs },
      })
      pos += length
    }
    if (pos !== end) throw corrupt()
    return entries
  }
  let pos = 0
  while (pos + 30 <= buf.length && buf.readUInt32LE(pos) === 0x04034b50) {
    const method = buf.readUInt16LE(pos + 8)
    const compressedSize = buf.readUInt32LE(pos + 18)
    const uncompressedSize = buf.readUInt32LE(pos + 22)
    const nameLen = buf.readUInt16LE(pos + 26)
    const extraLen = buf.readUInt16LE(pos + 28)
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8')
    entries.push({
      name,
      uncompressedSize,
      compressedSize,
      isDirectory: name.endsWith('/'),
      method,
      localHeaderOffset: pos,
    })
    pos += 30 + nameLen + extraLen + compressedSize
  }
  if (entries.length === 0) {
    throw new Error(`Invalid or corrupt zip archive (missing central directory and local file headers): ${filePath}`)
  }
  return entries
}

export function extractZipEntryBuffer(buf: Buffer, entry: ArchiveEntryMeta): Buffer {
  if (entry.uncompressedSize > RICH_ENTRY_MAX_BYTES) {
    throw new Error(
      `Archive entry "${entry.name}" (${formatFileSize(entry.uncompressedSize)} uncompressed) exceeds the maximum allowed entry size (${formatFileSize(RICH_ENTRY_MAX_BYTES)}).`,
    )
  }
  const pos = entry.localHeaderOffset
  if (pos + 30 > buf.length || buf.readUInt32LE(pos) !== 0x04034b50) {
    throw new Error(`Invalid local file header for zip entry "${entry.name}".`)
  }
  const nameLen = buf.readUInt16LE(pos + 26)
  const extraLen = buf.readUInt16LE(pos + 28)
  const dataStart = pos + 30 + nameLen + extraLen
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buf.length) {
    throw new Error(`Truncated zip entry "${entry.name}".`)
  }
  const raw = buf.subarray(dataStart, dataEnd)
  if (entry.method === 0) {
    if (raw.length > RICH_ENTRY_MAX_BYTES) {
      throw new Error(
        `Archive entry "${entry.name}" (${formatFileSize(raw.length)}) exceeds the maximum allowed entry size (${formatFileSize(RICH_ENTRY_MAX_BYTES)}).`,
      )
    }
    return raw
  }
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength: RICH_ENTRY_MAX_BYTES })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/maxOutputLength|Cannot create a Buffer larger than|output length/i.test(msg)) {
        throw new Error(
          `Archive entry "${entry.name}" inflated past the maximum allowed entry size (${formatFileSize(RICH_ENTRY_MAX_BYTES)}).`,
        )
      }
      throw err
    }
  }
  throw new Error(`Unsupported zip compression method ${entry.method} for entry "${entry.name}".`)
}

function parseOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim()
  if (raw === '') return 0
  const n = Number.parseInt(raw, 8)
  return Number.isFinite(n) ? n : 0
}

function cString(buf: Buffer, offset: number, length: number): string {
  const sub = buf.subarray(offset, offset + length)
  const nul = sub.indexOf(0)
  return (nul === -1 ? sub : sub.subarray(0, nul)).toString('utf8')
}

function verifyTarHeaderChecksum(header: Buffer): boolean {
  const rawChk = header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim()
  if (rawChk === '' || !/^[0-7]+$/.test(rawChk)) return false
  const expected = Number.parseInt(rawChk, 8)
  if (!Number.isFinite(expected)) return false
  let unsignedSum = 0
  let signedSum = 0
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i]!
    unsignedSum += b
    signedSum += b > 127 ? b - 256 : b
  }
  return expected === unsignedSum || expected === signedSum
}

function readTarEntriesFromFile(filePath: string, wantedSubtarget?: string): ArchiveEntryMeta[] {
  const normalizedWanted = wantedSubtarget?.replace(/^\/+/, '')
  const fd = openSync(filePath, 'r')
  const entries: ArchiveEntryMeta[] = []
  let pos = 0
  let pendingLongName: string | null = null
  const header = Buffer.alloc(512)

  try {
    while (true) {
      const read = readSync(fd, header, 0, 512, pos)
      if (read === 0) break
      if (read < 512) {
        throw new Error(`Not a valid tar archive (truncated header at byte offset ${pos}): ${filePath}`)
      }
      let allZero = true
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) {
          allZero = false
          break
        }
      }
      if (allZero) break
      if (!verifyTarHeaderChecksum(header)) {
        throw new Error(`Not a tar archive (header checksum failed at byte offset ${pos}): ${filePath}`)
      }

      const namePart = cString(header, 0, 100)
      const size = parseOctal(header, 124, 12)
      const typeFlag = header[156] ?? 0
      const magic = cString(header, 257, 6)
      const prefix = magic.startsWith('ustar') ? cString(header, 345, 155) : ''
      const dataStart = pos + 512
      const paddedSize = Math.ceil(size / 512) * 512

      if (typeFlag === 0x4c) {
        const cap = Math.min(size, 65536)
        const nameBuf = Buffer.alloc(cap)
        readSync(fd, nameBuf, 0, cap, dataStart)
        pendingLongName = cString(nameBuf, 0, cap)
        pos = dataStart + paddedSize
        continue
      }
      if (typeFlag === 0x78 || typeFlag === 0x67) {
        const cap = Math.min(size, 65536)
        const paxBuf = Buffer.alloc(cap)
        readSync(fd, paxBuf, 0, cap, dataStart)
        const pax = paxBuf.toString('utf8')
        const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(pax)
        if (m && typeFlag === 0x78) pendingLongName = m[1]!
        pos = dataStart + paddedSize
        continue
      }

      const fullName = pendingLongName ?? (prefix ? `${prefix}/${namePart}` : namePart)
      pendingLongName = null
      const isDir = typeFlag === 0x35 || fullName.endsWith('/')
      const matchesTarget =
        wantedSubtarget !== undefined &&
        (fullName === wantedSubtarget || fullName.replace(/^\/+/, '') === normalizedWanted)

      let data: Buffer | undefined
      if (matchesTarget && !isDir) {
        if (size > RICH_ENTRY_MAX_BYTES) {
          throw new Error(
            `Archive entry "${fullName}" (${formatFileSize(size)}) exceeds the maximum allowed entry size (${formatFileSize(RICH_ENTRY_MAX_BYTES)}).`,
          )
        }
        data = Buffer.alloc(size)
        const got = readSync(fd, data, 0, size, dataStart)
        if (got < size) {
          throw new Error(`Truncated tar entry "${fullName}" in ${filePath}.`)
        }
      }

      entries.push({
        name: fullName,
        uncompressedSize: size,
        compressedSize: size,
        isDirectory: isDir,
        method: 0,
        localHeaderOffset: dataStart,
        data,
      })

      pos = dataStart + paddedSize
    }
    return entries
  } finally {
    closeSync(fd)
  }
}

async function readTgzEntriesStreaming(filePath: string, wantedSubtarget?: string): Promise<ArchiveEntryMeta[]> {
  const normalizedWanted = wantedSubtarget?.replace(/^\/+/, '')
  const entries: ArchiveEntryMeta[] = []
  const fd = openSync(filePath, 'r')
  const gunzip = createGunzip()

  let state: string = 'header'
  let headerFill = 0
  const headerBuf = Buffer.alloc(512)
  let remainingPayload = 0
  let remainingPad = 0
  let streamOffset = 0
  let pendingLongName: string | null = null
  let currentMeta: {
    typeFlag: number
    fullName: string
    size: number
    isDir: boolean
    dataStart: number
    collect: boolean
    chunks: Buffer[]
    collected: number
  } | null = null

  const consumeDecompressed = (chunk: Buffer): void => {
    let idx = 0
    while (idx < chunk.length && state !== 'done') {
      if (state === 'header') {
        const take = Math.min(512 - headerFill, chunk.length - idx)
        chunk.copy(headerBuf, headerFill, idx, idx + take)
        headerFill += take
        idx += take
        if (headerFill === 512) {
          headerFill = 0
          let allZero = true
          for (let i = 0; i < 512; i++) {
            if (headerBuf[i] !== 0) {
              allZero = false
              break
            }
          }
          if (allZero) {
            state = 'done'
            break
          }
          if (!verifyTarHeaderChecksum(headerBuf)) {
            throw new Error(`Not a tar archive (header checksum failed at decompressed byte offset ${streamOffset}): ${filePath}`)
          }
          const namePart = cString(headerBuf, 0, 100)
          const size = parseOctal(headerBuf, 124, 12)
          const typeFlag = headerBuf[156] ?? 0
          const magic = cString(headerBuf, 257, 6)
          const prefix = magic.startsWith('ustar') ? cString(headerBuf, 345, 155) : ''
          const dataStart = streamOffset + 512
          streamOffset += 512
          const paddedSize = Math.ceil(size / 512) * 512
          remainingPayload = size
          remainingPad = paddedSize - size

          const fullName = pendingLongName ?? (prefix ? `${prefix}/${namePart}` : namePart)
          const isMeta = typeFlag === 0x4c || typeFlag === 0x78 || typeFlag === 0x67
          if (!isMeta) pendingLongName = null
          const isDir = typeFlag === 0x35 || fullName.endsWith('/')
          const matchesTarget =
            wantedSubtarget !== undefined &&
            (fullName === wantedSubtarget || fullName.replace(/^\/+/, '') === normalizedWanted)

          if (matchesTarget && !isDir && size > RICH_ENTRY_MAX_BYTES) {
            throw new Error(
              `Archive entry "${fullName}" (${formatFileSize(size)}) exceeds the maximum allowed entry size (${formatFileSize(RICH_ENTRY_MAX_BYTES)}).`,
            )
          }

          const collect = isMeta ? size <= 65536 : (matchesTarget && !isDir)
          currentMeta = {
            typeFlag,
            fullName,
            size,
            isDir,
            dataStart,
            collect,
            chunks: [],
            collected: 0,
          }
          if (remainingPayload > 0) {
            state = 'data'
          } else if (remainingPad > 0) {
            finishCurrentEntry()
            state = 'skip'
          } else {
            finishCurrentEntry()
            state = 'header'
          }
        }
        continue
      }

      if (state === 'data') {
        const take = Math.min(remainingPayload, chunk.length - idx)
        if (currentMeta?.collect) {
          currentMeta.chunks.push(Buffer.from(chunk.subarray(idx, idx + take)))
          currentMeta.collected += take
        }
        idx += take
        remainingPayload -= take
        streamOffset += take
        if (remainingPayload === 0) {
          finishCurrentEntry()
          state = remainingPad > 0 ? 'skip' : 'header'
        }
        continue
      }

      if (state === 'skip') {
        const take = Math.min(remainingPad, chunk.length - idx)
        idx += take
        remainingPad -= take
        streamOffset += take
        if (remainingPad === 0) {
          state = 'header'
        }
      }
    }
  }

  const finishCurrentEntry = (): void => {
    if (!currentMeta) return
    const meta = currentMeta
    currentMeta = null
    const payload = meta.collect ? Buffer.concat(meta.chunks) : undefined
    if (meta.typeFlag === 0x4c && payload) {
      pendingLongName = cString(payload, 0, payload.length)
      return
    }
    if ((meta.typeFlag === 0x78 || meta.typeFlag === 0x67) && payload) {
      const pax = payload.toString('utf8')
      const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(pax)
      if (m && meta.typeFlag === 0x78) pendingLongName = m[1]!
      return
    }
    entries.push({
      name: meta.fullName,
      uncompressedSize: meta.size,
      compressedSize: meta.size,
      isDirectory: meta.isDir,
      method: 0,
      localHeaderOffset: meta.dataStart,
      data: payload,
    })
  }

  let streamErr: unknown = null
  gunzip.on('data', (chunk: Buffer) => {
    if (streamErr !== null) return
    try {
      consumeDecompressed(chunk)
    } catch (e) {
      streamErr = e
    }
  })
  gunzip.on('error', err => {
    if (state !== 'done' && streamErr === null) streamErr = err
  })

  const readBuf = Buffer.alloc(16384)
  let filePos = 0
  try {
    while (state !== 'done' && streamErr === null) {
      const bytesRead = readSync(fd, readBuf, 0, readBuf.length, filePos)
      if (bytesRead === 0) {
        await new Promise<void>(resolve => gunzip.end(() => resolve()))
        break
      }
      filePos += bytesRead
      await new Promise<void>(resolve => gunzip.write(readBuf.subarray(0, bytesRead), () => resolve()))
    }
    if (state !== 'done' && streamErr !== null) throw streamErr
    return entries
  } finally {
    gunzip.destroy()
    closeSync(fd)
  }
}

export function isNestedArchiveOrBinaryEntry(entryName: string): { kind: 'nested-archive' | 'binary'; ext: string } | null {
  const lower = entryName.toLowerCase()
  if (lower.endsWith('.tar.gz')) return { kind: 'nested-archive', ext: 'tar.gz' }
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return null
  const ext = lower.slice(dot + 1)
  if (ARCHIVE_EXTENSIONS.has(ext)) return { kind: 'nested-archive', ext }
  if (hasBinaryExtension(entryName)) return { kind: 'binary', ext }
  return null
}

export function hasNonTextBytes(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 4096)
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export interface RichRender {
  text: string
  ownBytes: boolean
}

export async function renderArchiveTarget(
  containerPath: string,
  ext: string,
  subtarget?: string,
): Promise<RichRender> {
  statBoundedContainer(containerPath)
  const isTgz = ext === 'tar.gz' || ext === 'tgz'
  const isTar = ext === 'tar' || isTgz

  let zipBuf: Buffer | null = null
  let entries: ArchiveEntryMeta[]
  if (isTgz) {
    entries = await readTgzEntriesStreaming(containerPath, subtarget)
  } else if (ext === 'tar') {
    entries = readTarEntriesFromFile(containerPath, subtarget)
  } else {
    zipBuf = readFileSync(containerPath)
    entries = readZipEntries(zipBuf, containerPath)
  }

  if (subtarget !== undefined && subtarget !== '') {
    const normalizedWanted = subtarget.replace(/^\/+/, '')
    const entry =
      entries.find(e => e.name === subtarget) ??
      entries.find(e => e.name.replace(/^\/+/, '') === normalizedWanted)
    if (!entry) {
      const names = entries.slice(0, 20).map(e => e.name).join(', ')
      throw new Error(
        `Archive entry "${subtarget}" not found in ${containerPath}. Available entries (${entries.length}): ${names}`,
      )
    }
    if (entry.isDirectory) {
      const children = entries
        .filter(e => e !== entry && e.name.replace(/^\/+/, '').startsWith(normalizedWanted.replace(/\/?$/, '/')))
        .map(e => `${e.name}\t(${e.uncompressedSize} B)`)
      return {
        text: [
          `(archive: ${ext} · entry: ${entry.name} · directory · ${children.length} children)`,
          ...children,
        ].join('\n'),
        ownBytes: false,
      }
    }
    const special = isNestedArchiveOrBinaryEntry(entry.name)
    if (special !== null) {
      return {
        text: `(archive: ${ext} · entry: ${entry.name} · ${special.kind === 'nested-archive' ? `nested archive (.${special.ext})` : `binary file (.${special.ext})`} · ${entry.uncompressedSize} B — binary/nested archive entry is not decoded as text)`,
        ownBytes: false,
      }
    }
    const data = isTar ? (entry.data ?? Buffer.alloc(0)) : extractZipEntryBuffer(zipBuf!, entry)
    if (hasNonTextBytes(data)) {
      return {
        text: `(archive: ${ext} · entry: ${entry.name} · binary entry · ${data.length} B — binary content is not decoded as text)`,
        ownBytes: false,
      }
    }
    return { text: data.toString('utf8'), ownBytes: true }
  }

  const lines = [
    `(archive: ${ext} · entries: ${entries.length} · pass file_path "${containerPath}:<entry>" to read one entry)`,
    ...entries.map(e =>
      e.isDirectory
        ? `${e.name}\t(dir)`
        : `${e.name}\t(${e.uncompressedSize} B)`,
    ),
  ]
  return { text: lines.join('\n'), ownBytes: false }
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos|nbsp);/g, (full, entity: string) => {
    switch (entity) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'amp':
        return '&'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'nbsp':
        return ' '
      default: {
        const code = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full
      }
    }
  })
}

function readSelectedZipEntries(
  buf: Buffer,
  filePath: string,
  filter: (name: string) => boolean,
): Map<string, Buffer> {
  const map = new Map<string, Buffer>()
  for (const entry of readZipEntries(buf, filePath)) {
    if (entry.isDirectory || !filter(entry.name)) continue
    map.set(entry.name, extractZipEntryBuffer(buf, entry))
  }
  return map
}

function extractDocxText(buf: Buffer, filePath: string): string {
  const entries = readSelectedZipEntries(buf, filePath, name => /^word\/(?:document|styles|footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/.test(name))
  const order = [...[...entries.keys()].filter(k => /^word\/header\d*\.xml$/.test(k)).sort(), 'word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml', ...[...entries.keys()].filter(k => /^word\/footer\d*\.xml$/.test(k)).sort()]
  const styles = entries.get('word/styles.xml')?.toString('utf8')
  return order.map(key => entries.has(key) ? officeWord(entries.get(key)!.toString('utf8'), styles) : '').filter(Boolean).join('\n\n')
}

function officeTarget(base: string, target: string): string {
  return posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(base, target))
}

function extractXlsxText(buf: Buffer, filePath: string): string {
  const entries = readSelectedZipEntries(buf, filePath, name => name === 'xl/sharedStrings.xml' || name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/[^/]+\.xml$/.test(name))
  const sharedStrings = [...(entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(si => [...si[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(t => decodeXmlEntities(t[1]!)).join(''))
  const names = officeSheetNames(entries.get('xl/workbook.xml')?.toString('utf8') ?? '')
  const rels = officeRelationships(entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '')
  const keys = [...entries.keys()].filter(k => /^xl\/worksheets\/[^/]+\.xml$/.test(k)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const ordered = names.length ? names.map((sheet, i) => ({ name: sheet.name, key: rels.has(sheet.id) ? officeTarget('xl', rels.get(sheet.id)!) : keys[i] })) : keys.map((key, i) => ({ key, name: `Sheet${i + 1}` }))
  return ordered.map(({ name, key }) => key && entries.has(key) ? `## ${name}\n${officeSpreadsheet(entries.get(key)!.toString('utf8'), sharedStrings)}` : '').filter(Boolean).join('\n\n')
}

function extractPptxText(buf: Buffer, filePath: string): string {
  const entries = readSelectedZipEntries(buf, filePath, name => name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels' || /^ppt\/(?:slides|notesSlides|comments)\/(?:_rels\/)?[^/]+\.(?:xml|rels)$/.test(name))
  const presentationRels = officeRelationships(entries.get('ppt/_rels/presentation.xml.rels')?.toString('utf8') ?? '')
  const ids = officeSlideIds(entries.get('ppt/presentation.xml')?.toString('utf8') ?? '')
  const keys = ids.length ? ids.map(id => officeTarget('ppt', presentationRels.get(id) ?? '')).filter(key => entries.has(key)) : [...entries.keys()].filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return keys.map((key, i) => {
    const rels = officeRelationships(entries.get(`ppt/slides/_rels/${posix.basename(key)}.rels`)?.toString('utf8') ?? '')
    const parts = [`## Slide ${i + 1}`, officeSlides(entries.get(key)!.toString('utf8'))]
    for (const target of rels.values()) {
      const path = officeTarget('ppt/slides', target)
      const content = entries.get(path)?.toString('utf8')
      if (!content) continue
      if (path.startsWith('ppt/notesSlides/')) parts.push(`### Notes\n${officeSlides(content)}`)
      if (path.startsWith('ppt/comments/')) parts.push(`### Comments\n${officeComments(content)}`)
    }
    return parts.filter(Boolean).join('\n')
  }).join('\n\n')
}

function extractOdfText(buf: Buffer, filePath: string): string {
  const entries = readSelectedZipEntries(buf, filePath, name => name === 'content.xml')
  const content = entries.get('content.xml')
  return content ? officeOdf(content.toString('utf8')) : ''
}

function stripHtmlToText(html: string): string {
  const cleaned = html
    .replace(/<(?:script|style|head)\b[^>]*>[\s\S]*?<\/(?:script|style|head)>/gi, '')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '')
  return decodeXmlEntities(cleaned)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractEpubText(buf: Buffer, filePath: string): string {
  const allMeta = readZipEntries(buf, filePath)
  const byName = new Map(allMeta.filter(e => !e.isDirectory).map(e => [e.name, e]))
  const extractNamed = (name: string): Buffer | undefined => {
    const meta = byName.get(name)
    return meta ? extractZipEntryBuffer(buf, meta) : undefined
  }

  let opfPath: string | undefined
  const containerRaw = extractNamed('META-INF/container.xml')
  if (containerRaw) {
    const containerXml = containerRaw.toString('utf8')
    opfPath = /full-path="([^"]+)"/.exec(containerXml)?.[1]
  }
  if (!containerRaw) throw new Error(`${filePath}: EPUB is missing META-INF/container.xml.`)
  if (!opfPath || !byName.has(opfPath)) throw new Error(`${filePath}: EPUB container.xml names no readable package.`)

  const orderedDocs: string[] = []
  if (opfPath && byName.has(opfPath)) {
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
    const opfXml = extractNamed(opfPath)!.toString('utf8')
    const manifest = new Map<string, string>()
    const itemRe = /<item\b([^>]+)>/g
    let im: RegExpExecArray | null
    while ((im = itemRe.exec(opfXml)) !== null) {
      const attrs = im[1]!
      const id = /\bid="([^"]+)"/.exec(attrs)?.[1]
      const href = /\bhref="([^"]+)"/.exec(attrs)?.[1]
      if (id && href) manifest.set(id, `${opfDir}${href}`)
    }
    const itemrefRe = /<itemref\b[^>]*\bidref="([^"]+)"[^>]*>/g
    let irm: RegExpExecArray | null
    while ((irm = itemrefRe.exec(opfXml)) !== null) {
      const p = manifest.get(irm[1]!)
      if (p && byName.has(p)) orderedDocs.push(p)
    }
  }
  if (orderedDocs.length === 0) {
    orderedDocs.push(
      ...[...byName.keys()]
        .filter(k => /\.(?:xhtml|html|htm)$/i.test(k))
        .sort(),
    )
  }

  const parts: string[] = []
  for (const docKey of orderedDocs.slice(0, 200)) {
    const raw = extractNamed(docKey)
    if (!raw) continue
    const text = stripHtmlToText(raw.toString('utf8'))
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

function extractRtfText(rtf: string, filePath: string): string {
  const out: string[] = []
  const skipDestinations = new Set([
    'fonttbl',
    'colortbl',
    'stylesheet',
    'info',
    'pict',
    'object',
    'header',
    'footer',
    'fldinst',
    'themedata',
    'colorschememapping',
    'latentstyles',
    'datastore',
  ])
  const stack: { skip: boolean }[] = []
  let skip = false
  let i = 0
  const len = rtf.length

  while (i < len) {
    const ch = rtf[i]!
    if (ch === '{') {
      stack.push({ skip })
      i++
      if (rtf[i] === '\\' && rtf[i + 1] === '*') {
        skip = true
        i += 2
      }
      continue
    }
    if (ch === '}') {
      const prev = stack.pop()
      if (!prev) throw new Error(`${filePath}: RTF has unbalanced groups.`)
      skip = prev.skip
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (ch === '\\') {
      i++
      if (i >= len) break
      const next = rtf[i]!
      if (next === '\\' || next === '{' || next === '}') {
        if (!skip) out.push(next)
        i++
        continue
      }
      if (next === '~') {
        if (!skip) out.push(' ')
        i++
        continue
      }
      if (next === '-') {
        i++
        continue
      }
      if (next === '_') {
        if (!skip) out.push('-')
        i++
        continue
      }
      if (next === '\'') {
        const hex = rtf.slice(i + 1, i + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex) && !skip) {
          out.push(String.fromCharCode(Number.parseInt(hex, 16)))
        }
        i += 3
        continue
      }
      if (next === '\r' || next === '\n') {
        if (!skip) out.push('\n')
        i++
        continue
      }
      const wordMatch = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i))
      if (wordMatch) {
        const word = wordMatch[1]!.toLowerCase()
        const param = wordMatch[2]
        i += wordMatch[0].length
        if (word === 'bin' && param !== undefined) {
          const count = Number(param)
          if (count < 0 || i + count > len) throw new Error(`${filePath}: truncated RTF binary data.`)
          i += count
          continue
        }
        if (skipDestinations.has(word)) {
          skip = true
          continue
        }
        if (!skip) {
          if (word === 'par' || word === 'line' || word === 'row' || word === 'sect' || word === 'page') {
            out.push('\n')
          } else if (word === 'tab' || word === 'cell') {
            out.push('\t')
          } else if (word === 'emdash') {
            out.push('\u2014')
          } else if (word === 'endash') {
            out.push('\u2013')
          } else if (word === 'lquote') {
            out.push('\u2018')
          } else if (word === 'rquote') {
            out.push('\u2019')
          } else if (word === 'ldblquote') {
            out.push('\u201C')
          } else if (word === 'rdblquote') {
            out.push('\u201D')
          } else if (word === 'bullet') {
            out.push('\u2022')
          } else if (word === 'u' && param !== undefined) {
            let code = Number.parseInt(param, 10)
            if (code < 0) code += 65536
            if (code > 0 && code <= 0x10ffff) out.push(String.fromCodePoint(code))
            if (rtf[i] === '?') i++
          }
        }
        continue
      }
      i++
      continue
    }
    if (!skip) out.push(ch)
    i++
  }

  if (stack.length) throw new Error(`${filePath}: RTF has unbalanced groups.`)
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function renderDocumentTarget(filePath: string, ext: string): string {
  statBoundedContainer(filePath)
  return renderDocumentBytes(readFileSync(filePath), ext, filePath)
}

export function renderDocumentBytes(buf: Buffer, ext: string, filePath = `document.${ext}`): string {
  if (buf.length > RICH_CONTAINER_MAX_BYTES) throw new Error(`Container file (${formatFileSize(buf.length)}) exceeds the maximum allowed container size (${formatFileSize(RICH_CONTAINER_MAX_BYTES)}): ${filePath}`)
  if (ext !== 'rtf' && findEocdOffset(buf) === -1) throw new Error(`${filePath}: truncated ZIP; central directory is missing.`)
  let body = ''
  switch (ext) {
    case 'docx':
      body = extractDocxText(buf, filePath)
      break
    case 'xlsx':
      body = extractXlsxText(buf, filePath)
      break
    case 'pptx':
      body = extractPptxText(buf, filePath)
      break
    case 'odt':
    case 'ods':
    case 'odp':
      body = extractOdfText(buf, filePath)
      break
    case 'epub':
      body = extractEpubText(buf, filePath)
      break
    case 'rtf':
      body = extractRtfText(buf.toString('latin1'), filePath)
      break
  }
  return `(document: ${ext})\n${body}`.trimEnd()
}

type SqliteStmt = {
  all(...params: unknown[]): Record<string, unknown>[]
  safeIntegers?(on: boolean): SqliteStmt
}
export type SqliteDb = {
  prepare(sql: string): SqliteStmt
  close(): unknown
}

const SQLITE_SAMPLE_ROWS = 20
const SQLITE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SqliteRowSelector = { column: string | null; value: string }

export function parseSqliteSubtarget(
  subtarget: string,
): { ok: true; table: string; selector: SqliteRowSelector | null } | { ok: false; reason: string } {
  const slash = subtarget.indexOf('/')
  const table = (slash === -1 ? subtarget : subtarget.slice(0, slash)).trim()
  if (!SQLITE_IDENTIFIER.test(table)) {
    return {
      ok: false,
      reason: `"${table}" is not a table name: a table is named with letters, digits and underscores only (db.sqlite:table or db.sqlite:table/key).`,
    }
  }
  if (slash === -1) return { ok: true, table, selector: null }
  const rest = subtarget.slice(slash + 1).trim()
  if (rest === '') {
    return { ok: false, reason: `The row selector after "${table}/" is empty: name the row as ${table}/<key> or ${table}/<column>=<value>.` }
  }
  const eq = rest.indexOf('=')
  const column = eq === -1 ? null : rest.slice(0, eq).trim()
  const value = (eq === -1 ? rest : rest.slice(eq + 1)).trim()
  const sqlLike = (s: string): boolean =>
    /[;'"`\u0000-\u001f]|--|\/\*|\s+(?:OR|AND|UNION|SELECT|INSERT|UPDATE|DELETE|DROP|WHERE)\b/i.test(s)
  if (column !== null && !SQLITE_IDENTIFIER.test(column)) {
    if (/\s|--|\/\*|;/.test(column)) {
      return { ok: false, reason: `The row selector "${rest}" is a key value, never SQL: quotes, SQL clauses, semicolons and control characters are refused.` }
    }
    return { ok: false, reason: `"${column}" is not a column name: a column is named with letters, digits and underscores only (${table}/<column>=<value>).` }
  }
  if (value === '') {
    return { ok: false, reason: `The row selector "${rest}" names no value: write ${table}/<key> or ${table}/<column>=<value>.` }
  }
  if (sqlLike(value)) {
    return { ok: false, reason: `The row selector "${rest}" is a key value, never SQL: quotes, SQL clauses, semicolons and control characters are refused.` }
  }
  return { ok: true, table, selector: { column, value } }
}

type SqliteColumnInfo = { cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }

type SqliteRowAddress =
  | { kind: 'column'; column: string }
  | { kind: 'rowid' }
  | { kind: 'composite'; columns: string[] }

export function sqliteTableShape(db: SqliteDb, table: string): { columns: SqliteColumnInfo[]; address: SqliteRowAddress } {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as SqliteColumnInfo[]
  const keyed = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk)
  if (keyed.length === 1) return { columns, address: { kind: 'column', column: keyed[0]!.name } }
  if (keyed.length > 1) return { columns, address: { kind: 'composite', columns: keyed.map(c => c.name) } }
  return { columns, address: { kind: 'rowid' } }
}

export function sqliteKeyBinding(value: string): number | bigint | string {
  if (/^-?\d{1,15}$/.test(value)) return Number(value)
  if (/^-?\d{16,20}$/.test(value)) {
    try {
      const big = BigInt(value)
      if (big >= -9223372036854775808n && big <= 9223372036854775807n) return big
    } catch {}
  }
  return value
}

function sqliteRows(db: SqliteDb, sql: string, params: unknown[]): Record<string, unknown>[] {
  const stmt = db.prepare(sql)
  return (stmt.safeIntegers?.(true) ?? stmt).all(...params)
}

export function selectSqliteRows(
  db: SqliteDb,
  table: string,
  shape: { columns: SqliteColumnInfo[]; address: SqliteRowAddress },
  selector: SqliteRowSelector,
): { matchColumn: string; rows: Record<string, unknown>[] } {
  const { address } = shape
  let matchColumn: string
  if (selector.column === null) {
    if (address.kind === 'composite') {
      throw new Error(
        `Table "${table}" has a composite primary key (${address.columns.join(', ')}); select a row with ${table}/<column>=<value>.`,
      )
    }
    matchColumn = address.kind === 'column' ? address.column : 'rowid'
  } else {
    const known = shape.columns.some(c => c.name === selector.column) || (address.kind === 'rowid' && selector.column === 'rowid')
    if (!known) {
      throw new Error(`Table "${table}" has no column "${selector.column}" (columns: ${shape.columns.map(c => c.name).join(', ')}).`)
    }
    matchColumn = selector.column
  }
  const projection = address.kind === 'rowid' ? 'rowid, *' : '*'
  const rows = sqliteRows(
    db,
    `SELECT ${projection} FROM ${quoteIdent(table)} WHERE ${quoteIdent(matchColumn)} = ? LIMIT 3`,
    [sqliteKeyBinding(selector.value)],
  )
  return { matchColumn, rows }
}

export function renderSqliteValue(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'bigint') {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? String(v) : JSON.stringify(String(v))
  }
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return JSON.stringify(`<BLOB ${v.byteLength}B>`)
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  return JSON.stringify(String(v))
}

export function renderSqliteRow(row: Record<string, unknown>): string {
  const fields = Object.keys(row).map(key => `  ${JSON.stringify(key)}: ${renderSqliteValue(row[key])}`)
  return `{\n${fields.join(',\n')}\n}\n`
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return `<BLOB ${v.byteLength}B>`
  const s = String(v).replace(/\r?\n/g, ' ')
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

function queryBoundedSqliteRows(
  db: SqliteDb,
  tableName: string,
  limit: number,
): { cols: string[]; rows: Record<string, unknown>[] } {
  const qName = quoteIdent(tableName)
  const info = db.prepare(`PRAGMA table_info(${qName})`).all() as Array<{ name?: unknown }>
  const cols = info.map(c => String(c.name ?? '')).filter(Boolean)
  if (cols.length === 0) return { cols: [], rows: [] }
  const exprs = cols.map(c => {
    const qCol = quoteIdent(c)
    return `CASE WHEN typeof(${qCol}) = 'blob' THEN '<BLOB ' || length(${qCol}) || 'B>' WHEN typeof(${qCol}) = 'text' AND length(${qCol}) > 200 THEN substr(${qCol}, 1, 200) || '…' ELSE ${qCol} END AS ${qCol}`
  })
  const rows = db.prepare(`SELECT ${exprs.join(', ')} FROM ${qName} LIMIT ${limit}`).all()
  return { cols, rows }
}

function sqliteRowNotFoundMessage(table: string, matchColumn: string, value: string, dbPath: string): string {
  return `No row of table "${table}" has ${matchColumn} = ${value} in ${dbPath}.`
}

export function sqliteRowAmbiguousMessage(table: string, matchColumn: string, value: string): string {
  return `More than one row of table "${table}" has ${matchColumn} = ${value}; select the row by its key column instead.`
}

function renderSqliteRowTarget(
  db: SqliteDb,
  dbPath: string,
  table: string,
  selector: SqliteRowSelector,
): string {
  const shape = sqliteTableShape(db, table)
  const { matchColumn, rows } = selectSqliteRows(db, table, shape, selector)
  if (rows.length === 0) throw new Error(sqliteRowNotFoundMessage(table, matchColumn, selector.value, dbPath))
  if (rows.length > 1) throw new Error(sqliteRowAmbiguousMessage(table, matchColumn, selector.value))
  return renderSqliteRow(rows[0]!)
}

export async function renderSqliteTarget(
  dbPath: string,
  subtarget?: string,
): Promise<RichRender> {
  statBoundedContainer(dbPath)
  const bunSqlite = 'bun:sqlite'
  const openReadOnly = async (file: string): Promise<SqliteDb> =>
    process.versions.bun
      ? new ((await import(bunSqlite)) as { Database: new (file: string, opts?: { readonly?: boolean }) => SqliteDb }).Database(file, { readonly: true })
      : new (await import('node:sqlite')).DatabaseSync(file, { open: true, readOnly: true } as never)
  let scratch: string | null = null
  let db: SqliteDb
  const hasLiveJournal = existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-journal`)
  try {
    db = await openReadOnly(hasLiveJournal ? dbPath : `${pathToFileURL(dbPath).href}?immutable=1`)
  } catch {
    scratch = mkdtempSync(join(tmpdir(), 'mercury-sqlite-read-'))
    const copy = join(scratch, basename(dbPath))
    try {
      copyFileSync(dbPath, copy)
      db = await openReadOnly(copy)
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true })
      throw error
    }
  }

  try {
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view') ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>

    if (subtarget !== undefined && subtarget !== '') {
      const findObject = (name: string) => objects.find(o => o.name === name || o.name.toLowerCase() === name.toLowerCase())
      const notFound = (name: string) =>
        new Error(`SQLite table or view "${name}" not found in ${dbPath}. Available: ${objects.map(o => o.name).join(', ') || '(none)'}`)
      let targetObj = findObject(subtarget)
      if (!targetObj && subtarget.includes('/')) {
        const parsed = parseSqliteSubtarget(subtarget)
        if (!parsed.ok) throw new Error(parsed.reason)
        targetObj = findObject(parsed.table)
        if (!targetObj) throw notFound(parsed.table)
        if (targetObj.type === 'view') {
          throw new Error(`"${targetObj.name}" is a view: a view has no addressable rows; read ${dbPath}:${targetObj.name} for its rows.`)
        }
        if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(targetObj.sql ?? '')) {
          throw new Error(`"${targetObj.name}" is a virtual table: a virtual table has no addressable rows; read ${dbPath}:${targetObj.name} for its rows.`)
        }
        return { text: renderSqliteRowTarget(db, dbPath, targetObj.name, parsed.selector!), ownBytes: true }
      }
      if (!targetObj) throw notFound(subtarget)
      const qName = quoteIdent(targetObj.name)
      const isView = targetObj.type === 'view'
      let rowLabel = 'view'
      if (!isView) {
        const countRow = db.prepare(`SELECT COUNT(*) AS c FROM ${qName}`).all()[0] as { c?: number } | undefined
        rowLabel = `rows: ${Number(countRow?.c ?? 0)}`
      }
      const { cols, rows } = queryBoundedSqliteRows(db, targetObj.name, 100)
      const lines: string[] = [
        `(database: sqlite · ${isView ? 'view' : 'table'}: ${targetObj.name} · ${rowLabel})`,
      ]
      if (targetObj.sql) lines.push(targetObj.sql.trim())
      if (rows.length > 0 && cols.length > 0) {
        lines.push(cols.join('\t'))
        for (const row of rows) {
          lines.push(cols.map(c => formatCellValue(row[c])).join('\t'))
        }
      }
      return { text: lines.join('\n'), ownBytes: false }
    }

    const lines: string[] = [
      `(database: sqlite · tables: ${objects.length})`,
    ]
    for (const obj of objects) {
      const qName = quoteIdent(obj.name)
      const isView = obj.type === 'view'
      let countDesc = 'view'
      let cols: string[] = []
      let sample: Record<string, unknown>[] = []
      try {
        if (!isView) {
          const countRow = db.prepare(`SELECT COUNT(*) AS c FROM ${qName}`).all()[0] as { c?: number } | undefined
          const rowCount = Number(countRow?.c ?? 0)
          countDesc = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
        }
        const res = queryBoundedSqliteRows(db, obj.name, SQLITE_SAMPLE_ROWS)
        cols = res.cols
        sample = res.rows
      } catch {}
      lines.push('')
      lines.push(isView ? `## ${obj.name} (view)` : `## ${obj.name} (${obj.type}, ${countDesc})`)
      if (obj.sql) lines.push(obj.sql.trim())
      if (sample.length > 0 && cols.length > 0) {
        lines.push(cols.join('\t'))
        for (const row of sample) {
          lines.push(cols.map(c => formatCellValue(row[c])).join('\t'))
        }
      }
    }
    return { text: lines.join('\n'), ownBytes: false }
  } finally {
    db.close()
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true })
  }
}
