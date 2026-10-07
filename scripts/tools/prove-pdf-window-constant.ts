import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PDF_PAGES_PER_REQUEST } from '../../src/tools/FileReadTool/prompt.ts'

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
console.log(`pdf-window-constant: ${failures} failures`)
process.exit(failures ? 1 : 0)
