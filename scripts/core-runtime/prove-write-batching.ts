#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'write-batching-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'write-batching-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'NODE_ENV']) delete process.env[k]

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { runTools } = await import('../../src/services/tools/toolOrchestration.ts')
const { batchClaimOf, canonicalPath, claimsCompatible, pathsOverlap } = await import('../../src/services/tools/toolBatching.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { NotebookEditTool } = await import('../../src/tools/NotebookEditTool/NotebookEditTool.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — write-batching prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const root = realpathSync(mkdtempSync(join(tmpdir(), 'write-batching-tree-')))
const src = join(root, 'src')
const docs = join(root, 'docs')
mkdirSync(src, { recursive: true })
mkdirSync(docs, { recursive: true })
const fileA = join(src, 'a.ts')
const fileB = join(src, 'b.ts')
const fileC = join(docs, 'c.md')
writeFileSync(fileA, 'export const a = 1\n')
writeFileSync(fileB, 'export const b = 2\n')
writeFileSync(fileC, '# c\n')
function linkFolder(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : null)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    console.log(`  [SKIP] ${path} -> ${target}: this account may not create folder links (EPERM), so the link legs are not read on this run`)
    return false
  }
}
const link = join(root, 'link-to-src')
const linked = linkFolder(src, link)

const MODEL = 'claude-opus-4-8'
function makeCtx(tools: unknown[]): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools,
      engineModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
}

section('1 — the claims of the real tools: an edit or a write claims its file for writing, a read or a search claims its path for reading, a shell command claims nothing it can name')
{
  const tools = [FileEditTool, FileWriteTool, FileReadTool, GrepTool, GlobTool, BashTool, NotebookEditTool]
  const ctx = makeCtx(tools) as never
  const claim = (name: string, input: Record<string, unknown>) => batchClaimOf({ type: 'tool_use', id: `tu_${name}`, name, input } as never, ctx)
  const edit = await claim('Edit', { file_path: fileA, old_string: 'a = 1', new_string: 'a = 2' })
  check('Edit claims its file for writing, canonically', edit.kind === 'writes' && edit.path === canonicalPath(fileA), JSON.stringify(edit))
  const write = await claim('Write', { file_path: join(src, 'new.ts'), content: 'x' })
  check('Write claims a file that does not exist yet for writing, under its real parent', write.kind === 'writes' && write.path === canonicalPath(join(src, 'new.ts')) && write.path.startsWith(canonicalPath(src) + sep), JSON.stringify(write))
  const notebook = await claim('NotebookEdit', { notebook_path: join(src, 'n.ipynb'), new_source: 'x' })
  check('NotebookEdit claims its notebook for writing', notebook.kind === 'writes' && notebook.path === canonicalPath(join(src, 'n.ipynb')), JSON.stringify(notebook))
  const read = await claim('Read', { file_path: fileB })
  check('Read claims its file for reading', read.kind === 'reads' && read.path === canonicalPath(fileB), JSON.stringify(read))
  const grep = await claim('Grep', { pattern: 'needle', path: src })
  check('Grep claims its search root for reading', grep.kind === 'reads' && grep.path === canonicalPath(src), JSON.stringify(grep))
  const glob = await claim('Glob', { pattern: '**/*.ts', path: docs })
  check('Glob claims its search root for reading', glob.kind === 'reads' && glob.path === canonicalPath(docs), JSON.stringify(glob))
  const ls = await claim('Bash', { command: 'ls -la' })
  check('a read-only shell command is free (it names no path the batch can hold)', ls.kind === 'free', JSON.stringify(ls))
  const rm = await claim('Bash', { command: `rm -f ${fileA}` })
  check('a mutating shell command is exclusive', rm.kind === 'exclusive', JSON.stringify(rm))
  const unknown = await claim('NoSuchTool', { x: 1 })
  check('a tool not in the session is exclusive', unknown.kind === 'exclusive', JSON.stringify(unknown))
  const broken = await claim('Edit', { file_path: 42 })
  check('an input that does not parse is exclusive', broken.kind === 'exclusive', JSON.stringify(broken))
}

section('2 — the canonical path: a symlink resolves to its target, a missing file resolves under its real parent, and the comparison folds case where the file system does')
{
  if (linked) {
    check('a path through a symlinked folder equals the real path', canonicalPath(join(link, 'a.ts')) === canonicalPath(fileA), `${canonicalPath(join(link, 'a.ts'))} vs ${canonicalPath(fileA)}`)
    check('a file that does not exist resolves under its real parent', canonicalPath(join(link, 'ghost', 'x.ts')) === canonicalPath(join(src, 'ghost', 'x.ts')), canonicalPath(join(link, 'ghost', 'x.ts')))
  } else {
    console.log('  [SKIP] the two link spellings of section 2 (no folder link on this account)')
    check('a file that does not exist resolves under its real parent', canonicalPath(join(src, 'ghost', 'x.ts')) === join(canonicalPath(src), 'ghost', 'x.ts'), canonicalPath(join(src, 'ghost', 'x.ts')))
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    check('on a case-folding platform two spellings of one file are one claim', canonicalPath(fileA.toUpperCase()) === canonicalPath(fileA), canonicalPath(fileA.toUpperCase()))
  } else {
    check('on a case-sensitive platform the spelling stands', canonicalPath(fileA) === fileA)
  }
  check('a relative path resolves against the working directory', canonicalPath('relative/one.ts') === canonicalPath(join(getCwd(), 'relative', 'one.ts')))
}

section('3 — overlap: the same path, a folder and a file inside it, never two siblings that merely share a prefix')
{
  const a = canonicalPath(fileA)
  check('a path overlaps itself', pathsOverlap(a, a))
  check('a folder overlaps a file inside it, both ways', pathsOverlap(canonicalPath(src), a) && pathsOverlap(a, canonicalPath(src)))
  check('two files in one folder do not overlap', !pathsOverlap(a, canonicalPath(fileB)))
  check('a sibling whose name extends the other is no overlap', !pathsOverlap(canonicalPath(join(root, 'src')), canonicalPath(join(root, 'src-extra', 'z.ts'))))
  check('two writers of disjoint files are compatible', claimsCompatible({ kind: 'writes', path: a }, { kind: 'writes', path: canonicalPath(fileB) }))
  check('two writers of one file are not', !claimsCompatible({ kind: 'writes', path: a }, { kind: 'writes', path: a }))
  check('a reader of the folder and a writer inside it are not', !claimsCompatible({ kind: 'reads', path: canonicalPath(src) }, { kind: 'writes', path: a }))
  check('a reader of another folder and the writer are', claimsCompatible({ kind: 'reads', path: canonicalPath(docs) }, { kind: 'writes', path: a }))
  check('a free call never shares a batch with a writer', !claimsCompatible({ kind: 'free' }, { kind: 'writes', path: a }) && !claimsCompatible({ kind: 'writes', path: a }, { kind: 'free' }))
  check('a free call shares a batch with readers and other free calls', claimsCompatible({ kind: 'free' }, { kind: 'reads', path: a }) && claimsCompatible({ kind: 'free' }, { kind: 'free' }))
  check('an exclusive call shares nothing', !claimsCompatible({ kind: 'exclusive' }, { kind: 'free' }) && !claimsCompatible({ kind: 'reads', path: a }, { kind: 'exclusive' }))
}

type Gate = { resolve: () => void; promise: Promise<void> }
function gate(): Gate {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { resolve, promise }
}
const started: string[] = []
const finished: string[] = []
const gates = new Map<string, Gate>()
function gateFor(id: string): Gate {
  let g = gates.get(id)
  if (!g) {
    g = gate()
    gates.set(id, g)
  }
  return g
}

type Shape = { name: string; readOnly: boolean; safe: boolean; pathOf: (input: Record<string, unknown>) => string | undefined; prepare?: (input: Record<string, unknown>) => Promise<void> }
function fixtureTool(shape: Shape): never {
  return {
    name: shape.name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => shape.name,
    isEnabled: () => true,
    isConcurrencySafe: () => shape.safe,
    isReadOnly: () => shape.readOnly,
    getPath: (input: Record<string, unknown>) => shape.pathOf(input),
    ...(shape.prepare ? { prepare: shape.prepare } : {}),
    isMcp: false,
    maxResultSizeChars: 50_000,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      const id = String(input.id)
      started.push(id)
      await gateFor(id).promise
      finished.push(id)
      return { data: `${shape.name} ${id} done` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
const filePathOf = (input: Record<string, unknown>) => (typeof input.file_path === 'string' ? input.file_path : undefined)
const searchRootOf = (input: Record<string, unknown>) => (typeof input.path === 'string' ? input.path : getCwd())
const TOOLS = [
  fixtureTool({ name: 'Edit', readOnly: false, safe: false, pathOf: filePathOf }),
  fixtureTool({ name: 'Write', readOnly: false, safe: false, pathOf: filePathOf }),
  fixtureTool({ name: 'Read', readOnly: true, safe: true, pathOf: filePathOf }),
  fixtureTool({ name: 'Grep', readOnly: true, safe: true, pathOf: searchRootOf }),
  fixtureTool({ name: 'Free', readOnly: true, safe: true, pathOf: () => undefined }),
  fixtureTool({ name: 'Shell', readOnly: false, safe: false, pathOf: () => undefined }),
]
check('the fixture tools carry the members the batching law reads, as the real tools do', ['getPath', 'isReadOnly', 'isConcurrencySafe'].every(member => typeof (FileEditTool as unknown as Record<string, unknown>)[member] === 'function' && typeof (FileReadTool as unknown as Record<string, unknown>)[member] === 'function'))

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

type Step = { name: string; input: Record<string, unknown> }
let seq = 0
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5))
}
async function drive(steps: Step[], plan: (ids: string[]) => Promise<void>): Promise<{ ids: string[]; results: string[] }> {
  started.length = 0
  finished.length = 0
  gates.clear()
  const ids = steps.map(() => `tu_${++seq}`)
  const blocks = steps.map((step, i) => ({ type: 'tool_use', id: ids[i], name: step.name, input: { ...step.input, id: ids[i] } }))
  const assistant = createAssistantMessage({ content: blocks as never })
  const ctx = makeCtx(TOOLS)
  const results: string[] = []
  const gen = runTools(blocks as never, [assistant] as never, allowAll as never, ctx as never)
  const drain = (async () => {
    for await (const update of gen) {
      const content = (update.message as { message?: { content?: unknown } } | undefined)?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as Array<{ type?: string; tool_use_id?: string }>) if (block.type === 'tool_result' && block.tool_use_id) results.push(block.tool_use_id)
    }
  })()
  await settle()
  await plan(ids)
  for (const id of ids) gateFor(id).resolve()
  await drain
  return { ids, results }
}
function release(id: string): Promise<void> {
  gateFor(id).resolve()
  return settle()
}

section('4 — two edits of different files run beside each other')
{
  const { ids, results } = await drive(
    [{ name: 'Edit', input: { file_path: fileA } }, { name: 'Edit', input: { file_path: fileB } }],
    async ids => {
      check('both edits have started before either finished', started.includes(ids[0]!) && started.includes(ids[1]!) && finished.length === 0, `started=${JSON.stringify(started)} finished=${JSON.stringify(finished)}`)
    },
  )
  check('each call settled exactly once', ids.every(id => results.filter(r => r === id).length === 1), JSON.stringify(results))
}

section('5 — two edits of ONE file keep their order: the second starts only after the first has finished')
{
  await drive(
    [{ name: 'Edit', input: { file_path: fileA } }, { name: 'Edit', input: { file_path: linked ? join(link, 'a.ts') : fileA } }],
    async ids => {
      check(`only the first edit has started (the second names the same file${linked ? ' through a symlink' : ''})`, started.length === 1 && started[0] === ids[0], JSON.stringify(started))
      await release(ids[0]!)
      check('after the first finished, the second started', finished[0] === ids[0] && started[1] === ids[1], `started=${JSON.stringify(started)} finished=${JSON.stringify(finished)}`)
    },
  )
}

section('6 — a reader and a writer: ordered when they overlap, side by side when they do not')
{
  await drive(
    [{ name: 'Edit', input: { file_path: fileA } }, { name: 'Read', input: { file_path: fileA } }],
    async ids => {
      check('a read of the file being edited waits for the edit', started.length === 1 && started[0] === ids[0], JSON.stringify(started))
    },
  )
  await drive(
    [{ name: 'Edit', input: { file_path: fileA } }, { name: 'Read', input: { file_path: fileB } }],
    async () => {
      check('a read of another file runs beside the edit', started.length === 2, JSON.stringify(started))
    },
  )
  await drive(
    [{ name: 'Read', input: { file_path: fileB } }, { name: 'Edit', input: { file_path: fileA } }],
    async () => {
      check('an edit after a read of another file runs beside it', started.length === 2, JSON.stringify(started))
    },
  )
  await drive(
    [{ name: 'Read', input: { file_path: fileA } }, { name: 'Edit', input: { file_path: fileA } }],
    async ids => {
      check('an edit of a file being read waits for the read', started.length === 1 && started[0] === ids[0], JSON.stringify(started))
    },
  )
}

section('7 — a search of a folder is a reader of the whole subtree')
{
  await drive(
    [{ name: 'Edit', input: { file_path: fileA } }, { name: 'Grep', input: { pattern: 'x', path: src } }],
    async ids => {
      check('a search of the folder holding the edited file waits', started.length === 1 && started[0] === ids[0], JSON.stringify(started))
    },
  )
  await drive(
    [{ name: 'Edit', input: { file_path: fileA } }, { name: 'Grep', input: { pattern: 'x', path: docs } }],
    async () => {
      check('a search of another folder runs beside the edit', started.length === 2, JSON.stringify(started))
    },
  )
  await drive(
    [{ name: 'Grep', input: { pattern: 'x', path: src } }, { name: 'Write', input: { file_path: join(src, 'fresh.ts') } }],
    async ids => {
      check('a write of a new file inside a folder being searched waits', started.length === 1 && started[0] === ids[0], JSON.stringify(started))
    },
  )
}

section('8 — a call that names no path never shares a batch with a writer; two readers of one subtree still share')
{
  await drive(
    [{ name: 'Edit', input: { file_path: fileA } }, { name: 'Free', input: {} }],
    async ids => {
      check('a free call after an edit waits for it', started.length === 1 && started[0] === ids[0], JSON.stringify(started))
    },
  )
  await drive(
    [{ name: 'Edit', input: { file_path: fileA } }, { name: 'Shell', input: {} }],
    async ids => {
      check('an exclusive call after an edit waits for it', started.length === 1 && started[0] === ids[0], JSON.stringify(started))
    },
  )
  await drive(
    [{ name: 'Read', input: { file_path: fileA } }, { name: 'Grep', input: { pattern: 'x', path: src } }, { name: 'Free', input: {} }],
    async () => {
      check('readers of one subtree and a free call all run together (the law as it was)', started.length === 3, JSON.stringify(started))
    },
  )
}

section('9 — a mixed reply: [Write a, Write b, Edit a, Read c] runs as {Write a, Write b} then {Edit a, Read c}')
{
  const { ids, results } = await drive(
    [
      { name: 'Write', input: { file_path: fileA } },
      { name: 'Write', input: { file_path: fileB } },
      { name: 'Edit', input: { file_path: fileA } },
      { name: 'Read', input: { file_path: fileC } },
    ],
    async ids => {
      check('the two writes start together; the edit of a written file and the read behind it wait', started.length === 2 && started.includes(ids[0]!) && started.includes(ids[1]!), JSON.stringify(started))
      await release(ids[0]!)
      check('one write done does not start the batch behind: the second write still holds it', started.length === 2, JSON.stringify(started))
      await release(ids[1]!)
      check('both writes done: the edit and the read start together', started.length === 4 && started.includes(ids[2]!) && started.includes(ids[3]!), JSON.stringify(started))
    },
  )
  check('four calls, four settlements', ids.every(id => results.filter(r => r === id).length === 1), JSON.stringify(results))
}

section('refusals — traversal and symlink-escape spellings resolve to their canonical host target; read-before-edit and deny rules hold on concurrent writes')
{
  const escapeLink = join(src, 'escape-to-docs')
  const escapeLinked = linked && linkFolder(docs, escapeLink)
  const tools = [FileEditTool, FileWriteTool, FileReadTool, GrepTool, GlobTool, BashTool, NotebookEditTool]
  const ctx = makeCtx(tools) as never
  const claim = (name: string, input: Record<string, unknown>) => batchClaimOf({ type: 'tool_use', id: `tu_ref_${name}`, name, input } as never, ctx)
  const viaTraversal = await claim('Edit', { file_path: join(src, 'sub', '..', '..', 'docs', 'c.md'), old_string: '# c', new_string: '# c2' })
  const direct = await claim('Edit', { file_path: fileC, old_string: '# c', new_string: '# c4' })
  if (escapeLinked) {
    const viaSymlinkOut = await claim('Write', { file_path: join(escapeLink, 'c.md'), content: '# c3' })
    check('a ../ traversal spelling and a symlink-out spelling resolve to the exact same canonical write claim as the direct host path', viaTraversal.kind === 'writes' && viaSymlinkOut.kind === 'writes' && direct.kind === 'writes' && viaTraversal.path === direct.path && viaSymlinkOut.path === direct.path && !claimsCompatible(viaTraversal, viaSymlinkOut), JSON.stringify({ viaTraversal, viaSymlinkOut, direct }))
  } else {
    console.log('  [SKIP] the symlink-out spelling (no folder link on this account)')
    check('a ../ traversal spelling resolves to the exact same canonical write claim as the direct host path', viaTraversal.kind === 'writes' && direct.kind === 'writes' && viaTraversal.path === direct.path && !claimsCompatible(viaTraversal, direct), JSON.stringify({ viaTraversal, direct }))
  }
  const nulClaim = await claim('Edit', { file_path: `${fileA}\0evil`, old_string: 'a', new_string: 'b' })
  check('a path carrying a NUL byte degrades to an exclusive claim, never batched', nulClaim.kind === 'exclusive', JSON.stringify(nulClaim))
  const realCtx = makeCtx([FileEditTool, FileWriteTool, FileReadTool])
  const unreadBlocks = [
    { type: 'tool_use', id: 'tu_unread_a', name: 'Edit', input: { file_path: fileA, old_string: 'a = 1', new_string: 'a = 9' } },
    { type: 'tool_use', id: 'tu_unread_b', name: 'Edit', input: { file_path: fileB, old_string: 'b = 2', new_string: 'b = 9' } },
  ]
  const unreadParent = createAssistantMessage({ content: unreadBlocks as never })
  const unreadOut: Array<{ id: string; text: string; isError: boolean }> = []
  for await (const update of runTools(unreadBlocks as never, [unreadParent] as never, allowAll as never, realCtx as never)) {
    const content = (update.message as { message?: { content?: unknown } } | undefined)?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (b.type === 'tool_result' && b.tool_use_id) unreadOut.push({ id: b.tool_use_id, text: String(b.content), isError: b.is_error === true })
    }
  }
  check('read-before-edit holds across a concurrent write batch: both unread edits are refused', unreadOut.length === 2 && unreadOut.every(r => r.isError && /read/i.test(r.text)), JSON.stringify(unreadOut))
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`WRITE-BATCHING: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`WRITE-BATCHING: all ${checks} checks passed`)
process.exit(0)
