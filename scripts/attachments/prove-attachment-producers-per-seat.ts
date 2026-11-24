import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'attachment-producers-per-seat-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'NODE_ENV', 'MERCURY_PROJECT_INTEL']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const previousCwd = process.cwd()
process.chdir(cwd)

let failures = 0
const WHERE = "makeMaybe and getAttachments in src/engine/attachments/turnAttachments.ts key a pending producer by the thread's owner key with its label"
const check = (label: string, good: boolean, detail = ''): void => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${good ? '' : `: ${[detail, WHERE].filter(Boolean).join('. ')}`}`)
  if (!good) failures++
}

try {
  const bootstrap = await import(`${root}/src/boot/process-state/processState.ts`)
  bootstrap.setOriginalCwd(cwd)
  bootstrap.setProjectRoot(cwd)
  bootstrap.setCwdState(cwd)
  bootstrap.setSessionTrustAccepted(true)
  bootstrap.setIsInteractive(false)
  const { enableConfigs } = await import(`${root}/src/platform/config/globalConfig.ts`)
  enableConfigs()
  const { getDefaultAppState } = await import(`${root}/src/screen/app-state/AppStateStore.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${root}/src/platform/files/fileStateCache.ts`)
  const { ReadTool: FileReadTool } = await import(`${root}/src/tools/read/ReadTool.ts`)
  const { getAttachments } = await import(`${root}/src/engine/attachments/turnAttachments.ts`)

  type Row = { type: string; filename?: string; refs?: string[]; snippet?: string }
  const seat = (agentId: string) => {
    let state = getDefaultAppState()
    return {
      agentId,
      abortController: new AbortController(),
      options: { tools: [FileReadTool], commands: [], engineModel: 'claude-fable-5-1', mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => state,
      setAppState: (f: (s: typeof state) => typeof state) => { state = f(state) },
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(100),
      loadedNestedMemoryPaths: new Set<string>(),
      nestedMemoryAttachmentTriggers: new Set<string>(),
      setInProgressToolUseIDs() {},
      setResponseLength() {},
      updateFileHistoryState() {},
    }
  }
  const toldOf = (rows: Row[], path: string): string[] =>
    rows.filter(row => (row.type === 'edited_text_file' && row.filename === path) || (row.type === 'context_capsule' && (row.refs ?? []).includes(path))).map(row => row.type)
  const editOutside = (path: string, text: string, mtime: number): boolean =>
    spawnSync(process.execPath, ['-e', 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], process.argv[2]); fs.utimesSync(process.argv[1], new Date(), new Date(Number(process.argv[3])));', path, text, String(mtime)], { encoding: 'utf8' }).status === 0

  console.log('§1 two sibling seats of one process; seat A read a file, seat B never touched it; their attachment passes overlap')
  const a = seat('seat-a')
  const b = seat('seat-b')
  const fileA = join(scratch, 'only-seat-a-read-this.txt')
  writeFileSync(fileA, 'before\nsecond\n')
  await FileReadTool.call({ file_path: fileA }, a as never)
  const heldA = a.readFileState.get(fileA)
  check('seat A holds the file after its own Read', heldA !== undefined && heldA.offset === 0, JSON.stringify({ offset: heldA?.offset, limit: heldA?.limit }))
  check('seat B holds nothing', [...b.readFileState.keys()].length === 0, [...b.readFileState.keys()].join(','))
  check('another process edits the file', editOutside(fileA, 'after\nsecond\n', (heldA?.timestamp ?? Date.now()) + 1000))
  const [rowsA, rowsB] = (await Promise.all([getAttachments(null, a as never, []), getAttachments(null, b as never, [])])) as [Row[], Row[]]
  check('control: seat A, which read the file, is told it changed', toldOf(rowsA, fileA).includes('edited_text_file'), toldOf(rowsA, fileA).join(',') || 'no row')
  check('THE LEAK: seat B, which never read or wrote the file, is told nothing of it', toldOf(rowsB, fileA).length === 0, `seat B got ${toldOf(rowsB, fileA).join(' + ')} naming ${fileA}`)
  check('seat B still holds no file', [...b.readFileState.keys()].length === 0, [...b.readFileState.keys()].join(','))

  console.log('§2 the other way round: the seat whose pass comes second is told of its OWN changed file in that same pass')
  const c = seat('seat-c')
  const d = seat('seat-d')
  const fileD = join(scratch, 'only-seat-d-read-this.txt')
  writeFileSync(fileD, 'one\ntwo\n')
  await FileReadTool.call({ file_path: fileD }, d as never)
  const heldD = d.readFileState.get(fileD)
  check("another process edits seat D's file", editOutside(fileD, 'one\nchanged\n', (heldD?.timestamp ?? Date.now()) + 1000))
  const [rowsC, rowsD] = (await Promise.all([getAttachments(null, c as never, []), getAttachments(null, d as never, [])])) as [Row[], Row[]]
  check('seat C, first in and holding nothing, is told nothing', toldOf(rowsC, fileD).length === 0, toldOf(rowsC, fileD).join(','))
  check("seat D is told of its own file in the pass that overlapped seat C's", toldOf(rowsD, fileD).includes('edited_text_file'), toldOf(rowsD, fileD).join(',') || 'no row: its own scan did not run in this pass')

  console.log('§3 one seat alone: two overlapping passes of the SAME seat still share one scan')
  const e = seat('seat-e')
  const fileE = join(scratch, 'seat-e-read-this.txt')
  writeFileSync(fileE, 'x\ny\n')
  await FileReadTool.call({ file_path: fileE }, e as never)
  const heldE = e.readFileState.get(fileE)
  check("another process edits seat E's file", editOutside(fileE, 'x\nz\n', (heldE?.timestamp ?? Date.now()) + 1000))
  const [first, second] = (await Promise.all([getAttachments(null, e as never, []), getAttachments(null, e as never, [])])) as [Row[], Row[]]
  check('both overlapping passes of one seat carry the change', toldOf(first, fileE).includes('edited_text_file') && toldOf(second, fileE).includes('edited_text_file'), `${toldOf(first, fileE).join(',') || 'none'} | ${toldOf(second, fileE).join(',') || 'none'}`)
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `FAIL attachment producers per seat: ${failures} check(s)` : 'PASS attachment producers per seat')
process.exit(failures ? 1 : 0)
