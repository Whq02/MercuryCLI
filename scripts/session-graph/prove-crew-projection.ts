#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-crew-projection.ts — the M2 teammate-projection
//  laws.
//
//  Hermetic: config home + party dir are mkdtemp scratch roots. Sections:
//    §1 vocabularies       — presence/lifecycle are distinct closed sets
//    §2 dormancy           — no subscriber ⇒ no engine; arm/teardown observable
//    §3 derivation         — members join registry facts with owner-observed
//                            presence/lifecycle/focus; unknown vocab ⇒ silence
//    §4 stable reference   — a no-op refresh keeps the SAME snapshot object
//    §5 source health      — empty ≠ unavailable; health rows say what was read
//    §6 honest attention   — absent while the attention store is dormant
//    §7 one-shot resolve   — resolveCrewSnapshot never arms the engine
//    §8 the resource face  — mercury://crew + agent/<id> resolve through the
//                            registered adapter (the production surface)
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, waitUntil } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-projection-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(join(scratch, 'home'), { recursive: true })

const identity = await import('../../src/services/crew/identity.ts')
const projection = await import('../../src/services/crew/projection.ts')

t.section('§1 — distinct closed vocabularies')
{
  t.check(
    'PRESENCE_STATES is exactly online|away|offline|unknown',
    JSON.stringify([...projection.PRESENCE_STATES].sort()) ===
      JSON.stringify(['away', 'offline', 'online', 'unknown']),
  )
  t.check(
    'LIFECYCLE_STATES is exactly starting..failed (7 states)',
    JSON.stringify(projection.LIFECYCLE_STATES) ===
      JSON.stringify(['starting', 'working', 'waiting', 'held', 'finishing', 'completed', 'failed']),
  )
}

t.section('§2 — solo dormancy: no subscriber, no engine')
{
  t.check('the engine is dormant before any subscriber', projection.isCrewProjectionArmed() === false)
  const unsub = projection.subscribeCrew(() => {})
  t.check('the first subscriber arms the engine', projection.isCrewProjectionArmed() === true)
  unsub()
  t.check('the last unsubscribe tears the engine down', projection.isCrewProjectionArmed() === false)
}

t.section('§3 — derivation joins registry + owner facts (silence on unknown)')
{
  // Registry: the main agent + two party seats (one with a name collision).
  const main = await identity.ensureAgentIdentity({
    displayName: 'Mercury',
    binding: { bindingKind: 'principal', bindingId: 'agent-mercury' },
  })
  const tank = await identity.ensureAgentIdentity({
    displayName: 'Atlas',
    binding: { bindingKind: 'native', bindingId: 'seat:tank' },
  })
  const healer = await identity.ensureAgentIdentity({
    displayName: 'Atlas',
    binding: { bindingKind: 'native', bindingId: 'seat:healer' },
  })
  // Party store: engaged, tank busy (→ online/working), healer dead
  // (→ offline/failed); one dispatch names the tank's focus.
  writeFileSync(
    join(scratch, 'party', 'state.json'),
    JSON.stringify({
      engaged: true,
      updatedAt: Date.now(),
      seats: [
        { seat: 'tank', model: 'm', effort: 'high', state: 'busy' },
        { seat: 'healer', model: 'm', effort: 'high', state: 'dead' },
      ],
      dispatches: [
        { id: 'd1', seat: 'tank', title: 'refit the tide gauges', specPreview: '', state: 'working', ts: Date.now() },
      ],
    }),
  )
  let pings = 0
  const unsub = projection.subscribeCrew(() => {
    pings++
  })
  const ready = await waitUntil(() => (projection.cachedCrewSnapshot()?.members.length ?? 0) >= 3)
  t.check('the snapshot gathered all three registry members', ready)
  const snap = projection.cachedCrewSnapshot()!
  const mainRow = snap.members.find(m => m.agentId === main.agentId)
  t.check('the main agent reads online from the session source', mainRow?.presence.state === 'online' && mainRow?.presence.source === 'session')
  // THE PARTY RETIREMENT (the multiplayer estate): seat
  // bindings read offline/'seat:retired' BY DESIGN — no seat host exists,
  // and a live spinner over a crew nothing runs would lie. The party
  // fixture above stays on disk as the POISON: even a standing party file
  // revives NOTHING (busy seats never paint working, dispatches never
  // become focus).
  const tankRow = snap.members.find(m => m.agentId === tank.agentId)
  t.check("a seat binding reads offline from the retirement (source 'seat:retired')", tankRow?.presence.state === 'offline' && tankRow?.presence.source === 'seat:retired')
  t.check('POISON: the party fixture revives no focus (dispatch titles stay dead)', tankRow?.focus?.label !== 'refit the tide gauges')
  const healerRow = snap.members.find(m => m.agentId === healer.agentId)
  t.check('every seat binding reads the same retirement (dead and busy alike)', healerRow?.presence.state === 'offline' && healerRow?.presence.source === 'seat:retired')
  t.check(
    'colliding display names disambiguate in labels',
    tankRow !== undefined && healerRow !== undefined && tankRow.label !== healerRow.label,
    `${tankRow?.label} vs ${healerRow?.label}`,
  )
  t.check('at least one refresh notified the subscriber', pings >= 1, String(pings))

  t.section('§4 — stable reference across a no-op refresh')
  {
    const before = projection.cachedCrewSnapshot()
    // A room status ping with unchanged facts must coalesce into a no-op.
    const { notifyRoomStatusFeed } = await import('../../src/services/attention/statusFeed.ts')
    notifyRoomStatusFeed('presence.heartbeat')
    await new Promise(r => setTimeout(r, 200))
    const after = projection.cachedCrewSnapshot()
    t.check('unchanged facts keep the SAME snapshot object', before === after)
  }

  t.section('§5 — source health: what was read, said honestly')
  {
    const snap2 = projection.cachedCrewSnapshot()!
    t.check("the identity source reads 'ready' with members present", snap2.sources.identity.state === 'ready')
    // The party source RETIRED from the snapshot shape with the estate —
    // sources are exactly identity + workbench; a party row returning here
    // means the estate revived and this section re-trues with it.
    t.check('the source roster is exactly identity + workbench (the party source stays retired)', Object.keys(snap2.sources).sort().join(',') === 'identity,workbench')
    t.check(
      'the workbench source states its condition instead of masquerading as empty',
      ['ready', 'unavailable'].includes(snap2.sources.workbench.state),
      snap2.sources.workbench.state,
    )
    t.check(
      "the ruled truth (operator screenshot): with the flag on, a DORMANT workbench engine no longer prints 'unavailable' — the one-shot gather answers ready",
      snap2.sources.workbench.state === 'ready',
      snap2.sources.workbench.state,
    )
  }

  t.section('§6 — attention: armed truth while subscribed, honest absence after')
  {
    const snap3 = projection.cachedCrewSnapshot()!
    t.check(
      'while the crew engine is armed, attention is the ARMED view (real facts)',
      snap3.attention !== undefined && typeof snap3.attention.needsYou === 'number',
    )
    unsub()
    t.check(
      'after teardown the retained snapshot reads attention as ABSENT (dormant store ⇒ honest absence, never needsYou:0-as-fact)',
      snap3.attention === undefined,
    )
  }
}

t.section('§7 — one-shot resolve never arms the engine')
{
  t.check('the engine is dormant again', projection.isCrewProjectionArmed() === false)
  const snap = await projection.resolveCrewSnapshot()
  t.check('resolveCrewSnapshot returns a snapshot', snap !== null && snap.members.length >= 3)
  t.check('…without arming the engine', projection.isCrewProjectionArmed() === false)
}

t.section('§8 — the mercury://crew resource face (the production surface)')
{
  const { crewAdapter } = await import('../../src/services/resources/adapters/crew.ts')
  const { resourceAdapterKinds } = await import('../../src/services/resources/registry.ts')
  t.check(
    "the registry serves the 'crew' kind",
    resourceAdapterKinds().some(k => k.kind === 'crew'),
  )
  const listing = await crewAdapter.resolve(
    { kind: 'crew', id: '', query: {} } as never,
    {} as never,
  )
  t.check('mercury://crew resolves ok', listing.state === 'ok')
  if (listing.state === 'ok') {
    t.check('the listing carries member children', (listing.resource.children?.length ?? 0) >= 3)
    const firstRef = listing.resource.children?.[0]?.ref ?? ''
    const detail = await crewAdapter.resolve(
      { kind: 'crew', id: firstRef.replace('mercury://crew/', ''), query: {} } as never,
      {} as never,
    )
    t.check('an agent/<id> child resolves to the member detail', detail.state === 'ok')
    if (detail.state === 'ok') {
      t.check(
        'the detail names presence + bindings (source-backed, never invented)',
        /presence: /.test(detail.resource.text ?? '') && /bindings: /.test(detail.resource.text ?? ''),
      )
    }
  }
  const ghost = await crewAdapter.resolve(
    { kind: 'crew', id: 'agent/cw-000000000000', query: {} } as never,
    {} as never,
  )
  t.check('an unknown member reads absent (never an empty ok)', ghost.state === 'absent')
}

t.section('§9 — wave-A pin: a role CLOSE moves the projection (facts, not row counts)')
{
  const unsub = projection.subscribeCrew(() => {})
  await waitUntil(() => (projection.cachedCrewSnapshot()?.members.length ?? 0) >= 3)
  const tankId = (await identity.resolveAgent('native:seat:tank'))!
  await identity.linkAgentRole(tankId, 'party-seat', 'party:tank')
  const linked = await waitUntil(() => {
    const m = projection.cachedCrewSnapshot()?.members.find(x => x.agentId === tankId)
    return m?.roles.some(r => r.role === 'party-seat' && r.activeUntil === undefined) === true
  })
  t.check('the open role link lands in the snapshot', linked)
  await identity.endAgentRole(tankId, 'party-seat', 'party:tank')
  const closed = await waitUntil(() => {
    const m = projection.cachedCrewSnapshot()?.members.find(x => x.agentId === tankId)
    return m?.roles.some(r => r.role === 'party-seat' && typeof r.activeUntil === 'number') === true
  })
  t.check(
    'closing the link (row count UNCHANGED) still lands a fresh snapshot — the signature reads facts',
    closed,
  )
  unsub()
}

t.finish('prove-crew-projection')
