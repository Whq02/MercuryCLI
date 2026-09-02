#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-contracts.ts — the slice-0 cross-domain
//  characterization. Freezes the LAWS the six-primitive convergence must not
//  break, at the seams no existing suite pins together:
//
//    1. Owner law — canonical formatting, forge resistance, round-trip,
//       equality, lane derivation, disposal propagation (stores + ad-hoc),
//       disposer error isolation, idempotence.
//    2. Resource honesty law — invalid ref ⇒ absent; unknown kind ⇒ absent
//       naming known kinds; throwing adapter ⇒ explicit unavailable; killed
//       plane ⇒ unavailable; bounded reads page honestly.
//    3. Receipt-mint law at the ONE observation seam — succeeded mutation ⇒
//       exactly one receipt; effect-less events ⇒ none; read-shaped effects ⇒
//       none; failed-with-changedPaths ⇒ recorded (partial application is
//       truth, not embarrassment).
//    4. View vocabulary law — the card grammar maps every Law-3 execution
//       state + every resource honesty state; unknown states read neutral,
//       never invented.
//
//  Behavioural floor elsewhere: scripts/project-services/ + scripts/run/ +
//  scripts/context/ + scripts/reliability/ (recon doc §Anchors).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'axiom-contracts-'))

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 1. Owner law ─────────────────────────────────────────────────────────────
console.log('owner law')
const { makeOwnerKey, parseOwnerKey, isOwnerKey, ownerEquals, agentLane, MAIN_LANE } =
  await import('../../src/services/run/ownerKey.ts')
const { OwnerScopedStore } = await import('../../src/services/run/ownerScopedStore.ts')
const {
  registerOwnerScopedStore,
  registerOwnerDisposer,
  disposeOwner,
} = await import('../../src/services/run/ownerLifecycle.ts')

{
  const id = { workspace: '/w s|p', sessionId: 's|1', lane: MAIN_LANE }
  const key = makeOwnerKey(id)
  const back = parseOwnerKey(key)
  check('round-trip with hostile separators', back.workspace === id.workspace && back.sessionId === id.sessionId)
  const forged = makeOwnerKey({ workspace: '/w s', sessionId: 'p|s|1', lane: MAIN_LANE })
  check('separator cannot forge a boundary', !ownerEquals(key, forged))
  check('isOwnerKey accepts canonical', isOwnerKey(key))
  check('isOwnerKey rejects junk', !isOwnerKey('mo1|only|three'))
  check('agent lane derivation', agentLane('a1') === 'agent:a1')
  check('equality is canonical-string equality', ownerEquals(key, makeOwnerKey({ ...id })))
}

{
  const disposed: string[] = []
  const store = new OwnerScopedStore<{ n: number }>({
    name: 'axiom-proof-store',
    create: () => ({ n: 1 }),
    dispose: () => disposed.push('store'),
  })
  registerOwnerScopedStore(store)
  const owner = makeOwnerKey({ workspace: '/axiom', sessionId: 'sess-a', lane: MAIN_LANE })
  store.get(owner)
  registerOwnerDisposer(owner, 'adhoc-1', () => {
    disposed.push('adhoc')
  })
  registerOwnerDisposer(owner, 'adhoc-throw', () => {
    disposed.push('adhoc-throw')
    throw new Error('disposer failure must be isolated')
  })
  await disposeOwner(owner)
  check('disposal propagates to stores and ad-hoc disposers',
    disposed.includes('store') && disposed.includes('adhoc'))
  check('disposer errors are isolated', disposed.includes('adhoc-throw'))
  check('store entry gone after disposal', store.peek(owner) === undefined)
  await disposeOwner(owner) // idempotent
  check('disposal is idempotent', disposed.length === 3)
}

// ── 2. Resource honesty law ──────────────────────────────────────────────────
console.log('resource honesty law')
const { resolveResource, registerResourceAdapter } =
  await import('../../src/services/resources/registry.ts')
const { boundedTextView } = await import('../../src/services/resources/contracts.ts')
const ctx = {
  owner: makeOwnerKey({ workspace: '/axiom', sessionId: 'sess-r', lane: MAIN_LANE }),
  cwd: process.cwd(),
}

{
  const invalid = await resolveResource('not-a-ref', ctx)
  check('invalid ref ⇒ absent with grammar guidance',
    invalid.state === 'absent' && invalid.note.includes('mercury://'))
  const unknown = await resolveResource('mercury://no-such-kind/x', ctx)
  check('unknown kind ⇒ absent naming known kinds',
    unknown.state === 'absent' && unknown.note.includes('known kinds') && unknown.note.includes('file'))
  registerResourceAdapter({
    kind: 'axiom-throw',
    describe: 'proof adapter that throws',
    resolve: async () => {
      throw new Error('boom')
    },
  })
  const thrown = await resolveResource('mercury://axiom-throw/x', ctx)
  check('throwing adapter degrades to explicit unavailable',
    thrown.state === 'unavailable' && thrown.note.includes('boom'))
  process.env.MERCURY_REFS = '0'
  const killed = await resolveResource('mercury://file/x', ctx)
  check('killed plane ⇒ unavailable, never absent', killed.state === 'unavailable')
  delete process.env.MERCURY_REFS
}

{
  const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')
  const page = boundedTextView(text, { cursor: 4, limit: 3 })
  check('bounded read pages honestly',
    page.text === 'line5\nline6\nline7' && page.page.hasMore && page.page.total === 10)
  const empty = boundedTextView(text, { q: 'no-such-needle' })
  check('legitimate zero rows read as empty text, total 0',
    empty.text === '' && empty.page.total === 0)
}

// ── 3. Receipt-mint law at the ONE seam ──────────────────────────────────────
console.log('receipt-mint law')
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const receiptsMod = await import('../../src/services/changeTransaction/receipts.ts')

{
  const owner = makeOwnerKey({ workspace: '/axiom', sessionId: 'sess-c', lane: MAIN_LANE })
  const base = {
    owner,
    toolUseId: 'tu-1',
    input: { file_path: '/axiom/a.ts' },
    ok: true,
    durationMs: 5,
    cwd: '/axiom',
  }
  observeToolTerminal({
    ...base,
    toolName: 'Edit',
    effect: {
      outcome: 'succeeded',
      operation: 'file.edit',
      changedPaths: ['/axiom/a.ts'],
      evidence: 'proof',
      startedAt: 1,
      completedAt: 2,
    },
  })
  const afterMutation = receiptsMod.receiptsFor(owner)
  check('succeeded mutation mints exactly one receipt',
    afterMutation.length === 1 && afterMutation[0]!.seq === 1)
  check('receipt carries intent + effect',
    afterMutation[0]!.intent.targetPaths.includes('/axiom/a.ts') &&
      afterMutation[0]!.effect.operation === 'file.edit')

  observeToolTerminal({ ...base, toolName: 'Read', effect: undefined })
  check('effect-less event mints nothing', receiptsMod.receiptsFor(owner).length === 1)

  observeToolTerminal({
    ...base,
    toolName: 'LSP',
    effect: {
      outcome: 'succeeded',
      operation: 'lsp.hover',
      changedPaths: [],
      evidence: 'read op',
      startedAt: 3,
      completedAt: 4,
    },
  })
  check('read-shaped effect mints nothing', receiptsMod.receiptsFor(owner).length === 1)

  observeToolTerminal({
    ...base,
    ok: false,
    toolName: 'Edit',
    effect: {
      outcome: 'failed',
      operation: 'file.edit',
      changedPaths: ['/axiom/b.ts'],
      evidence: 'partial application',
      startedAt: 5,
      completedAt: 6,
    },
  })
  const final = receiptsMod.receiptsFor(owner)
  check('failed-with-changedPaths is recorded truth',
    final.length === 2 && final[1]!.effect.outcome === 'failed')
  check('sequence is monotonic', final[1]!.seq === 2)
  await disposeOwner(owner)
  check('owner disposal clears the ring', receiptsMod.receiptsFor(owner).length === 0)
}

// ── 4. View vocabulary law ───────────────────────────────────────────────────
console.log('view vocabulary law')
const { cardTone } = await import('../../src/components/mercury-ui/toolCardGrammar.ts')

{
  const law3 = [
    'queued', 'starting', 'ready', 'running', 'waiting', 'stopping', 'stopped',
    'succeeded', 'failed', 'cancelled', 'unavailable', 'indeterminate',
  ]
  const honesty = ['absent', 'expired', 'busy']
  const fallback = cardTone('__unknown__')
  const unmapped = [...law3, ...honesty].filter(s => {
    const t = cardTone(s)
    return t.glyph === fallback.glyph && t.tone === fallback.tone
  })
  check('card grammar covers Law-3 + honesty states', unmapped.length === 0,
    unmapped.length ? `unmapped: ${unmapped.join(', ')}` : undefined)
  check('unknown states read neutral, never invented', fallback.glyph === '·')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
