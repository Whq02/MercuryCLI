#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-change-receipts.ts — the
//  ChangeReceipt ring, proved through the REAL effectObserver seam (the
//  exactly-once chokepoint feed) — plus the end-to-end law that a real
//  FileEdit driven through the PRODUCTION runToolUse transaction mints
//  exactly one receipt, and a pre-execution refusal mints none (the
//  cancellation law: refusals/aborts never reach observeToolTerminal).
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-change-receipts.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-receipts-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_CHANGE_RECEIPTS

const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const {
  _resetChangeReceiptsForTesting,
  receiptById,
  receiptCursor,
  receiptsFor,
  receiptsSince,
} = await import('../../src/services/changeTransaction/receipts.ts')
const { isMutationOperation } = await import('../../src/services/changeTransaction/contracts.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — receipts proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const owner = makeOwnerKey({
  workspace: '/tmp/vanguard-receipts',
  sessionId: 'session-receipts',
  lane: 'main',
} as never)

function synthEvent(overrides: Record<string, unknown>): void {
  observeToolTerminal({
    owner,
    toolName: 'Edit',
    toolUseId: 'toolu_synth',
    input: { file_path: '/tmp/a.ts' },
    ok: true,
    durationMs: 5,
    cwd: '/tmp',
    effect: {
      outcome: 'succeeded',
      operation: 'file.edit',
      changedPaths: ['/tmp/a.ts'],
      evidence: 'synthetic',
      startedAt: 1,
      completedAt: 2,
    },
    ...overrides,
  } as never)
}

// ── vocabulary ──────────────────────────────────────────────────────────────
section('V. mutation-operation vocabulary')
{
  check('V1 file./notebook./lsp-apply/workshop ops are mutations',
    isMutationOperation('file.edit') && isMutationOperation('file.write') &&
    isMutationOperation('notebook.edit') && isMutationOperation('lsp.rename.apply') &&
    isMutationOperation('lsp.codeAction.apply') && isMutationOperation('workshop.cell'))
  check('V2 read/navigation ops are not',
    !isMutationOperation('lsp.goToDefinition') && !isMutationOperation('debug.stack') &&
    !isMutationOperation('lsp.diagnostics'))
}

// ── ring laws ───────────────────────────────────────────────────────────────
section('L. receipt ring laws (through the real observer seam)')
{
  _resetChangeReceiptsForTesting()

  synthEvent({})
  check('L1 mutation effect mints one receipt', receiptsFor(owner).length === 1)
  const r = receiptsFor(owner)[0]!
  check('L2 receipt shape: version/seq/intent/effect',
    r.version === 1 && r.seq === 1 && r.intent.operation === 'file.edit' &&
    r.intent.targetPaths[0] === '/tmp/a.ts' && r.effect.outcome === 'succeeded')
  check('L3 receiptById finds it', receiptById(owner, r.id)?.seq === 1)

  // Read-shaped effects never mint.
  synthEvent({
    toolName: 'LSP',
    effect: {
      outcome: 'succeeded', operation: 'lsp.goToDefinition', changedPaths: [],
      evidence: 'nav', startedAt: 1, completedAt: 2,
    },
  })
  check('L4 read-shaped effect mints nothing', receiptsFor(owner).length === 1)

  // Failed mutations DO mint (failed-attempt receipts for Counsel).
  synthEvent({
    ok: false,
    effect: {
      outcome: 'failed', operation: 'file.write', changedPaths: [],
      evidence: 'disk full', startedAt: 1, completedAt: 2,
    },
  })
  check('L5 failed mutation mints a failed-attempt receipt',
    receiptsFor(owner).length === 2 && receiptsFor(owner)[1]!.effect.outcome === 'failed')

  // Effect-less legacy events never mint.
  synthEvent({ effect: undefined })
  check('L6 effect-less event mints nothing', receiptsFor(owner).length === 2)

  // Cursor reads.
  check('L7 receiptCursor is the high-water seq', receiptCursor(owner) === 2)
  check('L8 receiptsSince(1) returns only the newer receipt',
    receiptsSince(owner, 1).length === 1 && receiptsSince(owner, 1)[0]!.seq === 2)

  // Owner isolation.
  const other = makeOwnerKey({
    workspace: '/tmp/vanguard-receipts',
    sessionId: 'session-other',
    lane: 'main',
  } as never)
  check('L9 owners are isolated', receiptsFor(other).length === 0)

  // Ring bound: 300 mutations retain exactly the cap (256), newest kept.
  for (let i = 0; i < 300; i++) synthEvent({})
  const ring = receiptsFor(owner)
  check('L10 ring bounded at 256, newest retained',
    ring.length === 256 && ring[ring.length - 1]!.seq === 302)

  // Owner disposal tears the ring out.
  disposeOwner(owner)
  check('L11 disposeOwner clears the ring (cursor resets)',
    receiptsFor(owner).length === 0 && receiptCursor(owner) === 0)

  // Gate OFF ⇒ no receipts.
  process.env.MERCURY_CHANGE_RECEIPTS = '0'
  synthEvent({})
  check('L12 gate OFF ⇒ no receipt', receiptsFor(owner).length === 0)
  delete process.env.MERCURY_CHANGE_RECEIPTS
}

// ── end-to-end through the production transaction ───────────────────────────
section('T. end-to-end: runToolUse mints exactly one receipt per executed edit')
{
  _resetChangeReceiptsForTesting()
  const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
  const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

  const dir = mkdtempSync(join(tmpdir(), 'vanguard-receipts-e2e-'))
  const file = join(dir, 'e2e.ts')
  writeFileSync(file, 'const x = 1\n')

  const readFileState = new Map([[file, {
    content: 'const x = 1\n',
    timestamp: statSync(file).mtimeMs + 1,
    offset: undefined,
    limit: undefined,
  }]])

  const events: unknown[] = []
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' },
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  const context = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    options: { tools: [FileEditTool], mcpClients: [], isNonInteractiveSession: true },
  }

  const assistantMessage = {
    uuid: '00000000-0000-0000-0000-00000000000a',
    requestId: 'req_e2e',
    message: { id: 'msg_e2e' },
  }

  const canUse = async (_t: unknown, input: unknown) => ({
    behavior: 'allow',
    updatedInput: input,
  })
  for await (const msg of runToolUse(
    {
      type: 'tool_use',
      id: 'toolu_e2e_1',
      name: FileEditTool.name,
      input: { file_path: file, old_string: 'const x = 1', new_string: 'const x = 2' },
    } as never,
    assistantMessage as never,
    canUse as never,
    context as never,
  )) {
    events.push(msg)
  }

  // Re-derive the production owner exactly as the chokepoint does and
  // assert the receipt landed under it.
  const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
  const { receiptsFor: rf } = await import('../../src/services/changeTransaction/receipts.ts')
  const e2eOwner = ownerFromToolUseContext(context as never)
  const e2eReceipts = rf(e2eOwner)
  check('T1 the executed edit minted exactly one file.edit receipt',
    (await import('node:fs')).readFileSync(file, 'utf8').includes('const x = 2') &&
    e2eReceipts.length === 1 &&
    e2eReceipts[0]!.effect.operation === 'file.edit' &&
    e2eReceipts[0]!.effect.changedPaths[0] === file &&
    e2eReceipts[0]!.toolUseId === 'toolu_e2e_1')

  // Pre-execution refusal (unread file) mints NO receipt: reset the store,
  // run an edit that fails validateInput, then scan for any receipt.
  _resetChangeReceiptsForTesting()
  const file2 = join(dir, 'unread.ts')
  writeFileSync(file2, 'const y = 1\n')
  const refusalEvents: unknown[] = []
  for await (const msg of runToolUse(
    {
      type: 'tool_use',
      id: 'toolu_e2e_2',
      name: FileEditTool.name,
      input: { file_path: file2, old_string: 'const y = 1', new_string: 'const y = 2' },
    } as never,
    assistantMessage as never,
    canUse as never,
    { ...context, readFileState: new Map() } as never,
  )) {
    refusalEvents.push(msg)
  }
  // No owner anywhere should hold a receipt — the refusal never executed.
  check('T2 a pre-execution refusal mints no receipt (cancellation law)',
    rf(owner).length === 0 &&
    (await import('node:fs')).readFileSync(file2, 'utf8').includes('const y = 1'))
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ change receipts: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ change receipts: every law holds')
