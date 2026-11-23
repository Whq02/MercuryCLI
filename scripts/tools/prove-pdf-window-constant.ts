import { LINE_FORMAT_INSTRUCTION, renderPromptTemplate } from '../../src/tools/kit/names/fileRead.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
const described = renderPromptTemplate(LINE_FORMAT_INSTRUCTION, { pdf: true, images: true })
const pdfSentence = /PDFs open as numbered text[^.]*\.?[^.]*\./.exec(described)?.[0] ?? ''
check('the Read description names default text and page pictures with pages', pdfSentence.includes('PDFs open as numbered text with page markers, or as page pictures with `pages`'), pdfSentence)
console.log(`pdf-window-constant: ${failures} failures`)
process.exit(failures ? 1 : 0)
