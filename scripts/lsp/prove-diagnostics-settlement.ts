#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const registry = await import(join(ROOT, 'src/services/lsp/LSPDiagnosticRegistry.ts'))
const manager = await import(join(ROOT, 'src/services/lsp/manager.ts'))
const road = await import(join(ROOT, 'src/utils/attachments/diagnostics.ts'))
const { processOwnerForLane } = await import(join(ROOT, 'src/services/run/resolveOwner.ts'))
const { BASH_TOOL_NAME } = await import(join(ROOT, 'src/tools/BashTool/toolName.ts'))
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
    check('the write is armed for the main lane', registry.writesAwaitingReport(mainOwner).includes(FILE), j(registry.writesAwaitingReport(mainOwner)))
    setTimeout(() => publish(FILE, [typeError(0)], 2), 120)
    const { value: rows, ms } = await timed(() => drain(context()))
    check('the attachment carries the error the write made', messagesOf(rows).join('|') === "Type 'string' is not assignable to type 'number'.", j(rows))
    check('…delivered when the publish arrived, not after the ceiling', ms >= 100 && ms < 1_000, `${ms} ms`)
    check('the write is settled', !registry.writesAwaitingReport(mainOwner).includes(FILE))
  }

  section('§2 a publish of the pre-write document version does not end the wait; the written version does')
  registry.resetAllLSPDiagnosticState()
  {
    writeAsTheToolsDo(mainOwner, FILE, 3)
    setTimeout(() => publish(FILE, [diagnostic(0, "Cannot find name 'helper'.")], 3), 60)
    setTimeout(() => publish(FILE, [typeError(0)], 4), 260)
    const { value: rows, ms } = await timed(() => drain(context()))
    check('the wait ran past the stale publish to the written version', ms >= 240 && ms < 1_000, `${ms} ms`)
    check('the attachment carries the written version\'s report (the stale set superseded)', messagesOf(rows).join('|') === "Type 'string' is not assignable to type 'number'.", j(messagesOf(rows)))
  }

  section('§3 a server that never answers: the wait is the ceiling, nothing stale is attached, the file is awaited once')
  registry.resetAllLSPDiagnosticState()
  {
    publish(FILE, [diagnostic(4, "Cannot find name 'helper'.")], 1)
    writeAsTheToolsDo(mainOwner, FILE, 1)
    const { value: rows, ms } = await timed(() => drain(context()))
    check('the wait is the ceiling', ms >= CEILING_MS - 50 && ms < CEILING_MS + 400, `${ms} ms`)
    check('nothing stale is attached (the pre-write publish was dropped by the write)', rows.length === 0, j(rows))
    check('the written file is settled after one wait', !registry.writesAwaitingReport(mainOwner).includes(FILE))
    const { value: again, ms: againMs } = await timed(() => drain(context()))
    check('the next drain does not wait again', again.length === 0 && againMs < 100, `${againMs} ms`)
  }

  section('§4 a written file no server holds open is never awaited')
  registry.resetAllLSPDiagnosticState()
  {
    writeAsTheToolsDo(mainOwner, CLOSED, undefined)
    const { value: rows, ms } = await timed(() => drain(context()))
    check('the drain is immediate', rows.length === 0 && ms < 100, `${ms} ms`)
    check('and the write is settled (nothing will come)', !registry.writesAwaitingReport(mainOwner).includes(CLOSED))
  }

  section('§5 lanes wait for their own writes alone')
  registry.resetAllLSPDiagnosticState()
  {
    writeAsTheToolsDo(crewOwner, OTHER, 1)
    const { value: mainRows, ms: mainMs } = await timed(() => drain(context()))
    check('the main lane does not wait on a crewmate\'s write', mainRows.length === 0 && mainMs < 100, `${mainMs} ms`)
    check('the crewmate\'s write is still armed', registry.writesAwaitingReport(crewOwner).includes(OTHER))
    setTimeout(() => publish(OTHER, [typeError(2)], 2), 80)
    const { value: crewRows, ms: crewMs } = await timed(() => drain(context('agent-settle')))
    check('the crewmate\'s drain waits for and carries its own publish', messagesOf(crewRows).length === 1 && crewMs >= 60 && crewMs < 1_000, `${j(messagesOf(crewRows))} ${crewMs} ms`)
  }

  section('§6 the turn\'s end: the writer\'s unread publish is read once, bounded; an interrupted turn reads nothing')
  registry.resetAllLSPDiagnosticState()
  {
    const { value: nothing, ms: nothingMs } = await timed(() => road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('nothing to settle: no rows, no wait', nothing.length === 0 && nothingMs < 100, `${nothingMs} ms`)
    writeAsTheToolsDo(mainOwner, FILE, 1)
    registry.settleWritesAwaitingReport(mainOwner, [FILE])
    publish(FILE, [typeError(0)], 2)
    const aborted = await (road.settleWriterDiagnosticsAtTurnEnd(context(undefined, true) as never) as Promise<Row[]>)
    check('an interrupted turn reads nothing (the entry stays for the next turn)', aborted.length === 0 && registry.getPendingLSPDiagnosticCount() === 1, j(aborted))
    const { value: settled, ms: settledMs } = await timed(() => road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('the turn\'s end reads the error the last write made', settled.length === 1 && settled[0]!.type === 'diagnostics' && messagesOf(settled).join('|') === "Type 'string' is not assignable to type 'number'.", j(settled))
    check('…without waiting (the publish was in)', settledMs < 100, `${settledMs} ms`)
    const once = await (road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('…once: a second settlement carries nothing', once.length === 0)
    writeAsTheToolsDo(mainOwner, OTHER, 1)
    setTimeout(() => publish(OTHER, [typeError(5)], 2), 150)
    const { value: late, ms: lateMs } = await timed(() => road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('a publish still to come at the turn\'s end is awaited and carried', late.length === 1 && lateMs >= 130 && lateMs < 1_000, `${j(messagesOf(late))} ${lateMs} ms`)
    writeAsTheToolsDo(mainOwner, OTHER, 2)
    const { value: silent, ms: silentMs } = await timed(() => road.settleWriterDiagnosticsAtTurnEnd(context() as never) as Promise<Row[]>)
    check('a server silent at the turn\'s end holds it the ceiling at most, and the answer stands', silent.length === 0 && silentMs >= CEILING_MS - 50 && silentMs < CEILING_MS + 400, `${silentMs} ms`)

    const stopHooks = readFileSync(join(ROOT, 'src/query/stopHooks.ts'), 'utf8')
    const guards = stopHooks.indexOf('const holds = await judgeTurnEnd(')
    const settlement = stopHooks.indexOf('for (const row of await settleWriterDiagnosticsAtTurnEnd(toolUseContext))')
    const answerHooks = stopHooks.indexOf("prepareHooks(\n      'turn.answer'")
    check('the stop-hook path settles the writer\'s diagnostics after the guards and before the turn.answer hooks', guards !== -1 && settlement > guards && answerHooks > settlement, `${guards} ${settlement} ${answerHooks}`)
    check('the rows ride the transcript as the one attachment the model knows, and hold the turn once (never a hold already granted)', stopHooks.includes('const message = createAttachmentMessage(row)\n        yield message\n        if (stopHookActive !== true) settlementBlocks.push(message)'))
    check('bare mode is left alone', /if \(!isBareMode\(\)\) \{\n\s+try \{\n\s+for \(const row of await settleWriterDiagnosticsAtTurnEnd/.test(stopHooks))
    const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
    check('a held turn continues with the rows in its messages (the existing stop-hook gate)', machine.includes('...stopHookResult.blockingErrors,') && machine.includes("transition: { reason: 'stop_hook_blocking' }"))
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
