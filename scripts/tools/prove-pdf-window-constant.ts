import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LINE_FORMAT_INSTRUCTION, MAX_PDF_PAGES_PER_REQUEST, OFFSET_INSTRUCTION_DEFAULT, renderPromptTemplate } from '../../src/tools/FileReadTool/prompt.ts'

const source = readFileSync(join(import.meta.dir, '../../src/tools/FileReadTool/FileReadTool.ts'), 'utf8')
const guard = source.match(/const pageCount = await getPDFPageCount\(resolvedPath\)\s+if \(([^\n]+)\) \{/)
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
const described = renderPromptTemplate(LINE_FORMAT_INSTRUCTION, '', OFFSET_INSTRUCTION_DEFAULT, { pdf: true, images: true })
const pdfSentence = described.split('\n').find(line => line.includes('PDFs with more than')) ?? ''
const thresholds = [...pdfSentence.matchAll(/more than (\d+) pages/g)].map(m => Number(m[1]))
check('the Read description states the whole-PDF gate the product holds', thresholds.length === 1 && thresholds[0] === MAX_PDF_PAGES_PER_REQUEST, pdfSentence || 'no PDF sentence')
check(`the description names ${MAX_PDF_PAGES_PER_REQUEST} as the per-request maximum and no other page count`, [...pdfSentence.matchAll(/(\d+) pages/g)].every(m => Number(m[1]) === MAX_PDF_PAGES_PER_REQUEST), pdfSentence)
console.log(`pdf-window-constant: ${failures} failures`)
process.exit(failures ? 1 : 0)
