#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'read-rich-formats-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.NODE_ENV

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const FIXTURES = join(import.meta.dir, 'fixtures', 'read-formats')
const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { createFileStateCacheWithSizeLimit } = await import(`${SRC}/utils/fileStateCache.ts`)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function makeContext() {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never
}

let serial = 0
async function runRead(input: Record<string, unknown>, ctx = makeContext()): Promise<{ ok: true; text: string; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const valid = await (FileReadTool as { validateInput?: Function }).validateInput?.(input, ctx)
    if (valid && !valid.result) {
      return { ok: false, error: valid.message }
    }
    serial++
    const res = await (FileReadTool as { call: Function }).call(
      input,
      ctx,
      null,
      { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_rf_${serial}` } },
    )
    const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(res.data, `toolu_${serial}`)
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
    return { ok: true, text, data: res.data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildCustomZip(
  entries: Array<{ name: string; rawData: Buffer; compData?: Buffer; claimedUncompressedSize?: number; method?: number }>,
): Buffer {
  const localParts: Buffer[] = []
  const cdParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.rawData
    const comp = entry.compData ?? deflateRawSync(raw)
    const method = entry.method ?? 8
    const uncompressedSize = entry.claimedUncompressedSize ?? raw.length
    const crc = crc32(raw)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    localParts.push(local, comp)

    const cd = Buffer.alloc(46 + nameBuf.length)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(uncompressedSize, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    nameBuf.copy(cd, 46)
    cdParts.push(cd)

    offset += local.length + comp.length
  }

  const cdBuf = Buffer.concat(cdParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, cdBuf, eocd])
}

console.log('§1 Archive lane (.zip, .tar, .tgz) — listing entries and reading one entry with windowing')
{
  const zipPath = join(FIXTURES, 'sample.zip')
  const zipList = await runRead({ file_path: zipPath })
  check('1a. zip archive opens and lists entries', zipList.ok && zipList.text.includes('README.txt') && zipList.text.includes('src/config.json'), zipList.ok ? zipList.text : zipList.error)

  const zipEntry = await runRead({ file_path: `${zipPath}:README.txt`, offset: 2, limit: 1 })
  check('1b. zip entry opens with offset/limit window and continuation mark', zipEntry.ok && zipEntry.text.includes('2\tAlpha zip line 2') && zipEntry.text.includes('[line 2 of 3 — Read(offset: 3, limit: 1) continues from there]'), zipEntry.ok ? zipEntry.text : zipEntry.error)

  const tarPath = join(FIXTURES, 'sample.tar')
  const tarList = await runRead({ file_path: tarPath })
  check('1c. tar archive opens and lists entries', tarList.ok && tarList.text.includes('manifest.txt') && tarList.text.includes('sub/notes.md'), tarList.ok ? tarList.text : tarList.error)

  const tarEntry = await runRead({ file_path: `${tarPath}:sub/notes.md` })
  check('1d. tar entry opens and returns markdown content', tarEntry.ok && tarEntry.text.includes('# Tar Notes') && tarEntry.text.includes('Body inside tar.'), tarEntry.ok ? tarEntry.text : tarEntry.error)

  const tgzPath = join(FIXTURES, 'sample.tgz')
  const tgzEntry = await runRead({ file_path: `${tgzPath}:manifest.txt` })
  check('1e. tgz archive entry opens and returns content', tgzEntry.ok && tgzEntry.text.includes('Tar manifest line A'), tgzEntry.ok ? tgzEntry.text : tgzEntry.error)
}

console.log('§2 SQLite lane (.sqlite) — tables, schema, row counts and bounded sample rows')
{
  const dbPath = join(FIXTURES, 'sample.sqlite')
  const dbOverview = await runRead({ file_path: dbPath })
  check('2a. sqlite database opens with schema, row count, and sample rows', dbOverview.ok && dbOverview.text.includes('(database: sqlite · tables: 1)') && dbOverview.text.includes('CREATE TABLE widgets') && dbOverview.text.includes('sprocket') && dbOverview.text.includes('flange'), dbOverview.ok ? dbOverview.text : dbOverview.error)

  const dbTable = await runRead({ file_path: `${dbPath}:widgets` })
  check('2b. sqlite single table selector opens table schema and rows', dbTable.ok && dbTable.text.includes('(database: sqlite · table: widgets · rows: 2)') && dbTable.text.includes('sprocket'), dbTable.ok ? dbTable.text : dbTable.error)
}

console.log('§3 Document lane (.docx, .xlsx, .pptx, .odt, .epub, .rtf)')
{
  const docxRes = await runRead({ file_path: join(FIXTURES, 'sample.docx') })
  check('3a. docx opens and extracts paragraph text', docxRes.ok && docxRes.text.includes('Quarterly Review Heading') && docxRes.text.includes('Revenue grew 18% year over year.'), docxRes.ok ? docxRes.text : docxRes.error)

  const xlsxRes = await runRead({ file_path: join(FIXTURES, 'sample.xlsx') })
  check('3b. xlsx opens and extracts sheet names, shared strings, and numeric cells', xlsxRes.ok && xlsxRes.text.includes('## Ledger') && xlsxRes.text.includes('Item\tTotal') && xlsxRes.text.includes('Bolts\t450'), xlsxRes.ok ? xlsxRes.text : xlsxRes.error)

  const pptxRes = await runRead({ file_path: join(FIXTURES, 'sample.pptx') })
  check('3c. pptx opens and extracts slide text', pptxRes.ok && pptxRes.text.includes('## Slide 1') && pptxRes.text.includes('Architecture Deck Slide One') && pptxRes.text.includes('Zero external runtime dependencies.'), pptxRes.ok ? pptxRes.text : pptxRes.error)

  const odtRes = await runRead({ file_path: join(FIXTURES, 'sample.odt') })
  check('3d. odt opens and extracts OpenDocument text', odtRes.ok && odtRes.text.includes('OpenDocument Title') && odtRes.text.includes('Paragraph inside ODT container.'), odtRes.ok ? odtRes.text : odtRes.error)

  const epubRes = await runRead({ file_path: join(FIXTURES, 'sample.epub') })
  check('3e. epub opens OPF spine and extracts chapter text', epubRes.ok && epubRes.text.includes('Chapter One: Awakening') && epubRes.text.includes('The lantern lit the corridor.'), epubRes.ok ? epubRes.text : epubRes.error)

  const rtfRes = await runRead({ file_path: join(FIXTURES, 'sample.rtf') })
  check('3f. rtf opens and strips control words while keeping text and punctuation', rtfRes.ok && rtfRes.text.includes('Rich Text Heading') && rtfRes.text.includes('Second line with \u2014 dash.'), rtfRes.ok ? rtfRes.text : rtfRes.error)

  const outOfRange = mkdtempSync(join(tmpdir(), 'read-rich-codepoint-'))
  try {
    const rtfPath = join(outOfRange, 'wild.rtf')
    writeFileSync(rtfPath, '{\\rtf1\\ansi before \\u8212? mid \\u99999999? after}')
    const wildRtf = await runRead({ file_path: rtfPath })
    check('3g. an RTF \\u value past U+10FFFF is skipped instead of failing the whole read (the in-range one still decodes)', wildRtf.ok && wildRtf.text.includes('before \u2014 mid') && wildRtf.text.includes('after') && !/RangeError|Invalid code point/.test(wildRtf.text), wildRtf.ok ? wildRtf.text : wildRtf.error)

    const docxPath = join(outOfRange, 'wild.docx')
    const documentXml = Buffer.from('<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>dash &#8212; then &#99999999; and &#x110000; stay literal</w:t></w:r></w:p></w:body></w:document>', 'utf8')
    writeFileSync(docxPath, buildCustomZip([{ name: 'word/document.xml', rawData: documentXml }]))
    const wildDocx = await runRead({ file_path: docxPath })
    check('3h. a numeric XML entity past U+10FFFF (decimal or hex) stays literal text instead of failing the document read', wildDocx.ok && wildDocx.text.includes('dash \u2014 then &#99999999; and &#x110000; stay literal'), wildDocx.ok ? wildDocx.text : wildDocx.error)
  } finally {
    rmSync(outOfRange, { recursive: true, force: true })
  }
}

console.log('§4 Genuine binary files (.exe, .dll, .class) still refuse at validateInput')
{
  const exeRes = await runRead({ file_path: '/tmp/nonexistent-binary.exe' })
  check('4a. .exe is still refused as binary', !exeRes.ok && exeRes.error.includes('cannot read binary files'), exeRes.ok ? exeRes.text : exeRes.error)
}

console.log('§5 Bounds before decoding (container ceiling, zip bomb header/inflate cap, selective docx extraction, streaming tgz)')
const scratch = mkdtempSync(join(tmpdir(), 'read-rich-bounds-'))
try {
  const overContainer = join(scratch, 'huge.zip')
  const fd = openSync(overContainer, 'w')
  ftruncateSync(fd, 17 * 1024 * 1024)
  closeSync(fd)
  const overRes = await runRead({ file_path: overContainer })
  check('5a. container over 16 MB ceiling refuses by stat before reading', !overRes.ok && overRes.error.includes('exceeds the maximum allowed container size'), overRes.ok ? overRes.text : overRes.error)

  const bombPayload = Buffer.alloc(5 * 1024 * 1024, 0x41)
  const bombDeflated = deflateRawSync(bombPayload)
  const claimedBombZip = join(scratch, 'claimed-bomb.zip')
  writeFileSync(
    claimedBombZip,
    buildCustomZip([{ name: 'bomb.txt', rawData: bombPayload, compData: bombDeflated, claimedUncompressedSize: bombPayload.length }]),
  )
  const claimedBombRes = await runRead({ file_path: `${claimedBombZip}:bomb.txt` })
  check('5b. zip entry whose header claims > 4 MB refuses before inflating', !claimedBombRes.ok && claimedBombRes.error.includes('exceeds the maximum allowed entry size'), claimedBombRes.ok ? claimedBombRes.text : claimedBombRes.error)

  const spoofedBombZip = join(scratch, 'spoofed-bomb.zip')
  writeFileSync(
    spoofedBombZip,
    buildCustomZip([{ name: 'bomb.txt', rawData: bombPayload, compData: bombDeflated, claimedUncompressedSize: 128 }]),
  )
  const spoofedBombRes = await runRead({ file_path: `${spoofedBombZip}:bomb.txt` })
  check('5c. zip entry with spoofed small header that inflates past 4 MB refuses via maxOutputLength', !spoofedBombRes.ok && spoofedBombRes.error.includes('inflated past the maximum allowed entry size'), spoofedBombRes.ok ? spoofedBombRes.text : spoofedBombRes.error)

  const docxWithBombMedia = join(scratch, 'with-media.docx')
  const tenMbZeros = Buffer.alloc(10 * 1024 * 1024, 0)
  const tenMbDeflated = deflateRawSync(tenMbZeros)
  let inflatedTenMb = 0
  const origFrom = Buffer.from
  Buffer.from = function (...args: Parameters<typeof Buffer.from>): Buffer {
    const b = origFrom.apply(Buffer, args)
    if (b.length >= 10 * 1024 * 1024) inflatedTenMb++
    return b
  } as typeof Buffer.from
  writeFileSync(
    docxWithBombMedia,
    buildCustomZip([
      {
        name: 'word/document.xml',
        rawData: origFrom('<w:document><w:body><w:p><w:r><w:t>Clean document text</w:t></w:r></w:p></w:body></w:document>', 'utf8'),
      },
      {
        name: 'word/media/image1.png',
        rawData: tenMbZeros,
        compData: tenMbDeflated,
        claimedUncompressedSize: tenMbZeros.length,
        method: 8,
      },
    ]),
  )
  const memBeforeDocx = process.memoryUsage().rss
  const docxMediaRes = await runRead({ file_path: docxWithBombMedia })
  Buffer.from = origFrom
  const srcRich = await Bun.file(join(SRC, 'tools/FileReadTool/readRichFormats.ts')).text()
  check(
    '5d. docx with huge embedded media entry never inflates media (readSelectedZipEntries filters word/*.xml only)',
    docxMediaRes.ok &&
      docxMediaRes.text.includes('Clean document text') &&
      srcRich.includes('readSelectedZipEntries') &&
      !srcRich.includes('function readZipEntryMap') &&
      inflatedTenMb === 0 &&
      process.memoryUsage().rss - memBeforeDocx < 8 * 1024 * 1024,
    docxMediaRes.ok ? `rssDelta=${process.memoryUsage().rss - memBeforeDocx}` : docxMediaRes.error,
  )

  const validTar = Buffer.alloc(1536, 0)
  validTar.write('hello.txt', 0, 100, 'utf8')
  validTar.write('0000644\0', 100, 8, 'ascii')
  validTar.write('0000000\0', 108, 8, 'ascii')
  validTar.write('0000000\0', 116, 8, 'ascii')
  validTar.write((6).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  validTar.write((0).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii')
  validTar.fill(0x20, 148, 156)
  validTar[156] = 0x30
  validTar.write('ustar\0', 257, 6, 'ascii')
  validTar.write('00', 263, 2, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += validTar[i]!
  validTar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  validTar.write('hello\n', 512, 6, 'utf8')
  const tgzWithTrailingBomb = join(scratch, 'trailing.tgz')
  writeFileSync(tgzWithTrailingBomb, Buffer.concat([gzipSync(validTar), Buffer.alloc(32768, 0), Buffer.from('not-gzip-after-eof-marker')]))
  const tgzListRes = await runRead({ file_path: tgzWithTrailingBomb })
  check(
    '5e. tgz streaming reader stops at tar end-of-archive blocks without gunzipSync of whole file',
    tgzListRes.ok &&
      tgzListRes.text.includes('hello.txt') &&
      srcRich.includes('readTgzEntriesStreaming') &&
      !srcRich.includes('gunzipSync('),
    tgzListRes.ok ? tgzListRes.text : tgzListRes.error,
  )

  console.log('§6 Malformed archives and binary/nested entries')
  const badTar = join(scratch, 'corrupt.tar')
  writeFileSync(badTar, Buffer.alloc(1024, 0x55))
  const badTarRes = await runRead({ file_path: badTar })
  check('6a. tar with invalid header checksum refuses with offset', !badTarRes.ok && /checksum failed at byte offset 0/i.test(badTarRes.error), badTarRes.ok ? badTarRes.text : badTarRes.error)

  const badZip = join(scratch, 'corrupt.zip')
  writeFileSync(badZip, Buffer.from('this is not a zip file at all', 'utf8'))
  const badZipRes = await runRead({ file_path: badZip })
  check('6b. non-zip file with .zip extension refuses rather than listing 0 entries', !badZipRes.ok && /Invalid or corrupt zip archive/i.test(badZipRes.error), badZipRes.ok ? badZipRes.text : badZipRes.error)

  const nestedAndBinZip = join(scratch, 'nested.zip')
  writeFileSync(
    nestedAndBinZip,
    buildCustomZip([
      { name: 'inner.zip', rawData: Buffer.from('PK\x05\x06' + '\x00'.repeat(18), 'binary') },
      { name: 'image.png', rawData: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) },
      { name: '../escaped.txt', rawData: Buffer.from('safe escaped content\n', 'utf8') },
    ]),
  )
  const nestedRes = await runRead({ file_path: `${nestedAndBinZip}:inner.zip` })
  check('6c. nested archive entry returns a one-line description instead of raw bytes', nestedRes.ok && nestedRes.text.includes('nested archive (.zip)') && nestedRes.text.includes('not decoded as text'), nestedRes.ok ? nestedRes.text : nestedRes.error)

  const binEntryRes = await runRead({ file_path: `${nestedAndBinZip}:image.png` })
  check('6d. binary entry inside archive returns a one-line description instead of raw bytes', binEntryRes.ok && binEntryRes.text.includes('binary file (.png)') && binEntryRes.text.includes('not decoded as text'), binEntryRes.ok ? binEntryRes.text : binEntryRes.error)

  const escapedRes = await runRead({ file_path: `${nestedAndBinZip}:../escaped.txt` })
  check('6e. escaping entry name is matched in-memory without touching disk', escapedRes.ok && escapedRes.text.includes('safe escaped content'), escapedRes.ok ? escapedRes.text : escapedRes.error)

  console.log('§7 SQLite read-only safety: WAL-mode database in writable dir creates no -wal/-shm/-journal, views skip COUNT(*), blobs use SQL length()')
  const { Database } = await import('bun:sqlite')
  const { readdirSync, readFileSync } = await import('node:fs')
  const walBuildDir = join(scratch, 'wal-build')
  const walTestDir = join(scratch, 'wal-test')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(walBuildDir, { recursive: true })
  mkdirSync(walTestDir, { recursive: true })
  const builtWalDbPath = join(walBuildDir, 'built.sqlite')
  const dbWal = new Database(builtWalDbPath)
  dbWal.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE items (id INTEGER PRIMARY KEY, payload BLOB, note TEXT);
    INSERT INTO items (id, payload, note) VALUES (1, zeroblob(2097152), '${'x'.repeat(500)}');
    CREATE VIEW heavy_view AS SELECT a.id AS aid, b.id AS bid FROM items a CROSS JOIN items b;
  `)
  dbWal.close()
  const testWalDbPath = join(walTestDir, 'wal.sqlite')
  writeFileSync(testWalDbPath, readFileSync(builtWalDbPath))
  const beforeWalFiles = readdirSync(walTestDir).sort()
  const walOverviewRes = await runRead({ file_path: testWalDbPath })
  const afterWalFiles = readdirSync(walTestDir).sort()
  check(
    '7a. WAL-mode SQLite database in writable folder opens via immutable URI and creates zero -wal/-shm/-journal files',
    walOverviewRes.ok &&
      JSON.stringify(beforeWalFiles) === JSON.stringify(['wal.sqlite']) &&
      JSON.stringify(afterWalFiles) === JSON.stringify(['wal.sqlite']),
    walOverviewRes.ok ? `files=${afterWalFiles.join(',')}` : walOverviewRes.error,
  )
  check(
    '7b. SQLite view skips COUNT(*) (headed "## heavy_view (view)") and SQLite blob/text columns are bounded in SQL via length()/substr()',
    walOverviewRes.ok &&
      walOverviewRes.text.includes('## heavy_view (view)') &&
      !walOverviewRes.text.includes('## heavy_view (view,') &&
      walOverviewRes.text.includes('<BLOB 2097152B>') &&
      walOverviewRes.text.includes(`${'x'.repeat(200)}…`) &&
      srcRich.includes("typeof(${qCol}) = 'blob' THEN '<BLOB ' || length(${qCol})"),
    walOverviewRes.ok ? walOverviewRes.text : walOverviewRes.error,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-read-rich-formats: all green' : `\nprove-read-rich-formats: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
