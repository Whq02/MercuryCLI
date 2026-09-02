import { scribeModeEnabled, isImplementerRole, scribeBusLiveEnabled, scribeBackPressureEnabled, scribeChatroomEnabled } from './scribeGates.js'
import { isScribeModeOn } from '../scribeMode.js'
import { getBatchMode, isBatchApproved } from './scribeBatchGate.js'
import { buildScribeLedger, countOpenDispatches, computeScribeAttention } from '../../components/mercury-ui/scribeChatTabs.js'
import { parseScribeEnvelope } from './scribeBus.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { getImplementerTelemetry } from './implementerTelemetry.js'
import { fmtElapsedMs } from '../time.js'

const LEDGER_TAIL = 3

const SCRIBE_STALL_MS = 600_000

export function buildScribeAwarenessReminder(messages: readonly unknown[]): string {
  if (!(scribeModeEnabled() && isScribeModeOn()) || isImplementerRole()) return ''

  const chatroom = scribeChatroomEnabled()
  const parts: string[] = []
  parts.push(
    chatroom
      ? 'You and a long-lived Implementer converse in a shared chat the operator OBSERVES. Address the ' +
          'Implementer directly by name; it answers you; the operator watches and talks to you. Never post a ' +
          'reply on the Implementer’s behalf, and never narrate or invent its work — until a REAL Implementer ' +
          'message appears in the chat, nothing has come back. Do not expose pids, effort, or model ids.'
      : 'You are the Scribe — the only surface the operator talks to. Speak as one transparent ' +
          'assistant; never narrate the two-process split, the bus, hooks, the daemon, mode names, ' +
          'model ids, or effort to the operator.',
  )

  if (scribeBusLiveEnabled()) {
    parts.push(
      'When the operator hands you ACTIONABLE intent, refine it into a crisp spec and dispatch it over the bus' +
        (chatroom ? ' (speak TO the Implementer in-chat by name)' : '') +
        '. Remember, a successful send means the message was WRITTEN to the bus; it does NOT prove an ' +
        'Implementer received it or ran it. Until a REAL Implementer reply actually lands' +
        (chatroom ? ' in the chat' : '') +
        ', nothing has come back: NEVER narrate, summarize, claim, or invent an Implementer reply or its ' +
        'progress (that is the fabrication to avoid). So just be honest that you are waiting — and equally ' +
        'do not invent a failure when a send genuinely succeeded. ' +
        'But if this turn has NOTHING to dispatch yet — a bare/greeting/content-free intake ("test", "hi", ' +
        '"you there?"), or you are simply waiting on the operator — answer in ONE short line and STOP: do NOT ' +
        'emit another ack, re-ask the same question, or narrate that you are waiting (the clean stop IS the wait).',
    )
  } else {
    parts.push(
      'The live bus is off this session, so there is no Implementer to dispatch to right now. Do the ' +
        'legitimate refining/clarifying you can, and be honest that you cannot take execution on right ' +
        'now — never claim work is underway when it is not. And if this turn has nothing to act on yet — a ' +
        'bare/greeting/content-free intake ("test", "hi", "you there?"), or you are simply waiting on the ' +
        'operator — answer in ONE short line and STOP; do NOT stack a second readiness line or narrate that ' +
        'you are waiting (the clean stop is the wait).',
    )
  }

  if (scribeBusLiveEnabled()) {
    const t = getImplementerTelemetry()
    if (t.daemonUp && t.present && !t.settled) {
      const ctx = typeof t.contextPct === 'number' ? `, context ~${Math.round(t.contextPct)}%` : ''
      const re = t.respawns && t.respawns > 0 ? `, ${t.respawns} restart${t.respawns > 1 ? 's' : ''}` : ''
      const elapsedMs = t.turnElapsedMs
      const forStr =
        typeof elapsedMs === 'number' && elapsedMs > 0 ? ` for ~${fmtElapsedMs(elapsedMs)}` : ''
      const stalled = typeof elapsedMs === 'number' && elapsedMs > SCRIBE_STALL_MS
      parts.push(
        t.busy
          ? stalled
            ? `Backend state (internal): the Implementer has been MID-TASK${forStr}${ctx}${re} — that is UNUSUALLY long and it may be wedged. Be honest with the operator that it is taking a while (it is still working / may need a check); do NOT claim it finished, invent a reply, or stack another dispatch behind it.`
            : `Backend state (internal): the Implementer is MID-TASK${forStr}${ctx}${re} — hold/fold a new dispatch behind it (one at a time); it is not stuck just because a reply hasn't landed yet.`
          : `Backend state (internal): the Implementer is IDLE${ctx}${re} — ready for the next dispatch.` +
              (typeof t.contextPct === 'number' && t.contextPct >= 80
                ? ' Its context is near full — it auto-clears at a turn boundary; you may also clear it now if the next task is a clean topic switch.'
                : ''),
      )
    } else {
      parts.push(
        'Backend state (internal): there is NO confirmed-live Implementer right now (the backend has not ' +
          'answered yet, or no healthy worker is in the roster). Be honest with the operator that you cannot ' +
          'take execution on at the moment; do the legitimate refining you can, and don’t claim work is underway.',
      )
    }
  }

  if (getBatchMode() === 'manual' && !isBatchApproved()) {
    parts.push(
      'The operator has PAUSED dispatching (a /batch hold): do NOT send new work to the Implementer until they ' +
        'approve the batch. Keep refining, clarifying, and relaying meanwhile. You may drop a queued item that has ' +
        'clearly become obsolete, but do not routinely prune the operator’s queued work.',
    )
  }

  parts.push(renderLedgerState(messages))

  if (scribeBackPressureEnabled()) {
    let open = 0
    try {
      open = countOpenDispatches(messages).open
    } catch {
      open = 0
    }
    if (open > 0) {
      parts.push(
        `You have ${open} dispatch${open > 1 ? 'es' : ''} still in flight to the Implementer. HOLD a new ` +
          'dispatch until it reports done or blocked — refine/clarify what you can meanwhile — UNLESS the ' +
          'operator explicitly told you to queue (then dispatch and note it is queued behind the current ' +
          'work). If the operator sends a CORRECTION to work already in flight, SUPERSEDE: send ONE dispatch ' +
          'that replaces the prior step, never stack a contradicting one. Batch related asks (same ' +
          'files/feature, or an ordered sequence) into ONE ordered dispatch; keep genuinely independent asks ' +
          'separate so the Implementer can parallelize.',
      )
    }
  }

  const relayToOperator = chatroom ? 'via SendUserMessage' : 'in your own prose'
  const attn = computeScribeAttention(messages)
  if (attn.kind === 'escalate') {
    parts.push(
      `The Implementer just ESCALATED${attn.needsOperator ? ' (it flagged this as operator-level)' : ''}` +
        `${attn.detail ? `: "${attn.detail}"` : ''}. Resolve it now as the operator’s proxy — or, ONLY if the ` +
        `decision is genuinely theirs, put it to the operator ${relayToOperator}. Do not sit on it.`,
    )
  } else if (attn.kind === 'blocked' || attn.kind === 'failed') {
    parts.push(
      `The Implementer reports ${attn.kind.toUpperCase()}${attn.detail ? `: "${attn.detail}"` : ''}. Unblock it ` +
        `(re-dispatch a corrected/clarified spec) or, if it needs the operator, relay ${relayToOperator}.`,
    )
  } else if (attn.kind === 'done') {
    parts.push(doneClause(chatroom, attn.detail))
  }

  parts.push(
    'Nothing is running unless a status appears above. Ending on ONE tight option-bearing (or open ' +
      'intake) question to the operator — asked once — is a valid resting point; a clean stop with no ' +
      'follow-up readiness line is itself the wait. Acting as the operator’s proxy never ' +
      'licenses bypassing a permission, approval, capability, or refusal gate.',
  )

  return parts.join('\n\n')
}

function doneClause(chatroom: boolean, detail?: string): string {
  const d = detail ? `: "${detail}"` : ''
  if (chatroom) {
    return (
      `The Implementer reports DONE${d}. The operator already saw that nameplated [Mercury-Implement] ` +
      `line in the chat, so do NOT re-relay or restate it to them (that is a double-message) — acknowledge ` +
      `it internally (note the completion, advance the next dispatch or wait), and only speak up if you have ` +
      `something genuinely NEW to add. Never paste the raw envelope.`
    )
  }
  return (
    `The Implementer reports DONE${d}. Confirm it and relay the result to the operator in your own prose ` +
    `— never paste the raw envelope.`
  )
}

function renderLedgerState(messages: readonly unknown[]): string {
  let ledger: Array<{ status: string; title: string; detail?: string }>
  try {
    ledger = buildScribeLedger(messages)
  } catch {
    ledger = []
  }
  if (ledger.length === 0) {
    return 'Dispatched-work state: no work has been dispatched to the Implementer this session.'
  }
  const tail = ledger.slice(-LEDGER_TAIL)
  const rows = tail.map(e => `- [${e.status}] ${e.title}`).join('\n')
  const latest = tail[tail.length - 1]
  const latestLine = `  latest (most recently dispatched): ${latest.status}${latest.detail ? `: ${latest.detail}` : ''}`
  return (
    'Dispatched-work state (derived from the bus ledger, not asserted — report only what is here, in ' +
    'your own voice; never paste it):\n' +
    rows +
    '\n' +
    latestLine
  )
}

export function briefTurnSatisfiedByScribeBus(assistantMessages: readonly unknown[]): boolean {
  const BUS_KINDS = new Set(['dispatch', 'escalate', 'progress'])
  for (const raw of assistantMessages) {
    const m = raw as { type?: string; message?: { content?: unknown } }
    if (m?.type !== 'assistant' || !Array.isArray(m.message?.content)) continue
    for (const b of m.message!.content as Array<{ type?: string; id?: string; name?: string; input?: { message?: unknown } }>) {
      if (b?.type !== 'tool_use' || b.name !== SEND_MESSAGE_TOOL_NAME) continue
      const inner = b.input?.message
      const structured =
        inner && typeof inner === 'object' && BUS_KINDS.has((inner as { type?: string }).type ?? '')
      const serialized =
        typeof inner === 'string' && (() => {
          const env = parseScribeEnvelope(inner)
          return !!env && BUS_KINDS.has(env.kind)
        })()
      if ((structured || serialized) && !scribeBusSendFailed(b.id, assistantMessages)) return true
    }
  }
  return false
}

function scribeBusSendFailed(toolUseId: string | undefined, window: readonly unknown[]): boolean {
  if (!toolUseId) return false
  for (const raw of window) {
    const m = raw as { type?: string; toolUseResult?: unknown; message?: { content?: unknown } }
    if (m?.type !== 'user' || !Array.isArray(m.message?.content)) continue
    const block = (m.message!.content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean }>).find(
      c => c?.type === 'tool_result' && c.tool_use_id === toolUseId,
    )
    if (!block) continue
    if (block.is_error) return true
    return (m.toolUseResult as { success?: boolean } | undefined)?.success === false
  }
  return false
}
