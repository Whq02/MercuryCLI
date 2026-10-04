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
const bootstrap = await import(`${root}/src/bootstrap/state.ts`)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import(`${root}/src/utils/config/globalConfig.ts`)
enableConfigs()
const { getDefaultAppState } = await import(`${root}/src/state/AppStateStore.ts`)
const { createFileStateCacheWithSizeLimit } = await import(`${root}/src/utils/fileStateCache.ts`)
const { FileReadTool } = await import(`${root}/src/tools/FileReadTool/FileReadTool.ts`)
const { getEngineModel } = await import(`${root}/src/utils/model/model.ts`)
const files = await import(`${root}/src/utils/attachments/fileAttachments.ts`)
const fileHelpers = await import(`${root}/src/utils/file.ts`)
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
const check = (label: string, good: boolean, detail = '') => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!good) failures++
}
const path = join(scratch, 'tracked.txt')
writeFileSync(path, 'before\nsecond\n')
await FileReadTool.call({ file_path: path }, context)
const entry = context.readFileState.get(path)
check('the real read tool creates a full-read baseline', entry?.offset === 0 && entry?.limit === undefined)
const stats = spyOn(fileHelpers, 'getFileModificationTimeAsync')
const reads = spyOn(FileReadTool, 'call')
try {
  const unchanged = await files.getChangedFiles(context)
  check('an unchanged full read costs one stat and no content read', stats.mock.calls.length === 1 && reads.mock.calls.length === 0 && unchanged.length === 0, `stats=${stats.mock.calls.length} reads=${reads.mock.calls.length} attachments=${unchanged.length}`)
  stats.mockClear()
  reads.mockClear()
  const edited = spawnSync(process.execPath, ['-e', 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], "after\\nsecond\\n"); fs.utimesSync(process.argv[1], new Date(), new Date(Number(process.argv[2])));', path, String(entry.timestamp + 1000)], { encoding: 'utf8' })
  check('another process edited the tracked file', edited.status === 0, edited.stderr)
  const changed = await files.getChangedFiles(context)
  check('the next turn attaches the outside edit after a real full read', changed.some((row: any) => row.type === 'edited_text_file' && row.filename === path && row.snippet.includes('after')))
  console.log(`MEASURE outside edit stats=${stats.mock.calls.length} reads=${reads.mock.calls.length} attachments=${changed.length}`)
} finally {
  stats.mockRestore()
  reads.mockRestore()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `FAIL file observation: ${failures} checks` : 'PASS file observation')
process.exit(failures ? 1 : 0)
