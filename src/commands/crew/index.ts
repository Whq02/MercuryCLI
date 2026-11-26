import { randomUUID } from 'node:crypto'
import type { Command } from '../catalogue/commands.js'
import type { LocalCommandCall } from '../catalogue/command.js'
import { crewDirectoryEnabled } from '../../crew/crewmates/identity.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const call: LocalCommandCall = async (args: string, context) => {
  const trimmed = args.trim()
  const [verb, ...rest] = trimmed.split(/\s+/).filter(Boolean)
  if (verb === 'attach') {
    const kind = rest[0]
    const { attachExternalSeat } = await import('../../crew/crewmates/seatBridge.js')
    if (kind === 'codex') {
      const { codexSeatTransport } = await import('../../crew/crewmates/adapters/codex.js')
      const seat = await attachExternalSeat(codexSeatTransport({}))
      return {
        type: 'text',
        value: `· attached ${seat.displayName} — seat ${seat.seatId} · agent ${seat.agentId} · ${seat.protocol} · ${seat.revision}`,
      }
    }
    if (kind === 'opencode' || kind === 'goose' || kind === 'devin') {
      const { acpSeatTransport } = await import('../../crew/crewmates/adapters/acpProfile.js')
      const { getCwd } = await import('../../platform/files/cwd.js')
      const display = kind === 'opencode' ? 'OpenCode' : kind === 'devin' ? 'Devin' : 'goose'
      const getPermissionContext =
        typeof context?.getAppState === 'function'
          ? () => context.getAppState().toolPermissionContext
          : undefined
      try {
        const seat = await attachExternalSeat(
          acpSeatTransport(kind, display, {
            command: [kind, 'acp'],
            cwd: getCwd(),
            ...(getPermissionContext !== undefined ? { getPermissionContext } : {}),
          }),
        )
        return {
          type: 'text',
          value: `· attached ${seat.displayName} — seat ${seat.seatId} · agent ${seat.agentId} · ${seat.protocol} · ${seat.revision}\n  ${seat.displayName} runs its own tools and permissions; Mercury only handles permission requests ${seat.displayName} sends and enforces your path deny rules on them.`,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          type: 'text',
          value: `· attach refused — ${msg}`,
        }
      }
    }
    return {
      type: 'text',
      value: `/crew attach <codex|opencode|goose|devin> — '${kind ?? ''}' is not an attachable adapter`,
    }
  }

  if (verb === 'detach') {
    const seatId = rest[0]
    if (!seatId) return { type: 'text', value: '/crew detach <seat-id>' }
    const { detachExternalSeat } = await import('../../crew/crewmates/seatBridge.js')
    const ok = await detachExternalSeat(seatId)
    return {
      type: 'text',
      value: ok
        ? `· detached ${seatId} — its capability observations are expired`
        : `· no attached seat '${seatId}'`,
    }
  }

  if (verb === 'send') {
    const match = /^send\s+(\S+)\s+([\s\S]+)$/.exec(trimmed)
    if (!match) return { type: 'text', value: '/crew send <seat-id> <prompt>' }
    const seatId = match[1]!
    const prompt = match[2]!
    const { attachedSeatOf } = await import('../../crew/crewmates/seatBridge.js')
    const seat = attachedSeatOf(seatId)
    if (!seat) return { type: 'text', value: `· no attached seat '${seatId}'` }
    const { dispatchToAgent } = await import('../../crew/crewmates/dispatch.js')
    const receipt = await dispatchToAgent({
      clientMessageId: `crew-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      requestedAddress: { agentId: seat.agentId },
      requestedDisposition: 'start-turn',
      instruction: prompt,
      attachments: [],
    })
    return {
      type: 'text',
      value:
        receipt.state === 'delivered'
          ? `· dispatched to ${seat.displayName} (${seat.seatId}) — ${receipt.disposition ?? 'started-turn'} · ${receipt.clientMessageId} (use /crew activity or /crew seats for completion)`
          : `· send ${receipt.state} — ${receipt.reason ?? 'not delivered'}`,
    }
  }

  if (verb === 'cancel') {
    const seatId = rest[0]
    if (!seatId) return { type: 'text', value: '/crew cancel <seat-id>' }
    const { cancelSeatTurn } = await import('../../crew/crewmates/seatBridge.js')
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
    const seatId = rest[0]
    if (!seatId) return { type: 'text', value: '/crew renegotiate <seat-id>' }
    const { renegotiateSeat } = await import('../../crew/crewmates/seatBridge.js')
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
    const { listDeliveryReceipts } = await import('../../crew/crewmates/dispatch.js')
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
    const { lastSeatTurn, listAttachedSeats } = await import('../../crew/crewmates/seatBridge.js')
    const { capabilitiesOf } = await import('../../crew/crewmates/capabilities.js')
    const seats = listAttachedSeats()
    if (seats.length === 0) {
      return { type: 'text', value: 'no attached external seats — /crew attach <codex|opencode|goose|devin>' }
    }
    const lines = seats.map(s => {
      const caps = capabilitiesOf(s.seatId)
      const supported = caps
        ? [...caps.facts.values()].filter(f => f.state === 'supported').map(f => f.kind)
        : []
      const stale = caps?.invalidatedAt !== undefined ? ' · observations EXPIRED' : ''
      const last = lastSeatTurn(s.seatId)
      const overflowDetail =
        last?.replyTruncated === true
          ? last.replyOverflowPath !== undefined
            ? last.replyOmittedChars && last.replyOmittedChars > 0
              ? `; ${last.replySavedChars ?? 0} chars saved at ${last.replyOverflowPath}, ${last.replyOmittedChars} chars omitted above cap`
              : `; full ${last.replySavedChars ?? 0} chars saved at ${last.replyOverflowPath}`
            : `; overflow save failed${last.replySaveError ? `: ${last.replySaveError}` : ''}`
          : ''
      const overflowNote =
        last?.replyTruncated === true
          ? `\n    reply truncated (showing ${last.reply?.length ?? 0} of ${last.replyChars ?? 0} chars${overflowDetail})`
          : ''
      const replyLine = last?.reply ? `\n    reply: ${last.reply}${overflowNote}` : ''
      const turnLine = last
        ? `\n    last turn [${last.clientMessageId}]: ${last.status}${last.stopReason ? ` (${last.stopReason})` : ''}${last.reason ? ` — ${last.reason}` : ''}${replyLine}`
        : ''
      return `${s.seatId} — ${s.displayName} (${s.adapterKind}) · ${s.lifecycle} · ${s.revision}${stale}\n    supported: ${supported.join(', ') || '(none observed)'}${turnLine}`
    })
    return { type: 'text', value: lines.join('\n') }
  }

  if (verb === 'activity') {
    const { cachedActivityFeed, activityRows, activityLineOf } = await import(
      '../../crew/crewmates/activity.js'
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

  const { resolveCrewSnapshot } = await import('../../crew/crewmates/projection.js')
  const snap = await resolveCrewSnapshot()
  if (!snap || snap.members.length === 0) {
    return {
      type: 'text',
      value: 'the crew directory is empty — it fills as this session and attached agents register',
    }
  }
  const { targetPickerRows } = await import('../../crew/crewmates/targetPicker.js')
  const { listSessionDescriptors, renderSessionTitle } = await import(
    '../../crew/crewmates/descriptor.js'
  )
  const picker = new Map(targetPickerRows(snap).map(r => [r.agentId as string, r]))
  const descriptors = await listSessionDescriptors().catch((error) => { passedOver(error); return [] })
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
  seat: 'screen',
  load: () => Promise.resolve({ call }),
} satisfies Command

export default crew
