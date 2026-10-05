import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'tombstone-record-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const src = (file: string) => import(pathToFileURL(join(root, 'src', file)).href)
const writer = await src('utils/sessionStorage/writer.ts')
const { loadTranscriptFile } = await src('utils/sessionStorage/loading.ts')
const { getSessionId } = await src('bootstrap/state.ts')
const { LITE_READ_BUF_SIZE } = await src('utils/sessionStoragePortable.ts')
const sessionId = getSessionId()
const store = join(home, 'store')
mkdirSync(store)
const beyondTail = '00000000-0000-4000-8000-00000000000a'
const retained = '00000000-0000-4000-8000-00000000000b'
const insideTail = '00000000-0000-4000-8000-00000000000c'
const row = (uuid: string, parentUuid: string | null, text: string) => ({
  type: 'user', uuid, parentUuid, isSidechain: false, sessionId,
  timestamp: '2026-01-01T00:00:00.000Z', cwd: home, version: 'proof',
  message: { role: 'user', content: text },
})
const lineOf = (file: string, uuid: string): string | undefined =>
  readFileSync(file, 'utf8').split('\n').find(line => line.includes(`"uuid":"${uuid}"`))
try {
  const file = join(store, `${sessionId}.jsonl`)
  writer.setSessionFileForTesting(file)
  writer.appendEntryToFile(file, row(beyondTail, null, 'an orphan the tail window no longer covers'))
  writer.appendEntryToFile(file, row(retained, beyondTail, 'retained '.repeat(Math.ceil(LITE_READ_BUF_SIZE / 9) + 1024)))
  writer.appendEntryToFile(file, row(insideTail, retained, 'an orphan still inside the tail window'))
  const retainedLine = lineOf(file, retained)
  assert.ok(retainedLine !== undefined && retainedLine.length > LITE_READ_BUF_SIZE, 'the retained row must push the first row past the tail window')

  await writer.removeTranscriptMessage(insideTail)
  const afterFast = await loadTranscriptFile(file)
  assert.equal(afterFast.messages.has(insideTail), false, 'FAIL a record inside the tail window is removed by the byte search')
  assert.equal(afterFast.messages.has(beyondTail), true, 'FAIL the fast path removes only its target')
  assert.equal(afterFast.messages.has(retained), true, 'FAIL the fast path removes only its target')

  await writer.removeTranscriptMessage(beyondTail)
  const afterSlow = await loadTranscriptFile(file)
  assert.equal(afterSlow.messages.has(beyondTail), false, 'FAIL a record beyond the tail window is removed by the identity the reader restores')
  assert.equal(afterSlow.messages.has(retained), true, 'FAIL the rewrite keeps the unrelated row')
  assert.equal(lineOf(file, retained), retainedLine, 'FAIL the rewrite keeps the unrelated row byte for byte')
  assert.equal(lineOf(file, beyondTail), undefined, 'FAIL the removed row leaves no line behind')
  writer.resetProjectForTesting()
  console.log('PASS tombstones remove their target inside and beyond the tail window by the identity the reader restores, and keep every other row byte for byte')
} finally {
  rmSync(home, { recursive: true, force: true })
}
