#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-receipts-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_CHANGE_RECEIPTS

const { observeToolTerminal } = await import('../../src/engine/run-owner/effectObserver.ts')
const {
  _resetChangeReceiptsForTesting,
  receiptById,
  receiptCursor,
  receiptsFor,
} = await import('../../src/tools/engines/change-transaction/receipts.ts')
const { isMutationOperation } = await import('../../src/tools/engines/change-transaction/contracts.ts')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
const { disposeOwner } = await import('../../src/engine/run-owner/ownerLifecycle.ts')

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

section('V. mutation-operation vocabulary')
{
  check('V1 file./notebook./lsp-apply ops are mutations',
    isMutationOperation('file.edit') && isMutationOperation('file.write') &&
    isMutationOperation('notebook.edit') && isMutationOperation('lsp.rename.apply') &&
    isMutationOperation('lsp.codeAction.apply'),
    'isMutationOperation in src/tools/engines/change-transaction/contracts.ts must return true for file., notebook. and lsp apply operations')
  check('V2 read/navigation ops are not',
    !isMutationOperation('lsp.goToDefinition') && !isMutationOperation('debug.stack') &&
    !isMutationOperation('lsp.diagnostics'),
    'isMutationOperation in src/tools/engines/change-transaction/contracts.ts must return false for read and navigation operations')
}

section('L. receipt ring laws (through the real observer seam)')
{
  _resetChangeReceiptsForTesting()

  synthEvent({})
  check('L1 mutation effect mints one receipt', receiptsFor(owner).length === 1, `receipts ${receiptsFor(owner).length} · observeToolTerminal in src/engine/run-owner/effectObserver.ts must record a receipt through src/tools/engines/change-transaction/receipts.ts for a mutation effect`)
  const r = receiptsFor(owner)[0]!
  check('L2 receipt shape: version/seq/intent/effect',
    r.version === 1 && r.seq === 1 && r.intent.operation === 'file.edit' &&
    r.intent.targetPaths[0] === '/tmp/a.ts' && r.effect.outcome === 'succeeded',
    `receipt ${JSON.stringify(r)} · the receipt built in src/tools/engines/change-transaction/receipts.ts must carry version 1, seq, intent and effect`)
  check('L3 receiptById finds it', receiptById(owner, r.id)?.seq === 1, 'receiptById in src/tools/engines/change-transaction/receipts.ts must find a receipt by its id')

  synthEvent({
    toolName: 'LSP',
    effect: {
      outcome: 'succeeded', operation: 'lsp.goToDefinition', changedPaths: [],
      evidence: 'nav', startedAt: 1, completedAt: 2,
    },
  })
  check('L4 read-shaped effect mints nothing', receiptsFor(owner).length === 1, `receipts ${receiptsFor(owner).length} · observeToolTerminal in src/engine/run-owner/effectObserver.ts must skip an effect whose operation is not a mutation`)

  synthEvent({
    ok: false,
    effect: {
      outcome: 'failed', operation: 'file.write', changedPaths: [],
      evidence: 'disk full', startedAt: 1, completedAt: 2,
    },
  })
  check('L5 failed mutation mints a failed-attempt receipt',
    receiptsFor(owner).length === 2 && receiptsFor(owner)[1]!.effect.outcome === 'failed',
    `receipts ${receiptsFor(owner).length} · observeToolTerminal in src/engine/run-owner/effectObserver.ts must mint a receipt for a failed mutation`)

  synthEvent({ effect: undefined })
  check('L6 effect-less event mints nothing', receiptsFor(owner).length === 2, `receipts ${receiptsFor(owner).length} · observeToolTerminal in src/engine/run-owner/effectObserver.ts must skip an event with no effect`)

  check('L7 receiptCursor is the high-water seq', receiptCursor(owner) === 2, `cursor ${receiptCursor(owner)} · receiptCursor in src/tools/engines/change-transaction/receipts.ts must return the highest seq`)

  const other = makeOwnerKey({
    workspace: '/tmp/vanguard-receipts',
    sessionId: 'session-other',
    lane: 'main',
  } as never)
  check('L9 owners are isolated', receiptsFor(other).length === 0, `other owner sees ${receiptsFor(other).length} · src/tools/engines/change-transaction/receipts.ts must key receipts by owner`)

  for (let i = 0; i < 300; i++) synthEvent({})
  const ring = receiptsFor(owner)
  check('L10 ring bounded at 256, newest retained',
    ring.length === 256 && ring[ring.length - 1]!.seq === 302,
    `ring ${ring.length}, newest seq ${ring[ring.length - 1]?.seq} · the ring in src/tools/engines/change-transaction/receipts.ts must hold 256 and keep the newest`)

  disposeOwner(owner)
  check('L11 disposeOwner clears the ring (cursor resets)',
    receiptsFor(owner).length === 0 && receiptCursor(owner) === 0,
    `receipts ${receiptsFor(owner).length}, cursor ${receiptCursor(owner)} · disposeOwner in src/engine/run-owner/ownerLifecycle.ts must clear the receipt ring in src/tools/engines/change-transaction/receipts.ts`)

  process.env.MERCURY_CHANGE_RECEIPTS = '0'
  synthEvent({})
  check('L12 gate OFF ⇒ no receipt', receiptsFor(owner).length === 0, `receipts ${receiptsFor(owner).length} · observeToolTerminal in src/engine/run-owner/effectObserver.ts must mint nothing when MERCURY_CHANGE_RECEIPTS is 0`)
  delete process.env.MERCURY_CHANGE_RECEIPTS
}

section('T. end-to-end: runToolUse mints exactly one receipt per executed edit')
{
  _resetChangeReceiptsForTesting()
  const { runToolUse } = await import('../../src/engine/tool-dispatch/toolExecution.ts')
  const { EditTool } = await import('../../src/tools/edit/EditTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')

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
    options: { tools: [EditTool], mcpClients: [], isNonInteractiveSession: true },
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
      name: EditTool.name,
      input: { file_path: file, old_string: 'const x = 1', new_string: 'const x = 2' },
    } as never,
    assistantMessage as never,
    canUse as never,
    context as never,
  )) {
    events.push(msg)
  }

  const { ownerFromToolUseContext } = await import('../../src/engine/run-owner/resolveOwner.ts')
  const { receiptsFor: rf } = await import('../../src/tools/engines/change-transaction/receipts.ts')
  const e2eOwner = ownerFromToolUseContext(context as never)
  const e2eReceipts = rf(e2eOwner)
  check('T1 the executed edit minted exactly one file.edit receipt',
    (await import('node:fs')).readFileSync(file, 'utf8').includes('const x = 2') &&
    e2eReceipts.length === 1 &&
    e2eReceipts[0]!.effect.operation === 'file.edit' &&
    e2eReceipts[0]!.effect.changedPaths[0] === file &&
    e2eReceipts[0]!.toolUseId === 'toolu_e2e_1',
    `receipts ${JSON.stringify(e2eReceipts)} · runToolUse in src/engine/tool-dispatch/toolExecution.ts must report the executed edit to observeToolTerminal once`)

  _resetChangeReceiptsForTesting()
  const file2 = join(dir, 'unread.ts')
  writeFileSync(file2, 'const y = 1\n')
  const refusalEvents: unknown[] = []
  for await (const msg of runToolUse(
    {
      type: 'tool_use',
      id: 'toolu_e2e_2',
      name: EditTool.name,
      input: { file_path: file2, old_string: 'const y = 1', new_string: 'const y = 2' },
    } as never,
    assistantMessage as never,
    canUse as never,
    { ...context, readFileState: new Map() } as never,
  )) {
    refusalEvents.push(msg)
  }
  check('T2 a pre-execution refusal mints no receipt (cancellation law)',
    rf(owner).length === 0 &&
    (await import('node:fs')).readFileSync(file2, 'utf8').includes('const y = 1'),
    `receipts ${rf(owner).length} · runToolUse in src/engine/tool-dispatch/toolExecution.ts must not report a refused tool call to observeToolTerminal`)
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ change receipts: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ change receipts: every law holds')
