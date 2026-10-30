import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LINE_FORMAT_INSTRUCTION, MAX_PDF_PAGES_PER_REQUEST, renderPromptTemplate } from '../../src/tools/FileReadTool/prompt.ts'

const source = readFileSync(join(import.meta.dir, '../../src/tools/FileReadTool/FileReadTool.ts'), 'utf8')
const guard = source.match(/const pageCount = document.pageCount\s+if \(([^\n]+)\) \{/)
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
check('the whole-PDF gate reads the per-request page constant', guard?.[1]?.includes('MAX_PDF_PAGES_PER_REQUEST') === true, guard?.[1])
if (guard) {
  const refuses = new Function('pageCount', 'MAX_PDF_PAGES_PER_REQUEST', `return ${guard[1]}`) as (count: number | null, max: number) => boolean
  for (const maximum of [MAX_PDF_PAGES_PER_REQUEST, MAX_PDF_PAGES_PER_REQUEST + 7]) {
    for (const count of [null, 1, maximum - 1, maximum, maximum + 1]) {
      check(`the exact product gate at ${count} pages follows a ${maximum}-page window`, refuses(count, maximum) === (count !== null && count > maximum), String(refuses(count, maximum)))
    }
  }
}
const described = renderPromptTemplate(LINE_FORMAT_INSTRUCTION, { pdf: true, images: true })
const pdfSentence = described.split('\n').find(line => line.includes('PDFs open as numbered text')) ?? ''
check('the Read description names default text and selected page pictures', pdfSentence.includes('offset, limit and ranges select text lines') && pdfSentence.includes('otherwise those pages as text'), pdfSentence)
check('only the pages field states the page-picture cap', !pdfSentence.includes('per request') && !pdfSentence.includes('per call') && source.includes('at most ${MAX_PDF_PAGES_PER_REQUEST} pages per call`'), pdfSentence)
check('fold 46al text extraction runs before the inline-document gate, with both anchors present', source.includes('return readRichFormatLane(resolvedPath') && source.includes('const pageCount = document.pageCount') && source.indexOf('return readRichFormatLane(resolvedPath') < source.indexOf('const pageCount = document.pageCount'))
console.log(`pdf-window-constant: ${failures} failures`)
process.exit(failures ? 1 : 0)
