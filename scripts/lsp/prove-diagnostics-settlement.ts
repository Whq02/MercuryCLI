#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spyOn } from 'bun:test'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const registry = await import(join(ROOT, 'src/integrations/lsp/LSPDiagnosticRegistry.ts'))
const manager = await import(join(ROOT, 'src/integrations/lsp/serverManagerLifecycle.ts'))
const road = await import(join(ROOT, 'src/engine/attachments/diagnostics.ts'))
const { processOwnerForLane } = await import(join(ROOT, 'src/engine/run-owner/resolveOwner.ts'))
const { BASH_TOOL_NAME } = await import(join(ROOT, 'src/tools/kit/names/bash.ts'))
type Diagnostic = { message: string; severity: 'Error' | 'Warning'; range: { start: { line: number; character: number }; end: { line: number; character: number } }; source: string; code: string }
type Row = { type: string; files: Array<{ uri: string; diagnostics: Diagnostic[] }> }

let failures = 0
let count = 0
function check(name: string, ok: boolean, detail = ''): void {
  count++
  if (ok) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}
const j = (value: unknown): string => JSON.stringify(value)
const SERVER = 'mercury-ts'
const FILE = '/x/proj/src/app.ts'
const OTHER = '/x/proj/src/other.ts'
const CLOSED = '/x/proj/notes.md'
const CEILING_MS = 1_500
const ARMED = 'snapshotDiagnosticsBeforeWrite in src/integrations/lsp/LSPDiagnosticRegistry.ts must arm the write and settleWritesAwaitingReport must clear it once the file is answered or given up'
const WAIT = 'getLSPDiagnosticAttachments and deliverAfterRevalidation in src/engine/attachments/diagnostics.ts must wait (awaitFreshReports, RESYNC_REPORT_WAIT_MS) for a publish of each armed written file the server holds open, then deliver through checkForLSPDiagnostics'
const TURN_END = 'settleWriterDiagnosticsAtTurnEnd in src/engine/attachments/diagnostics.ts must read the writer\'s publish once and return nothing when the turn is aborted'
const diagnostic = (line: number, message: string): Diagnostic => ({ message, severity: 'Error', range: { start: { line, character: 0 }, end: { line, character: 12 } }, source: SERVER, code: '2322' })
const typeError = (line: number): Diagnostic => diagnostic(line, "Type 'string' is not assignable to type 'number'.", )
function publish(uri: string, diagnostics: Diagnostic[], version?: number): void {
  const file = { uri, diagnostics }
  registry.recordPublishedReport(SERVER, file, version)
  registry.registerPendingLSPDiagnostic({ serverName: SERVER, files: [file], ...(version !== undefined ? { version } : {}) })
}
const open = new Set<string>([FILE, OTHER])
const fakeManager = {
  async revalidateOpenDocuments() {
    return { checked: open.size, resynced: [], closed: [], failed: [] }
  },
  isFileOpen(path: string) {
    return open.has(path)
  },
}
const spy = spyOn(manager, 'getLspServerManager').mockImplementation(() => fakeManager as never)
const context = (agentId?: string, aborted = false): Record<string, unknown> => {
  const abortController = new AbortController()
  if (aborted) abortController.abort()
  return { abortController, options: { tools: [{ name: BASH_TOOL_NAME }] }, ...(agentId !== undefined ? { agentId } : {}) }
}
const mainOwner = processOwnerForLane(null)
const crewOwner = processOwnerForLane('agent-settle')
const drain = (ctx: Record<string, unknown>): Promise<Row[]> => road.getLSPDiagnosticAttachments(ctx as never) as Promise<Row[]>
const messagesOf = (rows: Row[]): string[] => rows.flatMap(row => row.files.flatMap(file => file.diagnostics.map(d => d.message)))
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  const value = await work()
  return { value, ms: Date.now() - started }
}
function writeAsTheToolsDo(owner: string, path: string, docVersion: number | undefined): void {
  registry.snapshotDiagnosticsBeforeWrite(path, 'const a: number = 1\n', 'const a: number = "x"\n', docVersion, owner)
  registry.clearDeliveredDiagnosticsForFile(`file://${path}`)
}

try {
  section('§1 the round\'s drain carries the publish the write caused, when it arrives')
  registry.resetAllLSPDiagnosticState()
  {
    writeAsTheToolsDo(mainOwner, FILE, 1)
    check('the write is armed for the main lane', registry.writesAwaitingReport(mainOwner).includes(FILE), `${j(registry.writesAwaitingReport(mainOwner))} — ${ARMED}`)
    setTimeout(() => publish(FILE, [typeError(0)], 2), 120)
    const { value: rows, ms } = await timed(() => drain(context()))
    check('the attachment carries the error the write made', messagesOf(rows).join('|') === "Type 'string' is not assignable to type 'number'.", `${j(rows)} — ${WAIT}`)
    check('…delivered when the publish arrived, not after the ceiling', ms >= 100 && ms < 1_000, `${ms} ms — ${WAIT}; the wait must end when the publish arrives`)
    check('the write is settled', !registry.writesAwaitingReport(mainOwner).includes(FILE), `still armed — ${ARMED}`)
  }

  section('§2 a publish of the pre-write document version does not end the wait; the written version does')
  registry.resetAllLSPDiagnosticState()
  {
    writeAsTheToolsDo(mainOwner, FILE, 3)
    setTimeout(() => publish(FILE, [diagnostic(0, "Cannot find name 'helper'.")], 3), 60)
    setTimeout(() => publish(FILE, [typeError(0)], 4), 260)
    const { value: rows, ms } = await timed(() => drain(context()))
    check('the wait ran past the stale publish to the written version', ms >= 240 && ms < 1_000, `${ms} ms — the settle check of the document version in settleAwaitingWrite (src/integrations/lsp/LSPDiagnosticRegistry.ts) and the stillAwaited test in deliverAfterRevalidation (src/engine/attachments/diagnostics.ts) must keep waiting past a publish whose version is not newer than the write's`)
    check('the attachment carries the written version\'s report (the stale set superseded)', messagesOf(rows).join('|') === "Type 'string' is not assignable to type 'number'.", `${j(messagesOf(rows))} — ${WAIT}; the stale set must be superseded by the report of the written version`)
  }

  section('§3 a server that never answers: the wait is the ceiling, nothing stale is attached, the file is awaited once')
  registry.resetAllLSPDiagnosticState()
  {
    publish(FILE, [diagnostic(4, "Cannot find name 'helper'.")], 1)
    writeAsTheToolsDo(mainOwner, FILE, 1)
    const { value: rows, ms } = await timed(() => drain(context()))
    check('the wait is the ceiling', ms >= CEILING_MS - 50 && ms < CEILING_MS + 400, `${ms} ms — ${WAIT}; the wait is RESYNC_REPORT_WAIT_MS`)
    check('nothing stale is attached (the pre-write publish was dropped by the write)', rows.length === 0, `${j(rows)} — snapshotDiagnosticsBeforeWrite in src/integrations/lsp/LSPDiagnosticRegistry.ts must drop the pending publish of the written file`)
    check('the written file is settled after one wait', !registry.writesAwaitingReport(mainOwner).includes(FILE), `still armed — deliverAfterRevalidation in src/engine/attachments/diagnostics.ts must call settleWritesAwaitingReport for the written files`)
    const { value: again, ms: againMs } = await timed(() => drain(context()))
    check('the next drain does not wait again', again.length === 0 && againMs < 100, `${againMs} ms — the file must not stay armed after the first wait (settleWritesAwaitingReport)`)
  }

  section('§4 a written file no server holds open is never awaited')
  registry.resetAllLSPDiagnosticState()
  {
    writeAsTheToolsDo(mainOwner, CLOSED, undefined)
    const { value: rows, ms } = await timed(() => drain(context()))
    check('the drain is immediate', rows.length === 0 && ms < 100, `${ms} ms — getLSPDiagnosticAttachments in src/engine/attachments/diagnostics.ts must not await a written file the manager's isFileOpen says is closed`)
    check('and the write is settled (nothing will come)', !registry.writesAwaitingReport(mainOwner).includes(CLOSED), `still armed — getLSPDiagnosticAttachments must call settleWritesAwaitingReport for armed files no server holds open`)
  }

  section('§5 lanes wait for their own writes alone')
  registry.resetAllLSPDiagnosticState()
  {
    writeAsTheToolsDo(crewOwner, OTHER, 1)
    const { value: mainRows, ms: mainMs } = await timed(() => drain(context()))
    check('the main lane does not wait on a crewmate\'s write', mainRows.length === 0 && mainMs < 100, `${mainMs} ms — writesAwaitingReport(owner) in src/integrations/lsp/LSPDiagnosticRegistry.ts must return only the lane's own writes`)
    check('the crewmate\'s write is still armed', registry.writesAwaitingReport(crewOwner).includes(OTHER), `not armed — the main lane's drain must not settle another lane's write (settleWritesAwaitingReport, writesAwaitingReport in src/integrations/lsp/LSPDiagnosticRegistry.ts)`)
    setTimeout(() => publish(OTHER, [typeError(2)], 2), 80)
    const { value: crewRows, ms: crewMs } = await timed(() => drain(context('agent-settle')))
    check('the crewmate\'s drain waits for and carries its own publish', messagesOf(crewRows).length === 1 && crewMs >= 60 && crewMs < 1_000, `${j(messagesOf(crewRows))} ${crewMs} ms — ${WAIT}, for the drain's own lane`)
  }

  section('§6 the turn\'s end: the writer\'s unread publish is read once, bounded; an interrupted turn reads nothing')
  registry.resetAllLSPDiagnosticState()
  {
    const { value: nothing, ms: nothingMs } = await timed(() => road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('nothing to settle: no rows, no wait', nothing.length === 0 && nothingMs < 100, `${nothingMs} ms — ${TURN_END}; with no armed write it must not wait`)
    writeAsTheToolsDo(mainOwner, FILE, 1)
    registry.settleWritesAwaitingReport(mainOwner, [FILE])
    publish(FILE, [typeError(0)], 2)
    const aborted = await (road.settleWriterDiagnosticsAtTurnEnd(context(undefined, true) as never) as Promise<Row[]>)
    check('an interrupted turn reads nothing (the entry stays for the next turn)', aborted.length === 0 && registry.getPendingLSPDiagnosticCount() === 1, `${j(aborted)} — ${TURN_END}`)
    const { value: settled, ms: settledMs } = await timed(() => road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('the turn\'s end reads the error the last write made', settled.length === 1 && settled[0]!.type === 'diagnostics' && messagesOf(settled).join('|') === "Type 'string' is not assignable to type 'number'.", `${j(settled)} — ${TURN_END}`)
    check('…without waiting (the publish was in)', settledMs < 100, `${settledMs} ms — ${TURN_END}; a publish already in must be delivered without waiting`)
    const once = await (road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('…once: a second settlement carries nothing', once.length === 0, `${j(once)} — ${TURN_END}; a delivered publish must not be delivered again (checkForLSPDiagnostics)`)
    writeAsTheToolsDo(mainOwner, OTHER, 1)
    setTimeout(() => publish(OTHER, [typeError(5)], 2), 150)
    const { value: late, ms: lateMs } = await timed(() => road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('a publish still to come at the turn\'s end is awaited and carried', late.length === 1 && lateMs >= 130 && lateMs < 1_000, `${j(messagesOf(late))} ${lateMs} ms — ${TURN_END}; it must await a publish still to come`)
    writeAsTheToolsDo(mainOwner, OTHER, 2)
    const { value: silent, ms: silentMs } = await timed(() => road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('a server silent at the turn\'s end holds it the ceiling at most, and the answer stands', silent.length === 0 && silentMs >= CEILING_MS - 50 && silentMs < CEILING_MS + 400, `${silentMs} ms — ${TURN_END}; the wait is bounded by RESYNC_REPORT_WAIT_MS`)

    registry.resetAllLSPDiagnosticState()
    const t = await import('../core-runtime/turnScenarios.ts')
    const held = await t.runScripted({
      tools: [{ name: BASH_TOOL_NAME }],
      before: () => {
        const writer = processOwnerForLane(null)
        writeAsTheToolsDo(writer, FILE, 1)
        registry.settleWritesAwaitingReport(writer, [FILE])
        publish(FILE, [typeError(0)], 2)
      },
      script: [t.fixtures.yields(t.fixtures.says('the edit is in.')), t.fixtures.yields(t.fixtures.says('the type is fixed.'))],
    })
    type Sent = { type?: string; attachment?: Row }
    const [asked, again] = held.requests.map(request => request.messages as Sent[])
    const added = (again ?? []).slice((asked ?? []).length)
    const carried = added.filter(row => row.type === 'attachment' && row.attachment?.type === 'diagnostics').map(row => row.attachment as Row)
    check(
      'a held turn continues with the rows in its messages (the existing stop-hook gate)',
      held.transitions.join(',') === 'stop_hook_blocking' && held.requests.length === 2 && held.terminal.reason === 'completed' && added.length === 2 && added[0]?.type === 'assistant' && added[1]?.attachment === carried[0] && messagesOf(carried).join('|') === "Type 'string' is not assignable to type 'number'.",
      `the stop_hooks rule (src/engine/loop/turn/noToolReply.ts) must hand a held turn over as stop_hook_blocking with the request's rows, the reply and the gate's blocking rows, once; a turn that ended with the writer's publish unread handed over [${held.transitions.join(',')}] in ${held.requests.length} model calls, ended ${j(held.terminal)}, and its second request adds ${added.map(row => `${String(row.type)}${row.attachment ? ` (${row.attachment.type})` : ''}`).join(', ') || 'nothing'} carrying ${j(messagesOf(carried))}`,
    )
  }
} finally {
  spy.mockRestore()
  registry.resetAllLSPDiagnosticState()
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('prove-diagnostics-settlement: RED')
  process.exit(1)
}
console.log('prove-diagnostics-settlement: GREEN')
