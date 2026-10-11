import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spyOn } from 'bun:test'

const home = mkdtempSync(join(tmpdir(), 'binary-output-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const storage = await import(join(root, 'utils/toolResultStorage.ts'))
const { persistBinaryContent } = await import(join(root, 'utils/mcpOutputStorage.ts'))
try {
  const bytes = Buffer.from([0, 255, 1, 13, 10])
  const cases: Array<[string | undefined, string]> = [
    [' Application/PDF ; charset=binary', 'pdf'], ['text/plain', 'txt'], [undefined, 'bin'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['image/svg+xml', 'svg'], ['audio/ogg', 'ogg'], ['unlisted/type', 'bin'],
  ]
  for (const [mime, ext] of cases) {
    const result = await persistBinaryContent(bytes, mime, `sample-${ext}`)
    assert(!('error' in result))
    assert.equal(result.ext, ext)
    assert.equal(result.size, bytes.length)
    assert(result.filepath.endsWith(`sample-${ext}.${ext}`))
    assert.deepEqual(readFileSync(result.filepath), bytes)
  }
  assert('error' in await persistBinaryContent(bytes, 'image/png', 'missing-parent/file'))
  const ensure = spyOn(storage, 'ensureToolResultsDir').mockRejectedValue(new Error('fixture directory failure'))
  try { await assert.rejects(persistBinaryContent(bytes, 'application/pdf', 'unwritten'), /fixture directory failure/) } finally { ensure.mockRestore() }
  console.log('PASS exact binary bytes, MIME extensions, write errors and directory failure boundary')
} finally { rmSync(home, { recursive: true, force: true }) }
