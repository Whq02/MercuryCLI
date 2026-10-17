#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
}

console.log('§4 Genuine binary files (.exe, .dll, .class) still refuse at validateInput')
{
  const exeRes = await runRead({ file_path: '/tmp/nonexistent-binary.exe' })
  check('4a. .exe is still refused as binary', !exeRes.ok && exeRes.error.includes('cannot read binary files'), exeRes.ok ? exeRes.text : exeRes.error)
}

console.log(failures === 0 ? '\nprove-read-rich-formats: all green' : `\nprove-read-rich-formats: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
