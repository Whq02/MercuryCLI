import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const calls: { binary: string; args: string[]; options: any }[] = []
const pdf = await PDFDocument.create(); pdf.addPage().drawText('Converted fixture')
const pdfBytes = await pdf.save()
const which = await import('../../src/utils/which.ts')
const execution = await import('../../src/utils/execFileNoThrow.ts')
mock.module('../../src/utils/which.js', () => ({ ...which, whichSync: (name: string) => `/fixture/${name}` }))
mock.module('../../src/utils/execFileNoThrow.js', () => ({
  ...execution,
  execFileNoThrowWithCwd: async (binary: string, args: string[], options: any) => {
    calls.push({ binary, args, options })
    assert.equal(options.env.HOME, options.cwd)
    assert.equal(options.env.USERPROFILE, options.cwd)
    if (binary.endsWith('soffice')) {
      assert.ok(args.includes('--headless'))
      assert.match(args[0]!, /^-env:UserInstallation=file:/)
      assert.equal(args[args.indexOf('--outdir') + 1], options.cwd)
      assert.match(readFileSync(join(options.cwd, 'office-profile', 'registrymodifications.xcu'), 'utf8'), /MacroSecurityLevel/)
      writeFileSync(join(options.cwd, 'input.pdf'), pdfBytes)
    } else {
      assert.ok(args.includes('--sandbox'))
      writeFileSync(args[args.indexOf('--output') + 1]!, '<h1>Converted fixture</h1>')
    }
    return { code: 0, stdout: '', stderr: '' }
  },
}))
const { createDocument } = await import('../../src/tools/DocumentTool/create.ts')
const { convertDocument } = await import('../../src/tools/DocumentTool/convert.ts')
const io = { read: async (path: string) => readFileSync(path), signal: new AbortController().signal }
try {
  const source = join(proofHome, 'fixture.docx')
  writeFileSync(source, (await createDocument({ op: 'create', output: source, markdown: '# Fixture' }, io)).files[0]!.bytes)
  for (const [renderer, ext, road] of [['libreoffice', 'pdf', 'LibreOffice'], ['pandoc', 'html', 'pandoc']] as const) {
    const product = await convertDocument({ op: 'convert', source, output: join(proofHome, `result.${ext}`), renderer }, io)
    assert.equal(product.road, road)
    assert.ok(product.files[0]!.bytes.length)
    assert.equal(existsSync(calls[calls.length - 1]!.options.cwd), false)
  }
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0]!.options.cwd, calls[1]!.options.cwd)
  console.log('PASS converter command contract: explicit argv, separate scratch profiles, sandbox argument, bytes read back and scratch cleanup; stand-ins, not live converter verification')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
