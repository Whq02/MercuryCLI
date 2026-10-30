import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, reader, scratch, zip } from './hardening-fixtures.ts'

const root = scratch('large')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
const kind = process.argv[2]
try {
  if (!kind) {
    for (const ext of ['pdf', 'xlsx']) {
      const child = spawnSync(process.execPath, [import.meta.filename, ext], { env: process.env, encoding: 'utf8', timeout: 90_000 })
      process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '')
      assert.equal(child.status, 0, `${ext}: ${child.error ?? child.signal ?? 'proof failed'}`)
    }
  } else {
    assert.ok(['pdf', 'xlsx'].includes(kind))
    const path = join(root, `large.${kind}`), size = 50 * 1024 * 1024
    const fd = openSync(path, 'w')
    try {
      if (kind === 'pdf') {
        const head = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n5 0 obj\n<< /Length 54 >>\nstream\nBT /F1 12 Tf 40 700 Td (Large PDF text survives) Tj ET\nendstream\nendobj\n'
        writeSync(fd, head)
        const offsets = [0, ...[1, 2, 3, 4, 5].map(n => head.indexOf(`${n} 0 obj`))]
        const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n`
        const pad = Buffer.alloc(64 * 1024, 0x20); pad[0] = 0x25; pad[pad.length - 1] = 10
        let remaining = size - head.length - 300
        while (remaining > 0) { const n = Math.min(pad.length, remaining); writeSync(fd, pad.subarray(0, n)); remaining -= n }
        writeSync(fd, '\n')
        const at = statSync(path).size
        writeSync(fd, `${xref}${at}\n%%EOF\n`)
        writeSync(fd, Buffer.alloc(size - statSync(path).size, 0x20))
      } else {
        const ExcelJS = await import('../../src/tools/DocumentTool/workbook.ts')
        const book = new ExcelJS.Workbook(); book.addWorksheet('Data').addRow(['Large workbook'])
        const base = Buffer.from(await book.xlsx.writeBuffer()), end = Buffer.from(base.subarray(base.length - 22))
        const originalOffset = end.readUInt32LE(16), originalCentral = base.subarray(originalOffset, base.length - 22)
        writeSync(fd, base.subarray(0, originalOffset))
        const name = Buffer.from('xl/media/padding.bin'), payloadSize = size - base.length - 30 - name.length - 46 - name.length
        let crc = 0xffffffff
        for (let n = 0; n < payloadSize; n++) { for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
        crc = (crc ^ 0xffffffff) >>> 0
        const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14)
        header.writeUInt32LE(payloadSize, 18); header.writeUInt32LE(payloadSize, 22); header.writeUInt16LE(name.length, 26)
        writeSync(fd, header); writeSync(fd, name)
        const zeros = Buffer.alloc(64 * 1024)
        let remaining = payloadSize
        while (remaining > 0) { const n = Math.min(zeros.length, remaining); writeSync(fd, zeros.subarray(0, n)); remaining -= n }
        const cdOffset = statSync(path).size, central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(payloadSize, 20); central.writeUInt32LE(payloadSize, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(originalOffset, 42)
        const count = end.readUInt16LE(10) + 1
        end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(originalCentral.length + 46 + name.length, 12); end.writeUInt32LE(cdOffset, 16)
        writeSync(fd, originalCentral); writeSync(fd, central); writeSync(fd, name); writeSync(fd, end)
      }
    } finally { closeSync(fd) }
    const { read, healthy, context } = await reader(root)
    const start = performance.now()
    if (kind === 'pdf') {
      assert.match(await read(path, { offset: 1, limit: 2 }), /Large PDF text survives/)
      const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
      const lines = join(root, 'window.docx')
      writeFileSync(lines, zip({ 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(2100) + '</w:body></w:document>' }))
      const result = await FileReadTool.call({ file_path: lines }, context, undefined as any, { uuid: crypto.randomUUID() } as any)
      assert.equal(result.data.type, 'text')
      assert.ok((result.data as any).file.numLines <= 2000)
      assert.match(JSON.stringify(FileReadTool.mapToolResultToToolResultBlockParam(result.data, 'window')), /Read\(offset:|Read.*limit|read.*offset/i)
      const { parsePdfText } = await import('../../src/utils/pdfText.ts')
      const { pdfFixture, textPage } = await import('./fixtures.ts')
      const abort = new AbortController()
      const pending = parsePdfText(pdfFixture(Array.from({ length: 500 }, () => textPage('cancel'))), undefined, abort.signal)
      const timer = setTimeout(() => abort.abort(), 20)
      try { await assert.rejects(pending, /cancelled|abort/i) } finally { clearTimeout(timer) }
      const { getToolResultsDir } = await import('../../src/utils/toolResultStorage.ts')
      assert.ok(!readdirSync(getToolResultsDir()).some(name => name.startsWith('pdf-input-')), 'worker input remains after cancellation')
    } else {
      await assert.rejects(read(path), (e: Error) => /large\.xlsx/.test(e.message) && /16 (?:MiB|MB)|16777216/.test(e.message))
      const { DocumentTool } = await import('../../src/tools/DocumentTool/DocumentTool.ts')
      await assert.rejects(DocumentTool.call({ op: 'inspect', source: path }, context, undefined as any, { uuid: crypto.randomUUID() } as any), (e: Error) => /large\.xlsx/.test(e.message) && /16 (?:MiB|MB)|16777216/.test(e.message))
      const { documentArchive } = await import('../../src/tools/DocumentTool/archive.ts')
      assert.throws(() => documentArchive(zip({ 'word/document.xml': 'x'.repeat(4 * 1024 * 1024 + 1) })), /entry.*(?:size|limit)|exceeds/i)
    }
    await healthy()
    const elapsed = performance.now() - start
    const peakBytes = process.resourceUsage().maxRSS * (process.versions.bun && process.platform === 'darwin' ? 1 : 1024)
    console.log(JSON.stringify({ kind, bytes: statSync(path).size, elapsedMs: Math.round(elapsed), peakRSSBytes: peakBytes, peakRSSMiB: Math.round(peakBytes / 1024 / 1024) }))
    assert.ok(elapsed < 60_000)
    assert.ok(peakBytes < 1536 * 1024 ** 2, 'peak RSS exceeds 1.5 GiB')
    const limits = readFileSync(join(import.meta.dir, '../../src/tools/FileReadTool/prompt.ts'), 'utf8')
    assert.match(limits, /MAX_LINES_TO_READ = 2000/)
    assert.match(limits, /MAX_PDF_PAGES_PER_REQUEST = 20/)
    console.log(`PASS large ${kind}: bounded read and healthy session`)
  }
} finally { cleanup(root) }
