#!/usr/bin/env bun
// ============================================================================
//  prove-parity-tier1-degrade — the tool-boundary and renderer degrade
//  mechanisms from frontier-sweep #1, tier 1 (crash classes):
//
//   1. safeUserFacingName is TOTAL over malformed wire/persisted input: a
//      namer that throws (the real Bash namer on a non-string command —
//      exactly what a malformed persisted tool_use replays on resume)
//      degrades to the fallback name; the empty-string chrome opt-out
//      passes through untouched.
//   2. The orphaned-permission replay path validates persisted input before
//      the tool body: a malformed input settles the dangling tool_use as an
//      error tool_result — the tool's call generator never runs.
//   3. The design-system ProgressBar renders (empty) at negative and
//      non-finite widths instead of throwing RangeError — the narrow
//      terminal geometry floor.
//   4. git push-output scanning stays bounded on pathological shapes: a
//      single huge whitespace-free dotted token completes promptly (the
//      unbounded overlap made this quadratic in the whole output cap), and
//      a real ref-update line still reads as a push.
// ============================================================================

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. safeUserFacingName totality ——————————————————————————————————
const { safeUserFacingName } = await import('../../src/Tool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')

let threw = false
let named = ''
try {
  named = safeUserFacingName(BashTool as never, { command: 42 }, 'Bash')
} catch {
  threw = true
}
t('real Bash namer on a non-string command degrades, never throws', !threw)
t('degraded name is the fallback', named === 'Bash', `got ${JSON.stringify(named)}`)
t(
  'empty-string chrome opt-out passes through',
  safeUserFacingName({ name: 'x', userFacingName: () => '' }, {}) === '',
)
t(
  'absent namer falls back to the tool name',
  safeUserFacingName({ name: 'x' }, {}) === 'x',
)

// —— 2. orphan-replay input validation ———————————————————————————————
const { setSessionPersistenceDisabled } = await import('../../src/bootstrap/state.ts')
setSessionPersistenceDisabled(true)
const { handleOrphanedPermission } = await import('../../src/utils/queryHelpers.ts')
const { z } = await import('zod')

let toolBodyRan = false
const fakeTool = {
  name: 'ParityProbe',
  inputSchema: z.object({ target: z.string() }),
  async *call(): AsyncGenerator<unknown> {
    toolBodyRan = true
  },
}
const assistantMessage = {
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-00000000fee1',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_parity_1',
        name: 'ParityProbe',
        // The malformed persisted input: target must be a string.
        input: { target: 42 },
      },
    ],
  },
}
const projections: unknown[] = []
const mutableMessages: unknown[] = []
for await (const projection of handleOrphanedPermission(
  {
    permissionResult: { behavior: 'allow', toolUseID: 'toolu_parity_1' },
    assistantMessage,
  } as never,
  [fakeTool] as never,
  mutableMessages as never,
  {} as never,
)) {
  projections.push(projection)
}
t('malformed replay input never reaches the tool body', !toolBodyRan)
const settled = mutableMessages.find(message => {
  const m = message as { type?: string; message?: { content?: unknown } }
  if (m.type !== 'user' || !Array.isArray(m.message?.content)) return false
  return (m.message.content as Array<Record<string, unknown>>).some(
    block =>
      block.type === 'tool_result' &&
      block.tool_use_id === 'toolu_parity_1' &&
      block.is_error === true,
  )
})
t('the dangling tool_use settles as an error tool_result', settled !== undefined)

// —— 3. ProgressBar narrow-geometry floor ————————————————————————————
const { ProgressBar } = await import('../../src/components/design-system/ProgressBar.tsx')
for (const width of [-3, -1, 0, Number.NaN]) {
  let barThrew = false
  try {
    ProgressBar({ ratio: 0.5, width })
  } catch {
    barThrew = true
  }
  t(`ProgressBar renders at width ${width} without throwing`, !barThrew)
}

// —— 4. bounded git push-output scanning ————————————————————————————
const { detectGitOperation } = await import('../../src/tools/shared/gitOperationTracking.ts')
// The class shape: one whitespace-free token studded with double-dot sites,
// at the shell output cap. Unbounded, both greedy runs explore every site —
// measured quadratic (148ms at 24K chars, seconds at this size).
const pathological = 'a..'.repeat(50_000)
const startedAt = performance.now()
detectGitOperation('git push origin main', pathological)
const elapsedMs = performance.now() - startedAt
// Mechanism bound, not a vintage number: the unbounded overlap took tens of
// seconds on this exact input; bounded, it is single-digit milliseconds.
// 2000ms holds a three-orders-of-magnitude margin on loaded runners.
t('pathological push output scans promptly', elapsedMs < 2000, `${Math.round(elapsedMs)}ms`)
const realPush = detectGitOperation(
  'git push origin main',
  'To github.com:acme/widget.git\n   ab12cd3..ef45ab6  main -> main\n',
)
t(
  'a real ref-update line still reads as a push',
  (realPush as { push?: { branch?: string } }).push?.branch === 'main',
  JSON.stringify(realPush),
)

process.exit(failures)
