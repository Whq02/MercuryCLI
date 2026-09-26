#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const NODE = execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-editor-context-'))
process.env.MERCURY_CONFIG_DIR ??= join(scratch, 'prover-home')
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
const children: ChildProcess[] = []
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL')
    } catch {}
  }
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {}
})

const EXTENSION = join(ROOT, 'integrations/vscode/extension.js')
const HARNESS = join(ROOT, 'scripts/editor-bridge/fixtures/vscode-bridge-harness.cjs')

type Wire = { method: string; params?: Record<string, unknown> }
type SelectionWire = {
  text?: string
  filePath?: string
  selection?: { start: { line: number; character: number }; end: { line: number; character: number } }
}
type ContextWire = {
  v?: number
  sessionId?: string
  workspaceFolders?: string[]
  activeFile?: { path?: string; languageId?: string; selection?: { startLine?: number; endLine?: number; text?: string } }
  openFiles?: string[]
  diagnostics?: Array<{ path?: string; line?: number; severity?: string; message?: string }>
}
type IDESelection = { lineCount: number; text?: string; filePath?: string; lineStart?: number; openFiles?: string[] }
type Attachment = Record<string, unknown> & { type: string }
type Producer = (selection: IDESelection | null, context: unknown) => Promise<Attachment[]>
type Register = (client: unknown, live: () => boolean, latest: () => IDESelection, emit: (next: IDESelection) => void) => void

const sameOnce = (have: string[] | undefined, want: string[]): boolean =>
  have !== undefined && have.length === want.length && want.every(p => have.filter(h => h === p).length === 1)
const j = (v: unknown): string => JSON.stringify(v)

const configHome = join(scratch, 'config-home')
const workspace = join(scratch, 'workspace')
mkdirSync(workspace, { recursive: true })
const editedFile = join(workspace, 'stub.ts')
writeFileSync(editedFile, 'line one\nline two\nline three\nline four\nline five\n')
const openFiles = ['alpha.ts', 'beta.ts', 'gamma.ts'].map(name => join(workspace, name))
for (const file of openFiles) writeFileSync(file, `export const ${file.slice(file.lastIndexOf('/') + 1, -3)} = 1\n`)
const SELECTED_TEXT = 'line three\nline four'
const knownSelection: IDESelection = { lineCount: 2, text: SELECTED_TEXT, filePath: editedFile, lineStart: 3 }

const harness = spawn(NODE, [HARNESS, EXTENSION], {
  env: { ...process.env, MERCURY_CONFIG_DIR: configHome, MERCURY_STUB_WORKSPACE: workspace },
  stdio: ['pipe', 'pipe', 'inherit'],
})
children.push(harness)
const events: Array<Record<string, unknown>> = []
let buffer = ''
harness.stdout!.setEncoding('utf8')
harness.stdout!.on('data', (chunk: string) => {
  buffer += chunk
  let idx = buffer.indexOf('\n')
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line !== '') {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>)
      } catch {}
    }
    idx = buffer.indexOf('\n')
  }
})
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return cond()
}
const send = (command: string): void => {
  harness.stdin!.write(`${command}\n`)
}

section('§0 the bridge is up (the stub editor, the advertisement, the port)')
const ready = await until(() => events.some(e => e.event === 'ready'), 15_000)
check('the extension activated under the stub', ready, j(events).slice(0, 200))
const gotEnv = await until(() => events.some(e => e.event === 'env' && e.name === 'MERCURY_IDE_PORT'), 15_000)
const envEvent = events.find(e => e.event === 'env' && e.name === 'MERCURY_IDE_PORT')
const port = Number(envEvent?.value ?? 0)
check('MERCURY_IDE_PORT is stamped into the terminal environment', gotEnv && port > 0, j(envEvent ?? null))

const { Client, SSEClientTransport } = await import('@modelcontextprotocol/client')
const connect = async (name: string): Promise<InstanceType<typeof Client>> => {
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)))
  return client
}
const wires: Wire[] = []
const listener = await connect('mercury-editor-context-listener')
listener.fallbackNotificationHandler = async n => {
  wires.push(n as Wire)
}
const runtime = await connect('mercury-editor-context-runtime')
check('two MCP clients connected over SSE (a raw listener and the runtime road)', listener.getServerVersion()?.name === 'mercury-vscode' && runtime.getServerVersion()?.name === 'mercury-vscode')

const hook = (await import('../../src/hooks/useIdeSelection.ts')) as Record<string, unknown>
const register = typeof hook.registerIdeSelectionHandlers === 'function' ? (hook.registerIdeSelectionHandlers as Register) : null
const reports: IDESelection[] = []
let latest: IDESelection = { lineCount: 0 }
if (register !== null) {
  register(runtime, () => true, () => latest, next => {
    latest = next
    reports.push(next)
  })
}
await runtime.notification({ method: 'ide_connected', params: { pid: process.pid } })

const contexts = (): ContextWire[] => wires.filter(w => w.method === 'editor_context').map(w => (w.params ?? {}) as ContextWire)
const methodsSeen = (): string => [...new Set(wires.map(w => w.method))].join(', ') || 'none'

section('§1 the extension pushes the editor context on the MCP stream beside selection_changed')
for (const file of openFiles) send(`open ${file}`)
const gotOpen = await until(() => contexts().some(c => c.openFiles !== undefined && c.openFiles.length === 3), 5_000)
check('opening three tabs pushes editor_context naming the three open files', gotOpen, `no editor_context with three open files arrived; methods seen: ${methodsSeen()}`)
if (register !== null) await until(() => latest.openFiles !== undefined && latest.openFiles.length === 3, 5_000)

send('select')
const gotSelection = await until(() => wires.some(w => w.method === 'selection_changed'), 5_000)
const gotSelectedContext = await until(() => contexts().some(c => c.activeFile?.selection?.startLine === 3), 5_000)
const selectionWire = wires.find(w => w.method === 'selection_changed')?.params as SelectionWire | undefined
check(
  'the selection wire is unchanged beside it (selection_changed: text · filePath · zero-based range)',
  gotSelection && selectionWire?.text === SELECTED_TEXT && selectionWire.filePath === editedFile && selectionWire.selection?.start.line === 2 && selectionWire.selection.end.line === 3,
  j(selectionWire ?? null),
)
const withSelection = contexts().find(c => c.activeFile?.selection?.startLine === 3)
check('the selection pushes editor_context too, with the selection on the active file', gotSelectedContext && withSelection !== undefined, `no editor_context carrying the selection; methods seen: ${methodsSeen()}`)
const sel = withSelection?.activeFile?.selection
check(
  "the wire is the ACP road's shape: v 1 · activeFile path + languageId · selection lines 3-4 with its text · the three open files once each",
  withSelection?.v === 1 && withSelection.activeFile?.path === editedFile && withSelection.activeFile.languageId === 'typescript' && sel?.startLine === 3 && sel.endLine === 4 && sel.text === SELECTED_TEXT && sameOnce(withSelection.openFiles, openFiles),
  j(withSelection ?? null),
)
check(
  "the wire carries the active file's diagnostics (one-based line, severity word) and the workspace folders",
  withSelection?.diagnostics?.[0]?.path === editedFile && withSelection.diagnostics[0].line === 2 && withSelection.diagnostics[0].severity === 'Error' && withSelection.workspaceFolders?.[0] === workspace,
  j(withSelection?.diagnostics ?? null),
)
check('the MCP wire names no ACP session (the same wire, minus the session)', withSelection !== undefined && !('sessionId' in withSelection), j(withSelection ?? null))

section('§2 the runtime hook reads it: openFiles rides IDESelection and a later selection keeps it')
check('useIdeSelection exports a handler registration the prover can drive without React', register !== null, `exports: ${Object.keys(hook).sort().join(', ')}`)
if (register !== null) await until(() => latest.lineCount === 2 && latest.openFiles !== undefined && latest.openFiles.length === 3, 5_000)
check('the hook reported the three open files before any selection (lineCount 0, the list present)', reports.some(r => r.lineCount === 0 && sameOnce(r.openFiles, openFiles)), `reports: ${j(reports)}`)
check(
  'after the selection the state carries both: lineCount 2 · lineStart 3 · the text · the path · the three open files',
  latest.lineCount === 2 && latest.lineStart === 3 && latest.text === SELECTED_TEXT && latest.filePath === editedFile && sameOnce(latest.openFiles, openFiles),
  j(latest),
)

section('§3 the producers at the prompt: one open-files attachment naming the three paths once, the selection unchanged')
const producers = (await import('../../src/utils/attachments/mentionResolvers.ts')) as Record<string, unknown>
const ideProducers = ['getSelectedLinesFromIDE', 'getOpenedFileFromIDE', 'getOpenFilesFromIDE'].filter(n => typeof producers[n] === 'function').map(n => producers[n] as Producer)
const permissions = { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false }
const ideClient = {
  name: 'ide',
  type: 'connected',
  client: runtime,
  capabilities: {},
  config: { type: 'sse-ide', url: `http://127.0.0.1:${port}/sse`, ideName: 'VS Code' },
  cleanup: async () => {},
}
const toolUseContext = { options: { mcpClients: [ideClient] }, getAppState: () => ({ toolPermissionContext: permissions }) }
const atPrompt = async (selection: IDESelection | null): Promise<Attachment[]> => (await Promise.all(ideProducers.map(p => p(selection, toolUseContext)))).flat()
const promptState: IDESelection = register !== null ? latest : { ...knownSelection, openFiles: contexts().at(-1)?.openFiles }
const attachments = await atPrompt(promptState)
const kinds = attachments.map(a => a.type)
const lists = attachments.filter(a => a.type === 'open_files_in_ide')
check(
  'the prompt carries ONE open-files attachment naming the three paths once each',
  lists.length === 1 && sameOnce(lists[0]?.filenames as string[] | undefined, openFiles),
  `no list attachment: the IDE producers yielded ${kinds.join(', ') || 'nothing'}`,
)
const selected = attachments.find(a => a.type === 'selected_lines_in_ide')
check(
  'the selection attachment is unchanged beside it (lines 3-4 of the active file, the same text)',
  selected?.lineStart === 3 && selected.lineEnd === 4 && selected.filename === editedFile && selected.content === SELECTED_TEXT,
  j(selected ?? null),
)
const withoutList = (await atPrompt({ ...promptState, openFiles: undefined })).find(a => a.type === 'selected_lines_in_ide')
check('the same selection attachment comes with or without the list (the list is its own attachment, never folded into the selection)', j(withoutList) === j(selected), `${j(withoutList)} vs ${j(selected)}`)
check('no opened-file attachment doubles the active file while a selection is live', !kinds.includes('opened_file_in_ide'), kinds.join(', '))
{
  const { normalizeAttachmentForAPI } = (await import('../../src/utils/messages/attachmentText.ts')) as { normalizeAttachmentForAPI: (a: unknown) => unknown[] }
  const text = lists.length === 1 ? j(normalizeAttachmentForAPI(lists[0])) : ''
  const once = openFiles.every(p => text.split(p).length - 1 === 1)
  check('the prompt text names each open file exactly once and says they are open in the IDE', lists.length === 1 && once && text.includes('open in the IDE'), text.slice(0, 300))
}

section('§4 an empty openFiles yields no list attachment; no push at all invents no editor')
send('close-tabs')
const gotEmpty = await until(() => contexts().some(c => c.openFiles !== undefined && c.openFiles.length === 0 && c.activeFile?.selection?.startLine === 3), 5_000)
check('closing every tab pushes editor_context with an empty openFiles and the selection still on the active file', gotEmpty, `contexts seen: ${j(contexts().map(c => c.openFiles))}`)
if (register !== null) await until(() => latest.openFiles !== undefined && latest.openFiles.length === 0, 5_000)
check('the hook clears the list and keeps the selection', register !== null && latest.openFiles !== undefined && latest.openFiles.length === 0 && latest.lineCount === 2 && latest.text === SELECTED_TEXT, j(latest))
const emptied = await atPrompt(register !== null ? latest : { ...knownSelection, openFiles: [] })
check('an empty openFiles yields no list attachment; the selection attachment stays', emptied.every(a => a.type !== 'open_files_in_ide') && emptied.some(a => a.type === 'selected_lines_in_ide'), j(emptied.map(a => a.type)))
const untouched = await atPrompt(knownSelection)
const nothing = await atPrompt(null)
check('an IDESelection the editor never pushed a list into yields no list attachment, and no selection at all yields nothing', untouched.every(a => a.type !== 'open_files_in_ide') && nothing.length === 0, `${j(untouched.map(a => a.type))} / ${j(nothing.map(a => a.type))}`)

section('§5 the registry law: a body-shape row, a fixture and a union member for the new kind')
{
  const { BODY_SHAPE_KINDS } = (await import('../../src/fabric/validate.ts')) as { BODY_SHAPE_KINDS: { attachment: string[] } }
  check('ATTACHMENT_BODY_SHAPES has a row for open_files_in_ide', BODY_SHAPE_KINDS.attachment.includes('open_files_in_ide'), `${BODY_SHAPE_KINDS.attachment.length} rows, none for open_files_in_ide`)
  const fixtures = readFileSync(join(ROOT, 'scripts/idiom/prove-body-shape-registry.ts'), 'utf8')
  check('the body-shape fixture table carries open_files_in_ide', /^\s*open_files_in_ide:/m.test(fixtures))
  const union = readFileSync(join(ROOT, 'src/utils/attachments/types.ts'), 'utf8')
  check('the Attachment union declares open_files_in_ide with its filenames list', /type: 'open_files_in_ide'\s*\n\s*filenames: string\[\]/.test(union))
}

await listener.close().catch(() => {})
await runtime.close().catch(() => {})
send('deactivate')
await until(() => events.some(e => e.event === 'deactivated'), 5_000)
await until(() => harness.exitCode !== null, 5_000)

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ the MCP bridge road reads the open-files editor context the ACP road reads')
