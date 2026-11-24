import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'changed-file-scan-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'fixture-key'
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'NODE_ENV', 'MERCURY_PROJECT_INTEL', 'MERCURY_PULSE_FIXTURE']) delete process.env[key]
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }
const previousCwd = process.cwd()
process.chdir(cwd)

const WHERE = 'getChangedFiles in src/engine/attachments/fileAttachments.ts runs the diffs of the files a seat read (getSnippetForTwoFileDiff in src/tools/edit/call/editMatching.ts); it must hand the thread back between them, take the files in the order of the read list, stop taking files once the gathering is called off, and leave the read state of every file it did not tell of as it was, so the next scan tells of it and an edit on its old contents is refused meanwhile'
const HOLD_LIMIT_MS = 100
const FILES = 40
const LINES = 800
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}${ok ? '' : ` — ${WHERE}`}`)
  if (!ok) failures++
}

type Scene = { name: string; before: (file: number) => string; after: (file: number) => string; digest: string }
const stable = (file: number): string => `export const stable_${file} = true`
const lines = (file: number, make: (line: number) => string): string => `${Array.from({ length: LINES }, (_, line) => (line === 0 ? stable(file) : make(line))).join('\n')}\n`
const kept = (line: number): boolean => line % 9 === 4 || line % 14 === 0
const scenes: Scene[] = [
  {
    name: 'every line rewritten but the first',
    before: file => lines(file, line => `const before_${file}_${line} = ${line}`),
    after: file => lines(file, line => `export const after_${file}_${line} = ${line * 3}`),
    digest: '6f41eaffa59e9f46a83a46d8d5f2f5b17c3e18e4bd82bcc2b153e4f3b385c5ed',
  },
  {
    name: 'every line rewritten but the first, the braces and the blank lines',
    before: file => lines(file, line => (kept(line) ? (line % 2 === 0 ? '}' : '') : `const before_${file}_${line} = ${line}`)),
    after: file => lines(file, line => (kept(line) ? (line % 2 === 0 ? '}' : '') : `export const after_${file}_${line} = ${line * 3}`)),
    digest: 'a4e8f1cf2896d91021b889d439226ede82fbd19d88049e825e90738a9092c928',
  },
]

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
  const { createFileStateCacheWithSizeLimit, cacheKeys } = await import(`${root}/src/platform/files/fileStateCache.ts`)
  const { ReadTool } = await import(`${root}/src/tools/read/ReadTool.ts`)
  const { EditTool } = await import(`${root}/src/tools/edit/EditTool.ts`)
  const { getEngineModel } = await import(`${root}/src/models/catalogue/engineModel.ts`)
  const { getChangedFiles } = await import(`${root}/src/engine/attachments/fileAttachments.ts`)
  const { getAttachments } = await import(`${root}/src/engine/attachments/turnAttachments.ts`)
  const { getSnippetForTwoFileDiff } = await import(`${root}/src/tools/edit/call/editMatching.ts`)

  type Note = { type: string; filename: string; snippet: string }
  type Verdict = { result: boolean; errorCode?: number; message?: string }
  const newContext = () => {
    let state = getDefaultAppState()
    return {
      abortController: new AbortController(),
      options: { tools: [ReadTool], commands: [], engineModel: getEngineModel(), mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => state,
      setAppState: (change: (prev: typeof state) => typeof state) => { state = change(state) },
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(200),
      loadedNestedMemoryPaths: new Set<string>(),
      nestedMemoryAttachmentTriggers: new Set<string>(),
      dynamicSkillDirTriggers: new Set<string>(),
      setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
    }
  }
  const pathOf = (dir: string, file: number): string => join(dir, `file-${String(file).padStart(2, '0')}.ts`)
  const fileOf = (path: string): number => Number(path.slice(-5, -3))
  const stage = async (scene: Scene, tag: string) => {
    const dir = join(cwd, tag)
    mkdirSync(dir, { recursive: true })
    const context = newContext()
    for (let file = 0; file < FILES; file++) {
      writeFileSync(pathOf(dir, file), scene.before(file))
      await ReadTool.call({ file_path: pathOf(dir, file) }, context)
    }
    for (let file = 0; file < FILES; file++) {
      const path = pathOf(dir, file)
      writeFileSync(path, scene.after(file))
      const moved = new Date(context.readFileState.get(path)!.timestamp + 5_000)
      utimesSync(path, moved, moved)
    }
    return { dir, context }
  }
  const held = async <T>(work: () => Promise<T>): Promise<{ value: T; longestMs: number; wallMs: number }> => {
    await new Promise<void>(done => setTimeout(done, 20))
    const started = performance.now()
    let last = started
    let longest = 0
    const beat = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 5)
    try {
      const value = await work()
      longest = Math.max(longest, performance.now() - last)
      return { value, longestMs: Math.round(longest), wallMs: Math.round(performance.now() - started) }
    } finally {
      clearInterval(beat)
    }
  }
  const gather = (context: ReturnType<typeof newContext>) => held(() => getAttachments(null, context, [], [], undefined, { localSubmission: true }))
  const digestOf = (snippets: string[]): string => createHash('sha256').update(JSON.stringify(snippets)).digest('hex')
  const notesOf = (rows: unknown): Note[] => (rows as Note[]).filter(row => row.type === 'edited_text_file')
  const namesOf = (notes: Note[]): string[] => notes.map(note => note.filename)
  const referenceOf = (scene: Scene): { snippets: string[]; slowestMs: number } => {
    let slowestMs = 0
    const snippets = Array.from({ length: FILES }, (_, file) => {
      const started = performance.now()
      const snippet: string = getSnippetForTwoFileDiff(scene.before(file), scene.after(file), 1)
      slowestMs = Math.max(slowestMs, performance.now() - started)
      return snippet
    })
    return { snippets, slowestMs: Math.round(slowestMs) }
  }
  const editOnOldContents = async (context: ReturnType<typeof newContext>, path: string): Promise<Verdict> => {
    const verdict: Verdict = await EditTool.validateInput({ file_path: path, old_string: stable(fileOf(path)), new_string: `${stable(fileOf(path))} && false` }, context)
    return { result: verdict.result, errorCode: verdict.errorCode, message: verdict.message?.replaceAll(path, '<file>') }
  }

  for (const [at, scene] of scenes.entries()) {
    const { snippets: reference, slowestMs } = referenceOf(scene)
    const holdLimitMs = Math.max(HOLD_LIMIT_MS, Math.ceil(slowestMs * 1.5))
    console.log(`MEASURE ${scene.name}: the snippets' digest is ${digestOf(reference)}; one file's diff took ${slowestMs} ms at the slowest`)
    check(`${scene.name}: the snippet door answers the bytes it answered before the scan was sliced`, digestOf(reference) === scene.digest, `digest ${digestOf(reference)}, pinned ${scene.digest}`)

    const direct = await stage(scene, `direct-${at}`)
    const readList: string[] = cacheKeys(direct.context.readFileState)
    const scan = await held(() => getChangedFiles(direct.context))
    const notes = notesOf(scan.value)
    console.log(`MEASURE ${scene.name}: scan of ${FILES} files of ${LINES} lines took ${scan.wallMs} ms and held the thread ${scan.longestMs} ms at the longest`)
    check(`${scene.name}: the scan hands back a note for each of the ${FILES} files, in the order of the read list, each the snippet door's own bytes`, readList.length === FILES && JSON.stringify(notes.map(note => [note.filename, note.snippet])) === JSON.stringify(readList.map(path => [path, reference[fileOf(path)]])), `${notes.length} notes`)
    check(`${scene.name}: the thread comes back within ${holdLimitMs} ms throughout the scan`, scan.longestMs <= holdLimitMs, `${scan.longestMs} ms at the longest of ${scan.wallMs} ms`)
    const again = await getChangedFiles(direct.context)
    check(`${scene.name}: the next scan finds nothing left to tell`, again.length === 0, `${again.length} rows`)

    const gathered = await stage(scene, `gathered-${at}`)
    const carried: string[] = cacheKeys(gathered.context.readFileState)
    const delivered: Note[] = []
    const rounds: Array<{ notes: number; wallMs: number; longestMs: number }> = []
    for (let round = 0; round < 8 && delivered.length < FILES; round++) {
      const pass = await gather(gathered.context)
      const got = notesOf(pass.value)
      delivered.push(...got)
      rounds.push({ notes: got.length, wallMs: pass.wallMs, longestMs: pass.longestMs })
      await new Promise<void>(done => setTimeout(done, 1_200))
    }
    console.log(`MEASURE ${scene.name}: through the gatherer ${JSON.stringify(rounds)}`)
    const byFile = new Map(delivered.map(note => [note.filename, note.snippet]))
    check(`${scene.name}: through the gatherer every file's note arrives once, none lost to the deadline, each the snippet door's own bytes`, delivered.length === FILES && reference.every((snippet, file) => byFile.get(pathOf(gathered.dir, file)) === snippet), `${delivered.length} notes over ${rounds.length} gathering(s)`)
    check(`${scene.name}: the gatherings' notes, one after the other, are what one gathering would have carried, in its order`, JSON.stringify(namesOf(delivered)) === JSON.stringify(carried), `${rounds.map(round => round.notes).join(' + ')} notes; first out of order at ${namesOf(delivered).findIndex((name, index) => name !== carried[index])}`)
    check(`${scene.name}: no gathering holds the thread longer than ${holdLimitMs} ms`, rounds.every(round => round.longestMs <= holdLimitMs), JSON.stringify(rounds.map(round => round.longestMs)))
    check(`${scene.name}: no gathering runs past its two second deadline`, rounds.every(round => round.wallMs < 2_300), JSON.stringify(rounds.map(round => round.wallMs)))

    const untold = await stage(scene, `untold-${at}`)
    const order: string[] = cacheKeys(untold.context.readFileState)
    const first = notesOf((await gather(untold.context)).value)
    const reached = order[0]!
    const unreached = order[FILES - 1]!
    const control = await stage(scene, `control-${at}`)
    const asToday = await editOnOldContents(control.context, pathOf(control.dir, fileOf(unreached)))
    const refused = await editOnOldContents(untold.context, unreached)
    const allowed = await editOnOldContents(untold.context, reached)
    console.log(`MEASURE ${scene.name}: after one gathering of ${first.length} notes, an edit on the old contents of a file it did not reach answers ${JSON.stringify(refused)}; with no scan at all ${JSON.stringify(asToday)}; on a file it told of ${JSON.stringify({ result: allowed.result })}`)
    check(`${scene.name}: the first gathering is called off before it reaches the last file of the read list`, first.length < FILES && !namesOf(first).includes(unreached) && namesOf(first)[0] === reached, `${first.length} notes`)
    check(`${scene.name}: an edit on the old contents of a file the scan did not reach is refused, in the words and the code the edit tool gives before any scan`, refused.result === false && asToday.result === false && JSON.stringify(refused) === JSON.stringify(asToday), `${JSON.stringify(refused)} against ${JSON.stringify(asToday)}`)
    check(`${scene.name}: the same edit on a file the scan told of goes through`, allowed.result === true, JSON.stringify(allowed))
  }
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `FAIL changed-file scan: ${failures} checks` : 'PASS changed-file scan')
process.exit(failures ? 1 : 0)
