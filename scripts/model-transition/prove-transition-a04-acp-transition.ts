#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-a04-acp-transition.ts —
//  old/current/next model state is durable and visible on the ACP surface.
//
//    §A the kernel fold — the 'model-transition' event lands modelState on
//       the snapshot; a receipt-less note (the consume-and-clear seam)
//       KEEPS the previously-noted settlement; the field is additive
//
//    §B the seam + projection anchors — the REPL notes on every slot
//       change; the `_mercury/run` handler projects snap.modelState in
//       BOTH branches (in-process + sidecar-only answer alike)
//
//  The other A04 surfaces are already pinned elsewhere: transcript row
//  (G01), SDK mapper both directions (G02), statusline pending chip
//  rendered live (G03 capture), /model picker pendingNext (G03 prover),
//  resume via the durable transcript row, branch via copy-fork whole-row
//  carry.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

const { emptyRunSnapshot, reduceRunEvent } = await import('../../src/services/run/runKernel.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the kernel fold — durable, merging, additive')
{
  const s0 = emptyRunSnapshot({
    runId: 'run-a04',
    owner: 'a04-owner' as never,
    objective: 'prove the projection',
    rootMessageId: null,
    at: 1,
  })
  check('legacy shape: modelState absent on the empty snapshot', s0.modelState === undefined)

  const queued = reduceRunEvent(s0, {
    type: 'model-transition',
    at: 2,
    current: 'claude-opus-5',
    pendingNext: 'gpt-5.2',
  })
  check(
    'a queue note lands current + pendingNext',
    queued.modelState?.current === 'claude-opus-5' && queued.modelState?.pendingNext === 'gpt-5.2',
  )

  const settledEvent = {
    type: 'model-transition',
    at: 3,
    current: 'gpt-5.2',
    pendingNext: null,
    last: {
      previous: 'claude-opus-5',
      applied: 'gpt-5.2',
      resolution: 'applied',
      boundary: 'turn-boundary',
      crossProvider: true,
    },
  } as const
  const settled = reduceRunEvent(queued, settledEvent as never)
  check(
    'a settlement note lands the receipt summary (old/current/next complete)',
    settled.modelState?.last?.previous === 'claude-opus-5' &&
      settled.modelState?.last?.applied === 'gpt-5.2' &&
      settled.modelState?.last?.boundary === 'turn-boundary' &&
      settled.modelState?.last?.crossProvider === true,
  )

  const afterClear = reduceRunEvent(settled, {
    type: 'model-transition',
    at: 4,
    current: 'gpt-5.2',
    pendingNext: null,
  } as never)
  check(
    'a receipt-less note (consume-and-clear seam) KEEPS the settlement',
    afterClear.modelState?.last?.applied === 'gpt-5.2' && afterClear.modelState?.pendingNext === null,
  )
}

section('§B the seam + projection anchors')
{
  // A model switch is the SESSION's: the face asks through the focused
  // connector's setModel door and the session's runner applies it (the
  // set_model control); the run kernel notes the transition where the
  // session runs — the screen notes none of its own.
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  const kernel = readFileSync(join(ROOT, 'src/services/run/runKernel.ts'), 'utf8')
  check(
    "the run kernel carries the 'model-transition' event; the screen notes none of its own",
    kernel.includes("type: 'model-transition'") && !repl.includes("type: 'model-transition'"),
  )
  const acp = readFileSync(join(ROOT, 'src/services/acp/acpServer.ts'), 'utf8')
  check(
    'the _mercury/run projection carries snap.modelState (both branches share the snapshot read)',
    acp.includes('snap.modelState ? { model: snap.modelState }'),
  )
}

console.log(failures === 0 ? '\n ✅ MODEL STATE IS DURABLE + ACP-VISIBLE' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
