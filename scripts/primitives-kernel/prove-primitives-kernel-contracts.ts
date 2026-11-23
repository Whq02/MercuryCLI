#!/usr/bin/env bun
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

console.log('owner law')
const { makeOwnerKey, parseOwnerKey, isOwnerKey, ownerEquals, agentLane, MAIN_LANE } =
  await import('../../src/engine/run-owner/ownerKey.ts')
const { OwnerScopedStore } = await import('../../src/engine/run-owner/ownerScopedStore.ts')
const {
  registerOwnerScopedStore,
  registerOwnerDisposer,
  disposeOwner,
} = await import('../../src/engine/run-owner/ownerLifecycle.ts')

{
  const id = { workspace: '/w s|p', sessionId: 's|1', lane: MAIN_LANE }
  const key = makeOwnerKey(id)
  const back = parseOwnerKey(key)
  check('round-trip with hostile separators', back.workspace === id.workspace && back.sessionId === id.sessionId,
    'change makeOwnerKey/parseOwnerKey in src/engine/run-owner/ownerKey.ts so encoding then parsing returns the same workspace and sessionId')
  const forged = makeOwnerKey({ workspace: '/w s', sessionId: 'p|s|1', lane: MAIN_LANE })
  check('separator cannot forge a boundary', !ownerEquals(key, forged),
    'change makeOwnerKey in src/engine/run-owner/ownerKey.ts to escape the separator so different identities never give one key')
  check('isOwnerKey accepts canonical', isOwnerKey(key),
    'change isOwnerKey in src/engine/run-owner/ownerKey.ts to accept the string makeOwnerKey returns')
  check('isOwnerKey rejects junk', !isOwnerKey('mo1|only|three'),
    'change isOwnerKey in src/engine/run-owner/ownerKey.ts to reject a key with the wrong number of parts')
  check('agent lane derivation', agentLane('a1') === 'agent:a1',
    'change agentLane in src/engine/run-owner/ownerKey.ts to return agent: followed by the agent id')
  check('equality is canonical-string equality', ownerEquals(key, makeOwnerKey({ ...id })),
    'change ownerEquals in src/engine/run-owner/ownerKey.ts to compare the canonical key strings')
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
    disposed.includes('store') && disposed.includes('adhoc'),
    'change disposeOwner in src/engine/run-owner/ownerLifecycle.ts to call every registered store and every ad-hoc disposer for the owner')
  check('disposer errors are isolated', disposed.includes('adhoc-throw'),
    'change disposeOwner in src/engine/run-owner/ownerLifecycle.ts so a throwing disposer does not stop the others')
  check('store entry gone after disposal', store.peek(owner) === undefined,
    'change disposeOwner in src/engine/run-owner/ownerLifecycle.ts or OwnerScopedStore in src/engine/run-owner/ownerScopedStore.ts to drop the owner entry on disposal')
  await disposeOwner(owner)
  check('disposal is idempotent', disposed.length === 3,
    'change disposeOwner in src/engine/run-owner/ownerLifecycle.ts so a second call for the same owner runs no disposer again')
}

console.log('resource honesty law')
const { resolveResource } =
  await import('../../src/integrations/resources/registry.ts')
const { boundedTextView } = await import('../../src/integrations/resources/contracts.ts')
const ctx = {
  owner: makeOwnerKey({ workspace: '/axiom', sessionId: 'sess-r', lane: MAIN_LANE }),
  cwd: process.cwd(),
}

{
  const invalid = await resolveResource('not-a-ref', ctx)
  check('invalid ref ⇒ absent with grammar guidance',
    invalid.state === 'absent' && invalid.note.includes('mercury://'),
    'change resolveResource in src/integrations/resources/registry.ts to answer an invalid ref as absent with a note naming the mercury:// grammar')
  const unknown = await resolveResource('mercury://no-such-kind/x', ctx)
  check('unknown kind ⇒ absent naming known kinds',
    unknown.state === 'absent' && unknown.note.includes('known kinds') && unknown.note.includes('file'),
    'change resolveResource in src/integrations/resources/registry.ts to answer an unknown kind as absent with a note listing the known kinds')
  const thrown = await resolveResource('mercury://seat', {
    ...ctx,
    engineModel: 'axiom-model',
    getAppState: () => {
      throw new Error('boom')
    },
  })
  check('throwing adapter degrades to explicit unavailable',
    thrown.state === 'unavailable' && thrown.note.includes('boom'),
    'change resolveResource in src/integrations/resources/registry.ts to catch an adapter error and answer unavailable with the error message in the note')
  process.env.MERCURY_REFS = '0'
  const killed = await resolveResource('mercury://file/x', ctx)
  check('killed plane ⇒ unavailable, never absent', killed.state === 'unavailable',
    'change resolveResource in src/integrations/resources/registry.ts to answer unavailable when MERCURY_REFS is 0')
  delete process.env.MERCURY_REFS
}

{
  const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')
  const page = boundedTextView(text, { cursor: 4, limit: 3 })
  check('bounded read pages honestly',
    page.text === 'line5\nline6\nline7' && page.page.hasMore && page.page.total === 10,
    'change boundedTextView in src/integrations/resources/contracts.ts so cursor and limit select the lines and the page reports hasMore and total')
  const empty = boundedTextView(text, { q: 'no-such-needle' })
  check('legitimate zero rows read as empty text, total 0',
    empty.text === '' && empty.page.total === 0,
    'change boundedTextView in src/integrations/resources/contracts.ts so a query with no match returns empty text and total 0')
}

console.log('receipt-mint law')
const { observeToolTerminal } = await import('../../src/engine/run-owner/effectObserver.ts')
const receiptsMod = await import('../../src/tools/engines/change-transaction/receipts.ts')

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
    afterMutation.length === 1 && afterMutation[0]!.seq === 1,
    'change observeToolTerminal in src/engine/run-owner/effectObserver.ts or the ring in src/tools/engines/change-transaction/receipts.ts so one succeeded mutation records one receipt with seq 1')
  check('receipt carries intent + effect',
    afterMutation[0]!.intent.targetPaths.includes('/axiom/a.ts') &&
      afterMutation[0]!.effect.operation === 'file.edit',
    'change observeToolTerminal in src/engine/run-owner/effectObserver.ts so the receipt carries the changed paths as intent targets and the effect operation')

  observeToolTerminal({ ...base, toolName: 'Read', effect: undefined })
  check('effect-less event mints nothing', receiptsMod.receiptsFor(owner).length === 1,
    'change observeToolTerminal in src/engine/run-owner/effectObserver.ts to mint no receipt when the event has no effect')

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
  check('read-shaped effect mints nothing', receiptsMod.receiptsFor(owner).length === 1,
    'change observeToolTerminal in src/engine/run-owner/effectObserver.ts to mint no receipt for an effect with no changed paths')

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
    final.length === 2 && final[1]!.effect.outcome === 'failed',
    'change observeToolTerminal in src/engine/run-owner/effectObserver.ts to record a failed effect that lists changed paths')
  check('sequence is monotonic', final[1]!.seq === 2,
    'change the receipt sequence counter in src/tools/engines/change-transaction/receipts.ts to rise by one per receipt')
  await disposeOwner(owner)
  check('owner disposal clears the ring', receiptsMod.receiptsFor(owner).length === 0,
    'change src/tools/engines/change-transaction/receipts.ts to register its ring with disposeOwner (src/engine/run-owner/ownerLifecycle.ts) so disposal clears it')
}

console.log('view vocabulary law')
const { cardTone } = await import('../../src/screen/widgets/toolCardGrammar.ts')

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
    unmapped.length ? `unmapped: ${unmapped.join(', ')}; add each state to the tone table behind cardTone in src/screen/widgets/toolCardGrammar.ts` : undefined)
  check('unknown states read neutral, never invented', fallback.glyph === '·',
    'change the fallback tone of cardTone in src/screen/widgets/toolCardGrammar.ts to the neutral glyph')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
