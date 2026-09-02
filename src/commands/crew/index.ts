import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { crewDirectoryEnabled } from '../../services/crew/identity.js'

/**
 * /crew — the living-crew directory command.
 *
 *   /crew                       the member directory (identity · presence ·
 *                               lifecycle · focus · sendable endpoint ·
 *                               descriptor title, off the ONE projection +
 *                               the ONE target picker)
 *   /crew seats                 the attached external seats + their observed
 *                               tri-state capabilities
 *   /crew activity              the newest semantic activity rows
 *   /crew receipts              the newest delivery receipts (state ·
 *                               disposition · per-part outcomes)
 *   /crew attach <kind>         attach an external seat — codex · opencode ·
 *                               goose (real handshakes; a missing CLI fails
 *                               fast with the reason)
 *   /crew detach <seat-id>      detach a seat (expires its capability facts)
 *   /crew cancel <seat-id>      cancel the seat's turn (pre-flighted through
 *                               its LIVE declared cancel-turn fact)
 *   /crew renegotiate <seat-id> fresh handshake (the old set invalidates
 *                               FIRST — the documented recovery verb)
 *
 * The richer board surface (the attention inbox + the dispatch composer) is
 * /workbench; this command is the directory's first-class terminal entry.
 */
const call: LocalCommandCall = async (args: string) => {
  const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean)

  if (verb === 'attach') {
    const kind = rest[0]
    const { attachExternalSeat } = await import('../../services/crew/seatBridge.js')
    if (kind === 'codex') {
      const { codexSeatTransport } = await import('../../services/crew/adapters/codex.js')
      const seat = await attachExternalSeat(codexSeatTransport({}))
      return {
        type: 'text',
        value: `· attached ${seat.displayName} — seat ${seat.seatId} · agent ${seat.agentId} · ${seat.protocol} · ${seat.revision}`,
      }
    }
    if (kind === 'opencode' || kind === 'goose') {
      // ACP v1 seats — the handshake is real; a missing CLI fails FAST with
      // the spawn reason (the wave-A error-owned child), never a silent hang.
      const { acpSeatTransport } = await import('../../services/crew/adapters/acpProfile.js')
      const display = kind === 'opencode' ? 'OpenCode' : 'goose'
      const seat = await attachExternalSeat(
        acpSeatTransport(kind, display, { command: [kind, 'acp'] }),
      )
      return {
        type: 'text',
        value: `· attached ${seat.displayName} — seat ${seat.seatId} · agent ${seat.agentId} · ${seat.protocol} · ${seat.revision}`,
      }
    }
    return {
      type: 'text',
      value: `/crew attach <codex|opencode|goose> — '${kind ?? ''}' is not an attachable adapter`,
    }
  }

  if (verb === 'detach') {
    const seatId = rest[0]
    if (!seatId) return { type: 'text', value: '/crew detach <seat-id>' }
    const { detachExternalSeat } = await import('../../services/crew/seatBridge.js')
    const ok = await detachExternalSeat(seatId)
    return {
      type: 'text',
      value: ok
        ? `· detached ${seatId} — its capability observations are expired`
        : `· no attached seat '${seatId}'`,
    }
  }

  if (verb === 'cancel') {
    // M10: the cancel verb — pre-flighted through the seat's LIVE declared
    // cancel-turn fact (method presence never authorizes).
    const seatId = rest[0]
    if (!seatId) return { type: 'text', value: '/crew cancel <seat-id>' }
    const { cancelSeatTurn } = await import('../../services/crew/seatBridge.js')
    const outcome = await cancelSeatTurn(seatId)
    return {
      type: 'text',
      value:
        outcome.result === 'accepted'
          ? `· cancel accepted by ${seatId} (${outcome.adapterOutcome ?? 'interrupted'})`
          : `· cancel ${outcome.result} — ${outcome.reason}`,
    }
  }

  if (verb === 'renegotiate') {
    // M10: the documented recovery verb the refusal copy points at —
    // invalidates the old set BEFORE the fresh handshake records.
    const seatId = rest[0]
    if (!seatId) return { type: 'text', value: '/crew renegotiate <seat-id>' }
    const { renegotiateSeat } = await import('../../services/crew/seatBridge.js')
    try {
      const seat = await renegotiateSeat(seatId)
      return {
        type: 'text',
        value: seat
          ? `· renegotiated ${seatId} — fresh capability set recorded (${seat.protocol} · ${seat.revision})`
          : `· no attached seat '${seatId}'`,
      }
    } catch (e) {
      return { type: 'text', value: `· renegotiation failed — ${String(e).slice(0, 140)}` }
    }
  }

  if (verb === 'receipts') {
    // M10: the delivery-receipt surface — state · disposition · per-part
    // outcomes, straight off the durable receipts store.
    const { listDeliveryReceipts } = await import('../../services/crew/dispatch.js')
    const receipts = await listDeliveryReceipts()
    if (receipts.length === 0) {
      return { type: 'text', value: 'no delivery receipts yet — dispatches record here' }
    }
    const lines = receipts.slice(-15).map(r => {
      const parts =
        r.attachmentOutcomes.length > 0
          ? ` · parts ${r.attachmentOutcomes.filter(a => a.outcome === 'accepted').length}/${r.attachmentOutcomes.length} accepted`
          : ''
      return `${r.clientMessageId} — ${r.state}${r.disposition ? ` · ${r.disposition}` : ''}${parts}${r.reason ? ` · ${r.reason.slice(0, 60)}` : ''}`
    })
    return { type: 'text', value: lines.join('\n') }
  }

  if (verb === 'seats') {
    const { listAttachedSeats } = await import('../../services/crew/seatBridge.js')
    const { capabilitiesOf } = await import('../../services/crew/capabilities.js')
    const seats = listAttachedSeats()
    if (seats.length === 0) {
      return { type: 'text', value: 'no attached external seats — /crew attach <codex|opencode|goose>' }
    }
    const lines = seats.map(s => {
      const caps = capabilitiesOf(s.seatId)
      const supported = caps
        ? [...caps.facts.values()].filter(f => f.state === 'supported').map(f => f.kind)
        : []
      const stale = caps?.invalidatedAt !== undefined ? ' · observations EXPIRED' : ''
      return `${s.seatId} — ${s.displayName} (${s.adapterKind}) · ${s.lifecycle} · ${s.revision}${stale}\n    supported: ${supported.join(', ') || '(none observed)'}`
    })
    return { type: 'text', value: lines.join('\n') }
  }

  if (verb === 'activity') {
    const { cachedActivityFeed, activityRows, activityLineOf } = await import(
      '../../services/crew/activity.js'
    )
    const rows = activityRows(cachedActivityFeed())
    if (rows.length === 0) {
      return { type: 'text', value: 'no external activity yet — attach a seat (/crew attach …) and give it work' }
    }
    return {
      type: 'text',
      value: rows
        .slice(-20)
        .map(r => `${r.class.padEnd(17)} ${activityLineOf(r)}`)
        .join('\n'),
    }
  }

  const { resolveCrewSnapshot } = await import('../../services/crew/projection.js')
  const snap = await resolveCrewSnapshot()
  if (!snap || snap.members.length === 0) {
    return {
      type: 'text',
      value: 'the crew directory is empty — it fills as this session and attached agents register',
    }
  }
  // M10: the directory rides the ONE target picker (endpoint truth — the
  // same rows every composer cycles) and renders descriptor titles through
  // the ONE renderer where a session published one.
  const { targetPickerRows } = await import('../../services/crew/targetPicker.js')
  const { listSessionDescriptors, renderSessionTitle } = await import(
    '../../services/crew/descriptor.js'
  )
  const picker = new Map(targetPickerRows(snap).map(r => [r.agentId as string, r]))
  const descriptors = await listSessionDescriptors().catch(() => [])
  const rows = snap.members.map(m => {
    const lifecycle = m.lifecycle ? ` · ${m.lifecycle.state}` : ''
    const focus = m.focus ? ` · ${m.focus.label}` : ''
    const p = picker.get(m.agentId as string)
    const sendable = p?.dispatchable ? ` · sendable (${p.endpoint})` : ''
    const desc = descriptors.find(d => (d.agentId as string) === (m.agentId as string) && d.retiredAt === undefined)
    const title = desc
      ? ` · ${renderSessionTitle({
          agentLabel: m.label,
          ...(desc.missionRef !== undefined ? { missionLabel: desc.missionRef } : {}),
          ...(desc.worktreeRef !== undefined ? { worktreeLabel: desc.worktreeRef } : {}),
        })}`
      : ''
    return `${m.label} — ${m.presence.state}${lifecycle}${focus}${sendable}${title}`
  })
  return {
    type: 'text',
    value: `${rows.join('\n')}\n(sources: identity ${snap.sources.identity.state} · workbench ${snap.sources.workbench.state})`,
  }
}

const crew = {
  type: 'local',
  name: 'crew',
  needsConcourse: true,
  description: 'The living-crew directory — members, presence, external seat attach/detach',
  isEnabled: () => crewDirectoryEnabled(),
  supportsNonInteractive: true,
  // The crew directory (and its attach/detach verbs) reads and mutates the
  // SCREEN process's seats — executed in a session runner it reports the
  // runner's own empty estate and spins a phantom turn (operator report):
  // Screen seat; the receipt paints as display rows.
  seat: 'screen',
  load: () => Promise.resolve({ call }),
} satisfies Command

export default crew
