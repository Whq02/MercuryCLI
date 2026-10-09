import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nested-memory-admission-')))
const project = join(scratch, 'project')
mkdirSync(join(project, 'sub'), { recursive: true })
mkdirSync(join(scratch, 'home'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_BARE
process.chdir(project)
let failures = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures++
}
type Record_ = { content: string; timestamp: number; offset: number | undefined; limit: number | undefined; isPartialView?: boolean }
type Entry = { path: string; type: 'User' | 'Project' | 'Local' | 'Managed'; content: string; parent?: string; globs?: string[]; contentDiffersFromDisk?: boolean; rawContent?: string }
const entry = (path: string, extra: Partial<Entry> = {}): Entry => ({ path, type: 'Project', content: `guide at ${path}`, ...extra })
const context = () => ({ readFileState: new Map<string, Record_>(), loadedNestedMemoryPaths: new Set<string>() })
const settle = async (ready: () => boolean) => {
  const end = Date.now() + 5_000
  while (!ready() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
}
try {
  const { enableConfigs } = await import(`${root}/src/utils/config/globalConfig.ts`)
  enableConfigs()
  const { memoryFilesToAttachments } = await import(`${root}/src/utils/attachments/nestedMemory.ts`)
  const state = await import(`${root}/src/bootstrap/state.ts`)
  const guide = join(project, 'sub', 'MERCURY.md')
  const rule = join(project, '.mercury', 'rules', 'ts.md')

  const first = context()
  const before = Date.now()
  const admitted = memoryFilesToAttachments([entry(guide), entry(guide), entry(rule)], first as never, join(project, 'sub', 'file.ts'))
  check('a path repeated in one list is admitted once, in list order', admitted.map((a: { path: string }) => a.path).join(' ') === `${guide} ${rule}`)
  check('an admitted entry is a nested_memory attachment carrying the entry itself and a cwd-relative display path', admitted[0]?.type === 'nested_memory' && admitted[0]?.content.path === guide && admitted[0]?.displayPath === 'sub/MERCURY.md')
  check('an admitted path enters the loaded-paths ledger', first.loadedNestedMemoryPaths.has(guide) && first.loadedNestedMemoryPaths.has(rule))
  const record = first.readFileState.get(guide)
  check('an admitted entry gets a full-read cache record of its own content', record?.content === `guide at ${guide}` && record.offset === undefined && record.limit === undefined && !record.isPartialView && record.timestamp >= before)

  first.readFileState.delete(guide)
  const evicted = memoryFilesToAttachments([entry(guide)], first as never)
  check('the ledger keeps an evicted cache entry from re-attaching', evicted.length === 0 && !first.readFileState.has(guide))

  const cached = context()
  cached.readFileState.set(rule, { content: 'read by the user', timestamp: 1, offset: undefined, limit: undefined })
  const alreadyRead = memoryFilesToAttachments([entry(rule)], cached as never)
  check('a path already in the read cache attaches nothing and leaves the ledger alone', alreadyRead.length === 0 && cached.loadedNestedMemoryPaths.size === 0 && cached.readFileState.get(rule)?.content === 'read by the user')

  const partial = context()
  const stripped = entry(guide, { contentDiffersFromDisk: true, rawContent: '<!-- note -->\nvisible' , content: 'visible' })
  const noRaw = entry(rule, { contentDiffersFromDisk: true })
  const views = memoryFilesToAttachments([stripped, noRaw], partial as never)
  check('content that differs from disk caches the raw bytes as a partial view', partial.readFileState.get(guide)?.content === '<!-- note -->\nvisible' && partial.readFileState.get(guide)?.isPartialView === true)
  check('a differing entry without raw bytes caches its own content as a partial view', partial.readFileState.get(rule)?.content === `guide at ${rule}` && partial.readFileState.get(rule)?.isPartialView === true)
  check('the attachment still carries the entry as the model sees it', views[0]?.content === stripped && views[1]?.content === noRaw)

  const seen: Array<Record<string, unknown>> = []
  state.registerHookCallbacks({ InstructionsLoaded: [{ hooks: [{ type: 'callback', callback: async (input: Record<string, unknown>) => { seen.push(input); return {} } }] }] } as never)
  const trigger = join(project, 'sub', 'file.ts')
  const parent = join(project, 'MERCURY.md')
  memoryFilesToAttachments([
    entry(join(project, 'a.md'), { type: 'User', globs: ['src/**'] }),
    entry(join(project, 'b.md'), { type: 'Local', parent }),
    entry(join(project, 'c.md'), { type: 'Managed' }),
  ], context() as never, trigger)
  await settle(() => seen.length >= 3)
  const byPath = new Map(seen.map(input => [input.file_path, input]))
  const a = byPath.get(join(project, 'a.md'))
  const b = byPath.get(join(project, 'b.md'))
  const c = byPath.get(join(project, 'c.md'))
  check('a registered InstructionsLoaded hook hears every admitted file once', seen.length === 3 && byPath.size === 3)
  check('a rule with path globs loads as path_glob_match, carrying its globs', a?.load_reason === 'path_glob_match' && Array.isArray(a?.globs) && (a?.globs as string[])[0] === 'src/**' && a?.instruction_scope === 'User')
  check('an included file loads as include, naming its parent', b?.load_reason === 'include' && b?.parent_file_path === parent && b?.instruction_scope === 'Local')
  check('a plain nested guide loads as nested_traversal', c?.load_reason === 'nested_traversal' && c?.parent_file_path === undefined && c?.instruction_scope === 'Managed')
  check('every load names the file that triggered it', [a, b, c].every(input => input?.trigger_file_path === trigger))

  state.clearRegisteredHooks()
  const quiet = memoryFilesToAttachments([entry(join(project, 'd.md'))], context() as never, trigger)
  await new Promise(resolve => setTimeout(resolve, 50))
  check('with no hook registered the attachment still lands and nothing fires', quiet.length === 1 && seen.length === 3)
} finally {
  process.chdir(scratch)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} nested memory admission: ${failures} failures`)
process.exit(failures ? 1 : 0)
