import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanup, pdfFixture, reader, scratch, textPage, zip } from './hardening-fixtures.ts'

const root = scratch('paths')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
try {
  const { execFileNoThrow } = await import('../../src/utils/execFileNoThrow.ts')
  const { documentPath } = await import('../../src/tools/DocumentTool/files.ts')
  const { parseRichFormatTarget } = await import('../../src/tools/FileReadTool/readRichFormats.ts')
  const folder = join(root, '資料 & (draft) # 100%')
  mkdirSync(folder)
  const probe = join(folder, 'argv.mjs')
  writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const drive = String.raw`C:\Reports & (draft)\資料 100%\scan.pdf`
  const unc = String.raw`\\server\share\Research & notes\paper.docx`
  const values = [drive, unc, '-env:UserInstallation=' + pathToFileURL(win32.join('C:\\Reports & (draft)', 'office-profile'), { windows: true }).href, 'literal "quotes" and $HOME ; !']
  const spawned = await execFileNoThrow(process.execPath, [probe, ...values], { useCwd: false, timeout: 10_000 })
  assert.equal(spawned.code, 0, spawned.stderr)
  assert.deepEqual(JSON.parse(spawned.stdout), values)
  assert.doesNotThrow(() => documentPath(drive))
  assert.doesNotThrow(() => documentPath(unc))
  assert.throws(() => documentPath('https://example.invalid/report.pdf'), /local files/)
  assert.deepEqual(parseRichFormatTarget(String.raw`C:\Reports\archive.zip:notes.txt`), { kind: 'archive', containerPath: String.raw`C:\Reports\archive.zip`, ext: 'zip', subtarget: 'notes.txt' })
  const { read, healthy } = await reader(root)
  const pdf = join(folder, 'scan & (1).pdf'), docx = join(folder, 'text & (1).docx')
  writeFileSync(pdf, pdfFixture([textPage('Paths survive')]))
  writeFileSync(docx, zip({ 'word/document.xml': '<w:document><w:p><w:r><w:t>Paths survive</w:t></w:r></w:p></w:document>' }))
  assert.match(await read(pdf), /Paths survive/)
  assert.match(await read(docx), /Paths survive/)
  await healthy()
  const source = (path: string) => readFileSync(join(import.meta.dir, '../../src', path), 'utf8')
  const convert = source('tools/DocumentTool/convert.ts'), pdfSource = source('utils/pdf.ts'), ocr = source('utils/ocr.ts')
  assert.match(convert, /execFileNoThrowWithCwd\(binary, args,/)
  assert.match(convert, /pathToFileURL\(profile\)\.href/)
  assert.match(convert, /join\(dir, `input\$\{from\}`\)/)
  assert.match(pdfSource, /args\.push\(filePath, join\(outputDir, 'page'\)\)/)
  assert.match(pdfSource, /execFileNoThrow\('pdfinfo', \[filePath\]/)
  assert.match(ocr, /execFileNoThrow\('tesseract', \['stdin', 'stdout'/)
  assert.doesNotMatch(convert + pdfSource + ocr, /shell:\s*true|exec\(`|spawn\(`/)
  console.log('PASS document argv and local paths: drive/UNC literals survive real spawn; spaces, symbols and CJK survive reads; converters use argv and file URLs. Native Windows execution not run.')
} finally { cleanup(root) }
