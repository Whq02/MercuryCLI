#!/usr/bin/env bun
// gate-watch: src/utils/permissions/filesystem.ts src/utils/permissions/pathValidation.ts src/utils/memoryFileDetection.ts
// gate-watch: src/utils/collapseReadSearch.ts src/tools/FileWriteTool/FileWriteTool.ts src/tools/FileEditTool/FileEditTool.ts src/mneme/paths.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'memory-library-write-')))
const PROJ = join(SCRATCH, 'proj')
const HOME = join(SCRATCH, 'home')
mkdirSync(PROJ, { recursive: true })
mkdirSync(HOME, { recursive: true })
process.chdir(PROJ)
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setOriginalCwd, setCwdState } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(PROJ)
setCwdState(PROJ)
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { getMnemeHome } = await import('../../src/mneme/paths.ts')
const { isPathAllowed } = await import('../../src/utils/permissions/pathValidation.ts')
const { checkEditableInternalPath, checkReadableInternalPath } = await import('../../src/utils/permissions/filesystem.ts')
const { getToolSearchOrReadInfo } = await import('../../src/utils/collapseReadSearch.ts')
const { memoryWriteRefusal } = await import('../../src/utils/memoryFileDetection.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { RETAIN_TOOL_NAME, CORRECT_TOOL_NAME } = await import('../../src/tools/MemoryTools/prompt.ts')

const lib = mnemeLibraryDir()
mkdirSync(lib, { recursive: true })
writeFileSync(join(lib, 'pins.json'), JSON.stringify({ version: 1, pins: [{ seq: 1, at: '2026-10-01T12:00:00.000Z', asked: true }] }))
writeFileSync(join(lib, 'topic-project.md'), '# project\n')
const inProject = join(PROJ, 'notes.md')
writeFileSync(inProject, 'mine\n')
const appState = getDefaultAppState()
const readFileState = new Map<string, unknown>()
readFileState.set(inProject, { content: 'mine\n', timestamp: Date.now() + 60_000 })
const context = {
  getAppState: () => appState,
  abortController: new AbortController(),
  options: { tools: [] },
  readFileState,
  userModified: false,
  updateFileHistoryState: () => {},
  dynamicSkillDirTriggers: new Set<string>(),
  nestedMemoryAttachmentTriggers: new Set<string>(),
} as never
type Verdict = { result: boolean; message?: string; errorCode?: number }
const validateWrite = async (file_path: string): Promise<Verdict> =>
  (await (FileWriteTool as { validateInput: (input: never, context: never) => Promise<Verdict> }).validateInput({ file_path, content: 'x' } as never, context))
const validateEdit = async (file_path: string): Promise<Verdict> =>
  (await (FileEditTool as { validateInput: (input: never, context: never) => Promise<Verdict> }).validateInput({ file_path, old_string: 'mine', new_string: 'ours', replace_all: false } as never, context))
const sentence = (path: string): string => `${path} is Mercury's memory: save with ${RETAIN_TOOL_NAME} and change with ${CORRECT_TOOL_NAME} — a direct write is refused.`

try {
  section('§1 the write ladder: a write under the memory library is no longer carved out as allowed; the read carve-out stays')
  const ctx = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  for (const file of ['pins.json', 'topic-project.md', 'front-page.md', 'current.jsonl']) {
    const target = join(lib, file)
    const write = isPathAllowed(target, ctx, 'write') as { allowed: boolean; decisionReason?: unknown }
    check(`default mode: a write to library/${file} is not auto-allowed`, write.allowed === false, JSON.stringify(write))
    const read = isPathAllowed(target, ctx, 'read') as { allowed: boolean }
    check(`default mode: a read of library/${file} stays allowed`, read.allowed === true, JSON.stringify(read))
  }
  const oldNote = join(getMnemeHome(), 'feedback-old-note.md')
  check('the memory directory itself (an old note beside the library) has no write carve-out either', (isPathAllowed(oldNote, ctx, 'write') as { allowed: boolean }).allowed === false)
  check('the editable carve-out classifier passes a library path through', (checkEditableInternalPath(join(lib, 'pins.json'), undefined) as { behavior: string }).behavior === 'passthrough')
  check('the readable carve-out classifier still allows it', (checkReadableInternalPath(join(lib, 'pins.json'), undefined) as { behavior: string }).behavior === 'allow')
  check('a write inside the project is untouched by this (default mode falls through to the ladder as before)', (isPathAllowed(inProject, { ...ctx, mode: 'implement' as const }, 'write') as { allowed: boolean }).allowed === true)

  section('§2 the call road: Write and Edit refuse a memory-library target with one sentence naming the verbs, whatever the mode')
  const w = await validateWrite(join(lib, 'pins.json'))
  check('Write to library/pins.json is refused before any permission ask', w.result === false, JSON.stringify(w))
  check('the sentence names Retain and Correct and the path', w.message === sentence(join(lib, 'pins.json')), w.message ?? '')
  const e = await validateEdit(join(lib, 'topic-project.md'))
  check('Edit of a topic page is refused the same way', e.result === false && e.message === sentence(join(lib, 'topic-project.md')), JSON.stringify(e))
  const wFront = await validateWrite(join(lib, 'front-page.md'))
  check('Write to the front page is refused', wFront.result === false && (wFront.message ?? '').includes('a direct write is refused'), JSON.stringify(wFront))
  const wNote = await validateWrite(oldNote)
  check('Write to an old note under the memory directory is refused too', wNote.result === false && (wNote.message ?? '').includes(RETAIN_TOOL_NAME), JSON.stringify(wNote))
  const wTraversal = await validateWrite(join(lib, '..', 'library', 'pins.json'))
  check('a traversal spelling of the library path is refused as well', wTraversal.result === false && (wTraversal.message ?? '').includes('a direct write is refused'), JSON.stringify(wTraversal))
  const wProject = await validateWrite(inProject)
  check('Write inside the project passes validation (the ordinary road)', wProject.result === true, JSON.stringify(wProject))
  const eProject = await validateEdit(inProject)
  check('Edit inside the project passes validation', eProject.result === true, JSON.stringify(eProject))

  section('§3 the transcript: a write aimed at the library is never collapsed into a memory-write row')
  const writeInfo = getToolSearchOrReadInfo('Write', { file_path: join(lib, 'pins.json'), content: 'x' }, [] as never) as { isMemoryWrite: boolean; isCollapsible: boolean }
  check('Write to library/pins.json: not a memory write, not collapsible', writeInfo.isMemoryWrite === false && writeInfo.isCollapsible === false, JSON.stringify(writeInfo))
  const editInfo = getToolSearchOrReadInfo('Edit', { file_path: join(lib, 'topic-project.md'), old_string: 'a', new_string: 'b' }, [] as never) as { isMemoryWrite: boolean }
  check('Edit of a topic page: not a memory write', editInfo.isMemoryWrite === false, JSON.stringify(editInfo))
  const sessionInfo = getToolSearchOrReadInfo('Write', { file_path: join(HOME, 'projects', 'x', 'session-memory', 'notes.md'), content: 'x' }, [] as never) as { isMemoryWrite: boolean }
  check('a session-memory file still collapses as before (the control)', sessionInfo.isMemoryWrite === true, JSON.stringify(sessionInfo))

  section('§4 memory off: no refusal sentence — the path is an ordinary file under the home')
  process.env.MERCURY_BARE = '1'
  check('with memory off the sentence is null', memoryWriteRefusal(join(lib, 'pins.json')) === null)
  const wOff = await validateWrite(join(lib, 'pins.json'))
  check('and Write validation passes to the ordinary permission road', wOff.result === true, JSON.stringify(wOff))
  delete process.env.MERCURY_BARE
  check('memory on again: the sentence returns', memoryWriteRefusal(join(lib, 'pins.json')) === sentence(join(lib, 'pins.json')))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ THE MEMORY LIBRARY IS CHANGED THROUGH ITS VERBS ONLY' : `❌ ${failures} MEMORY-LIBRARY WRITE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
