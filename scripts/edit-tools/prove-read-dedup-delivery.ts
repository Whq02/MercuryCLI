#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'dedup-delivery-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_TIME_BASED_MC = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([])
process.env.ANTHROPIC_BASE_URL = api.url

const { FileReadTool } = await import('../../src/tools/read/ReadTool.ts')
const { FILE_UNCHANGED_STUB } = await import('../../src/tools/kit/names/fileRead.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { buildRequestContextPlan } = await import('../../src/engine/run/requestContextPlan.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
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
  console.log('\nTIMEOUT — dedup delivery prover exceeded 90s; a Read or buildRequestContextPlan call did not return, see src/tools/read/call/call.ts and src/engine/run/requestContextPlan.ts')
  process.exit(1)
}, 90_000)
guard.unref?.()

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

async function readViaTool(path: string, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await (FileReadTool as { call: Function }).call(
    { file_path: path, ...extra },
    context,
    null,
    { uuid: '00000000-0000-0000-0000-000000000001', message: { id: 'msg_fixture' } },
  )
  const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function })
    .mapToolResultToToolResultBlockParam(result.data, 'toolu_read')
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}

const fixtures = mkdtempSync(join(tmpdir(), 'dedup-delivery-fixture-'))
const files: string[] = []
for (let i = 1; i <= 11; i++) {
  const p = join(fixtures, `f${i}.txt`)
  writeFileSync(p, `file ${i} — ${`${'delivery truth line '.repeat(5)}\n`.repeat(850)}`)
  files.push(p)
}

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

section('D1 — the honest dedup: repeat of an unmodified window answers the stub')
{
  const repeat = await readViaTool(files[0]!)
  check('the first repeat answers the file-unchanged stub', repeat.startsWith(FILE_UNCHANGED_STUB), repeat.slice(0, 80) + ' — a repeat read of an unmodified window must answer the stub; see the file_unchanged branch in src/tools/read/call/call.ts')
  check('the original read served real content', contents[0]!.includes('file 1') && contents[0]!.includes('delivery truth line'), 'the first Read must return the file content; see src/tools/read/call/call.ts')
}

section('D2 — the apply-mode plan clears the oldest Read result and says so')
const owner = processMainOwner()
{
  const plan = await buildRequestContextPlan(
    {
      messages: messages as never,
      owner,
      querySource: 'main_thread' as never,
      contentReplacementState: undefined,
      skipToolNames: new Set<string>(),
      readFileState,
    },
    'apply',
  )
  check('exactly one result cleared (eleven reads, keep-recent ten)', plan.reductions.timeBasedCleared === 1, String(plan.reductions.timeBasedCleared) + ' — eleven old Read results with keep-recent ten must clear exactly one; see projectTimeBasedMicrocompact as used in buildRequestContextPlan (src/engine/run/requestContextPlan.ts)')
  const view = JSON.stringify(plan.messages)
  check('the cleared result no longer carries the content', !view.includes('file 1 — delivery truth'), 'content still rides the view — the apply-mode plan must clear the oldest Read result; see buildRequestContextPlan in src/engine/run/requestContextPlan.ts')
  check('the surviving results keep theirs', view.includes('file 11') && view.includes('file 2'), 'the clear must leave the recent Read results intact; see buildRequestContextPlan in src/engine/run/requestContextPlan.ts')
}

section('D3 — after the clear, the same window serves FULL CONTENT again (the lie pinned shut)')
{
  const reread = await readViaTool(files[0]!)
  check(
    'the re-read after the clear serves content, NEVER the stub',
    !reread.startsWith(FILE_UNCHANGED_STUB) && reread.includes('delivery truth line'),
    reread.slice(0, 100) + ' — once a Read result is cleared from the view, the dedup must stop answering the stub for it; see buildRequestContextPlan in src/engine/run/requestContextPlan.ts and the file_unchanged branch in src/tools/read/call/call.ts',
  )
}

section('D4 — no over-invalidation: a surviving result still dedups')
{
  const repeat6 = await readViaTool(files[5]!)
  check('the kept file still answers the stub (its result rides the view)', repeat6.startsWith(FILE_UNCHANGED_STUB), repeat6.slice(0, 80) + ' — a Read result still in the view must keep deduping; the clear must not invalidate it (buildRequestContextPlan in src/engine/run/requestContextPlan.ts)')
}

section('D5 — inspect mode never touches the ledger')
{
  await readViaTool(files[0]!)
  const before = readFileState.has(files[0]!)
  await buildRequestContextPlan(
    {
      messages: messages as never,
      owner,
      querySource: 'main_thread' as never,
      contentReplacementState: undefined,
      skipToolNames: new Set<string>(),
      readFileState,
    },
    'inspect',
  )
  check('the entry survives an inspect build', before && readFileState.has(files[0]!), 'an inspect-mode plan must not delete from readFileState; only apply may (buildRequestContextPlan in src/engine/run/requestContextPlan.ts)')
}

process.env.MERCURY_TIME_BASED_MC = '0'
const { createRewindRecordMessage } = await import('../../src/engine/compaction/checkpointRewind.ts')
const { createContentReplacementState } = await import('../../src/engine/tool-dispatch/toolResultStorage.ts')
const { wholeFileSeen, checkSeenLines, fileGeneration } = await import('../../src/tools/engines/change-transaction/seenLines.ts')
const { FileEditTool } = await import('../../src/tools/edit/EditTool.ts')
const { FileWriteTool } = await import('../../src/tools/write/WriteTool.ts')
const rounds = (id: string, path: string, body: string, extra: Record<string, unknown> = {}) => [
  createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path, ...extra } }] as never }),
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: body }] as never }),
]
for (const mode of ['rewind', 'budget']) {
  section(`${mode}: lost Read bodies lose their read evidence`)
  const file = join(fixtures, `${mode}.txt`)
  const survivor = join(fixtures, `${mode}-survivor.txt`)
  const body = Array.from({ length: 500 }, (_, i) => `${i + 1}: ${'body '.repeat(20)}`).join('\n') + '\n'
  writeFileSync(file, body)
  writeFileSync(survivor, 'kept content\n')
  const kept = rounds(`${mode}-kept`, survivor, await readViaTool(survivor))
  const before = rounds(`${mode}-before`, file, await readViaTool(file, { offset: 1, limit: 1 }), { offset: 1, limit: 1 })
  const checkpoint = [
    createAssistantMessage({ content: [{ type: 'tool_use', id: 'cp-reads', name: 'Checkpoint', input: { goal: 'read files' } }] as never }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'cp-reads', content: 'Checkpoint taken' }] as never }),
  ]
  const abandoned = join(fixtures, `${mode}-abandoned.txt`)
  writeFileSync(abandoned, body)
  const fullRead = rounds(`${mode}-lost`, file, await readViaTool(file))
  const lostRead = rounds(`${mode}-abandoned`, abandoned, await readViaTool(abandoned))
  const history = [...kept, ...before, ...(mode === 'rewind' ? checkpoint : []), ...fullRead, ...lostRead,
    ...(mode === 'rewind' ? [createRewindRecordMessage({ checkpointId: 'cp-reads', goal: 'read files', report: 'finished', abandonedMessageCount: 2, rootFallback: false })] : []),
  ]
  const state = mode === 'budget' ? { ...createContentReplacementState(), budgetChars: 5000 } : undefined
  const input = { messages: history, owner, querySource: 'main_thread' as never, contentReplacementState: state, skipToolNames: new Set<string>(), readFileState }
  await buildRequestContextPlan(input, 'inspect')
  check(`${mode}: inspect keeps the read cache and full line coverage`, readFileState.has(file) && wholeFileSeen(owner, file, body), 'inspect mode must not touch the read cache or seen lines; see buildRequestContextPlan in src/engine/run/requestContextPlan.ts')
  await buildRequestContextPlan(input, 'apply')
  check(`${mode}: apply invalidates the full-read cache`, !readFileState.has(file), 'apply must drop readFileState entries whose Read body was removed; see invalidateRemovedReads in src/engine/run/requestContextPlan.ts')
  check(`${mode}: the surviving partial Read cannot preserve the removed full Read`, !wholeFileSeen(owner, file, body), 'seen-line evidence must go with the removed full Read; see invalidateRemovedReads in src/engine/run/requestContextPlan.ts and src/tools/engines/change-transaction/seenLines.ts')
  const seen = (line: number) => checkSeenLines(owner, file, fileGeneration(file)!, [{ index: 0, start: line, end: line, replace: '' }]).ok
  check(`${mode}: rebuild keeps the displayed line, not the hidden middle`, seen(1) && !seen(250), 'only the lines still displayed may stay seen; see invalidateRemovedReads in src/engine/run/requestContextPlan.ts and checkSeenLines in src/tools/engines/change-transaction/seenLines.ts')
  check(`${mode}: an unrelated surviving Read still dedups`, (await readViaTool(survivor)).startsWith(FILE_UNCHANGED_STUB), 'invalidation must be limited to Reads whose body was removed; see invalidateRemovedReads in src/engine/run/requestContextPlan.ts')
  const edit = await FileEditTool.validateInput({ file_path: abandoned, old_string: body.split('\n')[249]!, new_string: 'changed' }, context)
  check(`${mode}: Edit cannot use a wholly discarded read`, edit.result === false, JSON.stringify(edit) + ' — Edit must refuse when the read was discarded from the view; see invalidateRemovedReads in src/engine/run/requestContextPlan.ts and FileEditTool validateInput (src/tools/edit/EditTool.ts)')
  let refused = false
  try { await FileWriteTool.call({ file_path: file, content: 'changed\n' }, context, null as never, { uuid: '00000000-0000-0000-0000-000000000002' } as never) } catch { refused = true }
  check(`${mode}: Write cannot use the discarded read`, refused, 'Write must throw when the read was discarded from the view; see invalidateRemovedReads in src/engine/run/requestContextPlan.ts and src/tools/write/WriteTool.ts')
  const reread = await readViaTool(file)
  check(`${mode}: the next Read returns its content, never the unchanged stub`, !reread.startsWith(FILE_UNCHANGED_STUB) && reread.includes('250: body'), 'after the removal a Read must return content, not the stub; see invalidateRemovedReads in src/engine/run/requestContextPlan.ts')
  const freshState = mode === 'budget' ? { ...createContentReplacementState(), budgetChars: Infinity, replacements: new Map(state!.replacements), seenIds: new Set(state!.seenIds) } : undefined
  await buildRequestContextPlan({ ...input, contentReplacementState: freshState, messages: [...history, ...rounds(`${mode}-fresh`, file, reread)] }, 'apply')
  check(`${mode}: a later surviving full Read is not invalidated by the old removal`, readFileState.has(file) && wholeFileSeen(owner, file, body) && (await readViaTool(file)).startsWith(FILE_UNCHANGED_STUB), 'invalidation must apply only to the removed Read, not a later full Read; see invalidateRemovedReads in src/engine/run/requestContextPlan.ts')
}

await api.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
