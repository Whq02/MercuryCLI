#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-compact-refusal-receipts.ts — the COMPACT
//  REFUSAL LAW (ruled): one pane line per refused/failed coordinator
//  receipt — what · why · the one fix — with the full daemon sentence in
//  the debug log only; successes keep their lines. The driven capture
//  lives in the lane record; these pins hold the seams:
//
//   R1  the label owner composes the ruled sentence (minted op-ids never
//       lead, typed-class parentheticals and `(got …)` drop, the
//       dispatchable roll-call yields to `did you mean` and caps at three,
//       repeats collapse);
//   R2  the pane paints negatives as ONE middle-truncated line (the fix
//       survives at the tail at any width) and logs nothing new — the
//       lane's door logs the full sentence;
//   R3  the validator's unknown-model refusal reads as a sentence with ONE
//       fix (the source of the ruled words).
// ============================================================================
import { readFileSync } from 'node:fs'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(rel, 'utf8')

// ── R1: the label owner ─────────────────────────────────────────────────────
{
  const { receiptLabelOf, compactRefusalWhy } = await import('../../src/services/concourse/coordinatorLane.ts')
  check(
    'R1 the ruled exemplar composes verbatim',
    receiptLabelOf({
      verb: 'session.launch',
      objectRef: 'coord-launch-3f2a9c1b-77aa-4bbb-8ccc-1234567890ab',
      outcome: 'refused',
      detail: `model refused (unknown-model) — 'sonnet 5' is not an exact model id (got "sonnet 5") · did you mean claude-sonnet-5?`,
    }) === `launch refused — 'sonnet 5' is not an exact model id · did you mean claude-sonnet-5?`,
  )
  check(
    'R1 a minted op-id never leads a refusal row',
    !receiptLabelOf({ verb: 'session.launch', objectRef: 'coord-launch-9b1c22aa-83f1-4d2c-a1b9-55e0c77d0f1e', outcome: 'refused', detail: 'x' }).includes('coord-launch-'),
  )
  check(
    'R1 the roll-call caps at three and repeats collapse',
    compactRefusalWhy('pick one of: a-1 · b-2 · c-3 · d-4 · e-5 · next: pick one of: a-1 · b-2 · c-3 · d-4 · e-5') === 'pick one of: a-1 · b-2 · c-3 (+2 more)',
  )
  check(
    'R1 the roll-call yields to the one fix',
    compactRefusalWhy(`dispatchable: a-1 · b-2 · c-3 · did you mean a-1?`) === 'did you mean a-1?',
  )
  check(
    'R1 a session-titled refusal keeps its subject',
    receiptLabelOf({ verb: 'session.redirect', objectRef: '3f2a9c1b-77aa-4bbb-8ccc-1234567890ab', outcome: 'refused', detail: 'the session is stopped' }, () => 'Fix OAuth').startsWith('message to "Fix OAuth" refused — '),
  )
  check(
    'R1 applied rows keep the full grammar',
    receiptLabelOf({ verb: 'session.launch', objectRef: 's', outcome: 'applied', detail: 'on Claude Sonnet 5' }, () => 'T') === 'launch "T": applied — on Claude Sonnet 5',
  )
}

// ── R2: the pane's one-line law ─────────────────────────────────────────────
{
  const pane = read('src/components/concourse/CoordinatorPane.tsx')
  check('R2 negatives paint ONE middle-truncated line (fix survives at the tail)', pane.includes("negative ? 'truncate-middle'"))
  check('R2 only an APPLIED launch row wraps', pane.includes("const carriesFacts = !negative && r.verb === 'session.launch'"))
  const lane = read('src/services/concourse/coordinatorLane.ts')
  check('R2 the lane logs the FULL refusal sentence to the debug log', lane.includes(`logForDebugging(\`[coordinator/receipt] \${r.verb} \${r.objectRef} \${r.outcome} — \${r.detail}\`)`))
}

// ── R3: the validator's sentence ────────────────────────────────────────────
{
  const models = read('src/services/concourse/workerModels.ts')
  check('R3 unknown-model speaks the ruled why', models.includes(`is not an exact model id`))
  check('R3 the one fix leads with did-you-mean, roll-call only without one', models.includes('did you mean ${nearest}?') && models.includes('pick one of: ${dispatchable}'))
}

if (failures > 0) {
  console.log(`\nprove-compact-refusal-receipts: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-compact-refusal-receipts: ALL LAWS HOLD')
