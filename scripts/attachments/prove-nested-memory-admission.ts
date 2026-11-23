import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

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
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
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
  const { enableConfigs } = await import(`${root}/src/platform/config/globalConfig.ts`)
  enableConfigs()
  const { instructionFilesToAttachments } = await import(`${root}/src/engine/attachments/nestedInstructions.ts`)
  const state = await import(`${root}/src/boot/process-state/processState.ts`)
  const guide = join(project, 'sub', 'MERCURY.md')
  const rule = join(project, '.mercury', 'rules', 'ts.md')

  const first = context()
  const before = Date.now()
  const admitted = instructionFilesToAttachments([entry(guide), entry(guide), entry(rule)], first as never)
  check('a path repeated in one list is admitted once, in list order', admitted.map((a: { path: string }) => a.path).join(' ') === `${guide} ${rule}`, `got ${admitted.map((a: { path: string }) => a.path).join(' ')} — instructionFilesToAttachments in src/engine/attachments/nestedInstructions.ts must skip a repeated path and keep list order`)
  check('an admitted entry is a nested_memory attachment carrying the entry itself and a cwd-relative display path', admitted[0]?.type === 'nested_memory' && admitted[0]?.content.path === guide && admitted[0]?.displayPath === join('sub', 'MERCURY.md'), `type ${admitted[0]?.type} path ${admitted[0]?.content?.path} display ${admitted[0]?.displayPath} — fix the attachment built in instructionFilesToAttachments in src/engine/attachments/nestedInstructions.ts`)
  check('an admitted path enters the loaded-paths ledger', first.loadedNestedMemoryPaths.has(guide) && first.loadedNestedMemoryPaths.has(rule), 'instructionFilesToAttachments in src/engine/attachments/nestedInstructions.ts must add each admitted path to loadedNestedMemoryPaths')
  const record = first.readFileState.get(guide)
  check('an admitted entry gets a full-read cache record of its own content', record?.content === `guide at ${guide}` && record.offset === undefined && record.limit === undefined && !record.isPartialView && record.timestamp >= before, `record ${JSON.stringify(record)} — the cache record written in src/engine/attachments/nestedInstructions.ts must be a full read of the entry content with a fresh timestamp`)

  first.readFileState.delete(guide)
  const evicted = instructionFilesToAttachments([entry(guide)], first as never)
  check('the ledger keeps an evicted cache entry from re-attaching', evicted.length === 0 && !first.readFileState.has(guide), `evicted ${evicted.length} — instructionFilesToAttachments in src/engine/attachments/nestedInstructions.ts must consult loadedNestedMemoryPaths before attaching again and must not rewrite the cache`)

  const cached = context()
  cached.readFileState.set(rule, { content: 'read by the user', timestamp: 1, offset: undefined, limit: undefined })
  const alreadyRead = instructionFilesToAttachments([entry(rule)], cached as never)
  check('a path already in the read cache attaches nothing and leaves the ledger alone', alreadyRead.length === 0 && cached.loadedNestedMemoryPaths.size === 0 && cached.readFileState.get(rule)?.content === 'read by the user', `attached ${alreadyRead.length}, ledger ${cached.loadedNestedMemoryPaths.size} — instructionFilesToAttachments in src/engine/attachments/nestedInstructions.ts must skip a path already in readFileState without touching the ledger`)

  const partial = context()
  const stripped = entry(guide, { contentDiffersFromDisk: true, rawContent: '<!-- note -->\nvisible' , content: 'visible' })
  const noRaw = entry(rule, { contentDiffersFromDisk: true })
  const views = instructionFilesToAttachments([stripped, noRaw], partial as never)
  check('content that differs from disk caches the raw bytes as a partial view', partial.readFileState.get(guide)?.content === '<!-- note -->\nvisible' && partial.readFileState.get(guide)?.isPartialView === true, 'src/engine/attachments/nestedInstructions.ts must cache rawContent as a partial view when contentDiffersFromDisk is set')
  check('a differing entry without raw bytes caches its own content as a partial view', partial.readFileState.get(rule)?.content === `guide at ${rule}` && partial.readFileState.get(rule)?.isPartialView === true, 'src/engine/attachments/nestedInstructions.ts must cache the entry own content as a partial view when contentDiffersFromDisk is set and rawContent is missing')
  check('the attachment still carries the entry as the model sees it', views[0]?.content === stripped && views[1]?.content === noRaw, 'src/engine/attachments/nestedInstructions.ts must attach the entry object unchanged, not the cached raw bytes')

  const parent = join(project, 'MERCURY.md')
  const admittedByReason = instructionFilesToAttachments([
    entry(join(project, 'a.md'), { type: 'User', globs: ['src/**'] }),
    entry(join(project, 'b.md'), { type: 'Local', parent }),
    entry(join(project, 'c.md'), { type: 'Managed' }),
  ], context() as never)
  check('every admitted file lands as an attachment, whatever its load reason', admittedByReason.length === 3, `admitted ${admittedByReason.length} of 3 — instructionFilesToAttachments in src/engine/attachments/nestedInstructions.ts must not filter by type, globs or parent`)
  const quiet = instructionFilesToAttachments([entry(join(project, 'd.md'))], context() as never)
  check('a plain nested guide lands too', quiet.length === 1, `admitted ${quiet.length} of 1 — see instructionFilesToAttachments in src/engine/attachments/nestedInstructions.ts`)

  const { getMaxInstructionFileCharacterCount } = await import(`${root}/src/sessions/instructions/instructionFiles.ts`)
  const cap: number = getMaxInstructionFileCharacterCount()
  const hugeGuide = join(project, 'sub', 'huge', 'MERCURY.md')
  const line = `- a rule line ${'x'.repeat(60)}\n`
  const huge = line.repeat(Math.ceil((cap * 3) / line.length))
  const bounded = context()
  const [clipped] = instructionFilesToAttachments([entry(hugeGuide, { content: huge })], bounded as never)
  const shown: string = clipped?.content.content ?? ''
  const keptPart = shown.slice(0, shown.lastIndexOf('\n[the rest of this file'))
  check(`a folder guide over the instruction-file limit (${cap} characters) is attached clipped to the limit, not whole`, shown.length <= cap + 240 && shown.length < huge.length, `${shown.length} of ${huge.length} — the clip in src/engine/attachments/nestedInstructions.ts must cut a folder guide to getMaxInstructionFileCharacterCount in src/sessions/instructions/instructionFiles.ts`)
  check('the clip ends on a whole line and says how much was left out and where to read it', shown.includes(`[the rest of this file, ${huge.length - keptPart.length} characters`) && shown.includes(`read ${hugeGuide} for the rest]`) && keptPart.endsWith('\n'), `${shown.slice(-220)} — the clip marker built in src/engine/attachments/nestedInstructions.ts must follow a whole line and name the omitted count and the path to read`)
  check('the read cache keeps the whole file as a partial view, so an edit still asks for a read of the unseen part', bounded.readFileState.get(hugeGuide)?.content === huge && bounded.readFileState.get(hugeGuide)?.isPartialView === true, 'src/engine/attachments/nestedInstructions.ts must cache the unclipped content as a partial view when a guide is clipped')
  const [small] = instructionFilesToAttachments([entry(join(project, 'sub', 'small', 'MERCURY.md'), { content: line.repeat(3) })], context() as never)
  check('a guide under the limit is attached whole and untouched', small?.content.content === line.repeat(3), 'src/engine/attachments/nestedInstructions.ts must leave a guide under the limit unclipped')
} finally {
  removeScratch(scratch)
}
console.log(`${failures ? 'FAIL' : 'PASS'} nested memory admission: ${failures} failures`)
process.exit(failures ? 1 : 0)
