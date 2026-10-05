import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'meta-owner-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
delete process.env.MERCURY_HOME
const src = (file: string) => pathToFileURL(join(root, 'src', file)).href
const { enableConfigs } = await import(src('utils/config/globalConfig.ts'))
enableConfigs()
const writer = await import(src('utils/sessionStorage/writer.ts'))
const logs = await import(src('utils/sessionStorage/logs.ts'))
const { loadTranscriptFile } = await import(src('utils/sessionStorage/loading.ts'))
const { getSessionId } = await import(src('bootstrap/state.ts'))
const sessionId = getSessionId()
const file = join(scratch, `${sessionId}.jsonl`)
try {
  writer.setSessionFileForTesting(file)
  await logs.saveCustomTitle(sessionId, 'operator title', file)
  await logs.saveTag(sessionId, 'operator tag', file)
  writer.appendEntryToFile(file, {
    type: 'assistant', uuid: '00000000-0000-4000-8000-000000000007', parentUuid: null, isSidechain: false, sessionId,
    timestamp: '2026-01-01T00:00:00.000Z', cwd: scratch, version: 'proof',
    message: { role: 'assistant', model: '', id: 'fixture-output', content: [{ type: 'tool_use', id: 'fixture-call', name: 'fixture', input: { metaKind: 'custom-title', customTitle: 'not a session title', nested: { metaKind: 'tag', tag: 'not a session tag' } } }] },
  })
  logs.reAppendSessionMetadata()
  const loaded = await loadTranscriptFile(file)
  assert.equal(loaded.customTitles.get(sessionId), 'operator title', 'FAIL nested tool input must not become session metadata during restamp')
  assert.equal(loaded.tags.get(sessionId), 'operator tag')
  logs.saveWorktreeState({ originalCwd: scratch, worktreePath: join(scratch, 'tree'), worktreeName: 'fixture', sessionId })
  await logs.linkSessionToPR(sessionId, 17, 'https://example.invalid/pull/17', 'fixture/project', file)
  logs.reAppendSessionMetadata()
  const withFacts = await loadTranscriptFile(file)
  assert.equal(withFacts.worktreeStates.get(sessionId)?.worktreeName, 'fixture')
  assert.equal(withFacts.prNumbers.get(sessionId), 17)
  logs.clearSessionMetadata()
  assert.equal(logs.getCurrentSessionTitle(sessionId), undefined)
  logs.restoreSessionMetadata(logs.resumeFactsOf(withFacts, sessionId, []))
  assert.equal(logs.getCurrentSessionTitle(sessionId), 'operator title')
  logs.saveWorktreeState(null)
  assert.equal((await loadTranscriptFile(file)).worktreeStates.get(sessionId), null)
  writer.resetProjectForTesting()
  console.log('PASS session metadata: nested content is inert, title/tag survive, synthetic worktree/PR restore, clear and exit')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
