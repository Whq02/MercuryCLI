#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-seat-bridge.ts — the M3 external-seat laws.
//
//  Hermetic; no real CLI and no paid call anywhere in this prover — the
//  adapters run against fixture-replaying fake children (the REAL adapter
//  code, an injected spawn seam) plus ONE genuine two-process journey against
//  fixtures/fake-seat.mjs over the real spawn/stdio plumbing. Sections:
//
//    §1 capability tri-state laws — record/authorize/expire; absence and
//       staleness can never authorize
//    §3 codex conformance         — the captured-fixture JSON-RPC handshake;
//       the honest sparse variant
//    §4 opencode/goose ACP conformance — protocol-fixture initialize through
//       the REAL profile; capability DERIVATION differs per declared caps
//    §5 bridge attach laws        — stable identity across re-attach;
//       renegotiation expires the old set first; detach forgets
//    §6 the dispatch transaction  — law probe + pre-flight refusal + the
//       delivered path + per-attachment outcomes + idempotent replay
//    §7 the two-process journey   — fake-seat.mjs over REAL stdio: handshake,
//       delivery ack, interrupt, detach kills the owned child
//    §8 wave-A regression pins    — atomic same-id concurrency (one delivery),
//       adapter-declared-only idempotent retry, cancel-turn pre-flight
//       authorization, a dead seat never shadowing a live re-attach, the
//       late-proven session identity binding
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, waitUntil } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-seat-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(join(scratch, 'home'), { recursive: true })

const caps = await import('../../src/services/crew/capabilities.ts')
const bridge = await import('../../src/services/crew/seatBridge.ts')
const dispatch = await import('../../src/services/crew/dispatch.ts')
const { codexSeatTransport } = await import('../../src/services/crew/adapters/codex.ts')
const { acpSeatTransport } = await import('../../src/services/crew/adapters/acpProfile.ts')
type NdjsonChildLike = import('../../src/services/crew/adapters/ndjsonChild.ts').NdjsonChildLike

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`scripts/session-graph/fixtures/${name}.fixture.json`, 'utf8'))

/** A fake child that answers writes from a fixture's handshake exchange. */
function fixtureChild(fx: Record<string, unknown>): NdjsonChildLike {
  const lineListeners = new Set<(line: string) => void>()
  const exitListeners = new Set<(code: number | null) => void>()
  const handshake = fx.handshake as { receive: Record<string, unknown> }
  return {
    write: (line: string) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      // Answer any initialize-shaped write with the fixture's captured reply,
      // echoing whichever correlation id the adapter minted.
      const isControlInit =
        msg.type === 'control_request' &&
        (msg.request as { subtype?: string })?.subtype === 'initialize'
      const isRpcInit = msg.method === 'initialize'
      if (isControlInit || isRpcInit) {
        const reply = JSON.parse(JSON.stringify(handshake.receive)) as Record<string, unknown>
        if (isControlInit) {
          ;(reply.response as Record<string, unknown>).request_id = msg.request_id
        } else {
          reply.id = msg.id
        }
        setTimeout(() => {
          for (const l of [...lineListeners]) l(JSON.stringify(reply))
        }, 5)
      }
    },
    onLine: l => {
      lineListeners.add(l)
      return () => lineListeners.delete(l)
    },
    onExit: l => {
      exitListeners.add(l)
      return () => exitListeners.delete(l)
    },
    kill: () => {
      for (const l of [...exitListeners]) l(0)
    },
    owned: true,
  }
}

t.section('§1 — capability tri-state laws')
{
  caps._resetCapabilitiesForTesting()
  const set = caps.recordCapabilities({
    seatId: 's1',
    adapterKind: 'probe',
    revision: 'r1',
    declared: {
      'steer-current': { state: 'supported', source: 'probe' },
      'attach-image': { state: 'unsupported', source: 'probe' },
    },
  })
  t.check('every kind gets a fact (absent kinds record unknown)', set.facts.size === caps.CAPABILITY_KINDS.length)
  t.check('a declared-supported fact authorizes', caps.authorizeCapability('s1', 'steer-current').ok === true)
  t.check('unsupported refuses with the source', caps.authorizeCapability('s1', 'attach-image').ok === false)
  const unknownAuth = caps.authorizeCapability('s1', 'set-title')
  t.check(
    "absent-from-handshake reads unknown and NEVER authorizes ('probably works' is banned)",
    unknownAuth.ok === false && unknownAuth.fact.state === 'unknown',
  )
  caps.invalidateCapabilities('s1', 'reconnect')
  const stale = caps.authorizeCapability('s1', 'steer-current')
  t.check('an expired set refuses EVERYTHING, including previously supported', stale.ok === false)
  t.check('the expired fact reads unknown with the invalidation reason', stale.fact.state === 'unknown' && /invalidated/.test(stale.fact.source))
  t.check('never-observed seats answer unknown', caps.capabilityStateOf('ghost', 'start-turn').state === 'unknown')
}

t.section('§3 — codex conformance (captured fixture; the sparse variant)')
{
  const transport = codexSeatTransport({ spawnImpl: () => fixtureChild(fixture('codex')) })
  const hs = await transport.handshake()
  t.check('the JSON-RPC initialize negotiates', hs.protocol === 'codex-app-server@jsonrpc-initialize')
  t.check('the revision is the userAgent', /0\.144\.5/.test(hs.revision))
  t.check('structured-activity supported', hs.declared['structured-activity']?.state === 'supported')
  t.check(
    'the turn surface stays honestly UNKNOWN (experimental-unnegotiated) — the capability variant',
    hs.declared['start-turn']?.state === 'unknown' && hs.declared['cancel-turn']?.state === 'unknown',
  )
  await transport.detach()
}

t.section('§4 — opencode/goose ACP conformance (fixture tier; derivation differs)')
{
  const oc = acpSeatTransport('opencode', 'OpenCode', {
    command: ['opencode', 'acp'],
    spawnImpl: () => fixtureChild(fixture('opencode')),
  })
  const ocHs = await oc.handshake()
  t.check('opencode negotiates acp@1', ocHs.protocol === 'acp@1')
  t.check('opencode: image attach DERIVED supported (promptCapabilities.image=true)', ocHs.declared['attach-image']?.state === 'supported')
  t.check('opencode: resume DERIVED supported (loadSession=true)', ocHs.declared['resume-session']?.state === 'supported')
  await oc.detach()
  const goose = acpSeatTransport('goose', 'goose', {
    command: ['goose', 'acp'],
    spawnImpl: () => fixtureChild(fixture('goose')),
  })
  const gHs = await goose.handshake()
  t.check('goose: image attach DERIVED unsupported (declared false — absence-by-protocol)', gHs.declared['attach-image']?.state === 'unsupported')
  t.check('goose: resume DERIVED unsupported (loadSession=false)', gHs.declared['resume-session']?.state === 'unsupported')
  await goose.detach()
}

t.section('§5 — bridge attach laws')
{
  bridge._resetSeatBridgeForTesting()
  caps._resetCapabilitiesForTesting()
  const dir = join(scratch, 'bridge-store')
  // The attach laws are seat-generic; the codex fixture is the surviving
  // external-harness conformance capture and carries the whole handshake.
  const mkTransport = (): ReturnType<typeof codexSeatTransport> =>
    codexSeatTransport({ spawnImpl: () => fixtureChild(fixture('codex')) })
  const seatA = await bridge.attachExternalSeat(mkTransport(), { displayName: 'Atlas', dir })
  t.check('attach binds a registry identity', /^cw-/.test(seatA.agentId))
  t.check('attach records the capability set', caps.capabilitiesOf(seatA.seatId) !== null)
  // A second attach with NO provable external session id is a NEW seat and a
  // new agent (nothing proves continuity).
  const seatB = await bridge.attachExternalSeat(mkTransport(), { displayName: 'Atlas', dir })
  t.check('two unproven seats stay distinct agents (no accidental aliasing)', seatB.agentId !== seatA.agentId)
  const before = caps.capabilitiesOf(seatA.seatId)
  const renegotiated = await bridge.renegotiateSeat(seatA.seatId)
  t.check('renegotiation records a FRESH set', renegotiated !== null && caps.capabilitiesOf(seatA.seatId) !== before)
  const detached = await bridge.detachExternalSeat(seatA.seatId)
  t.check('detach succeeds', detached === true)
  t.check('detach forgets the capability set', caps.capabilitiesOf(seatA.seatId) === null)
  t.check('the seat roster drops the seat', bridge.attachedSeatOf(seatA.seatId) === null)
  await bridge.detachExternalSeat(seatB.seatId)
}

t.section('§6 — the dispatch transaction')
{
  const laws = await dispatch.__dispatchLawsForProof()
  t.check('an ambiguous outcome preserves the draft as delivery-unknown', laws.draftPreservedOnUnknown)
  t.check('no automatic retry without declared dedupe (replay returns the receipt)', laws.noAutoRetryWithoutDeclaredIdempotency)
  t.check('instruction and every attachment carry independent outcomes', laws.perAttachmentOutcomes)
  t.check('only the positive state is clearable', laws.clearOnlyAfterPositiveReceipt)

  // Pre-flight refusal + the delivered path against a supportive fake seat.
  bridge._resetSeatBridgeForTesting()
  caps._resetCapabilitiesForTesting()
  const dir = join(scratch, 'dispatch-store')
  let delivered = 0
  const seat = await bridge.attachExternalSeat(
    {
      adapterKind: 'probe-adapter',
      displayName: 'Probe',
      mercuryOwnsProcess: true,
      handshake: async () => ({
        protocol: 'probe@1',
        revision: 'probe-1',
        externalSessionId: 'ext-1',
        declared: {
          'hold-next': { state: 'supported' as const, source: 'probe' },
          'attach-file': { state: 'supported' as const, source: 'probe' },
          'attach-image': { state: 'unsupported' as const, source: 'probe' },
        },
      }),
      deliver: async req => {
        delivered++
        return {
          result: 'accepted' as const,
          disposition: 'queued-next' as const,
          attachments: req.attachments.map(a => ({ attachmentId: a.attachmentId, outcome: 'accepted' as const })),
          adapterOutcome: 'probe-ack',
        }
      },
      detach: async () => {},
    },
    { displayName: 'Probe', dir },
  )
  const refused = await dispatch.dispatchToAgent(
    {
      clientMessageId: 'm-steer',
      requestedAddress: { agentId: seat.agentId },
      requestedDisposition: 'steer-current',
      instruction: 'steer!',
      attachments: [],
    },
    { dir },
  )
  t.check(
    'an undeclared disposition refuses PRE-FLIGHT (nothing was sent)',
    refused.state === 'not-delivered' && delivered === 0,
    refused.reason,
  )
  const ok = await dispatch.dispatchToAgent(
    {
      clientMessageId: 'm-hold',
      requestedAddress: { agentId: seat.agentId },
      requestedDisposition: 'hold-next',
      instruction: 'queued work',
      attachments: [
        { attachmentId: 'a-file', kind: 'file', ref: '/x', label: 'x' },
        { attachmentId: 'a-img', kind: 'image', ref: 'image:1', label: 'img' },
      ],
    },
    { dir },
  )
  t.check('a declared disposition delivers with the adapter disposition', ok.state === 'delivered' && ok.disposition === 'queued-next')
  const fileOut = ok.attachmentOutcomes.find(a => a.attachmentId === 'a-file')
  const imgOut = ok.attachmentOutcomes.find(a => a.attachmentId === 'a-img')
  t.check('a capability-refused attachment is rejected per-part while the rest deliver', fileOut?.outcome === 'accepted' && imgOut?.outcome === 'rejected')
  const replay = await dispatch.dispatchToAgent(
    {
      clientMessageId: 'm-hold',
      requestedAddress: { agentId: seat.agentId },
      requestedDisposition: 'hold-next',
      instruction: 'queued work',
      attachments: [],
    },
    { dir },
  )
  t.check('a replayed clientMessageId returns the recorded receipt (one delivery total)', replay.observedAt === ok.observedAt && delivered === 1)
  const persisted = await dispatch.readDeliveryReceipt('m-hold', { dir })
  t.check(
    'per-attachment outcomes ride the persisted receipt (the field production reads)',
    persisted !== null && persisted.attachmentOutcomes.length === 2,
  )
  t.check(
    'dispositionLabelOf renders the visible target+disposition copy',
    dispatch.dispositionLabelOf('hold-next', 'Atlas') === 'Hold for Atlas next' &&
      dispatch.dispositionLabelOf('steer-current', 'Atlas') === 'Steer Atlas now' &&
      dispatch.dispositionLabelOf('start-turn', 'Atlas') === 'Start a turn with Atlas',
  )
  await bridge.detachExternalSeat(seat.seatId)
}

// §7 (the two-process stdio journey) has no current host: the stdio-journey
// and proven-id-binding laws await re-hosting on the codex adapter (a named
// follow-up).

t.section('§8 — wave-A regression pins')
{
  bridge._resetSeatBridgeForTesting()
  caps._resetCapabilitiesForTesting()
  type Lifecycle = 'connected' | 'disconnected' | 'exited'
  const mkProbe = (args: {
    externalSessionId?: string
    declared?: Record<string, { state: 'supported' | 'unsupported' | 'unknown'; source: string }>
    declaresIdempotentDelivery?: boolean
    deliverImpl?: () => Promise<{ result: 'accepted' | 'rejected' | 'unknown' } & Record<string, unknown>>
    withCancel?: boolean
  }): {
    transport: import('../../src/services/crew/seatBridge.ts').ExternalSeatTransport
    fireLifecycle: (s: Lifecycle) => void
    deliveries: () => number
  } => {
    let deliverCalls = 0
    const lifecycleListeners = new Set<(s: Lifecycle) => void>()
    const transport = {
      adapterKind: 'probe-adapter',
      displayName: 'Probe',
      mercuryOwnsProcess: true,
      ...(args.declaresIdempotentDelivery === true ? { declaresIdempotentDelivery: true } : {}),
      handshake: async () => ({
        protocol: 'probe@1',
        revision: 'probe-1',
        ...(args.externalSessionId !== undefined ? { externalSessionId: args.externalSessionId } : {}),
        declared: (args.declared ?? {
          'hold-next': { state: 'supported' as const, source: 'probe' },
        }) as never,
      }),
      deliver: async (): Promise<never> => {
        deliverCalls++
        const impl =
          args.deliverImpl ??
          (async () => ({
            result: 'accepted' as const,
            disposition: 'queued-next' as const,
            attachments: [],
            adapterOutcome: 'probe-ack',
          }))
        return (await impl()) as never
      },
      ...(args.withCancel
        ? {
            cancelTurn: async (): Promise<never> =>
              ({ result: 'accepted', disposition: 'steered-current', attachments: [], adapterOutcome: 'x' }) as never,
          }
        : {}),
      onLifecycle: (l: (s: Lifecycle) => void): (() => void) => {
        lifecycleListeners.add(l)
        return () => lifecycleListeners.delete(l)
      },
      detach: async (): Promise<void> => {},
    }
    return {
      transport: transport as never,
      fireLifecycle: s => {
        for (const l of [...lifecycleListeners]) l(s)
      },
      deliveries: () => deliverCalls,
    }
  }

  // Concurrency: two overlapping dispatches with ONE clientMessageId — the
  // reservation is atomic, so exactly one delivery runs and both callers get
  // the same receipt.
  const dirC = join(scratch, 'wavea-concurrency')
  const slow = mkProbe({
    deliverImpl: async () => {
      await new Promise(r => setTimeout(r, 60))
      return { result: 'accepted', disposition: 'queued-next', attachments: [], adapterOutcome: 'probe-ack' }
    },
  })
  const seatC = await bridge.attachExternalSeat(slow.transport, { displayName: 'Probe', dir: dirC })
  const draftC = {
    clientMessageId: 'race-1',
    requestedAddress: { agentId: seatC.agentId },
    requestedDisposition: 'hold-next' as const,
    instruction: 'race work',
    attachments: [],
  }
  const [rA, rB] = await Promise.all([
    dispatch.dispatchToAgent(draftC, { dir: dirC }),
    dispatch.dispatchToAgent(draftC, { dir: dirC }),
  ])
  t.check(
    'two overlapping same-id dispatches deliver exactly ONCE',
    slow.deliveries() === 1 && rA.state === 'delivered' && rB.state === 'delivered' && rA.observedAt === rB.observedAt,
    `${slow.deliveries()} deliveries`,
  )
  await bridge.detachExternalSeat(seatC.seatId)

  // Idempotent retry is ADAPTER-declared, never caller-asserted: without the
  // transport declaration a delivery-unknown + retry flag re-sends NOTHING.
  const dirR = join(scratch, 'wavea-retry')
  const flaky = mkProbe({
    deliverImpl: async () => ({ result: 'unknown', reason: 'probe: ack lost' }),
  })
  const seatR = await bridge.attachExternalSeat(flaky.transport, { displayName: 'Probe', dir: dirR })
  const draftR = {
    clientMessageId: 'retry-1',
    requestedAddress: { agentId: seatR.agentId },
    requestedDisposition: 'hold-next' as const,
    instruction: 'maybe lost',
    attachments: [],
  }
  const r1 = await dispatch.dispatchToAgent(draftR, { dir: dirR })
  const before = flaky.deliveries()
  const r2 = await dispatch.dispatchToAgent(draftR, { dir: dirR, retryDeclaredIdempotent: true })
  t.check(
    'a caller-asserted retry against an UNDECLARED adapter is refused (recorded receipt returned, nothing re-sent)',
    r1.state === 'delivery-unknown' && flaky.deliveries() === before && r2.observedAt === r1.observedAt,
    `${flaky.deliveries() - before} extra deliveries`,
  )
  await bridge.detachExternalSeat(seatR.seatId)

  // …and WITH the adapter declaration, the same-id retry runs.
  const dirR2 = join(scratch, 'wavea-retry-declared')
  const dedupe = mkProbe({
    declaresIdempotentDelivery: true,
    deliverImpl: async () => ({ result: 'unknown', reason: 'probe: ack lost' }),
  })
  const seatR2 = await bridge.attachExternalSeat(dedupe.transport, { displayName: 'Probe', dir: dirR2 })
  const draftR2 = { ...draftR, requestedAddress: { agentId: seatR2.agentId } }
  await dispatch.dispatchToAgent(draftR2, { dir: dirR2 })
  const beforeDeclared = dedupe.deliveries()
  await dispatch.dispatchToAgent(draftR2, { dir: dirR2, retryDeclaredIdempotent: true })
  t.check(
    'a declared-idempotent adapter retry reuses the SAME id and re-delivers',
    dedupe.deliveries() === beforeDeclared + 1,
    `${dedupe.deliveries() - beforeDeclared} retries`,
  )
  await bridge.detachExternalSeat(seatR2.seatId)

  // cancel-turn authorizes via the LIVE declared fact — a transport METHOD
  // with no supporting fact refuses pre-flight.
  const dirK = join(scratch, 'wavea-cancel')
  const cancelNoFact = mkProbe({ withCancel: true })
  const seatK = await bridge.attachExternalSeat(cancelNoFact.transport, { displayName: 'Probe', dir: dirK })
  const refusedCancel = await bridge.cancelSeatTurn(seatK.seatId)
  t.check(
    'cancelSeatTurn refuses when cancel-turn is not a declared fact (method presence never authorizes)',
    refusedCancel.result === 'rejected' && /unknown/.test(refusedCancel.result === 'rejected' ? refusedCancel.reason : ''),
    JSON.stringify(refusedCancel).slice(0, 120),
  )
  // …and an invalidated set refuses even a previously declared cancel.
  const dirK2 = join(scratch, 'wavea-cancel-invalidated')
  const cancelDeclared = mkProbe({
    withCancel: true,
    declared: {
      'hold-next': { state: 'supported', source: 'probe' },
      'cancel-turn': { state: 'supported', source: 'probe' },
    },
  })
  const seatK2 = await bridge.attachExternalSeat(cancelDeclared.transport, { displayName: 'Probe', dir: dirK2 })
  cancelDeclared.fireLifecycle('exited')
  const staleCancel = await bridge.cancelSeatTurn(seatK2.seatId)
  t.check(
    'an invalidated capability set refuses cancel pre-flight (stale facts never authorize)',
    staleCancel.result === 'rejected' && /expired/.test(staleCancel.result === 'rejected' ? staleCancel.reason : ''),
    JSON.stringify(staleCancel).slice(0, 120),
  )
  await bridge.detachExternalSeat(seatK.seatId)
  await bridge.detachExternalSeat(seatK2.seatId)

  // A crashed seat never shadows the live re-attach of the SAME external
  // session: dispatch resolves the connected seat.
  const dirS = join(scratch, 'wavea-shadow')
  const dead = mkProbe({ externalSessionId: 'shared-ext-1' })
  const seatDead = await bridge.attachExternalSeat(dead.transport, { displayName: 'Probe', dir: dirS })
  dead.fireLifecycle('exited')
  const alive = mkProbe({ externalSessionId: 'shared-ext-1' })
  const seatAlive = await bridge.attachExternalSeat(alive.transport, { displayName: 'Probe', dir: dirS })
  t.check('the re-attach of the same external session resolves the SAME agent', seatAlive.agentId === seatDead.agentId)
  const routed = bridge.seatOfAgent(seatAlive.agentId)
  t.check(
    'seatOfAgent resolves the LIVE seat, not the corpse',
    routed !== null && routed.seatId === seatAlive.seatId && routed.lifecycle === 'connected',
    String(routed?.seatId),
  )
  const outcome = await dispatch.dispatchToAgent(
    {
      clientMessageId: 'shadow-1',
      requestedAddress: { agentId: seatAlive.agentId },
      requestedDisposition: 'hold-next',
      instruction: 'route to the living',
      attachments: [],
    },
    { dir: dirS },
  )
  t.check(
    'dispatch after crash-and-reattach delivers through the live seat',
    outcome.state === 'delivered' && alive.deliveries() === 1 && dead.deliveries() === 0,
    `${outcome.state}; live=${alive.deliveries()} dead=${dead.deliveries()}`,
  )
  t.check(
    'the dead seat view exposes its INVALIDATED capability set (no stale advertised facts)',
    bridge.attachedSeatOf(seatDead.seatId)?.capabilities.invalidatedAt !== undefined,
  )
  await bridge.detachExternalSeat(seatDead.seatId)
  await bridge.detachExternalSeat(seatAlive.seatId)

  // (late-proven identity + resume re-attach pins await the codex re-host —
  // the §7 follow-up.)
}

t.finish('prove-seat-bridge')
