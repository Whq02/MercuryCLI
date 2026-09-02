// ============================================================================
//  scribeAwareness — the per-turn Scribe-side awareness <system-reminder> (W3c).
// ----------------------------------------------------------------------------
//  The static pack (scribePack.ts) bakes in WHO the Scribe is at spawn; this
//  carries the DYNAMIC state that changes each turn: the live-bus boolean and the
//  last-known dispatched-work state, derived from the honest-by-construction bus
//  ledger (buildScribeLedger). Modeled on implementerFraming.ts — a role-gated
//  builder that returns '' (⇒ no attachment ⇒ byte-identical) when off.
//
//  Returns RAW content (no <system-reminder> envelope) — the attachment normalizer
//  (messages.ts case 'scribe_awareness') wraps it once via wrapMessagesInSystemReminder.
//
//  Pure + side-effect-free (gates read env/build constant; buildScribeLedger is a
//  pure transcript transform) so it is unit-testable under `bun run`.
// ============================================================================
import { scribeModeEnabled, isImplementerRole, scribeBusLiveEnabled, scribeBackPressureEnabled, scribeChatroomEnabled } from './scribeGates.js'
import { isScribeModeOn } from '../scribeMode.js'
import { getBatchMode, isBatchApproved } from './scribeBatchGate.js'
import { buildScribeLedger, countOpenDispatches, computeScribeAttention } from '../../components/mercury-ui/scribeChatTabs.js'
import { parseScribeEnvelope } from './scribeBus.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { getImplementerTelemetry } from './implementerTelemetry.js'
import { fmtElapsedMs } from '../time.js'

/** How many ledger entries (in dispatch order) the reminder surfaces. */
const LEDGER_TAIL = 3

/** A turn running this long flips the MID-TASK clause to an honest "running long /
 *  may be wedged" heads-up — mirrors the /daemon cockpit's stall threshold
 *  (daemonSupervisorRows STALL_MS) so the Scribe and the cockpit agree. */
const SCRIBE_STALL_MS = 600_000 // 10 min

/**
 * Build the Scribe awareness reminder CONTENT for this turn, or '' when this is
 * not the foreground Scribe / scribe mode is off (⇒ no attachment ⇒ byte-identical).
 * Gate is `scribeModeEnabled() && isScribeModeOn() && !isImplementerRole()`. Gate on
 * the MODE, not the role env (isScribeRole): the /model carousel engage flips only the
 * module boolean (setScribeMode), never MERCURY_SCRIBE, so an isScribeRole() gate left
 * this reminder DEAD on the operator's actual engage path (only a MERCURY_SCRIBE=1 launch
 * set the env) — inconsistent with the persona/doctrine, which already gate on the mode.
 * The AND is essential — scribeModeEnabled() alone is true in EVERY fork process;
 * isScribeModeOn() is the per-session toggle. The !isImplementerRole() term restores the
 * XOR the role env would otherwise give for free (the Implementer gets implementerAwareness, never
 * this) — defensive, even though the Implementer never engages scribe mode.
 */
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

  // #43 R2b — LIVE backend telemetry (so you are not blind): the foreground poll publishes
  // the daemon Implementer's real state; surface it ONLY when the daemon has actually
  // answered (never fabricate). Lets you route around a near-full / wedged backend and
  // report honestly. Internal — never narrate the numbers to the operator.
  if (scribeBusLiveEnabled()) {
    const t = getImplementerTelemetry()
    if (t.daemonUp && t.present && !t.settled) {
      const ctx = typeof t.contextPct === 'number' ? `, context ~${Math.round(t.contextPct)}%` : ''
      const re = t.respawns && t.respawns > 0 ? `, ${t.respawns} restart${t.respawns > 1 ? 's' : ''}` : ''
      // elapsed-on-turn (busy-only): how long it's been on THIS dispatch, so you stop
      // being time-blind. Past the stall threshold the guidance flips — a turn running
      // this long may be wedged, so be honest with the operator instead of reassuring.
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
      // EMPTY cache (daemonUp:false — the poll has not answered yet) OR present:false / settled ⇒ NO
      // confirmed-live backend. THE mechanical fabrication guard: a daemonUp:false that emits NO
      // line leaves the liveness clause uncontested and the model invents a reply. Any non-live
      // state positively says "not confirmed live" (advisory, not a hard "dead" — a starting daemon may
      // answer next poll), so the model never claims a reply that hasn't landed.
      parts.push(
        'Backend state (internal): there is NO confirmed-live Implementer right now (the backend has not ' +
          'answered yet, or no healthy worker is in the roster). Be honest with the operator that you cannot ' +
          'take execution on at the moment; do the legitimate refining you can, and don’t claim work is underway.',
      )
    }
  }

  // #47 /batch: when the operator has PAUSED dispatching (manual hold), surface it so
  // the Scribe holds new work gracefully instead of fighting the source gate — it keeps
  // refining/clarifying/relaying meanwhile, and may drop a queued item that has become
  // obsolete (but should not routinely prune the operator's queue). Auto ⇒ no clause.
  if (getBatchMode() === 'manual' && !isBatchApproved()) {
    parts.push(
      'The operator has PAUSED dispatching (a /batch hold): do NOT send new work to the Implementer until they ' +
        'approve the batch. Keep refining, clarifying, and relaying meanwhile. You may drop a queued item that has ' +
        'clearly become obsolete, but do not routinely prune the operator’s queued work.',
    )
  }

  parts.push(renderLedgerState(messages))

  // Dispatch discipline (#29 back-pressure + #30 batching): when work is already in
  // flight, advise HOLD / fold / supersede instead of stacking dispatches onto a busy
  // Implementer. Derived from the transcript ledger (countOpenDispatches) — no daemon
  // RPC on this sync render path. Gated; OFF ⇒ no clause ⇒ byte-identical.
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

  // Attention salience (#33): if an escalate/blocked/failed/done just landed in the
  // recent tail, make it SALIENT so the Scribe acts on it this turn (turn-end-tied,
  // not a blind timer). Advisory only — this rides the isMeta/null-rendering awareness
  // attachment, never an operator-visible turn; it NEVER auto-escalates or notifies.
  // Recency-bounded ⇒ self-quiets. '' when nothing landed ⇒ no line.
  // Surface-aware relay verb (must-fix #3): in DEFAULT mode the keystone denies the
  // Scribe Brief/SendUserMessage, so its typed prose IS its only operator surface —
  // telling it to relay "via SendUserMessage" names a tool it does NOT have and re-invites
  // the very double the keystone removed. CHATROOM mode keeps Brief, so SendUserMessage is
  // right there. (After the mode-gate fix above these clauses also fire on the carousel
  // path, so the phrasing must be correct in default mode too.)
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

/**
 * Surface-aware DONE clause (C1). The chatroom is default-ON
 * (scribeChatroomEnabled, opt out MERCURY_SCRIBE_CHATROOM=0). In CHATROOM mode the
 * Implementer's OWN done line already rendered nameplated + timestamped straight to
 * the operator as [Mercury-Implement] — the operator has already SEEN it — so a Scribe
 * re-relay/restate of that same result via SendUserMessage is a literal double-message
 * (the recurring complaint). So in chatroom mode we do NOT instruct relaying/restating
 * it to the operator; the Scribe acknowledges/closes INTERNALLY (note the completion,
 * advance the next dispatch or wait) and only speaks up if there is something genuinely
 * NEW to add. In DEFAULT (single-surface) mode the operator never saw the Implementer's
 * envelope, so the Scribe's typed prose IS the only operator-facing surface — keep the
 * existing "relay the result in your own prose" wording (and never "via SendUserMessage":
 * the default-mode keystone denies the Scribe that tool — see relayToOperator above).
 */
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

/**
 * Render the dispatched-work state from the bus ledger. The ledger is
 * dispatch-ordered with NO advancement timestamp, so we surface the LAST N entries
 * in dispatch order and mark the most-recently-dispatched one's detail — never
 * claiming a "most-recently-advanced" recency the data can't support. Empty ⇒ an
 * explicit "nothing dispatched" line (so the Scribe never confabulates in-flight work).
 */
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

/**
 * Does this turn's assistant output contain a Scribe BUS action (a SendMessage
 * dispatch/escalate/progress) that ACTUALLY DELIVERED? The Scribe's correct resting
 * state after dispatching is "I dispatched, now I wait for the bus reply" — but the
 * brief stop-hook only credits SendUserMessage, so a dispatch-and-wait turn gets
 * double-nagged (brief "speak now" + keep-working "dispatch and continue"), which the
 * transcripts show resolving into a hallucinated routing failure. The brief enforcer
 * consults this (scribe-role only) to treat a bus action as a satisfied turn.
 *
 * Work-item #1: an ATTEMPTED send is NOT a delivered report. A failed mailbox write
 * does NOT throw — the scribe-envelope path returns { success: false, … } (a clean
 * tool execution with a falsey payload), so the matching tool_result carries no
 * `is_error`. So we revoke the credit for an envelope whose matching tool_result is a
 * FAILURE — `is_error` on the result block OR `success === false` on the frame's native
 * toolUseResult. An envelope with NO matching result yet stays credited (genuinely
 * in-flight) — that preserves the prior semantics for the assistant-only caller
 * (which sees no tool_result frames) and never re-nags a turn that really did dispatch.
 * Pure + defensive over the runtime message shape so it's unit-testable under `bun run`.
 */
export function briefTurnSatisfiedByScribeBus(assistantMessages: readonly unknown[]): boolean {
  const BUS_KINDS = new Set(['dispatch', 'escalate', 'progress'])
  for (const raw of assistantMessages) {
    const m = raw as { type?: string; message?: { content?: unknown } }
    if (m?.type !== 'assistant' || !Array.isArray(m.message?.content)) continue
    for (const b of m.message!.content as Array<{ type?: string; id?: string; name?: string; input?: { message?: unknown } }>) {
      if (b?.type !== 'tool_use' || b.name !== SEND_MESSAGE_TOOL_NAME) continue
      const inner = b.input?.message
      // Structured form: { type: 'dispatch' | 'escalate' | 'progress', … }.
      const structured =
        inner && typeof inner === 'object' && BUS_KINDS.has((inner as { type?: string }).type ?? '')
      // Serialized-string form: parse the bus envelope and check its kind.
      const serialized =
        typeof inner === 'string' && (() => {
          const env = parseScribeEnvelope(inner)
          return !!env && BUS_KINDS.has(env.kind)
        })()
      // Only credit a send that DELIVERED: skip one whose matching tool_result failed
      // (is_error or success:false). No result yet ⇒ in-flight ⇒ credited (unchanged).
      if ((structured || serialized) && !scribeBusSendFailed(b.id, assistantMessages)) return true
    }
  }
  return false
}

/**
 * Did the SendMessage `tool_use` with this id resolve to a FAILED delivery in the
 * window? True only when a matching tool_result is PRESENT and is a failure — an
 * `is_error` result block, or a native toolUseResult reporting `success: false` (the
 * shape a dropped mailbox write returns without setting is_error). Absent result ⇒
 * false (treated as in-flight, not failed). Defensive over the runtime shape.
 */
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
