#!/usr/bin/env bun
// prove-ingestion-truths — the three ingestion/envelope truths from
// the second-machine harness verification (source 6).
//
//   §1 N-04 — NATIVE tool-result images ride the SAME 2000px clamp the MCP
//      converter and every user-side path already apply (one boundary at
//      tool settlement; a Browser fullPage capture beyond the API's 8000px
//      single-image cap 400'd the whole turn — H-14's mechanism).
//   §2 N-04 — the SINGLE-image dimension 400 ("…max allowed size…") gains
//      its missing matcher: isMediaSizeError fires, the errorDetails branch
//      exists, and the two existing phrasings keep matching.
//   §3 N-05 — the workflow terminal status derives from per-agent failures:
//      the 0/7-agents run is FAILED, partial failures are
//      completed_with_failures, clean runs stay completed.
//   §4 H-19 — ONE scope predicate across the three tools: ChangeSet and the
//      LSP ops delegate to Write/Edit's pathInAllowedWorkingPath (the
//      hand-rolled '/'-joined prefix compare refused primary-cwd files on
//      Windows while Write/Edit accepted them).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

// ── §1 the native tool-result clamp ─────────────────────────────────────────
section('§1 N-04 · NATIVE TOOL-RESULT IMAGES CLAMPED AT THE ONE BOUNDARY')
{
  const { clampToolResultImageBlocks } = await import('../../src/utils/imageResizer.ts')
  const sharp = (await import('sharp')).default

  // A synthetic capture past the 2000px clamp (the fullPage shape).
  const oversized = await sharp({
    create: { width: 2600, height: 3200, channels: 3, background: { r: 200, g: 60, b: 60 } },
  })
    .png()
    .toBuffer()
  const small = await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 60, g: 60, b: 200 } },
  })
    .png()
    .toBuffer()

  const block = {
    tool_use_id: 't1',
    type: 'tool_result',
    content: [
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: oversized.toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: small.toString('base64') } },
    ],
  }
  await clampToolResultImageBlocks(block)
  const clamped = block.content[1] as { source: { data: string } }
  const meta = await sharp(Buffer.from(clamped.source.data, 'base64')).metadata()
  check(
    'an oversized native capture clamps to ≤2000px on both sides',
    (meta.width ?? 9999) <= 2000 && (meta.height ?? 9999) <= 2000,
    `${meta.width}×${meta.height}`,
  )
  const untouchedSmall = block.content[2] as { source: { data: string } }
  check('an under-limit image passes through byte-identical', untouchedSmall.source.data === small.toString('base64'))
  check('text blocks pass through untouched', (block.content[0] as { text: string }).text === 'screenshot captured')

  const stringContent = { tool_use_id: 't2', type: 'tool_result', content: 'plain text result' }
  await clampToolResultImageBlocks(stringContent)
  check('string-content results are untouched', stringContent.content === 'plain text result')

  // Valid base64, not an image — the payload must survive BYTE-IDENTICAL
  // whether the resizer throws (our catch keeps the block) or fail-opens
  // internally (returns the original buffer re-encoded).
  const corruptPayload = Buffer.from('this is definitely not an image').toString('base64')
  const corrupt = {
    tool_use_id: 't3',
    type: 'tool_result',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: corruptPayload } }],
  }
  await clampToolResultImageBlocks(corrupt)
  check(
    'a corrupt image FAILS OPEN (payload byte-identical, nothing throws)',
    (corrupt.content[0] as { source: { data: string } }).source.data === corruptPayload,
  )

  const wire = src('src/services/tools/toolExecution.ts')
  // Pin over toolExecution.ts: the
  // mapped block is `mappedBlock`; the law is the ORDER — mapped first, clamped
  // right after, before any use.
  check(
    'the clamp rides the ONE tool-settlement boundary (after the map, before use)',
    /mapToolResultToToolResultBlockParam\([\s\S]{0,400}?clampToolResultImageBlocks\(mappedBlock/.test(wire),
  )
}

// ── §2 the missing 400 matcher ──────────────────────────────────────────────
section('§2 N-04 · THE SINGLE-IMAGE DIMENSION 400 MATCHER')
{
  const { isMediaSizeError } = await import('../../src/services/api/errors.ts')
  check(
    'the field phrasing now matches (single-image "max allowed size")',
    isMediaSizeError(
      'messages.5.content.237.image.source.base64.data: image dimensions exceed max allowed size: 8412 pixels > 8000 pixels',
    ),
  )
  check(
    'the byte-size phrasing still matches',
    isMediaSizeError('image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes'),
  )
  check(
    'the many-image phrasing still matches',
    isMediaSizeError('image dimensions exceed the limit for many-image requests'),
  )
  check('unrelated 400s still do NOT match', !isMediaSizeError('invalid_request: model not found'))
  const errorsTs = src('src/services/api/errors.ts')
  check(
    'the errorDetails branch exists for the new phrasing (recovery loop closed)',
    errorsTs.includes("error.message.includes('max allowed size')") &&
      errorsTs.includes('8000px on any side'),
  )
}

// ── §3 the workflow terminal-status truth ───────────────────────────────────
section('§3 N-05 · TERMINAL STATUS DERIVES FROM AGENT FAILURES')
{
  const { deriveWorkflowTerminalStatus } = await import('../../src/tools/WorkflowTool/executor.ts')
  const zeroOfSeven = deriveWorkflowTerminalStatus({ error: undefined, failures: Array(7).fill('agent died'), agentCount: 7 })
  check(
    'the 0/7-agents fixture settles FAILED with a derived error',
    zeroOfSeven.status === 'failed' && (zeroOfSeven.derivedError ?? '').includes('all 7 agent(s) failed'),
  )
  const partial = deriveWorkflowTerminalStatus({ error: undefined, failures: ['one died'], agentCount: 7 })
  check('partial failures settle completed_with_failures', partial.status === 'completed_with_failures')
  check(
    'a clean run stays completed',
    deriveWorkflowTerminalStatus({ error: undefined, failures: [], agentCount: 7 }).status === 'completed',
  )
  check(
    'a script error stays failed (unchanged)',
    deriveWorkflowTerminalStatus({ error: 'boom', failures: [], agentCount: 3 }).status === 'failed',
  )
  check(
    'a zero-agent run with no failures stays completed',
    deriveWorkflowTerminalStatus({ error: undefined, failures: [], agentCount: 0 }).status === 'completed',
  )

  check(
    'the manifest union carries completed_with_failures',
    src('src/tools/WorkflowTool/runManifest.ts').includes("'completed_with_failures'"),
  )
  const settle = src('src/tools/WorkflowTool/WorkflowTool.tsx')
  check(
    'the settle path derives, writes, and notifies the SAME status',
    settle.includes('deriveWorkflowTerminalStatus({') && settle.includes('status: terminal.status'),
  )
  const notif = src('src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx')
  check(
    'the notification names partial completion honestly (result + failures + recovery)',
    notif.includes('completed WITH') &&
      notif.includes("status === 'killed' || status === 'completed_with_failures'"),
  )
  check(
    'the board renders partial, never plain done',
    src('src/components/tasks/WorkflowDetailDialog.tsx').includes("word: 'partial'"),
  )
}

// ── §4 one scope predicate ──────────────────────────────────────────────────
section('§4 H-19 · ONE WRITE-SCOPE PREDICATE ACROSS THE THREE TOOLS')
{
  const changeSet = src('src/tools/ChangeSetTool/ChangeSetTool.ts')
  const lspOps = src('src/tools/LSPTool/mercuryOps.ts')
  check(
    'ChangeSet delegates to pathInAllowedWorkingPath',
    changeSet.includes('return pathInAllowedWorkingPath(abs, permCtx)'),
  )
  check(
    'the LSP ops delegate to pathInAllowedWorkingPath',
    // S47 respelled the delegation (a guard clause, same law): the ops
    // consult the ONE filesystem scope predicate before acting.
    /!pathInAllowedWorkingPath\((abs|endpoint), permissionContext\)/.test(lspOps),
  )
  check(
    "no hand-rolled '/'-joined prefix compare survives in either tool",
    !changeSet.includes("resolved + '/'") && !lspOps.includes('resolved + path.sep'),
  )

  // Behavioral identity: a file under the ORIGINAL cwd passes the shared
  // predicate — the same answer Write/Edit compute.
  const { pathInAllowedWorkingPath } = await import('../../src/utils/permissions/filesystem.ts')
  const { getOriginalCwd } = await import('../../src/bootstrap/state.ts')
  const ctx = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as unknown as Parameters<typeof pathInAllowedWorkingPath>[1]
  check(
    'a primary-cwd file is IN scope by the shared predicate',
    pathInAllowedWorkingPath(join(getOriginalCwd(), 'src', 'Tool.ts'), ctx),
  )
  check(
    'an outside path stays OUT of scope',
    !pathInAllowedWorkingPath('/definitely/not/in/scope/file.ts', ctx),
  )
}

if (failures > 0) {
  console.error(`\nprove-ingestion-truths: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ingestion-truths: all green')
