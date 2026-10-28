import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { drive, enterRoot, makeContext } from '../ast-tools/lib/harness.ts'

process.env.MERCURY_CONFIG_DIR = join(proofHome, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const originalCwd = process.cwd()
const { DocumentTool } = await import('../../src/tools/DocumentTool/DocumentTool.ts')
const { subscribeChangeReceipts } = await import('../../src/services/changeTransaction/receipts.ts')
const { captureDestinations } = await import('../../src/tools/DocumentTool/files.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { isDeferredTool } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const root = join(proofHome, 'project'); mkdirSync(root)
const receipts: any[] = []
subscribeChangeReceipts(receipt => receipts.push(receipt))
try {
  await enterRoot(root)
  assert.ok(getAllBaseTools().some(t => t.name === 'Document'))
  assert.equal(isDeferredTool(DocumentTool), true)
  const tools = [DocumentTool]
  const output = join(root, 'report.docx')
  const input = { op: 'create', output, markdown: '# Evidence\n\nA body paragraph.' }
  const declined = await drive(DocumentTool, input, await makeContext(tools), { answer: 'deny' })
  assert.equal(declined.isError, true)
  assert.equal(declined.asks.length, 1)
  assert.equal(existsSync(output), false)
  assert.match(declined.asks[0]!.message!, /Permission to write to/)
  const allowed = await drive(DocumentTool, input, await makeContext(tools))
  assert.equal(allowed.isError, false, allowed.text)
  assert.equal(allowed.asks.length, 1)
  assert.ok(existsSync(output))
  assert.deepEqual(receipts.at(-1).effect.changedPaths, [output])
  const inspect = await drive(DocumentTool, { op: 'inspect', source: output }, await makeContext(tools))
  assert.equal(inspect.isError, false, inspect.text)
  assert.equal(inspect.asks.length, 0)
  const map = JSON.parse(inspect.text).detail
  assert.ok(map.sha256)
  assert.doesNotMatch(inspect.text, /A body paragraph/)
  const denied = await drive(DocumentTool, { ...input, output: join(root, 'denied.docx') }, await makeContext(tools, { mode: 'implement', deny: ['Write(denied.docx)'] }))
  assert.equal(denied.isError, true)
  assert.equal(existsSync(join(root, 'denied.docx')), false)
  const stale = await drive(DocumentTool, { ...input, expectedSha256: { [output]: '0'.repeat(64) } }, await makeContext(tools, { mode: 'implement' }))
  assert.equal(stale.isError, true)
  const replaced = await drive(DocumentTool, { ...input, markdown: '# Replacement', expectedSha256: { [output]: map.sha256 } }, await makeContext(tools, { mode: 'implement' }))
  assert.equal(replaced.isError, false, replaced.text)
  const before = readFileSync(output)
  const invalid = await drive(DocumentTool, { op: 'create', source: output, output: join(root, 'empty.docx') }, await makeContext(tools, { mode: 'implement' }))
  assert.equal(invalid.isError, true)
  assert.ok(readFileSync(output).equals(before))
  const external = join(proofHome, 'outside.md')
  const outside = await drive(DocumentTool, { op: 'create', output: external, markdown: '# Outside' }, await makeContext(tools, { mode: 'implement' }), { answer: 'deny' })
  assert.equal(outside.isError, true)
  assert.equal(outside.asks.length, 1)
  assert.equal(existsSync(external), false)
  writeFileSync(join(proofHome, 'external.png'), Buffer.from('not read'))
  writeFileSync(join(root, 'linked.html'), '<p>Evidence</p><img src="../external.png">')
  const imageDenied = await drive(DocumentTool, { op: 'convert', source: join(root, 'linked.html'), output: join(root, 'linked.docx'), renderer: 'plain' }, await makeContext(tools, { mode: 'implement' }), { answer: 'deny' })
  assert.equal(imageDenied.isError, true)
  assert.equal(imageDenied.asks.length, 1)
  assert.equal(existsSync(join(root, 'linked.docx')), false)
  symlinkSync(root, join(root, 'alias'))
  assert.throws(() => captureDestinations({ op: 'split', parts: [{ pages: '1', output: join(root, 'same.pdf') }, { pages: '1', output: join(root, 'alias', 'same.pdf') }] }), /same file/)
  console.log('PASS tool door: real registry/deferral, validation, write ask/decline, deny rules, byte write receipt, structure read, digest replacement and aliased-output refusal')
} finally { process.chdir(originalCwd); rmSync(proofHome, { recursive: true, force: true }) }
