#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTally } from '../daemon/dupline-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'read-stub-truth-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([])
process.env.ANTHROPIC_BASE_URL = api.url

const bootstrap = await import(`${SRC}/bootstrap/state.ts`)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import(`${SRC}/utils/config/globalConfig.ts`)
enableConfigs()
const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { FileEditTool } = await import(`${SRC}/tools/FileEditTool/FileEditTool.ts`)
const { FILE_UNEXPECTEDLY_MODIFIED_ERROR } = await import(`${SRC}/tools/FileEditTool/constants.ts`)
const { FILE_UNCHANGED_STUB } = await import(`${SRC}/tools/FileReadTool/prompt.ts`)
const { getChangedFiles } = await import(`${SRC}/utils/attachments/fileAttachments.ts`)
const { getDefaultAppState } = await import(`${SRC}/state/AppStateStore.ts`)
const { createFileStateCacheWithSizeLimit } = await import(`${SRC}/utils/fileStateCache.ts`)
const { getEngineModel } = await import(`${SRC}/utils/model/model.ts`)

const tally = makeTally('prove-read-stub-truth')
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — read stub-truth prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

let appState = getDefaultAppState()
const readFileState = createFileStateCacheWithSizeLimit(100)
const context = {
  abortController: new AbortController(),
  options: { tools: [], commands: [], engineModel: getEngineModel(), mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => appState,
  setAppState: (f: (s: unknown) => unknown) => {
    appState = f(appState) as typeof appState
  },
  messages: [],
  readFileState,
  userModified: false,
  dynamicSkillDirTriggers: new Set<string>(),
  nestedMemoryAttachmentTriggers: new Set<string>(),
  setInProgressToolUseIDs() {},
  setResponseLength() {},
  updateFileHistoryState() {},
  updateAttributionState() {},
}

let serial = 0
async function ownRead(input: Record<string, unknown>): Promise<{ type: string; text: string }> {
  serial++
  const result = await (FileReadTool as { call: Function }).call(input, context, null, {
    uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`,
    message: { id: `msg_stub_truth_${serial}` },
  })
  const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(result.data, `toolu_${serial}`)
  return { type: result.data.type, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
}

const fixtures = mkdtempSync(join(tmpdir(), 'read-stub-truth-fixture-'))
const file = join(fixtures, 'tracked.txt')
const original = Array.from({ length: 10 }, (_, i) => `line ${i + 1} of the tracked file`).join('\n') + '\n'
writeFileSync(file, original)

tally.section('E — the unchanged stub is sent only when its words are true')
{
  const first = await ownRead({ file_path: file })
  tally.check('0. the first own Read returns the file', first.type === 'text' && first.text.includes('6\tline 6 of the tracked file'), first.text.slice(0, 120))
  const before = readFileState.get(file)
  const changed = original.replace('line 6 of the tracked file', 'line 6 was CHANGED outside the session')
  writeFileSync(file, changed)
  const moved = new Date(statSync(file).mtimeMs + 2000)
  utimesSync(file, moved, moved)
  const attachments = await getChangedFiles(context)
  const notice = attachments.filter((row: { type: string }) => row.type === 'edited_text_file')
  tally.check('1a. the harness notice reports the outside edit once', notice.length === 1 && (notice[0] as { snippet: string }).snippet.includes('CHANGED'), JSON.stringify(attachments).slice(0, 200))
  const entry = readFileState.get(file)
  tally.check('3. after the notice the entry holds the new content and mtime with offset undefined', entry !== undefined && entry.offset === undefined && entry.limit === undefined && entry.content === changed && entry.timestamp === Math.floor(statSync(file).mtimeMs) && before !== undefined && before.offset === 0, JSON.stringify({ offset: entry?.offset, limit: entry?.limit, sameContent: entry?.content === changed }))
  const again = await ownRead({ file_path: file })
  tally.check('1. the next Read with the same input returns the file with the changed line, not the stub', again.type === 'text' && again.text.includes('6\tline 6 was CHANGED outside the session') && !again.text.startsWith(FILE_UNCHANGED_STUB), again.text.slice(0, 160))
  const repeat = await ownRead({ file_path: file })
  tally.check('2. a repeat of that Read gets the stub (its words are true now)', repeat.type === 'file_unchanged' && repeat.text === FILE_UNCHANGED_STUB, repeat.text.slice(0, 160))
  const validated = await (FileEditTool as { validateInput: Function }).validateInput({ file_path: file, old_string: 'line 6 was CHANGED outside the session', new_string: 'line 6 edited after the notice' }, context)
  tally.check('4. the border: Edit of a line from the new text is not refused as unexpectedly modified', validated.result === true || validated.message !== FILE_UNEXPECTEDLY_MODIFIED_ERROR, JSON.stringify(validated).slice(0, 200))
  const anchored = await ownRead({ file_path: file, line_anchors: true })
  const anchoredRows = anchored.text.split('\n').filter(row => /^\d+#[0-9a-f]+\t/.test(row))
  tally.check('5. an anchored repeat gets the file with anchored rows, not the stub', anchored.type === 'text' && anchoredRows.length === 10 && !anchored.text.startsWith(FILE_UNCHANGED_STUB), anchored.text.slice(0, 160))
  const plainAfterAnchored = await ownRead({ file_path: file })
  tally.check('5b. the plain repeat after it still gets the stub (the anchored read recorded the same plain entry)', plainAfterAnchored.type === 'file_unchanged', plainAfterAnchored.text.slice(0, 120))
  tally.check('5c. the file on disk is as written', readFileSync(file, 'utf8') === changed)
}

tally.section('6 — the dedup-delivery pins stay green')
{
  const dedup = join(import.meta.dir, '..', 'edit-tools', 'prove-read-dedup-delivery.ts')
  const run = spawnSync(process.execPath, [dedup], { encoding: 'utf8', env: { ...process.env, PROVE_SRC: SRC }, timeout: 100_000 })
  tally.check('6. scripts/edit-tools/prove-read-dedup-delivery.ts: all green', run.status === 0 && /ALL GREEN/.test(run.stdout), (run.stdout + run.stderr).split('\n').filter(l => l.includes('FAIL')).join(' | ').slice(0, 300))
}

await api.close()
rmSync(fixtures, { recursive: true, force: true })
tally.finish()
