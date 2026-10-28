import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { pdfFixture, textPage } from './fixtures.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'grep-documents-'))
const root = join(home, 'docs')
mkdirSync(root)
mkdirSync(join(root, '.git'))
process.env.MERCURY_CONFIG_DIR = join(home, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const permission = { ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: ['Read(**/secret.pdf)'] } }
const context = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission }) } as never
async function search(input: object) {
  const result = await runWithCwdOverride(root, () => GrepTool.call({ path: root, pattern: 'Mercury', ...input }, context))
  return { data: result.data, text: GrepTool.mapToolResultToToolResultBlockParam(result.data, 'proof').content as string }
}
try {
  writeFileSync(join(root, 'paper.pdf'), pdfFixture([textPage('Mercury research')]))
  writeFileSync(join(root, 'secret.pdf'), pdfFixture([textPage('Mercury secret')]))
  writeFileSync(join(root, 'sheet.xlsx'), zipSync({ 'xl/worksheets/sheet1.xml': strToU8('<worksheet><row><c t="inlineStr"><is><t>Mercury cell</t></is></c></row></worksheet>'), 'xl/workbook.xml': strToU8('<workbook><sheet name="Results"/></workbook>') }))
  writeFileSync(join(root, 'broken.docx'), 'broken zip')
  writeFileSync(join(root, 'source.ts'), 'Mercury source\n')
  writeFileSync(join(root, '.gitignore'), 'ignored.pdf\n')
  writeFileSync(join(root, 'ignored.pdf'), pdfFixture([textPage('Mercury ignored')]))
  const result = await search({ output_mode: 'content' })
  assert.match(result.text, /paper.pdf:\d+:\[page 1\] Mercury research/)
  assert.match(result.text, /sheet.xlsx:\d+:\[Results\] Mercury cell/)
  assert.match(result.text, /source.ts:1:Mercury source/)
  assert.ok(!result.text.includes('Mercury secret'))
  assert.ok(!result.text.includes('Mercury ignored'))
  assert.match(result.text, /document.*skipped/)
  const count = await search({ type: 'pdf', output_mode: 'count' })
  assert.equal(count.data.numMatches, 1)
  const code = await search({ type: 'ts', output_mode: 'files_with_matches' })
  assert.equal(code.data.filenames.length, 1)
  assert.match(code.data.filenames[0]!, /source.ts$/)
  const look = await search({ glob: '*.xlsx', pattern: '(?<=Mercury )cell', output_mode: 'content' })
  assert.match(look.text, /Mercury cell/)
  const outside = join(home, 'outside.pdf')
  writeFileSync(outside, pdfFixture([textPage('Mercury outside')]))
  symlinkSync(outside, join(root, 'link.pdf'))
  assert.ok(!(await search({ output_mode: 'content' })).text.includes('Mercury outside'))
  for (let i = 0; i < 30; i++) writeFileSync(join(root, `many-${i}.pdf`), pdfFixture([textPage(`Mercury ${i}`)]))
  assert.match((await search({ glob: 'many-*.pdf' })).text, /Document search covered 20 of 30 files; narrow path or glob/)
  assert.match((await search({ path: join(root, 'many-29.pdf'), output_mode: 'content' })).text, /Mercury 29/)
  console.log('PASS Grep document text, page/sheet locations, PCRE2, type/glob, counts, ignores, Read denial, symlinks and twenty-document bound')
} finally { rmSync(home, { recursive: true, force: true }) }
