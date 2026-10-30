import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, pdfFixture, reader, scratch, textPage, zip } from './hardening-fixtures.ts'

const root = scratch('malformed')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
try {
  const { read, healthy, context } = await reader(root)
  const { DocumentTool } = await import('../../src/tools/DocumentTool/DocumentTool.ts')
  const cases: [string, Buffer, RegExp][] = []
  for (const [ext, part] of [['docx', 'word/document.xml'], ['xlsx', 'xl/worksheets/sheet1.xml'], ['pptx', 'ppt/slides/slide1.xml']]) {
    const bytes = zip({ [part!]: '<document>discarded partial text</document>' })
    cases.push([`truncated.${ext}`, bytes.subarray(0, bytes.length - 22), /central directory|truncated/i])
    const corrupt = Buffer.from(bytes)
    corrupt.writeUInt32LE(0xfffffff0, corrupt.length - 6)
    cases.push([`corrupt.${ext}`, corrupt, /central directory|corrupt/i])
  }
  const pdf = pdfFixture([textPage('discarded partial text')])
  cases.push(['broken-xref.pdf', Buffer.from(pdf.toString().replace(/startxref\n\d+/, 'startxref\n1')), /cross-reference|xref|damaged/i])
  cases.push(['missing-trailer.pdf', Buffer.from(pdf.toString().replace(/trailer\n<<[^>]+>>\n/, '')), /trailer|damaged|invalid/i])
  cases.push(['truncated-stream.pdf', pdf.subarray(0, pdf.indexOf('endstream') - 8), /truncated|end marker|damaged/i])
  cases.push(['unbalanced.rtf', Buffer.from('{\\rtf1 text {missing close'), /unbalanced|truncated/i])
  cases.push(['extra-close.rtf', Buffer.from('{\\rtf1 text}}'), /unbalanced/i])
  cases.push(['missing-container.epub', zip({ 'chapter.xhtml': '<p>discarded partial text</p>' }), /container\.xml/i])
  const failures: string[] = []
  for (const [name, bytes, reason] of cases) {
    const path = join(root, name)
    writeFileSync(path, bytes)
    const started = performance.now()
    let message = ''
    try { message = `RETURNED ${await read(path)}` } catch (error) { message = error instanceof Error ? error.message : String(error) }
    console.log(`${name}: ${message}`)
    if (!message.includes(name) || !reason.test(message) || /RETURNED|\n\s*at |discarded partial text/.test(message) || message.length > path.length + 350) failures.push(name)
    assert.ok(performance.now() - started < 30_000, `${name} took over 30 seconds`)
    await healthy()
    if (/\.(docx|xlsx|pptx|pdf)$/.test(name)) {
      await assert.rejects(DocumentTool.call({ op: 'inspect', source: path }, context, undefined as any, { uuid: crypto.randomUUID() } as any), (error: Error) => error.message.includes(name) && reason.test(error.message) && !/\n\s*at /.test(error.message))
      await healthy()
    }
  }
  assert.deepEqual(failures, [], 'malformed input must name the file and cause without partial text')
  console.log('PASS malformed inputs: ZIP directories, PDF xref/trailer/stream, RTF groups, EPUB container; same-session reads after every failure')
} finally { cleanup(root) }
