#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-contracts-'))
process.env.MERCURY_BARE = '1'

const { EditTool } = await import('../../src/tools/edit/EditTool.ts')
const { CrewmateTool } = await import('../../src/tools/crewmate/CrewmateTool.tsx')
const {
  observeToolTerminal,
  subscribeToolTerminal,
} = await import('../../src/engine/run-owner/effectObserver.ts')
const { generateTaskId, isTerminalTaskStatus } = await import('../../src/engine/tasks/taskBase.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — vanguard contracts proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

type ReadStamp = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean
}
function makeContext(readFileState: Map<string, ReadStamp>) {
  return {
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as never
}

const fixtureDir = mkdtempSync(join(tmpdir(), 'vanguard-fixture-'))
const filePath = join(fixtureDir, 'target.ts')

section('A. FileEdit staleness + refusal laws (validateInput/call)')
{
  writeFileSync(filePath, 'const alpha = 1\nconst beta = 2\nconst alpha2 = 1\n')

  const unread = await EditTool.validateInput!(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 3' } as never,
    makeContext(new Map()),
  )
  check('A1 read-first law: unread file refuses with errorCode 6',
    unread.result === false && (unread as { errorCode?: number }).errorCode === 6,
    `got ${JSON.stringify(unread).slice(0, 160)} · the read-first refusal (errorCode 6) lives in src/tools/edit/call/validate.ts`)
  const carried = await EditTool.validateInput!(
    { file_path: filePath, old_string: 'const alpha = 1', new_string: 'const gamma = 1' } as never,
    makeContext(new Map()),
  )
  check('A1b a refusal carries no line and records nothing: the next edit of the unread file refuses the same way (errorCode 6)',
    carried.result === false && (carried as { errorCode?: number }).errorCode === 6 && !/\n\d+\t/.test(String((carried as { message?: string }).message ?? '')),
    `got ${JSON.stringify(carried).slice(0, 160)} · the errorCode 6 refusal in src/tools/edit/call/validate.ts must stay the same and carry no numbered file line`)

  const stalePath = join(fixtureDir, 'stale.ts')
  writeFileSync(stalePath, readFileSync(filePath, 'utf8'))
  const staleMap = new Map<string, ReadStamp>([[stalePath, {
    content: 'something else entirely',
    timestamp: statSync(stalePath).mtimeMs - 5_000,
    offset: undefined,
    limit: undefined,
  }]])
  const stale = await EditTool.validateInput!(
    { file_path: stalePath, old_string: 'const alpha = 1', new_string: 'const gamma = 1' } as never,
    makeContext(staleMap),
  )
  check('A2 stale law: modified-since-read refuses with errorCode 7',
    stale.result === false && (stale as { errorCode?: number }).errorCode === 7,
    `got ${JSON.stringify(stale).slice(0, 160)} · the modified-since-read refusal (errorCode 7) lives in src/tools/edit/call/validate.ts`)

  const currentContent = readFileSync(filePath, 'utf8')
  const flapMap = new Map<string, ReadStamp>([[filePath, {
    content: currentContent,
    timestamp: statSync(filePath).mtimeMs - 5_000,
    offset: undefined,
    limit: undefined,
  }]])
  const flap = await EditTool.validateInput!(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 3' } as never,
    makeContext(flapMap),
  )
  check('A3 content-fallback law: equal-content full read passes despite older stamp',
    flap.result === true,
    `got ${JSON.stringify(flap).slice(0, 160)} · the staleness check in src/tools/edit/call/validate.ts must accept a read whose content equals the file despite an older stamp`)

  const window = readFileSync(filePath, 'utf8').split('\n').slice(1, 3).join('\n')
  const partialMap = new Map<string, ReadStamp>([[filePath, {
    content: window,
    timestamp: statSync(filePath).mtimeMs - 5_000,
    offset: 2,
    limit: 2,
  }]])
  const partialIntact = await EditTool.validateInput!(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 4' } as never,
    makeContext(partialMap),
  )
  check('A3b SM-07a: byte-identical partial WINDOW passes despite older stamp',
    partialIntact.result === true, JSON.stringify(partialIntact).slice(0, 100))

  const partialPath = join(fixtureDir, 'partial-stale.ts')
  writeFileSync(partialPath, readFileSync(filePath, 'utf8'))
  const partialDrift = new Map<string, ReadStamp>([[partialPath, {
    content: 'window content that no longer matches\n',
    timestamp: statSync(partialPath).mtimeMs - 5_000,
    offset: 2,
    limit: 2,
  }]])
  const partialStale = await EditTool.validateInput!(
    { file_path: partialPath, old_string: 'const beta = 2', new_string: 'const beta = 4' } as never,
    makeContext(partialDrift),
  )
  check('A3c SM-07a: drifted partial window still refuses (errorCode 7)',
    partialStale.result === false && (partialStale as { errorCode?: number }).errorCode === 7,
    `got ${JSON.stringify(partialStale).slice(0, 160)} · the staleness check in src/tools/edit/call/validate.ts must compare a partial window with the file and refuse a drifted one with errorCode 7`)

  const lfContent = readFileSync(filePath, 'utf8')
  writeFileSync(filePath, lfContent.replace(/\n/g, '\r\n'))
  const eolMap = new Map<string, ReadStamp>([[filePath, {
    content: lfContent,
    timestamp: statSync(filePath).mtimeMs - 5_000,
    offset: undefined,
    limit: undefined,
  }]])
  const eolDrift = await EditTool.validateInput!(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 5' } as never,
    makeContext(eolMap),
  )
  check('A3d SM-07b: EOL drift is ABSORBED (LF anchors validate against the CRLF file)',
    eolDrift.result === true, `${JSON.stringify(eolDrift).slice(0, 120)} · the staleness check in src/tools/edit/call/validate.ts must compare content with line endings normalised`)
  writeFileSync(filePath, lfContent)

  const freshStamp = () => new Map<string, ReadStamp>([[filePath, {
    content: readFileSync(filePath, 'utf8'),
    timestamp: statSync(filePath).mtimeMs + 1,
    offset: undefined,
    limit: undefined,
  }]])
  const notFound = await EditTool.validateInput!(
    { file_path: filePath, old_string: 'no such string', new_string: 'x' } as never,
    makeContext(freshStamp()),
  )
  check('A4 not-found law: absent old_string refuses with errorCode 8',
    notFound.result === false && (notFound as { errorCode?: number }).errorCode === 8,
    `got ${JSON.stringify(notFound).slice(0, 160)} · the not-found refusal (errorCode 8) lives in src/tools/edit/call/validate.ts`)

  const multi = await EditTool.validateInput!(
    { file_path: filePath, old_string: '= 1', new_string: '= 9' } as never,
    makeContext(freshStamp()),
  )
  check('A5 multi-match law: ambiguous match refuses with errorCode 9',
    multi.result === false && (multi as { errorCode?: number }).errorCode === 9,
    `got ${JSON.stringify(multi).slice(0, 160)} · the ambiguous-match refusal (errorCode 9) lives in src/tools/edit/call/exactMatch.ts`)

  const happyMap = freshStamp()
  const result = await (EditTool as { call: Function }).call(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 42' },
    makeContext(happyMap),
    null,
    { uuid: '00000000-0000-0000-0000-000000000000' },
  )
  const onDisk = readFileSync(filePath, 'utf8')
  check('A6a write law: the edit landed on disk', onDisk.includes('const beta = 42'), 'FileEditTool.call in src/tools/edit/EditTool.ts did not write the new_string to the file')
  const stamp = happyMap.get(filePath)
  check('A6b readFileState refresh law: stamp content matches the new disk bytes',
    stamp !== undefined && stamp.content === onDisk,
    'FileEditTool.call in src/tools/edit/EditTool.ts must store the written bytes in readFileState after the write')
  check('A6c result carries structuredPatch',
    Array.isArray(result?.data?.structuredPatch) && result.data.structuredPatch.length > 0,
    'the data returned by FileEditTool.call in src/tools/edit/EditTool.ts must carry a non-empty structuredPatch')
  check('A6d FileEdit result carries the typed file.edit effect (slice 1)',
    result?.effect?.outcome === 'succeeded' &&
    result.effect.operation === 'file.edit' &&
    result.effect.changedPaths.length === 1 &&
    result.effect.changedPaths[0] === filePath,
    `effect=${JSON.stringify(result?.effect)?.slice(0, 200)} · FileEditTool.call in src/tools/edit/EditTool.ts must return a succeeded file.edit effect with the edited path`)
}

section('B. Agent parent-boundary shape (mapToolResultToToolResultBlockParam)')
{
  const map = (CrewmateTool as { mapToolResultToToolResultBlockParam: Function })
    .mapToolResultToToolResultBlockParam
  const base = {
    status: 'completed',
    agentId: 'agent-fixture-1',
    agentType: 'custom-role',
    content: [{ type: 'text', text: 'final report prose' }],
    totalTokens: 1234,
    totalToolUseCount: 5,
    totalDurationMs: 6789,
  }
  const block = map(base, 'toolu_fixture')
  const texts = (block.content as { type: string; text: string }[]).map(b => b.text)
  check('B1 completed carries the prose content block', texts[0] === 'final report prose',
    `texts=${JSON.stringify(texts).slice(0, 200)} · the completed result block built in src/tools/crewmate/call/resultBlock.ts must put the prose first`)
  check('B2 trailer carries agentId + <usage> totals',
    texts[1] !== undefined &&
    texts[1].includes("agentId: agent-fixture-1") &&
    texts[1].includes('<usage>total_tokens: 1234') &&
    texts[1].includes('tool_uses: 5') &&
    texts[1].includes('duration_ms: 6789</usage>'),
    `trailer=${JSON.stringify(texts[1])?.slice(0, 200)} · the trailer built in src/tools/crewmate/call/resultBlock.ts must carry agentId and the usage totals`)

  const empty = map({ ...base, content: [] }, 'toolu_fixture')
  const emptyTexts = (empty.content as { text: string }[]).map(b => b.text)
  check('B3 empty completion carries the explicit no-output marker',
    emptyTexts[0]?.includes('The crewmate finished without producing any output'),
    `got ${JSON.stringify(emptyTexts[0])?.slice(0, 160)} · the empty-content text in src/tools/crewmate/call/resultBlock.ts must name that the crewmate produced no output`)

  const oneShot = map({ ...base, agentType: 'mercury-scout' }, 'toolu_fixture')
  check('B4 one-shot builtin drops the agentId/usage trailer',
    (oneShot.content as unknown[]).length === 1,
    `blocks=${(oneShot.content as unknown[]).length} · src/tools/crewmate/call/resultBlock.ts must skip the trailer for a type in ONE_SHOT_BUILTIN_AGENT_TYPES (src/tools/kit/names/crewmate.ts)`)
}

section('C. effectObserver seam (the slice-1 attachment point)')
{
  const seen: Record<string, unknown>[] = []
  const unsub1 = subscribeToolTerminal(e => seen.push(e as never))
  const unsub2 = subscribeToolTerminal(() => {
    throw new Error('hostile subscriber')
  })
  const event = {
    owner: { workspace: fixtureDir, sessionId: 's', lane: 'main', querySource: 'user' } as never,
    toolName: 'Edit',
    toolUseId: 'toolu_seam',
    input: { file_path: filePath },
    ok: true,
    durationMs: 12,
    effect: {
      outcome: 'succeeded' as const,
      operation: 'edit.write',
      changedPaths: [filePath],
      evidence: 'fixture',
      startedAt: 1,
      completedAt: 2,
    },
    cwd: fixtureDir,
  }
  let threw = false
  try {
    observeToolTerminal(event as never)
  } catch {
    threw = true
  }
  check('C1 hostile subscriber never breaks the writer', !threw, 'observeToolTerminal in src/engine/run-owner/effectObserver.ts must catch a throwing subscriber')
  check('C2 typed effect passes through verbatim',
    seen.length === 1 && (seen[0]!.effect as { operation: string })?.operation === 'edit.write',
    `seen=${seen.length} · observeToolTerminal in src/engine/run-owner/effectObserver.ts must pass the event, effect included, to every subscriber unchanged`)
  check('C3 event field names frozen (owner/toolName/toolUseId/input/ok/durationMs/effect/cwd)',
    ['owner', 'toolName', 'toolUseId', 'input', 'ok', 'durationMs', 'effect', 'cwd']
      .every(k => k in seen[0]!),
    `keys=${Object.keys(seen[0] ?? {}).join(',')} · ToolTerminalEvent in src/engine/run-owner/effectObserver.ts must keep these field names`)
  unsub1()
  unsub2()
  observeToolTerminal(event as never)
  check('C4 unsubscribe detaches', seen.length === 1, `seen=${seen.length} · the function subscribeToolTerminal returns in src/engine/run-owner/effectObserver.ts must remove the subscriber`)
}

section('D. Task substrate floors')
{
  const prefixes: Record<string, string> = {
    local_bash: 'b', local_agent: 'a', remote_agent: 'r',
    monitor_mcp: 'm',
  }
  check('D1 task id prefixes stable',
    Object.entries(prefixes).every(([t, p]) => generateTaskId(t as never).startsWith(p)),
    'generateTaskId in src/engine/tasks/taskBase.ts returned an id with a prefix other than the one frozen here')
  check('D2 terminal-status truth table',
    isTerminalTaskStatus('completed') && isTerminalTaskStatus('failed') &&
    isTerminalTaskStatus('killed') && !isTerminalTaskStatus('running') &&
    !isTerminalTaskStatus('pending'),
    'isTerminalTaskStatus in src/engine/tasks/taskBase.ts must be true for completed, failed and killed only')
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ vanguard contracts: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ vanguard contracts: all frozen laws hold')
