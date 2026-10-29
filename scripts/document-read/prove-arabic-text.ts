import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'arabic-text-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'home')
process.env.MERCURY_BARE = '1'
const marked = 'مديــنة \u2067\ufe8dلحديقة\u2069'
const quote = 'مدينة الحديقة'
function arabicPdf(): Buffer {
  const words = ['1', '2', '3', 'الحديقة', 'مديــنة']
  const letters = [...new Set(words.join('').split(''))]
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Fixture def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange ${letters.length} beginbfchar ${letters.map((c, i) => `<${hex(i + 1)}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`
  const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`
  const content = words.map((word, i) => `BT /F1 12 Tf 1 0 0 1 ${40 + i * 100} 740 Tm <${word.split('').reverse().map(c => hex(letters.indexOf(c) + 1)).join('')}> Tj ET`).join('\n')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>', `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 1 /LastChar ${letters.length} /Widths [${letters.map(() => 500).join(' ')}] /ToUnicode 5 0 R >>`, stream(cmap), stream(content)]
  let text = '%PDF-1.7\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const start = Buffer.byteLength(text)
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(text)
}
try {
  const { extractPdfText } = await import('../../src/utils/pdfText.ts')
  const path = join(home, 'fixture.pdf')
  writeFileSync(path, arabicPdf())
  const extracted = await extractPdfText(path)
  assert.ok(extracted.pages[0]!.text.replace(/\s+/g, ' ').includes(quote), extracted.pages[0]!.text)
  const { normaliseForMatch } = await import('../../src/utils/text/normaliseForMatch.ts')
  assert.equal(normaliseForMatch(marked), quote)
  assert.equal(normaliseForMatch(normaliseForMatch(marked)), quote)
  const { getToolResultsDir } = await import('../../src/utils/toolResultStorage.ts')
  const cache = readdirSync(getToolResultsDir()).find(file => file.startsWith('pdf-text-'))!
  const cached = JSON.parse(readFileSync(join(getToolResultsDir(), cache), 'utf8'))
  assert.ok(cached.pages[0].rawText.includes('ـ'))
  assert.equal((await extractPdfText(path)).pages[0]!.text, extracted.pages[0]!.text)
  const { zipSync, strToU8 } = await import('fflate')
  writeFileSync(join(home, 'fixture.docx'), zipSync({ 'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${marked}</w:t></w:r></w:p></w:body></w:document>`) }))
  mkdirSync(join(home, '.git'))
  const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const context = { abortController: new AbortController(), options: {}, getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) } as never
  const result = await runWithCwdOverride(home, () => GrepTool.call({ path: home, pattern: marked, literal: true, output_mode: 'content', glob: '*.docx' }, context))
  assert.ok(JSON.stringify(result.data).includes(quote))
  mock.module('../../src/tools/WebFetchTool/utils.js', () => ({ getURLMarkdownContent: async () => ({ content: marked, contentType: 'text/html', code: 200, codeText: 'OK', bytes: Buffer.byteLength(marked) }), isPreapprovedUrl: () => true, applyPromptToMarkdown: async () => { throw new Error('no model call') } }))
  const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.ts')
  const fetched = await WebFetchTool.call({ url: 'https://example.org/fixture' }, context)
  assert.ok(fetched.data.result.includes(quote))
  console.log('PASS Arabic PDF logical order, raw cache, tatweel and NFKC, document quote matching and fetched text')
} finally { rmSync(home, { recursive: true, force: true }) }
