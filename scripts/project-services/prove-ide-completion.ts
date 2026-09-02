#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-ide-completion.ts — the IDE
//  transaction completion, proved against the PRODUCTION mercuryOps pipeline
//  (fake server manager, real permission/drift/transaction code — the
//  prove-lsp-apply-safety idiom) and the PRODUCTION DebugTool over the real
//  DAP client + the deterministic mock adapter.
//
//  Laws:
//    PR. pathRename — preview writes nothing; apply = import edits + move +
//        readFileState follow + didRenameFiles as ONE transaction with exact
//        changedPaths; target-exists refusal; drift aborts BEFORE the move.
//    AI. action identity — a REORDERED action list still applies the action
//        the id names; a VANISHED id refuses; id+index disagreement refuses.
//    WD. workspaceDiagnostics — directory expansion (claimed files only,
//        deterministic), per-file pull, honest cap.
//    SS. serverStatus — typed rows from live instances (pathRename cap).
//    FX. fixDiagnostic — diagnose → sole-candidate fix → before/after proof.
//    DA. DAP additions — supported ops answer; unsupported ops answer
//        PRECISELY (capability named); exception filters list/arm/refuse;
//        the structured stop card rides the launch effect.
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-ide-completion.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-ide-'))
delete process.env.MERCURY_LSP
delete process.env.MERCURY_DAP

const { runMercuryLspOp, actionIdentity } = await import('../../src/tools/LSPTool/mercuryOps.ts')
const { LSPTool } = await import('../../src/tools/LSPTool/LSPTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — ide completion proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

// ── fixture workspace ───────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'vanguard-ide-fixture-'))
const libPath = join(dir, 'lib.ts')
const aPath = join(dir, 'a.ts')
const bPath = join(dir, 'b.ts')
writeFileSync(libPath, `export const answer = 42\n`)
writeFileSync(aPath, `import { answer } from './lib.js'\nexport const twice = answer * 2\n`)
writeFileSync(bPath, `import { twice } from './a.js'\nconsole.log(twice)\n`)

function rangeOf(content: string, needle: string): {
  start: { line: number; character: number }
  end: { line: number; character: number }
} {
  const idx = content.indexOf(needle)
  const before = content.slice(0, idx)
  const line = before.split('\n').length - 1
  const character = idx - (before.lastIndexOf('\n') + 1)
  return {
    start: { line, character },
    end: { line, character: character + needle.length },
  }
}

// ── the fake manager (real transaction code around it) ──────────────────────
type Edit = { range: ReturnType<typeof rangeOf>; newText: string }
const state = {
  open: new Map<string, string>(),
  notifications: [] as { method: string; params: unknown }[],
  // diagnostics per file: mutated by tests
  diagnostics: new Map<string, { range: ReturnType<typeof rangeOf>; severity: number; message: string; code: number }[]>(),
  // action list per call: tests reorder/remove between fetches
  actionLists: [] as { title: string; kind: string; edit?: { changes: Record<string, Edit[]> } }[][],
  actionFetches: 0,
}
const fakeServer = {
  name: 'fake-ts',
  state: 'running',
  // E's fan-out and the per-file diagnostic pull (the merged-report road)
  // ask the SERVER instance directly (server.sendRequest(method,
  // params)) — the double delegates to the manager-level answer FOR THE FILE
  // THE PARAMS NAME (a fixed file here served aPath's diagnostics to every
  // pull and read bPath as all-clean), falling back to aPath for methods
  // that carry no textDocument.
  start: async () => {},
  sendRequest: async (method: string, params: unknown) => {
    const uri = (params as { textDocument?: { uri?: string } })?.textDocument?.uri
    const file = uri ? fileURLToPath(uri) : aPath
    return (manager as { sendRequest: (f: string, m: string, p: unknown) => Promise<unknown> }).sendRequest(file, method, params)
  },
  generation: 1,
  restartCount: 0,
  lastError: undefined,
  capabilities: {
    renameProvider: true,
    codeActionProvider: { resolveProvider: false },
    diagnosticProvider: { interFileDependencies: true },
    typeDefinitionProvider: true,
    callHierarchyProvider: true,
    workspace: { fileOperations: { willRename: {}, didRename: {} } },
  },
  sendNotification: async (method: string, params: unknown) => {
    state.notifications.push({ method, params })
  },
}
const manager = {
  getServerForFile: (f: string) => (f.endsWith('.ts') ? fakeServer : undefined),
  // E's rename fan-out asks for EVERY matching server (first-wins list): the
  // double answers with the one fake server, same truth as getServerForFile.
  getServersForFile: (f: string) => (f.endsWith('.ts') ? [fakeServer] : []),
  getAllServers: () => new Map([['fake-ts', fakeServer]]),
  isFileOpen: (f: string) => state.open.has(f),
  openFile: async (f: string, t: string) => void state.open.set(f, t),
  changeFile: async (f: string, t: string) => void state.open.set(f, t),
  changeAndSaveFile: async (f: string, t: string) => void state.open.set(f, t),
  closeFile: async (f: string) => void state.open.delete(f),
  getDocumentVersion: () => 1,
  sendRequest: async (file: string, method: string, _params: unknown) => {
    if (method === 'textDocument/diagnostic') {
      return { kind: 'full', items: state.diagnostics.get(file) ?? [], resultId: `r${Date.now()}` }
    }
    if (method === 'workspace/willRenameFiles') {
      // Import-updating edits computed against CURRENT content.
      const aText = readFileSync(aPath, 'utf8')
      const bText = readFileSync(bPath, 'utf8')
      return {
        changes: {
          [pathToFileURL(aPath).href]: [
            { range: rangeOf(aText, `'./lib.js'`), newText: `'../lib.js'` },
          ],
          [pathToFileURL(bPath).href]: [
            { range: rangeOf(bText, `'./a.js'`), newText: `'./sub/a2.js'` },
          ],
        },
      }
    }
    if (method === 'textDocument/codeAction') {
      const idx = Math.min(state.actionFetches, state.actionLists.length - 1)
      state.actionFetches++
      return state.actionLists[idx] ?? []
    }
    throw new Error(`fake manager: unhandled method ${method}`)
  },
} as never

// the write-scope predicate is now Write/Edit's
// pathInAllowedWorkingPath — roots on the ORIGINAL cwd + DECLARED additional
// working directories, never a caller-passed cwd. The fixture root joins the
// context exactly the way a real session admits one (/add-dir).
const fixtureScopedPermissionContext = () => ({
  ...getEmptyToolPermissionContext(),
  additionalWorkingDirectories: new Map([[dir, { path: dir, source: 'cliArg' }]]),
})

const context = {
  abortController: new AbortController(),
  readFileState: new Map<string, unknown>(),
  getAppState: () => ({
    toolPermissionContext: fixtureScopedPermissionContext(),
  }),
  setAppState: () => {},
  agentId: undefined,
  options: { tools: [], isNonInteractiveSession: true },
} as never

function env(input: Record<string, unknown>, absolutePath: string) {
  return {
    input: input as never,
    absolutePath,
    cwd: dir,
    manager,
    tool: LSPTool as never,
    context,
  }
}

// ── PR. pathRename ──────────────────────────────────────────────────────────
section('PR. pathRename — the one-transaction import-updating move')
{
  const newPath = join(dir, 'sub', 'a2.ts')

  // PR1: preview writes nothing, moves nothing.
  const preview = await runMercuryLspOp(
    env({ operation: 'pathRename', filePath: aPath, newPath, line: 1, character: 1 }, aPath),
  )
  check('PR1 preview computes edits + move, writes nothing',
    preview.applied === false &&
    preview.effect.outcome === 'succeeded' &&
    preview.effect.changedPaths.length === 0 &&
    existsSync(aPath) && !existsSync(newPath) &&
    preview.result.includes('Move:') && preview.result.includes('import-updating'))

  // PR2: target-exists refusal.
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(newPath, 'occupied\n')
  const occupied = await runMercuryLspOp(
    env({ operation: 'pathRename', filePath: aPath, newPath, apply: true, line: 1, character: 1 }, aPath),
  )
  check('PR2 existing target refuses, nothing moved',
    occupied.effect.outcome === 'failed' && existsSync(aPath))
  const { unlinkSync } = await import('node:fs')
  unlinkSync(newPath)

  // PR3: apply — edits + move + state follow as one transaction.
  const rfs = (context as { readFileState: Map<string, unknown> }).readFileState
  rfs.set(aPath, { content: 'stale', timestamp: 0 })
  const applied = await runMercuryLspOp(
    env({ operation: 'pathRename', filePath: aPath, newPath, apply: true, line: 1, character: 1 }, aPath),
  )
  const movedText = existsSync(newPath) ? readFileSync(newPath, 'utf8') : ''
  const bText = readFileSync(bPath, 'utf8')
  check('PR3a the move landed with the import edits',
    applied.applied === true &&
    applied.effect.outcome === 'succeeded' &&
    !existsSync(aPath) && movedText.includes(`'../lib.js'`) &&
    bText.includes(`'./sub/a2.js'`))
  check('PR3b changedPaths carry edited files + both move endpoints',
    applied.effect.changedPaths.includes(aPath) &&
    applied.effect.changedPaths.includes(newPath) &&
    applied.effect.changedPaths.includes(bPath))
  check('PR3c didRenameFiles notified; readFileState followed the move',
    state.notifications.some(n => n.method === 'workspace/didRenameFiles') &&
    !rfs.has(aPath) && rfs.has(newPath))

  // PR4: drift refusal — disk changes between edit computation and write.
  // Move the file back for a fresh attempt, then race it.
  writeFileSync(aPath, readFileSync(newPath, 'utf8').replace(`'../lib.js'`, `'./lib.js'`))
  unlinkSync(newPath)
  writeFileSync(bPath, `import { twice } from './a.js'\nconsole.log(twice)\n`)
  // Real drift: prepareApply's sync-and-stabilize loop legitimately absorbs
  // changes made BEFORE its final round (re-request + re-sync) — so the
  // concurrent write must land AFTER the final request round, i.e. on the
  // SECOND willRenameFiles call (whose round finds everything synced and
  // returns), leaving disk ≠ snapshot for applyPrepared's re-read.
  const originalSendRequest = (manager as { sendRequest: unknown }).sendRequest as Function
  let willRenameCalls = 0
  ;(manager as { sendRequest: unknown }).sendRequest = async (
    file: string,
    method: string,
    params: unknown,
  ) => {
    if (method === 'workspace/willRenameFiles') {
      willRenameCalls++
      const out = await originalSendRequest(file, method, params)
      if (willRenameCalls === 2) {
        writeFileSync(bPath, `import { twice } from './a.js'\n// concurrent change\nconsole.log(twice)\n`)
      }
      return out
    }
    return originalSendRequest(file, method, params)
  }
  const drifted = await runMercuryLspOp(
    env({ operation: 'pathRename', filePath: aPath, newPath, apply: true, line: 1, character: 1 }, aPath),
  )
  ;(manager as { sendRequest: unknown }).sendRequest = originalSendRequest
  check('PR4 drift aborts BEFORE the move — nothing written, nothing moved',
    drifted.effect.outcome === 'failed' &&
    drifted.result.includes('drift') &&
    existsSync(aPath) && !existsSync(newPath))
  // Restore the pre-drift fixture state for later sections.
  writeFileSync(bPath, `import { twice } from './a.js'\nconsole.log(twice)\n`)
}

// ── AI. action identity ─────────────────────────────────────────────────────
section('AI. code-action identity — reordered lists can never mis-apply')
{
  const aText = readFileSync(aPath, 'utf8')
  const editFix = { changes: { [pathToFileURL(aPath).href]: [
    { range: rangeOf(aText, 'answer * 2'), newText: 'answer + answer' },
  ] } }
  const editRemove = { changes: { [pathToFileURL(aPath).href]: [
    { range: rangeOf(aText, 'export const twice'), newText: 'const twice' },
  ] } }
  const actFix = { title: 'Rewrite as addition', kind: 'quickfix', edit: editFix }
  const actRemove = { title: 'Un-export twice', kind: 'quickfix', edit: editRemove }
  const fixId = actionIdentity(actFix as never)

  // AI1: list carries stable ids.
  state.actionLists = [[actFix, actRemove]]
  state.actionFetches = 0
  const listing = await runMercuryLspOp(
    env({ operation: 'codeActions', filePath: aPath, line: 2, character: 14 }, aPath),
  )
  check('AI1 listing rows carry stable ids',
    listing.result.includes(`id:${fixId}`) &&
    listing.result.includes(`id:${actionIdentity(actRemove as never)}`))

  // AI2: the list REORDERS between listing and apply — actionId still
  // applies the named action (index 0 now points at the OTHER action).
  state.actionLists = [[actRemove, actFix], [actRemove, actFix], [actRemove, actFix]]
  state.actionFetches = 0
  const applied = await runMercuryLspOp(
    env({ operation: 'codeActions', filePath: aPath, line: 2, character: 14, apply: true, actionId: fixId }, aPath),
  )
  const after = readFileSync(aPath, 'utf8')
  check('AI2 reordered list: actionId applies the NAMED action',
    applied.applied === true && after.includes('answer + answer') && after.includes('export const twice'))

  // AI3: a vanished id refuses.
  state.actionLists = [[actRemove]]
  state.actionFetches = 0
  const vanished = await runMercuryLspOp(
    env({ operation: 'codeActions', filePath: aPath, line: 2, character: 14, apply: true, actionId: fixId }, aPath),
  )
  check('AI3 vanished actionId refuses (list changed)',
    vanished.effect.outcome === 'failed' && vanished.result.includes('changed'))

  // AI4: id + index disagreement refuses.
  state.actionLists = [[actRemove, actFix]]
  state.actionFetches = 0
  const disagree = await runMercuryLspOp(
    env({ operation: 'codeActions', filePath: aPath, line: 2, character: 14, apply: true, actionId: fixId, actionIndex: 0 }, aPath),
  )
  check('AI4 actionId/actionIndex disagreement refuses',
    disagree.effect.outcome === 'failed' && disagree.result.includes('different actions'))
}

// ── WD. workspaceDiagnostics ────────────────────────────────────────────────
section('WD. workspaceDiagnostics — bounded deterministic multi-file pull')
{
  const bText = readFileSync(bPath, 'utf8')
  state.diagnostics.set(bPath, [{
    range: rangeOf(bText, 'twice'),
    severity: 1,
    message: 'fixture error on twice',
    code: 9001,
  }])
  writeFileSync(join(dir, 'notes.md'), '# not claimed\n')
  const wd = await runMercuryLspOp(
    env({ operation: 'workspaceDiagnostics', paths: [dir], line: 1, character: 1 }, dir),
  )
  check('WD1 directory expands to claimed files; skipped counted; error found',
    wd.effect.outcome === 'succeeded' &&
    wd.result.includes('fixture error on twice') &&
    wd.result.includes('1 error') &&
    /skipped/.test(wd.result),
    `outcome=${wd.effect.outcome} result=${String(wd.result).slice(0, 400)}`)
  // Cap: a directory of 60 claimed files truncates honestly at 50.
  const bulk = join(dir, 'bulk')
  mkdirSync(bulk)
  for (let i = 0; i < 60; i++) writeFileSync(join(bulk, `f${String(i).padStart(2, '0')}.ts`), 'export {}\n')
  const capped = await runMercuryLspOp(
    env({ operation: 'workspaceDiagnostics', paths: [bulk], line: 1, character: 1 }, bulk),
  )
  check('WD2 the 50-file cap reports itself (never silent truncation)',
    capped.result.includes('CAPPED') && capped.fileCount === 50)
}

// ── SS. serverStatus ────────────────────────────────────────────────────────
section('SS. serverStatus — the typed roster')
{
  const ss = await runMercuryLspOp(
    env({ operation: 'serverStatus', filePath: aPath, line: 1, character: 1 }, aPath),
  )
  check('SS1 rows carry state/generation/capabilities incl. pathRename + file claim',
    ss.result.includes('fake-ts — running (gen 1') &&
    ss.result.includes('claims this file') &&
    ss.result.includes('pathRename'))
  const details = ss.effect.details as { servers?: { name: string; capabilities: { pathRename: boolean } }[] }
  check('SS2 typed rows ride effect.details (doctor-consumable)',
    Array.isArray(details.servers) && details.servers[0]?.capabilities.pathRename === true)
}

// ── FX. fixDiagnostic ───────────────────────────────────────────────────────
section('FX. fixDiagnostic — diagnose → fix → prove')
{
  const aText = readFileSync(aPath, 'utf8')
  const diag = {
    range: rangeOf(aText, 'answer + answer'),
    severity: 1,
    message: 'fixture: prefer multiplication',
    code: 4242,
  }
  state.diagnostics.set(aPath, [diag])
  const fixEdit = { changes: { [pathToFileURL(aPath).href]: [
    { range: rangeOf(aText, 'answer + answer'), newText: 'answer * 2' },
  ] } }
  const fixAction = { title: 'Use multiplication', kind: 'quickfix', edit: fixEdit }
  state.actionLists = [[fixAction], [fixAction], [fixAction], [fixAction]]
  state.actionFetches = 0

  // The fake pull returns clean once the edit landed: hook diagnostics to
  // content.
  const targetLine = diag.range.start.line
  const dynamicDiagnostics = () =>
    readFileSync(aPath, 'utf8').includes('answer + answer') ? [diag] : []
  const origGet = state.diagnostics.get.bind(state.diagnostics)
  state.diagnostics.get = ((f: string) =>
    f === aPath ? dynamicDiagnostics() : origGet(f)) as never
  void targetLine

  const line = diag.range.start.line + 1
  const preview = await runMercuryLspOp(
    env({ operation: 'fixDiagnostic', filePath: aPath, line, character: diag.range.start.character + 1 }, aPath),
  )
  check('FX1 preview names the diagnostics + candidate fixes with ids',
    preview.result.includes('prefer multiplication') &&
    preview.result.includes(`id:${actionIdentity(fixAction as never)}`))

  state.actionFetches = 0
  const fixed = await runMercuryLspOp(
    env({ operation: 'fixDiagnostic', filePath: aPath, line, character: diag.range.start.character + 1, apply: true }, aPath),
  )
  check('FX2 sole candidate auto-applies; before→after proof reported',
    fixed.applied === true &&
    readFileSync(aPath, 'utf8').includes('answer * 2') &&
    /errors before: 1 → after: 0/.test(fixed.result))
  state.diagnostics.get = origGet as never
}

// ── DA. DAP additions ───────────────────────────────────────────────────────
section('DA. DAP additions — capability-gated inspection through the real client')
{
  const MOCK = join(import.meta.dir, '..', 'dap', 'mock-dap-adapter.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mock: { command: process.execPath, args: [MOCK] },
  })
  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
  const call = (input: Record<string, unknown>) =>
    (DebugTool as { call: Function }).call(input, context)

  const launched = await call({
    op: 'launch',
    adapter: 'mock',
    program: '/tmp/demo.py',
    file: '/tmp/demo.py',
    lines: [3],
    session: 'vg',
  })
  check('DA1 launch stops at the verified breakpoint with the structured stop card',
    launched.data.debuggee === 'stopped' &&
    launched.effect.details?.stopCard?.reason === 'breakpoint' &&
    launched.effect.details?.stopCard?.verifiedBreakpoints === 1 &&
    launched.effect.details?.stopCard?.topFrame?.line === 3)

  const sources = await call({ op: 'loadedSources', session: 'vg' })
  check('DA2 loadedSources lists debuggee sources (capability advertised)',
    sources.data.result.includes('/tmp/demo.py') &&
    sources.data.result.includes('sourceReference 7'))

  const modules = await call({ op: 'modules', session: 'vg' })
  check('DA3 modules answers PRECISELY unsupported (capability named)',
    modules.data.result.includes('does not support modules') &&
    modules.data.result.includes('supportsModulesRequest'))

  const completions = await call({ op: 'completions', text: 'x', session: 'vg' })
  check('DA4 completions answers PRECISELY unsupported',
    completions.data.result.includes('does not support completions') &&
    completions.data.result.includes('supportsCompletionsRequest'))

  const filters = await call({ op: 'exceptionBreakpoints', session: 'vg' })
  check('DA5 exception filters listed from capabilities',
    filters.data.result.includes('raised: Raised Exceptions') &&
    filters.data.result.includes('uncaught: Uncaught Exceptions (default)'))

  const armed = await call({ op: 'exceptionBreakpoints', filters: ['raised'], session: 'vg' })
  check('DA6 arming known filters succeeds', armed.data.result.includes('armed: raised'))

  const bogus = await call({ op: 'exceptionBreakpoints', filters: ['bogus'], session: 'vg' })
  check('DA7 unknown filter refuses with the available set',
    bogus.effect.outcome === 'failed' && bogus.data.result.includes('available: raised, uncaught'))

  const src = await call({ op: 'source', sourceReference: 7, session: 'vg' })
  check('DA8 source retrieves generated content by reference',
    src.data.result.includes('generated line 1'))

  const setVar = await call({ op: 'setVariable', variablesReference: 100, name: 'x', value: '99', session: 'vg' })
  check('DA9 setVariable mutates and reports the adapter-confirmed value',
    setVar.effect.outcome === 'succeeded' && setVar.data.result.includes('x = 99'))

  const bye = await call({ op: 'disconnect', session: 'vg' })
  check('DA10 disconnect reaps', bye.data.result.includes('disconnected'))
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ide completion: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ ide completion: every law holds')
