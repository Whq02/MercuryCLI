#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'

const OUT_DIR = join(import.meta.dir, 'read-formats')
mkdirSync(OUT_DIR, { recursive: true })

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

function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const localParts: Buffer[] = []
  const cdParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const useDeflate = entry.deflate !== false && raw.length > 0
    const comp = useDeflate ? deflateRawSync(raw) : raw
    const method = useDeflate ? 8 : 0
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
    local.writeUInt32LE(raw.length, 22)
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
    cd.writeUInt32LE(raw.length, 24)
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

function buildTar(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0)
    header.write(entry.name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(entry.data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
    header.write((0).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii')
    header.fill(0x20, 148, 156)
    header[156] = 0x30
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]!
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')

    blocks.push(header)
    const paddedLen = Math.ceil(entry.data.length / 512) * 512
    const payload = Buffer.alloc(paddedLen, 0)
    entry.data.copy(payload, 0)
    blocks.push(payload)
  }
  blocks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(blocks)
}

writeFileSync(
  join(OUT_DIR, 'sample.zip'),
  buildZip([
    { name: 'README.txt', data: Buffer.from('Alpha zip line 1\nAlpha zip line 2\nAlpha zip line 3\n', 'utf8') },
    { name: 'src/config.json', data: Buffer.from('{"port":8080,"host":"127.0.0.1"}\n', 'utf8'), deflate: false },
  ]),
)

const tarBuf = buildTar([
  { name: 'manifest.txt', data: Buffer.from('Tar manifest line A\nTar manifest line B\n', 'utf8') },
  { name: 'sub/notes.md', data: Buffer.from('# Tar Notes\nBody inside tar.\n', 'utf8') },
])
writeFileSync(join(OUT_DIR, 'sample.tar'), tarBuf)
writeFileSync(join(OUT_DIR, 'sample.tgz'), gzipSync(tarBuf))

const dbPath = join(OUT_DIR, 'sample.sqlite')
try {
  writeFileSync(dbPath, Buffer.alloc(0))
} catch {}
const db = new Database(dbPath)
db.exec('DROP TABLE IF EXISTS widgets; CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER NOT NULL);')
db.exec("INSERT INTO widgets (id, label, qty) VALUES (1, 'sprocket', 12), (2, 'flange', 34);")
db.close()

writeFileSync(
  join(OUT_DIR, 'sample.docx'),
  buildZip([
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly Review Heading</w:t></w:r></w:p><w:p><w:r><w:t>Revenue grew 18% year over year.</w:t></w:r></w:p></w:body></w:document>',
        'utf8',
      ),
    },
  ]),
)

writeFileSync(
  join(OUT_DIR, 'sample.xlsx'),
  buildZip([
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><workbook><sheets><sheet name="Ledger" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'utf8',
      ),
    },
    {
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><sst><si><t>Item</t></si><si><t>Total</t></si><si><t>Bolts</t></si></sst>',
        'utf8',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>450</v></c></row></sheetData></worksheet>',
        'utf8',
      ),
    },
  ]),
)

writeFileSync(
  join(OUT_DIR, 'sample.pptx'),
  buildZip([
    {
      name: 'ppt/slides/slide1.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Architecture Deck Slide One</a:t></a:r></a:p><a:p><a:r><a:t>Zero external runtime dependencies.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        'utf8',
      ),
    },
  ]),
)

writeFileSync(
  join(OUT_DIR, 'sample.odt'),
  buildZip([
    {
      name: 'content.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h>OpenDocument Title</text:h><text:p>Paragraph inside ODT container.</text:p></office:text></office:body></office:document-content>',
        'utf8',
      ),
    },
  ]),
)

writeFileSync(
  join(OUT_DIR, 'sample.epub'),
  buildZip([
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'utf8',
      ),
    },
    {
      name: 'OEBPS/content.opf',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><package><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>',
        'utf8',
      ),
    },
    {
      name: 'OEBPS/ch1.xhtml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><html><head><title>Ignored Title</title></head><body><h1>Chapter One: Awakening</h1><p>The lantern lit the corridor.</p></body></html>',
        'utf8',
      ),
    },
  ]),
)

writeFileSync(
  join(OUT_DIR, 'sample.rtf'),
  Buffer.from(
    '{\\rtf1\\ansi{\\fonttbl{\\f0 Courier;}}\\pard\\b Rich Text Heading\\b0\\par Second line with \\emdash  dash.\\par}\n',
    'utf8',
  ),
)

console.log('Generated fixtures in', OUT_DIR)
