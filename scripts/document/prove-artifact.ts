import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { vendorDocumentLibraries } from '../vendor/documentLibraries.ts'

const root = join(import.meta.dir, '../..')
try {
  const manifest = await vendorDocumentLibraries(root, proofHome)
  assert.ok(manifest.licenceFiles >= 7)
  const entry = join(proofHome, 'libraries.ts')
  const packagePath = (name: string): string => JSON.stringify(join(root, 'node_modules', name))
  writeFileSync(entry, `import {Document,Packer,Paragraph} from ${packagePath('docx')};\nimport {PDFDocument} from ${packagePath('pdf-lib')};\nimport * as ExcelJS from ${JSON.stringify(join(root, 'src/tools/DocumentTool/workbook.ts'))};\nimport PptxGenJS from ${packagePath('pptxgenjs')};\nimport mammoth from ${packagePath('mammoth')};\nimport {DOMParser} from ${packagePath('@xmldom/xmldom')};\nimport assert from 'node:assert/strict';\nassert.equal(typeof globalThis.document,'undefined');\nconst doc=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Artifact fixture')]}]}));\nassert.match((await mammoth.extractRawText({buffer:doc})).value,/Artifact fixture/);\nconst pdf=await PDFDocument.create();pdf.addPage();assert.equal((await PDFDocument.load(await pdf.save())).getPageCount(),1);\nconst book=new ExcelJS.Workbook();book.addWorksheet('Evidence').addRow([1,2]);await book.xlsx.writeBuffer();\nconst slides=new PptxGenJS();slides.addSlide().addText('Artifact fixture',{x:1,y:1,w:5,h:1});await slides.write({outputType:'uint8array'});\nassert.equal(new DOMParser().parseFromString('<a/>','application/xml').documentElement.tagName,'a');\nconsole.log('PASS isolated document libraries');\n`)
  const built = await Bun.build({ entrypoints: [entry], outdir: proofHome, naming: 'libraries.mjs', target: 'node', format: 'esm', minify: true })
  assert.equal(built.success, true, built.logs.map(String).join('\n'))
  const artifact = join(proofHome, 'libraries.mjs')
  const bytes = readFileSync(artifact)
  const output = execFileSync(process.env.MERCURY_NODE ?? 'node', [artifact], { cwd: proofHome, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } })
  assert.match(output, /PASS isolated document libraries/)
  console.log(JSON.stringify({ isolatedLibraryBundleBytes: bytes.length, gzipBytes: gzipSync(bytes).length, licenceBytes: manifest.licenceBytes, licenceFiles: manifest.licenceFiles }))
  console.log('PASS artifact: pinned dependencies and licences packaged, minified Node bundle creates all binary formats outside the checkout without a DOM')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
