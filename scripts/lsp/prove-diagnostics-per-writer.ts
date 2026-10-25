#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { armScratch, check, cleanup, finish, REPO, section, TS_SIDECAR_ENTRY, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('diag-per-writer')
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'per-writer-probe', private: true }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }),
  'lib.ts': 'export const budget: number = 1\n',
  'main.ts': 'import { budget } from "./lib"\nexport const label: number = budget\n',
  'other.ts': 'export const count: number = 1\n',
}
const project = writeProject(scratch, 'project', FILES)
const worktree = writeProject(scratch, 'project/.mercury/worktrees/agent-fx', FILES)
process.env.MERCURY_LSP_SIDECAR_ENTRY = TS_SIDECAR_ENTRY

const harness = await import(join(REPO, 'scripts/ast-tools/lib/harness.ts'))
await harness.enterRoot(project)
const lspManager = await import(join(REPO, 'src/services/lsp/manager.ts'))
lspManager.initializeLspServerManager()
await lspManager.waitForInitialization()
const registry = await import(join(REPO, 'src/services/lsp/LSPDiagnosticRegistry.ts'))
const { getLSPDiagnosticAttachments } = await import(join(REPO, 'src/utils/attachments/diagnostics.ts'))
const { normalizeAttachmentForAPI } = await import(join(REPO, 'src/utils/messages/attachmentText.ts'))
const { FileReadTool } = await import(join(REPO, 'src/tools/FileReadTool/FileReadTool.ts'))
const { FileEditTool } = await import(join(REPO, 'src/tools/FileEditTool/FileEditTool.ts'))
const { getEmptyToolPermissionContext } = await import(join(REPO, 'src/Tool.ts'))
const { processOwnerForLane } = await import(join(REPO, 'src/services/run/resolveOwner.ts'))
const { BASH_TOOL_NAME } = await import(join(REPO, 'src/tools/BashTool/toolName.ts'))

type Row = { type: string; files: Array<{ uri: string; diagnostics: Array<{ message: string; severity: string }> }> }

function makeContext(agentId?: string): Record<string, unknown> {
  return {
    readFileState: new Map(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    options: { tools: [{ name: BASH_TOOL_NAME }] },
    ...(agentId !== undefined ? { agentId } : {}),
  }
}
let parentSeq = 0
const parent = (): { uuid: string; message: { id: string } } => {
  parentSeq++
  return { uuid: `00000000-0000-0000-0000-${String(parentSeq).padStart(12, '0')}`, message: { id: `msg_${parentSeq}` } }
}
async function readThenEdit(ctx: Record<string, unknown>, path: string, oldString: string, newString: string): Promise<void> {
  await (FileReadTool as { call: Function }).call({ file_path: path }, ctx, null, parent())
  await (FileEditTool as { call: Function }).call({ file_path: path, old_string: oldString, new_string: newString }, ctx, null, parent())
}
const plain = (uri: string): string => (uri.startsWith('file://') ? uri.slice('file://'.length) : uri)
function awaitReportFor(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, timeoutMs)
    const unsubscribe = registry.subscribePublishedReports((event: { file: { uri: string } }) => {
      if (plain(event.file.uri) !== path) return
      clearTimeout(timer)
      unsubscribe()
      resolve(true)
    })
  })
}
const drain = (ctx: Record<string, unknown>): Promise<Row[]> => getLSPDiagnosticAttachments(ctx as never) as Promise<Row[]>
const uris = (rows: Row[]): string[] => rows.flatMap(row => row.files.map(file => plain(file.uri)))
const under = (root: string) => (path: string): boolean => path.startsWith(root + '/')
const messagesOf = (rows: Row[]): string[] => rows.flatMap(row => row.files.flatMap(file => file.diagnostics.map(d => d.message)))
const j = (value: unknown): string => JSON.stringify(value)

const mainCtx = makeContext()
const crewCtx = makeContext('agent-fx')
const crewOwner = processOwnerForLane('agent-fx')
const wtMain = join(worktree, 'main.ts')
const wtOther = join(worktree, 'other.ts')
const projectMain = join(project, 'main.ts')
const projectOther = join(project, 'other.ts')
const REPORT_WAIT_MS = 20_000

try {
  registry.resetAllLSPDiagnosticState()
  registry.claimDiagnosticsRoot(crewOwner, worktree)

  section('§1 a crewmate writes a type error in its worktree: the publish is the crewmate\'s alone')
  {
    const reported = awaitReportFor(wtMain, REPORT_WAIT_MS)
    await readThenEdit(crewCtx, wtMain, 'export const label: number = budget', 'export const label: string = budget')
    check('the written file is claimed by the crewmate\'s owner', registry._writerForTesting(wtMain) === crewOwner, String(registry._writerForTesting(wtMain)))
    check('the server published for the written file', await reported)
    const parked = registry._pendingForTesting().filter((entry: { uris: string[] }) => entry.uris.some(uri => plain(uri) === wtMain))
    check('the publish is parked on the crewmate\'s lane', parked.length === 1 && parked[0]!.owner === crewOwner, j(parked))
    const mainRows = await drain(mainCtx)
    check('the main lane\'s read carries nothing for the worktree file', !uris(mainRows).some(under(worktree)), j(uris(mainRows)))
    check('…and leaves the crewmate\'s entry parked', registry._pendingForTesting().some((entry: { uris: string[]; owner: string | null }) => entry.owner === crewOwner && entry.uris.some(uri => plain(uri) === wtMain)), j(registry._pendingForTesting()))
    const crewRows = await drain(crewCtx)
    check('the crewmate\'s read carries one diagnostics attachment', crewRows.length === 1 && crewRows[0]!.type === 'diagnostics', j(crewRows))
    check('…naming its file', uris(crewRows).length === 1 && uris(crewRows)[0] === wtMain, j(uris(crewRows)))
    check('…and the error its edit made', messagesOf(crewRows).some(message => /not assignable to type 'string'/.test(message)) && crewRows[0]!.files[0]!.diagnostics.every(d => d.severity === 'Error'), j(messagesOf(crewRows)))
    const text = crewRows.length === 1 ? normalizeAttachmentForAPI(crewRows[0] as never).map((row: { message: { content: unknown } }) => j(row.message.content)).join('\n') : ''
    check('the model reads it under the <new-diagnostics> heading, with the file name and the error', text.includes('<new-diagnostics>New diagnostics from the language server:') && text.includes('main.ts') && text.includes('not assignable'), text.slice(0, 300))
    check('a second read of the crewmate\'s lane carries nothing (consumed once)', (await drain(crewCtx)).length === 0)
    check('nothing for the worktree is left parked', !registry._pendingForTesting().some((entry: { uris: string[] }) => entry.uris.some(uri => under(worktree)(plain(uri)))), j(registry._pendingForTesting()))
  }

  section('§2 two writers edit different files: each reads only its own; the round that wrote carries the publish')
  {
    const mainReported = awaitReportFor(projectMain, REPORT_WAIT_MS)
    await readThenEdit(mainCtx, projectMain, 'export const label: number = budget', 'export const label: string = budget')
    check('a main write releases the file to the main lane (no claim stored)', registry._writerForTesting(projectMain) === null)
    check('the server published for the main thread\'s file', await mainReported)
    await readThenEdit(crewCtx, wtOther, 'export const count: number = 1', "export const count: number = 'one'")
    const started = Date.now()
    const crewRows = await drain(crewCtx)
    const waited = Date.now() - started
    check('the crewmate\'s read, right after its write, carries the publish the server made for it', uris(crewRows).includes(wtOther) && messagesOf(crewRows).some(message => /not assignable to type 'number'/.test(message)), `${j(uris(crewRows))} ${j(messagesOf(crewRows))}`)
    check('…having waited for the publish, not the ceiling', waited < 1_400, `${waited} ms`)
    check('…and nothing of the main thread\'s', !uris(crewRows).some(path => path === projectMain || path === projectOther), j(uris(crewRows)))
    const mainRows = await drain(mainCtx)
    check('the main thread\'s read carries its own file', uris(mainRows).includes(projectMain) && messagesOf(mainRows).some(message => /not assignable to type 'string'/.test(message)), `${j(uris(mainRows))} ${j(messagesOf(mainRows))}`)
    check('…and nothing of the worktree', !uris(mainRows).some(under(worktree)), j(uris(mainRows)))
  }

  section('§3 the hand-back: a worktree\'s late publish is sunk; a shared-tree file returns to the main lane')
  {
    registry.releaseDiagnosticsWriter(crewOwner, worktree)
    check('the crewmate\'s path claims are released', registry._writerForTesting(wtMain) === null && registry._writerForTesting(wtOther) === null)
    let published = 0
    const unsubscribe = registry.subscribeLSPDiagnosticPublish((event: { files: Array<{ uri: string }> }) => {
      if (event.files.some(file => plain(file.uri) === wtOther)) published++
    })
    writeFileSync(wtOther, "export const count: number = 'two'\nexport const extra: string = 2\n")
    const mainRows = await drain(mainCtx)
    unsubscribe()
    check('the server published for the handed-back worktree file (observed, non-consuming)', published >= 1, String(published))
    check('the main lane\'s read carries nothing of the worktree', !uris(mainRows).some(under(worktree)), j(uris(mainRows)))
    check('…and nothing of the worktree is parked for anyone (sunk)', !registry._pendingForTesting().some((entry: { uris: string[] }) => entry.uris.some(uri => under(worktree)(plain(uri)))), j(registry._pendingForTesting()))

    const sharedCtx = makeContext('agent-shared')
    const sharedOwner = processOwnerForLane('agent-shared')
    const reported = awaitReportFor(projectOther, REPORT_WAIT_MS)
    await readThenEdit(sharedCtx, projectOther, 'export const count: number = 1', "export const count: number = 'one'")
    check('a shared-tree crewmate claims the file it writes', registry._writerForTesting(projectOther) === sharedOwner)
    check('the server published for it', await reported)
    check('the publish parks on the shared-tree crewmate\'s lane', registry._pendingForTesting().some((entry: { uris: string[]; owner: string | null }) => entry.owner === sharedOwner && entry.uris.some(uri => plain(uri) === projectOther)), j(registry._pendingForTesting()))
    registry.releaseDiagnosticsWriter(sharedOwner)
    check('the hand-back returns the file to the main lane', registry._writerForTesting(projectOther) === null)
    const afterHandBack = await drain(mainCtx)
    check('…and its unread publish with it: the main thread reads the error left in its tree', uris(afterHandBack).includes(projectOther) && messagesOf(afterHandBack).some(message => /not assignable to type 'number'/.test(message)), `${j(uris(afterHandBack))} ${j(messagesOf(afterHandBack))}`)
  }

  section('§4 the wiring')
  {
    const orchestrator = readFileSync(join(REPO, 'src/utils/attachments/orchestrator.ts'), 'utf8')
    const producer = "maybe('lsp_diagnostics', () => getLSPDiagnosticAttachments(toolUseContext), { inputScoped: true })"
    const mainLane = orchestrator.indexOf('const mainThreadAttachments = isMainThread')
    check('the diagnostics producer rides the every-thread lane, input-scoped (never another thread\'s in-flight read)', orchestrator.includes(producer) && orchestrator.indexOf(producer) < mainLane, '')
    check('the main-thread-only lane no longer carries it', !orchestrator.slice(mainLane).includes('lsp_diagnostics'))
    const road = readFileSync(join(REPO, 'src/utils/attachments/diagnostics.ts'), 'utf8')
    check('the read is the lane\'s own: no table-wide clear behind it', !road.includes('clearAllLSPDiagnostics'))
    const runner = readFileSync(join(REPO, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
    check('a worktree run claims its root at launch and the run\'s end hands its lane back', runner.includes('claimDiagnosticsRoot(processOwnerForLane(agentId), worktreePath)') && runner.includes('releaseDiagnosticsWriter(processOwnerForLane(agentId), worktreePath)'))
  }
} finally {
  registry.resetAllLSPDiagnosticState()
  await lspManager.shutdownLspServerManager()
  cleanup(scratch)
}
finish('prove-diagnostics-per-writer')
