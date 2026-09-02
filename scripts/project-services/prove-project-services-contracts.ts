#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-project-services-contracts.ts —
//  characterization fixtures for the integrated coding-loop contracts the
//  program will EXTEND. These freeze live BEHAVIOR (exported functions driven
//  with real fixtures — never source-string greps) so each later slice's
//  behavior change is a deliberate fixture update, not silent drift.
//
//  Frozen here:
//    A. FileEdit staleness/refusal laws (read-first · modified-since-read ·
//       content-equality fallback · not-found · multi-match) + the happy
//       write path (disk + readFileState + structuredPatch).
//    B. The agent parent-boundary shape (completed ⇒ content + agentId/usage
//       trailer; empty content ⇒ explicit marker; one-shot builtins drop the
//       trailer). restructures this boundary deliberately.
//    C. The effectObserver seam (ToolTerminalEvent field names, typed-effect
//       passthrough, subscriber-throw isolation, unsubscribe).
//       consumers (ChangeReceipts) hang off this seam.
//    D. Task substrate floors (id prefixes, terminal-status truth table).
//    E. /branch title derivation law (whitespace collapse, 100-char cap).
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-project-services-contracts.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-contracts-'))
// Hermetic: skip skill discovery side effects in FileEdit.call.
process.env.MERCURY_SIMPLE = '1'

const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const {
  observeToolTerminal,
  subscribeToolTerminal,
} = await import('../../src/services/run/effectObserver.ts')
const { generateTaskId, isTerminalTaskStatus } = await import('../../src/Task.ts')
const { deriveFirstPrompt } = await import('../../src/commands/branch/branch.ts')
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
  console.log('\n❌ TIMEOUT — vanguard contracts proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

// ── fixture context ─────────────────────────────────────────────────────────
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

// ── A. FileEdit staleness/refusal laws ──────────────────────────────────────
section('A. FileEdit staleness + refusal laws (validateInput/call)')
{
  writeFileSync(filePath, 'const alpha = 1\nconst beta = 2\nconst alpha2 = 1\n')

  // A1: edit before read → errorCode 6.
  const unread = await FileEditTool.validateInput!(
    { file_path: filePath, old_string: 'alpha', new_string: 'gamma' } as never,
    makeContext(new Map()),
  )
  check('A1 read-first law: unread file refuses with errorCode 6',
    unread.result === false && (unread as { errorCode?: number }).errorCode === 6)

  // A2: modified since read (different content, older stamp) → errorCode 7.
  const staleMap = new Map<string, ReadStamp>([[filePath, {
    content: 'something else entirely',
    timestamp: statSync(filePath).mtimeMs - 5_000,
    offset: undefined,
    limit: undefined,
  }]])
  const stale = await FileEditTool.validateInput!(
    { file_path: filePath, old_string: 'const alpha = 1', new_string: 'const gamma = 1' } as never,
    makeContext(staleMap),
  )
  check('A2 stale law: modified-since-read refuses with errorCode 7',
    stale.result === false && (stale as { errorCode?: number }).errorCode === 7)

  // A3: content-equality fallback — full read whose CONTENT matches passes
  // even with an older timestamp (the Windows mtime-flap fallback).
  const currentContent = readFileSync(filePath, 'utf8')
  const flapMap = new Map<string, ReadStamp>([[filePath, {
    content: currentContent,
    timestamp: statSync(filePath).mtimeMs - 5_000,
    offset: undefined,
    limit: undefined,
  }]])
  const flap = await FileEditTool.validateInput!(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 3' } as never,
    makeContext(flapMap),
  )
  check('A3 content-fallback law: equal-content full read passes despite older stamp',
    flap.result === true)

  // A3b: the PARTIAL-VIEW content fallback — an offset/limit
  // read whose WINDOW is byte-identical passes despite an older stamp (the
  // field case: stash round-trips restored identical bytes, yet partial
  // reads refused on mtime alone).
  // readFileInRange returns the window WITHOUT a trailing newline — the
  // fixture stores exactly what the real producer stores.
  const window = readFileSync(filePath, 'utf8').split('\n').slice(1, 3).join('\n')
  const partialMap = new Map<string, ReadStamp>([[filePath, {
    content: window,
    timestamp: statSync(filePath).mtimeMs - 5_000,
    offset: 2,
    limit: 2,
  }]])
  const partialIntact = await FileEditTool.validateInput!(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 4' } as never,
    makeContext(partialMap),
  )
  check('A3b SM-07a: byte-identical partial WINDOW passes despite older stamp',
    partialIntact.result === true, JSON.stringify(partialIntact).slice(0, 100))

  // A3c (SM-07a refusal preserved): a partial window whose content drifted
  // still refuses with errorCode 7 — never weaker than before.
  const partialDrift = new Map<string, ReadStamp>([[filePath, {
    content: 'window content that no longer matches\n',
    timestamp: statSync(filePath).mtimeMs - 5_000,
    offset: 2,
    limit: 2,
  }]])
  const partialStale = await FileEditTool.validateInput!(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 4' } as never,
    makeContext(partialDrift),
  )
  check('A3c SM-07a: drifted partial window still refuses (errorCode 7)',
    partialStale.result === false && (partialStale as { errorCode?: number }).errorCode === 7)

  // A3d: EOL drift is
  // ABSORBED by design — FileEditTool normalizes CRLF→LF on read and the
  // write path re-applies the file's current endings from metadata, so an
  // autocrlf stash round-trip (CRLF-rewritten bytes, identical content)
  // neither refuses nor mis-anchors: validation passes with LF anchors
  // against the CRLF file.
  const lfContent = readFileSync(filePath, 'utf8')
  writeFileSync(filePath, lfContent.replace(/\n/g, '\r\n'))
  const eolMap = new Map<string, ReadStamp>([[filePath, {
    content: lfContent,
    timestamp: statSync(filePath).mtimeMs - 5_000,
    offset: undefined,
    limit: undefined,
  }]])
  const eolDrift = await FileEditTool.validateInput!(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 5' } as never,
    makeContext(eolMap),
  )
  check('A3d SM-07b: EOL drift is ABSORBED (LF anchors validate against the CRLF file)',
    eolDrift.result === true, JSON.stringify(eolDrift).slice(0, 120))
  writeFileSync(filePath, lfContent) // restore for the following legs

  // A4: old_string absent → errorCode 8.
  const freshStamp = () => new Map<string, ReadStamp>([[filePath, {
    content: readFileSync(filePath, 'utf8'),
    timestamp: statSync(filePath).mtimeMs + 1,
    offset: undefined,
    limit: undefined,
  }]])
  const notFound = await FileEditTool.validateInput!(
    { file_path: filePath, old_string: 'no such string', new_string: 'x' } as never,
    makeContext(freshStamp()),
  )
  check('A4 not-found law: absent old_string refuses with errorCode 8',
    notFound.result === false && (notFound as { errorCode?: number }).errorCode === 8)

  // A5: multiple matches without replace_all → errorCode 9.
  const multi = await FileEditTool.validateInput!(
    { file_path: filePath, old_string: '= 1', new_string: '= 9' } as never,
    makeContext(freshStamp()),
  )
  check('A5 multi-match law: ambiguous match refuses with errorCode 9',
    multi.result === false && (multi as { errorCode?: number }).errorCode === 9)

  // A6: happy path — call() writes disk, refreshes readFileState, returns a
  // structuredPatch, and (slice-0 behavior) carries NO typed effect yet.
  const happyMap = freshStamp()
  const result = await (FileEditTool as { call: Function }).call(
    { file_path: filePath, old_string: 'const beta = 2', new_string: 'const beta = 42' },
    makeContext(happyMap),
    null,
    { uuid: '00000000-0000-0000-0000-000000000000' },
  )
  const onDisk = readFileSync(filePath, 'utf8')
  check('A6a write law: the edit landed on disk', onDisk.includes('const beta = 42'))
  const stamp = happyMap.get(filePath)
  check('A6b readFileState refresh law: stamp content matches the new disk bytes',
    stamp !== undefined && stamp.content === onDisk)
  check('A6c result carries structuredPatch',
    Array.isArray(result?.data?.structuredPatch) && result.data.structuredPatch.length > 0)
  // Slice-1 deliberate flip: FileEdit now emits
  // the typed mutation effect — succeeded + the exact absolute path written.
  check('A6d FileEdit result carries the typed file.edit effect (slice 1)',
    result?.effect?.outcome === 'succeeded' &&
    result.effect.operation === 'file.edit' &&
    result.effect.changedPaths.length === 1 &&
    result.effect.changedPaths[0] === filePath)
}

// ── B. Agent parent-boundary shape ──────────────────────────────────────────
section('B. Agent parent-boundary shape (mapToolResultToToolResultBlockParam)')
{
  const map = (AgentTool as { mapToolResultToToolResultBlockParam: Function })
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
  check('B1 completed carries the prose content block', texts[0] === 'final report prose')
  check('B2 trailer carries agentId + <usage> totals',
    texts[1] !== undefined &&
    texts[1].includes("agentId: agent-fixture-1") &&
    texts[1].includes('<usage>total_tokens: 1234') &&
    texts[1].includes('tool_uses: 5') &&
    texts[1].includes('duration_ms: 6789</usage>'))

  const empty = map({ ...base, content: [] }, 'toolu_fixture')
  const emptyTexts = (empty.content as { text: string }[]).map(b => b.text)
  check('B3 empty completion carries the explicit no-output marker',
    emptyTexts[0]?.includes('The subagent finished without producing any output'))

  const oneShot = map({ ...base, agentType: 'Explore' }, 'toolu_fixture')
  check('B4 one-shot builtin drops the agentId/usage trailer',
    (oneShot.content as unknown[]).length === 1)
}

// ── C. effectObserver seam ──────────────────────────────────────────────────
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
  check('C1 hostile subscriber never breaks the writer', !threw)
  check('C2 typed effect passes through verbatim',
    seen.length === 1 && (seen[0]!.effect as { operation: string })?.operation === 'edit.write')
  check('C3 event field names frozen (owner/toolName/toolUseId/input/ok/durationMs/effect/cwd)',
    ['owner', 'toolName', 'toolUseId', 'input', 'ok', 'durationMs', 'effect', 'cwd']
      .every(k => k in seen[0]!))
  unsub1()
  unsub2()
  observeToolTerminal(event as never)
  check('C4 unsubscribe detaches', seen.length === 1)
}

// ── D. Task substrate floors ────────────────────────────────────────────────
section('D. Task substrate floors')
{
  const prefixes: Record<string, string> = {
    local_bash: 'b', local_agent: 'a', remote_agent: 'r',
    in_process_teammate: 't', local_workflow: 'w', monitor_mcp: 'm', dream: 'd',
  }
  check('D1 task id prefixes stable',
    Object.entries(prefixes).every(([t, p]) => generateTaskId(t as never).startsWith(p)))
  check('D2 terminal-status truth table',
    isTerminalTaskStatus('completed') && isTerminalTaskStatus('failed') &&
    isTerminalTaskStatus('killed') && !isTerminalTaskStatus('running') &&
    !isTerminalTaskStatus('pending'))
}

// ── E. /branch title derivation ─────────────────────────────────────────────
section('E. /branch title derivation law')
{
  const multiline = deriveFirstPrompt({
    type: 'user',
    message: { content: [{ type: 'text', text: '  fix\n\nthe   thing\t\tnow  ' }] },
  } as never)
  check('E1 whitespace collapses to single spaces', multiline === 'fix the thing now')
  const long = deriveFirstPrompt({
    type: 'user',
    message: { content: 'x'.repeat(300) },
  } as never)
  check('E2 title caps at 100 chars', long.length === 100)
  check('E3 absent content falls back', deriveFirstPrompt(undefined) === 'Branched conversation')
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ vanguard contracts: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ vanguard contracts: all frozen laws hold')
