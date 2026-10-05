import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'sdk-listing-tag-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home)
mkdirSync(cwd)
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const src = (file: string) => import(pathToFileURL(join(root, 'src', file)).href)
const { enableConfigs } = await src('utils/config/globalConfig.ts')
enableConfigs()
const writer = await src('utils/sessionStorage/writer.ts')
const logs = await src('utils/sessionStorage/logs.ts')
const { getProjectDir } = await src('utils/sessionStorage/paths.ts')
const { listSessionsImpl } = await src('utils/listSessionsImpl.ts')
const sessionId = '00000000-0000-4000-8000-00000000c0de'
const row = (uuid: string, parentUuid: string | null, content: unknown) => ({
  type: 'user', uuid, parentUuid, isSidechain: false, sessionId, cwd, version: 'proof',
  timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content },
})
try {
  const project = getProjectDir(cwd)
  mkdirSync(project, { recursive: true })
  const file = join(project, `${sessionId}.jsonl`)
  writer.setSessionFileForTesting(file)
  writer.appendEntryToFile(file, row('00000000-0000-4000-8000-000000000001', null, 'label this session'))
  await logs.saveTag(sessionId, 'operator tag', file)
  writer.appendEntryToFile(file, row('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', [
    { type: 'tool_result', tool_use_id: 'fixture-call', content: '{"tag":"a field inside tool output"}' },
  ]))
  const rows = await listSessionsImpl({ dir: cwd })
  const listed = rows.find((entry: { sessionId: string }) => entry.sessionId === sessionId)
  assert.ok(listed !== undefined, 'FAIL the tagged session is listed')
  assert.equal(listed.tag, 'operator tag', 'FAIL the editor listing reads the tag the product stored as a session-meta record')
  writer.resetProjectForTesting()
  console.log('PASS the editor session list carries the saved tag and ignores a tag-shaped field inside tool output')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
