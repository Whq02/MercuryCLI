import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanup, pdfFixture, reader, scratch, textPage, zip } from './hardening-fixtures.ts'

const root = scratch('paths')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
try {
  const { execFileNoThrow } = await import('../../src/platform/processes/execFileNoThrow.ts')
  const { documentPath } = await import('../../src/tools/document/files.ts')
  const { parseRichFormatTarget } = await import('../../src/tools/read/readRichFormats.ts')
  const folder = join(root, '資料 & (draft) # 100%')
  mkdirSync(folder)
  const probe = join(folder, 'argv.mjs')
  writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const drive = String.raw`C:\Reports & (draft)\資料 100%\scan.pdf`
  const unc = String.raw`\\server\share\Research & notes\paper.docx`
  const values = [drive, unc, '-env:UserInstallation=' + pathToFileURL(win32.join('C:\\Reports & (draft)', 'office-profile'), { windows: true }).href, 'literal "quotes" and $HOME ; !']
  const spawned = await execFileNoThrow(process.execPath, [probe, ...values], { useCwd: false, timeout: 10_000 })
  assert.equal(spawned.code, 0, spawned.stderr + ' | the argv probe did not exit 0; look at execFileNoThrow in src/platform/processes/execFileNoThrow.ts, which must pass argv values to the child unchanged')
  assert.deepEqual(JSON.parse(spawned.stdout), values, 'a path or argument changed on its way through execFileNoThrow in src/platform/processes/execFileNoThrow.ts; it must hand drive, UNC, file URL and symbol values to the child literally')
  assert.doesNotThrow(() => documentPath(drive), 'documentPath in src/tools/document/files.ts refused a Windows drive path; it must accept it as a local file')
  assert.doesNotThrow(() => documentPath(unc), 'documentPath in src/tools/document/files.ts refused a UNC path; it must accept it as a local file')
  assert.throws(() => documentPath('https://example.invalid/report.pdf'), /local files/, 'documentPath in src/tools/document/files.ts must refuse a URL with an error that says local files only')
  assert.deepEqual(parseRichFormatTarget(String.raw`C:\Reports\archive.zip:notes.txt`), { kind: 'archive', containerPath: String.raw`C:\Reports\archive.zip`, ext: 'zip', subtarget: 'notes.txt' }, 'parseRichFormatTarget in src/tools/read/readRichFormats.ts must split a Windows archive path at the colon after the extension, not at the drive colon')
  const { read, healthy } = await reader(root)
  const pdf = join(folder, 'scan & (1).pdf'), docx = join(folder, 'text & (1).docx')
  writeFileSync(pdf, pdfFixture([textPage('Paths survive')]))
  writeFileSync(docx, zip({ 'word/document.xml': '<w:document><w:p><w:r><w:t>Paths survive</w:t></w:r></w:p></w:document>' }))
  assert.match(await read(pdf), /Paths survive/, 'reading the PDF in a folder with spaces, symbols and CJK did not return its text; look at the document read path under src/tools/document/ and src/tools/read/')
  assert.match(await read(docx), /Paths survive/, 'reading the DOCX in a folder with spaces, symbols and CJK did not return its text; look at the document read path under src/tools/document/ and src/tools/read/')
  await healthy()
  console.log('PASS document argv and local paths: drive/UNC literals survive real spawn; spaces, symbols and CJK survive reads; converters use argv and file URLs. Native Windows execution not run.')
} finally { cleanup(root) }
