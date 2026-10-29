import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import type { ToolPermissionContext } from '../../Tool.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { controlCharacterPathRefusal } from '../../utils/path.js'
import { extractDocumentText, isSearchableDocument, SEARCHABLE_DOCUMENT_EXTENSIONS } from '../../utils/documentText.js'
import { ensureScratchpadDir } from '../../utils/scratchpad.js'
import { normaliseForMatch } from '../../utils/text/normaliseForMatch.js'
import { ripGrepAnswer, RipgrepUsageError, type RipgrepAnswer } from '../../utils/ripgrep.js'

const MAX_DOCUMENTS = 20
const typeDefinitions = SEARCHABLE_DOCUMENT_EXTENSIONS.flatMap(ext => ['--type-add', `${ext}:*.${ext}`])
export function documentTypeArgs(): string[] { return typeDefinitions }

function discoveryArgs(args: string[], pattern: string): string[] {
  const result = ['--files', ...typeDefinitions]
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (['--glob', '--iglob', '--type', '--max-depth'].includes(arg)) result.push(arg, args[++i]!)
    else if (arg === '--hidden') result.push(arg)
    else if (arg === '-e') i++
    else if (arg === pattern) continue
    else if (['--max-columns', '-B', '-A', '-C'].includes(arg)) i++
  }
  return result
}
function textArgs(args: string[], pattern: string): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e') result.push(args[i]!, normaliseForMatch(args[++i]!))
    else if (['--glob', '--iglob', '--type', '--type-add', '--max-depth'].includes(args[i]!)) i++
    else result.push(args[i] === pattern ? normaliseForMatch(pattern) : args[i]!)
  }
  return result
}
export async function searchDocuments(options: {
  root: string
  args: string[]
  pattern: string
  mode: 'content' | 'files_with_matches' | 'count'
  permission: ToolPermissionContext
  signal: AbortSignal
  search: (args: string[], path: string) => Promise<{ answer: RipgrepAnswer; engine?: string }>
}): Promise<{ lines: string[]; paths: Set<string>; note?: string }> {
  const { root, args, pattern, mode, permission, signal } = options
  const directory = (await stat(root)).isDirectory()
  const listed = await ripGrepAnswer(discoveryArgs(args, pattern), root, signal, { cwd: directory ? root : dirname(root) })
  const candidates = listed.lines.map(path => isAbsolute(path) ? path : join(directory ? root : dirname(root), path)).filter(isSearchableDocument).sort()
  const paths = new Set(candidates)
  const lines: string[] = []
  let skipped = 0
  const selected = candidates.slice(0, MAX_DOCUMENTS)
  for (const path of selected) {
    signal.throwIfAborted()
    if (controlCharacterPathRefusal(path) !== null || checkReadPermissionForTool({ name: 'Read', getPath: () => path }, { file_path: path }, permission).behavior !== 'allow') { skipped++; continue }
    const scratch = join(ensureScratchpadDir(), `document-search-${randomUUID()}.txt`)
    try {
      const text = normaliseForMatch(await extractDocumentText(path, signal))
      await writeFile(scratch, text, { mode: 0o600 })
      const result = await options.search(textArgs(args, pattern), scratch)
      if (!result.answer.complete) { skipped++; continue }
      const sections: string[] = []
      let section = ''
      for (const line of text.split('\n')) {
        const page = /^--- page (\d+) ---$/.exec(line)
        const heading = /^## (.+)/.exec(line)
        if (page) section = `page ${page[1]}`
        else if (heading) section = heading[1]!
        sections.push(section)
      }
      for (const row of result.answer.lines) {
        if (mode === 'files_with_matches') { lines.push(path); break }
        if (mode === 'count') { lines.push(`${path}:${row.slice(row.lastIndexOf(':') + 1)}`); continue }
        const match = /\0(\d+)([:-])([\s\S]*)$/.exec(row)
        if (match) {
          const section = sections[Number(match[1]) - 1]
          lines.push(`${path}\0${match[1]}${match[2]}${section ? `[${section}] ` : ''}${match[3]}`)
        } else if (row === '--') lines.push(row)
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof RipgrepUsageError) throw error
      skipped++
    } finally { await rm(scratch, { force: true }) }
  }
  const notes: string[] = []
  if (candidates.length > MAX_DOCUMENTS) notes.push(`Document search covered ${MAX_DOCUMENTS} of ${candidates.length} files; narrow path or glob to search the rest.`)
  if (!listed.complete) notes.push('Document discovery did not finish; narrow path or glob.')
  if (skipped) notes.push(`${skipped} document${skipped === 1 ? '' : 's'} skipped because extraction or Read permission was unavailable.`)
  return { lines, paths, ...(notes.length ? { note: notes.join(' ') } : {}) }
}
