#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-read-dedup-delivery.ts — the read-dedup ledger
//  tracks DELIVERY, never just the decision to return.
//
//  The lie this pins shut (the dead-turn incident, the read half):
//  the Read front-door answers a repeat of an unmodified window with the
//  "file unchanged — lean on the earlier result above" stub, vouched by
//  readFileState. Time-based microcompact CLEARS old Read results out of
//  the model's view without touching that ledger — so after a clear, the
//  stub pointed at a placeholder: the model was told to lean on content it
//  could no longer see, retried, was "rejected as a duplicate" again, and
//  stalled. Delivery truth requires the clear to invalidate the ledger.
//
//    D1  the honest dedup: a repeat read of an unmodified window answers
//        the stub while the earlier result still rides the view.
//    D2  the APPLY-mode request plan's time-based clear reports the cleared
//        Read result and replaces its content in the view.
//    D3  after the clear, the SAME window read again serves FULL CONTENT —
//        the ledger entry died with the clear (the lie, pinned shut).
//    D4  no over-invalidation: a file whose result SURVIVED the clear
//        (keep-recent) still answers the stub.
//    D5  inspect mode leaves the ledger untouched (zero side effects).
//
//  Run: ~/.bun/bin/bun run scripts/edit-tools/prove-read-dedup-delivery.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'dedup-delivery-home-'))
process.env.MERCURY_SIMPLE = '1'
// The time-based trigger under proof — armed explicitly, never left to the
// remote gate.
process.env.MERCURY_TIME_BASED_MC = '1'
delete process.env.NODE_ENV

const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FILE_UNCHANGED_STUB } = await import('../../src/tools/FileReadTool/prompt.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { buildRequestContextPlan } = await import('../../src/services/run/requestContextPlan.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — dedup delivery prover exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

// ── rig ─────────────────────────────────────────────────────────────────────
const readFileState = createFileStateCacheWithSizeLimit(100)
const context = {
  readFileState,
  userModified: false,
  updateFileHistoryState: () => {},
  dynamicSkillDirTriggers: new Set<string>(),
  nestedMemoryAttachmentTriggers: new Set<string>(),
  abortController: new AbortController(),
  getAppState: () => ({
    toolPermissionContext: getEmptyToolPermissionContext(),
  }),
} as never

async function readViaTool(path: string): Promise<string> {
  const result = await (FileReadTool as { call: Function }).call(
    { file_path: path },
    context,
    null,
    { uuid: '00000000-0000-0000-0000-000000000001', message: { id: 'msg_fixture' } },
  )
  const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function })
    .mapToolResultToToolResultBlockParam(result.data, 'toolu_read')
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}

// Six fixture files: keep-recent is 5, so exactly the OLDEST read's result
// clears. Contents are long enough to beat the placeholder floor.
const fixtures = mkdtempSync(join(tmpdir(), 'dedup-delivery-fixture-'))
const files: string[] = []
for (let i = 1; i <= 6; i++) {
  const p = join(fixtures, `f${i}.txt`)
  writeFileSync(p, `file ${i} — ${'delivery truth line\n'.repeat(120)}`)
  files.push(p)
}

// The transcript as the turn machine holds it: one Read round per file —
// assistant tool_use + user tool_result — stamped OLD so the 60-minute
// time-gap trigger fires on the next plan build.
const OLD = new Date(Date.now() - 90 * 60_000).toISOString()
const messages: unknown[] = [createUserMessage({ content: 'seed prompt' })]
const contents: string[] = []
for (let i = 0; i < files.length; i++) {
  const body = await readViaTool(files[i]!)
  contents.push(body)
  const a = createAssistantMessage({
    content: [{ type: 'tool_use', id: `tu_read_${i + 1}`, name: 'Read', input: { file_path: files[i]! } }] as never,
  })
  a.message.stop_reason = 'tool_use'
  ;(a as { timestamp: string }).timestamp = OLD
  const u = createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: `tu_read_${i + 1}`, content: body }] as never,
  })
  ;(u as { timestamp: string }).timestamp = OLD
  messages.push(a, u)
}

// ── D1 ──────────────────────────────────────────────────────────────────────
section('D1 — the honest dedup: repeat of an unmodified window answers the stub')
{
  const repeat = await readViaTool(files[0]!)
  check('the first repeat answers the file-unchanged stub', repeat.startsWith(FILE_UNCHANGED_STUB), repeat.slice(0, 80))
  check('the original read served real content', contents[0]!.includes('file 1') && contents[0]!.includes('delivery truth line'))
}

// ── D2 ──────────────────────────────────────────────────────────────────────
section('D2 — the apply-mode plan clears the oldest Read result and says so')
const owner = processMainOwner()
{
  const plan = await buildRequestContextPlan(
    {
      messages: messages as never,
      owner,
      querySource: 'repl_main_thread' as never,
      contentReplacementState: undefined,
      skipToolNames: new Set<string>(),
      readFileState,
    },
    'apply',
  )
  check('exactly one result cleared (six reads, keep-recent five)', plan.reductions.timeBasedCleared === 1, String(plan.reductions.timeBasedCleared))
  const view = JSON.stringify(plan.messages)
  check('the cleared result no longer carries the content', !view.includes('file 1 — delivery truth'), 'content still rides the view')
  check('the surviving results keep theirs', view.includes('file 6') && view.includes('file 2'))
}

// ── D3 ──────────────────────────────────────────────────────────────────────
section('D3 — after the clear, the same window serves FULL CONTENT again (the lie pinned shut)')
{
  const reread = await readViaTool(files[0]!)
  check(
    'the re-read after the clear serves content, NEVER the stub',
    !reread.startsWith(FILE_UNCHANGED_STUB) && reread.includes('delivery truth line'),
    reread.slice(0, 100),
  )
}

// ── D4 ──────────────────────────────────────────────────────────────────────
section('D4 — no over-invalidation: a surviving result still dedups')
{
  const repeat6 = await readViaTool(files[5]!)
  check('the kept file still answers the stub (its result rides the view)', repeat6.startsWith(FILE_UNCHANGED_STUB), repeat6.slice(0, 80))
}

// ── D5 ──────────────────────────────────────────────────────────────────────
section('D5 — inspect mode never touches the ledger')
{
  // Re-arm: a fresh full read of file 1 (recorded), then an INSPECT plan
  // over the same aged transcript — the entry must survive.
  await readViaTool(files[0]!)
  const before = readFileState.has(files[0]!)
  await buildRequestContextPlan(
    {
      messages: messages as never,
      owner,
      querySource: 'repl_main_thread' as never,
      contentReplacementState: undefined,
      skipToolNames: new Set<string>(),
      // Inspection threads NO ledger by contract; passing it anyway must
      // still be inert because the apply-only branch owns the side effect.
      readFileState,
    },
    'inspect',
  )
  check('the entry survives an inspect build', before && readFileState.has(files[0]!))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
