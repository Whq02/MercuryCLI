import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spyOn } from 'bun:test'

const rootArg = process.argv.indexOf('--source-root')
const root = rootArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[rootArg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'capsule-file-change-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.NODE_ENV
delete process.env.MERCURY_BARE
const bootstrap = await import(`${root}/src/boot/process-state/processState.ts`)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import(`${root}/src/platform/config/globalConfig.ts`)
enableConfigs()
const { getDefaultAppState } = await import(`${root}/src/screen/app-state/AppStateStore.ts`)
const { createFileStateCacheWithSizeLimit } = await import(`${root}/src/platform/files/fileStateCache.ts`)
const { ReadTool } = await import(`${root}/src/tools/read/ReadTool.ts`)
const { getEngineModel } = await import(`${root}/src/models/catalogue/engineModel.ts`)
const files = await import(`${root}/src/engine/attachments/fileAttachments.ts`)
const fileHelpers = await import(`${root}/src/platform/files/file.ts`)
let appState = getDefaultAppState()
const context = {
  abortController: new AbortController(),
  options: { tools: [], commands: [], engineModel: getEngineModel(), mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => appState,
  setAppState: (f: any) => { appState = f(appState) },
  messages: [],
  readFileState: createFileStateCacheWithSizeLimit(100),
  setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
}
let failures = 0
const check = (label: string, good: boolean, detail = '', hint = '') => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}${!good && hint ? ` — ${hint}` : ''}`)
  if (!good) failures++
}
const path = join(scratch, 'tracked.txt')
writeFileSync(path, 'before\nsecond\n')
await ReadTool.call({ file_path: path }, context)
const entry = context.readFileState.get(path)
check('the real read tool creates a full-read baseline', entry?.offset === 0 && entry?.limit === undefined, '', 'ReadTool.call must record the file in context.readFileState with offset 0 and no limit; see src/tools/read/ReadTool.ts')
const stats = spyOn(fileHelpers, 'getFileModificationTimeAsync')
const reads = spyOn(ReadTool, 'call')
try {
  const unchanged = await files.getChangedFiles(context)
  check('an unchanged full read costs one stat and no content read', stats.mock.calls.length === 1 && reads.mock.calls.length === 0 && unchanged.length === 0, `stats=${stats.mock.calls.length} reads=${reads.mock.calls.length} attachments=${unchanged.length}`, 'getChangedFiles in src/engine/attachments/fileAttachments.ts must stat an unchanged full read once and must not call ReadTool.call')
  stats.mockClear()
  reads.mockClear()
  const edited = spawnSync(process.execPath, ['-e', 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], "after\\nsecond\\n"); fs.utimesSync(process.argv[1], new Date(), new Date(Number(process.argv[2])));', path, String(entry.timestamp + 1000)], { encoding: 'utf8' })
  check('another process edited the tracked file', edited.status === 0, edited.stderr, 'the child node process that rewrites the tracked file exited non-zero; read its stderr above')
  const changed = await files.getChangedFiles(context)
  check('the next turn attaches the outside edit after a real full read', changed.some((row: any) => row.type === 'edited_text_file' && row.filename === path && row.snippet.includes('after')), '', 'getChangedFiles in src/engine/attachments/fileAttachments.ts must return an edited_text_file row with the new content when the file mtime moves past the recorded timestamp')
  console.log(`MEASURE outside edit stats=${stats.mock.calls.length} reads=${reads.mock.calls.length} attachments=${changed.length}`)
  const folder = join(scratch, 'seeded-folder')
  mkdirSync(folder)
  writeFileSync(join(folder, 'one.txt'), 'one\n')
  context.readFileState.set(folder, { content: '(target: directory · entries: 1 shown of 1)\none.txt', timestamp: Date.now() - 60_000, offset: 0, limit: undefined })
  reads.mockClear()
  writeFileSync(join(folder, 'two.txt'), 'two\n')
  const afterOwnWrite = await files.getChangedFiles(context)
  const again = await files.getChangedFiles(context)
  check('a directory seeded into the read cache from history never becomes an edited_text_file row when a write lands inside it, and the seed is dropped rather than re-set stale every round (F43A-C8-01)', afterOwnWrite.length === 0 && again.length === 0 && reads.mock.calls.length === 0 && context.readFileState.get(folder) === undefined, `rows=${afterOwnWrite.length}/${again.length} reads=${reads.mock.calls.length} seeded=${String(context.readFileState.get(folder) !== undefined)}`, 'getChangedFiles in src/engine/attachments/fileAttachments.ts must skip a directory target (isDirectoryTarget) and delete its readFileState entry instead of emitting a row')
} finally {
  stats.mockRestore()
  reads.mockRestore()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `FAIL file observation: ${failures} checks` : 'PASS file observation')
process.exit(failures ? 1 : 0)
