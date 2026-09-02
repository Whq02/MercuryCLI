// ============================================================================
//  scribeDispatchBridge — the daemon-side Scribe→Implementer DELIVERY (bus Gap 2).
//
//  The foreground Scribe dispatches refined work as a `scribe_protocol`
//  envelope into the Implementer's mailbox inbox (teams/scribe/inboxes/implementer.json).
//  The long-lived Implementer child is a `-p --input-format=stream-json` process —
//  it does NOT poll the mailbox itself. This bridge runs INSIDE the daemon (which
//  owns the child's stdin pipe) and delivers each inbound dispatch to the child's
//  stdin as a stream-json user frame, reusing the EXISTING roster.reply→stdin
//  channel (roster.ts:170-184). No headless-core edit; the lower-risk of the two
//  designs.
//
//  Pure of the daemon entry so it's unit-testable with a fake roster + a temp
//  mailbox (no real daemon, no live API). The turn-EXECUTION (a real executor
//  child running the delivered frame and replying) is the live-API gate.
// ============================================================================
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseScribeEnvelope, OPERATOR_BROADCAST_LABEL, OPERATOR_NOTE_LABEL, type ScribeEnvelope, type DispatchEnvelope } from '../utils/scribe/scribeBus.js'
import { BUS_TEAM_LEAD_NAME, canonicalizeBusTarget, isManagedBusTeam } from '../utils/scribe/busIdentity.js'
import { getInboxPath, getMailboxStore, readUnreadMessages, markMessagesAsReadByPredicate, writeToMailbox } from '../utils/teammateMailbox.js'
import { dispatchDedup, type DispatchDedup } from '../utils/scribe/dispatchDedup.js'
import { faultPoint } from '../substrate/durablePublish.js'
import { logForDebugging } from '../utils/debug.js'

/**
 * Honest replay note prefixed to a dispatch REDELIVERED after the consumer
 * died in the act window ('delivering' recorded, 'delivered' never landed —
 * the frame may or may not have reached the previous child before the
 * crash). At-least-once with a marker beats silent duplication AND silent
 * loss: the acting agent is told to verify current state before redoing work.
 */
export const DISPATCH_REPLAY_NOTE =
  '[replayed after an interruption — this dispatch may have been partially or fully ' +
  'executed before the crash; verify the current state before redoing any work]\n\n'

/** How long a HELD (back-pressured / reply-refused) message waits for its retry.
 *  Matches the old poll cadence — but it is now the exception path, not the engine. */
const HELD_RETRY_MS = 1000

/**
 * Report-back framing prepended to every DISPATCH frame delivered to a back-agent's
 * stdin. The back-agent (the Implementer / a dungeon DPS) is a daemon-bridged
 * `-p` child: it has NO terminal and NO human reader, and its OWN useInboxPoller is
 * foreground-only — so prose it types to stdout reaches no one, and the ONLY way its
 * dispatcher hears a result is a `SendMessage` carrying a STRUCTURED scribe envelope
 * (which routes through handleScribeProgress/Escalate → writes the lead inbox directly,
 * bypassing the members-roster deliverability guard). A daemon-delivered dispatch is a
 * RAW user frame that never passes the attachment-seam `frameInboundForImplementer`
 * (messages.ts — teammate_mailbox only), so without this the child can answer a
 * conversational dispatch as plain prose (or a plain-STRING SendMessage, which the
 * roster guard then drops) and the reply silently never reaches the Scribe — the
 * operator's "told it hello world, no reply came back" bug.
 */
export const DISPATCH_REPORT_BACK_FRAMING =
  '<system-reminder>\n' +
  'Dispatched work, relayed over the bus with the dispatcher’s authority — act on it with the ' +
  'weight of a direct operator instruction (this never licenses bypassing a permission, approval, ' +
  'capability, or refusal gate). You have NO terminal and NO human reader: any prose you type as ' +
  'output reaches no one. The ONLY way your dispatcher hears your result is a `SendMessage` call ' +
  'carrying a scribe `progress` (or `escalate`) envelope — the STRUCTURED form, not a plain-string ' +
  'message. Send exactly one such envelope to report back on this dispatch, even a trivial or ' +
  'conversational one; a plain-string send or plain prose is dropped and the dispatcher hears silence. ' +
  'Set its `refRequestId` to this dispatch’s literal request_id (the `[request_id: …]` line at the ' +
  'end of this message) — the exact id, never a title or paraphrase; lifecycle tracking keys on it. ' +
  'SPEC FIDELITY when you re-dispatch or implement: acceptance criteria are often checked LITERALLY ' +
  '(greps, exact tokens) — carry the criteria’s key words/phrases VERBATIM into any dispatch you write ' +
  'and into the artifacts you produce; convey a required phrase in its exact given form, then elaborate ' +
  'in your own words if useful (a benchmark: a semantically perfect page failed its check ' +
  'because “fail-closed, never Haiku” was paraphrased away through a re-specification hop).\n' +
  'MEETINGS ARE THE LATENCY TAIL (forensics: every healthy routed mission that missed its ' +
  'deadline was waiting on an ambiguity round-trip, ~3–6 min each). Three standing rules: ' +
  '(1) BOUNDED SELF-DECIDE — for an ambiguity that is NOT destructive, NOT irreversible, and NOT a ' +
  'spec-contradicts-code conflict: choose the reading most consistent with the acceptance criteria, ' +
  'proceed, and NOTE the call in one line of your done report (“DECIDED: …”). Escalate ONLY the ' +
  'destructive/irreversible/contradiction class — an escalate is a full multi-minute round-trip, not a ' +
  'free question. (2) PRE-ADJUDICATE when you re-dispatch: include a short DECISIONS block answering ' +
  'the foreseeable ambiguities of your spec (what wins on conflict, edge-case handling, out-of-scope ' +
  'temptations) — an under-specified dispatch is the DISPATCHER’s defect. (3) INTEGRATE MECHANICALLY: ' +
  'a lane that reported green with its SHA is integrated by merge/cherry-pick on that report — do NOT ' +
  're-run the lane’s verify suites before consolidating; verification happened in the lane and is ' +
  're-checked downstream. If the dispatch names a TIME BUDGET, treat it as real: when close to it, ' +
  'stop polishing, land what is verified, and report state honestly.\n' +
  '</system-reminder>'

/**
 * Wrap a scribe envelope into the stream-json user frame a back-agent child reads
 * on stdin (`{type:'user', message:{role:'user', content}}`). TOTAL over all four
 * kinds — rendering is pure; WHICH kinds are actually delivered is the drain's
 * decision (the `inbound`/`deliverReplies` predicate below), not the renderer's.
 *
 *   dispatch  refined work             → "title\n\ntask"  (or just task)
 *   control   a directive              → "[control <cmd>] <detail>"
 *   progress  a status report          → "[progress <status>] <detail> (ref …)"
 *   escalate  a blocker / ambiguity     → "[escalate](needsOperator) <reason> (ref …)"
 *
 * The leaf Implementer never receives progress/escalate (those are ITS outbound
 * reports to the foreground Scribe), so the drain drops them for it; an
 * INTERMEDIARY back-agent like the Tank DOES receive its DPS's progress/escalate,
 * so the drain delivers them via this same renderer (deliverReplies). (The old
 * control branch read a non-existent `note` field — control envelopes carry
 * `command`+`detail` — so control always rendered ''; fixed here too.)
 */
export function buildBackAgentUserFrame(
  env: ScribeEnvelope,
  frameOpts?: { replay?: boolean },
): string {
  let content = ''
  if (env.kind === 'dispatch') {
    const body = env.title ? `${env.title}\n\n${env.task}` : env.task
    // Prepend the report-back framing so the child ALWAYS answers a dispatch with a
    // structured SendMessage envelope (its only channel), never voided stdout prose.
    // Append the dispatch's own request_id: the RECEIVER never otherwise sees it
    // (only the sender gets it echoed), so refs were guesswork by construction —
    // run #1's tank fanned out ref-less and run #2's executor escalated with the
    // TITLE as its ref; the lineage/settle machinery keys on the literal id.
    //
    // LATENESS HONESTY:
    // an alias-healed / long-held dispatch can deliver well after it was
    // written. Past 10 minutes, say so — the child must not treat a stale
    // liveness probe or superseded spec as fresh operator intent.
    let lateNote = ''
    const sentAt = Date.parse(env.timestamp ?? '')
    if (Number.isFinite(sentAt)) {
      const ageMs = Date.now() - sentAt
      if (ageMs > 10 * 60_000) {
        lateNote = `[delivered ~${Math.round(ageMs / 60_000)} min after it was dispatched — it may be stale; verify it is still wanted before heavy work]\n\n`
      }
    }
    const replayNote = frameOpts?.replay ? DISPATCH_REPLAY_NOTE : ''
    content = `${DISPATCH_REPORT_BACK_FRAMING}\n\n${replayNote}${lateNote}${body}\n\n[request_id: ${env.request_id}]`
  } else if (env.kind === 'control') {
    content = `[control ${env.command}]${env.detail ? ` ${env.detail}` : ''}`
  } else if (env.kind === 'progress') {
    content = `[progress ${env.status}]${env.detail ? ` ${env.detail}` : ''}${env.refRequestId ? ` (ref ${env.refRequestId})` : ''}`
  } else if (env.kind === 'escalate') {
    content = `[escalate]${env.needsOperator ? '(needsOperator)' : ''} ${env.reason}${env.refRequestId ? ` (ref ${env.refRequestId})` : ''}`
  } else if (env.kind === 'note') {
    // #47 `/all`: an operator note/broadcast — CONTEXT for the Implementer, not a work item.
    // A broadcast (env.broadcast) is the operator addressing BOTH agents at once (the Scribe
    // ALSO receives it via /all's stdout return, so it IS in the loop); a plain note is just
    // for the Implementer. Either way the Implementer reads it as context and still escalates
    // to the Scribe, never the human. The label is the single source of truth (scribeBus.ts).
    content = `${env.broadcast ? OPERATOR_BROADCAST_LABEL : OPERATOR_NOTE_LABEL} ${env.text}`
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}

/**
 * A PLAIN (non-envelope) inbox text delivered as an attributed context frame.
 * The final-run class: a seat hand-serialized its dispatch as a
 * STRING, the tool's generic DM path journaled it, and the drain silently
 * mark-read-discarded a perfectly good 7-field spec — 3 of 8 routed missions
 * stalled to their timebox with the work sitting readable in the inbox. The
 * framing nudges the sender ecosystem back toward structured bus kinds.
 */
export function buildPlainBusFrame(from: string, text: string): string {
  const content =
    `[bus] plain message from ${from} (NOT a scribe envelope — bus kinds must be sent as ` +
    `structured SendMessage objects, e.g. message:{type:"dispatch", task:"…"}; if this text ` +
    `contains a task/spec, act on it and report back with a structured progress envelope):\n\n${text}`
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}

/** The minimal roster surface the bridge needs (reply→stdin). */
export type DispatchRoster = {
  reply: (short: string, text: string) => Promise<boolean>
}

/**
 * Drain a back-agent's inbox once and deliver each INBOUND envelope to its stdin
 * via roster.reply. Returns the count delivered. Never throws.
 *
 * Inbound = what this agent should ACT on, by topology role:
 *   - leaf back-agent (the Implementer; the DPS): `dispatch` + `control` only.
 *     Its OWN progress/escalate are outbound (to the foreground Scribe / the Tank),
 *     so they never land in its own inbox — and if they somehow did, they're not
 *     work for it. `deliverReplies` is falsy ⇒ they're dropped (marked read).
 *   - INTERMEDIARY back-agent (the Tank): also `progress` + `escalate`, because the
 *     DPS report UP to it. Pass `deliverReplies: true` so those reach its stdin.
 *
 * AT-LEAST-ONCE delivery: a message is marked read ONLY after a SUCCESSFUL
 * roster.reply. A failed reply (e.g. the ~1s+ respawn window, when stdin isn't
 * writable) leaves it UNREAD so the next ~1s poll retries — never silently lost.
 * Non-inbound / non-envelope traffic is marked read too (else it re-parses every
 * poll). A crash between a successful stdin write and the mark can double-deliver;
 * dedup on the envelope request_id at the child if needed — a rare duplicate beats
 * silent loss for refined work.
 */
export async function drainScribeDispatches(
  roster: DispatchRoster,
  opts: {
    short: string
    agentName: string
    teamName: string
    deliverReplies?: boolean
    // Back-pressure (#29): when provided AND it returns true, a dispatch is HELD (left
    // unread → retried next poll) rather than delivered onto a busy Implementer. Absent
    // (gate off) ⇒ deliver-immediately ⇒ byte-identical to before.
    isBusy?: () => boolean
    // Context-clear (#31): a `control` `clear` from the Scribe RESPAWNS the Implementer
    // (fresh transcript) instead of delivering an inert "[control clear]" text frame.
    onClear?: () => void
    // #41 R1b dedup: exactly-once delivery keyed by the robust request_id. hasSeen ⇒
    // a redelivery (retry / fragile mark-read / respawn) is dropped not re-executed;
    // markSeen records a delivered id. Absent ⇒ no dedup (byte-identical).
    hasSeen?: (requestId: string) => boolean
    markSeen?: (requestId: string) => void
    // The route seam:
    // resolveRoute gives the routed {model, effort} for the chosen dispatch; any
    // field differing from currentRoute() triggers reconfigureRoute() — a
    // seat-validated respawn — BEFORE delivery (at this idle boundary), and the
    // dispatch is HELD (left unread) → delivered next poll once the fresh child
    // matches. onRouteHeld observes the park (route-store 'held' state — the UI
    // shows "changing model", never a spinner). Absent ⇒ no routing (byte-identical).
    resolveRoute?: (env: DispatchEnvelope) => { model?: string; effort?: string } | undefined
    currentRoute?: () => { model?: string; effort?: string }
    reconfigureRoute?: (patch: { model?: string; effort?: string }) => void
    onRouteHeld?: (env: DispatchEnvelope, patch: { model?: string; effort?: string }) => void
    // Router-party P7 observability: called AFTER each successful stdin
    // delivery with the delivered envelope — the party block mirrors bus
    // traffic into the live state store (echoes + dispatch rows). Absent ⇒
    // byte-identical (pure observer, never affects delivery/marking).
    onDelivered?: (env: ScribeEnvelope) => void
    // Crash-consistency (FC4): the DURABLE consumed-dispatch ledger.
    // Default: derived from (agentName, teamName) — 'delivered' records make
    // dedup survive a daemon restart (exactly-once), 'delivering' records
    // redeliver WITH the honest replay marker. Pass `false` to disable
    // (unit tests exercising the legacy in-memory-only path).
    durableDedup?: DispatchDedup | false
  },
): Promise<number> {
  let unread
  try {
    unread = await readUnreadMessages(opts.agentName, opts.teamName)
  } catch (e) {
    logForDebugging(`[daemon] scribe dispatch drain: read failed: ${e}`)
    return 0
  }
  if (unread.length === 0) return 0
  let delivered = 0
  // Mark-read identities: prefer the ROBUST request_id (#41 — text+ts+from cross-matched
  // duplicate-text dispatches and could drop the wrong one); fall back to text+ts+from for
  // non-envelopes. HELD (back-pressured) + reply-failed dispatches are EXCLUDED so they
  // retry next poll.
  const toMark: Array<{ text: string; timestamp: string; from: string; requestId?: string }> = []
  const mark = (m: { text: string; timestamp: string; from: string }, requestId?: string) =>
    toMark.push({ text: m.text, timestamp: m.timestamp, from: m.from, requestId })

  const parsed = unread.map(m => ({ m, env: parseScribeEnvelope(m.text) }))

  // Batch-dedup by request_id (reactive-substrate Phase 2 socket fallback): the socket-first
  // sender re-journals an envelope when the RPC reply is lost, so two records with the SAME
  // request_id can be unread together. Keep the first, mark the rest read — universal (all
  // kinds, no dedup-callback needed), closes the back-pressure-off + party double-delivery.
  // Non-envelope / no-request_id records are never deduped.
  const seenBatchIds = new Set<string>()
  const deduped: typeof parsed = []
  for (const p of parsed) {
    const id = p.env?.request_id
    if (id) {
      if (seenBatchIds.has(id)) {
        mark(p.m, id)
        continue
      }
      seenBatchIds.add(id)
    }
    deduped.push(p)
  }

  // SECURITY: work/directives delivered to the Implementer (dispatch /
  // control / note) MUST come from the dispatcher (operator/team-lead), NEVER from
  // 'implementer' itself. The inbox is a local file any same-user process can
  // append to, so an injected / role-confused envelope could forge work or a
  // cancel. progress/escalate flow the OTHER way and ARE from the implementer, so
  // they are exempt from this assertion.
  const fromDispatcher = (env: ScribeEnvelope | null): boolean =>
    !!env &&
    typeof env.from === 'string' &&
    env.from.length > 0 &&
    env.from !== 'implementer'

  // #41 R1c supersede: a dispatch (refRequestId) or a control 'cancel' (refRequestId)
  // SUPERSEDES the referenced dispatch — drop it if still queued in this batch.
  // Only a dispatcher-authored envelope may supersede, else a forged cancel could
  // drop a legitimate dispatch.
  const supersededIds = new Set<string>()
  for (const { env } of deduped) {
    if (
      env &&
      (env.kind === 'dispatch' || env.kind === 'control') &&
      env.refRequestId &&
      fromDispatcher(env)
    ) {
      supersededIds.add(env.refRequestId)
    }
  }

  // ── Phase 1: act on controls + intermediary replies + non-inbound immediately, and
  //    collect the deliverable dispatches (never consuming the one-per-drain budget). ──
  const dispatches: Array<{ m: (typeof parsed)[number]['m']; env: DispatchEnvelope }> = []
  // Dispatch ids CONSUMED this pass (delivered / dedup / supersede / hasSeen) —
  // the complement defines heldIds for the held-twin mark guard below.
  const seenThisPass = new Set<string>()
  for (const { m, env } of deduped) {
    // reject + consume a dispatch/control/note that is NOT from the
    // dispatcher before it reaches the Implementer's stdin (forged / role-confused
    // sender). progress/escalate are exempt (they ARE from the implementer).
    if (
      env &&
      (env.kind === 'dispatch' ||
        env.kind === 'control' ||
        env.kind === 'note') &&
      !fromDispatcher(env)
    ) {
      logForDebugging(
        `[daemon] scribe REJECT ${env.kind} ${env.request_id}: invalid sender from=${JSON.stringify(env.from)} (must be the dispatcher, not 'implementer') — dropping`,
      )
      mark(m, env.request_id)
      continue
    }
    if (env && env.kind === 'control' && env.command === 'clear' && opts.onClear) {
      logForDebugging('[daemon] scribe control: clear — respawning the Implementer (fresh transcript)')
      try {
        opts.onClear()
      } catch (e) {
        logForDebugging(`[daemon] scribe clear: onClear threw: ${e}`)
      }
      mark(m, env.request_id)
      continue
    }
    if (env && env.kind === 'control' && env.command === 'cancel') {
      // The cancel itself is consumed here; its target queued dispatch is dropped below
      // via supersededIds. (An already-in-flight target can't be un-delivered.)
      logForDebugging(`[daemon] scribe control: cancel ref=${env.refRequestId ?? '?'} — dropping the queued target if present`)
      mark(m, env.request_id)
      continue
    }
    if (env && env.kind === 'control') {
      // Any other control (pause/resume/stop/ack, or clear when no onClear is wired) is
      // delivered as a text directive — the prior behavior. Controls are directives, not
      // work, so they are NOT back-pressured (deliver immediately, don't consume the
      // one-dispatch-per-drain budget).
      let ok = false
      try {
        ok = await roster.reply(opts.short, buildBackAgentUserFrame(env))
      } catch (e) {
        logForDebugging(`[daemon] scribe control deliver threw: ${e}`)
      }
      if (ok) {
        delivered++
        opts.onDelivered?.(env)
        mark(m, env.request_id)
      } else {
        logForDebugging('[daemon] scribe control deliver not accepted — leaving UNREAD for retry')
      }
      continue
    }
    if (env && env.kind === 'note') {
      // #47 `/all`: an operator note — delivered to stdin like a control (context, not
      // work), so it NEVER consumes the one-dispatch-per-drain budget and is NOT
      // back-pressured. Marked read only on a successful deliver (at-least-once).
      let ok = false
      try {
        ok = await roster.reply(opts.short, buildBackAgentUserFrame(env))
      } catch (e) {
        logForDebugging(`[daemon] scribe note deliver threw: ${e}`)
      }
      if (ok) {
        delivered++
        opts.onDelivered?.(env)
        mark(m, env.request_id)
      } else {
        logForDebugging('[daemon] scribe note deliver not accepted — leaving UNREAD for retry')
      }
      continue
    }
    if (env && env.kind === 'dispatch') {
      if (opts.hasSeen?.(env.request_id)) {
        logForDebugging(`[daemon] scribe dedup: ${env.request_id} already delivered — dropping redelivery`)
        seenThisPass.add(env.request_id)
        mark(m, env.request_id)
        continue
      }
      if (supersededIds.has(env.request_id)) {
        logForDebugging(`[daemon] scribe supersede: ${env.request_id} replaced by a newer dispatch — dropping`)
        seenThisPass.add(env.request_id)
        mark(m, env.request_id)
        continue
      }
      dispatches.push({ m, env })
      continue
    }
    // Intermediary back-agents (the Tank) receive their workers' progress/escalate.
    if (opts.deliverReplies && env && (env.kind === 'progress' || env.kind === 'escalate')) {
      let ok = false
      try {
        ok = await roster.reply(opts.short, buildBackAgentUserFrame(env))
      } catch (e) {
        logForDebugging(`[daemon] scribe reply-deliver threw: ${e}`)
      }
      if (ok) {
        delivered++
        opts.onDelivered?.(env)
        mark(m, env.request_id)
      } else {
        logForDebugging('[daemon] scribe reply-deliver not accepted — leaving UNREAD for retry')
      }
      continue
    }
    if (!env) {
      // PLAIN non-envelope text: deliver it as an attributed context frame
      // (at-least-once — SOMETHING must reach the seat; see buildPlainBusFrame's
      // header for the silent-discard class). Like notes: context,
      // not work — never back-pressured, never consumes the dispatch budget.
      // Marked read only on a successful reply. Own echoes stay consumed.
      const plainFrom = (m.from ?? '').trim()
      if (plainFrom.length > 0 && plainFrom !== opts.short) {
        let ok = false
        try {
          ok = await roster.reply(opts.short, buildPlainBusFrame(plainFrom, m.text))
        } catch (e) {
          logForDebugging(`[daemon] plain-text deliver threw: ${e}`)
        }
        if (ok) {
          delivered++
          mark(m)
        } else {
          logForDebugging('[daemon] plain-text deliver not accepted — leaving UNREAD for retry')
        }
        continue
      }
      mark(m)
      continue
    }
    // A leaf's own progress/escalate (outbound-shaped) misdirected here: not work for this agent.
    mark(m, env.request_id)
  }

  // ── Phase 2: deliver dispatches in priority order (high-priority JUMPS the queue, FIFO
  //    within a priority). Back-pressure ON (the scribe Implementer default) ⇒ deliver
  //    EXACTLY ONE per drain, hold the rest UNREAD (strictly one task at a time; high no
  //    longer bypasses onto a busy child — that broke the invariant). Back-pressure OFF
  //    (opt-out / the party path, no isBusy) ⇒ deliver ALL (the prior behavior;
  //    byte-identical for existing no-priority traffic since order is then arrival order). ──
  if (dispatches.length > 0) {
    const backPressureOn = opts.isBusy !== undefined
    const ordered = [
      ...dispatches.filter(d => d.env.priority === 'high'),
      ...dispatches.filter(d => d.env.priority !== 'high'),
    ]
    const dedup =
      opts.durableDedup === false
        ? null
        : (opts.durableDedup ?? dispatchDedup(opts.agentName, opts.teamName))
    const deliverOne = async (d: (typeof ordered)[number]): Promise<boolean> => {
      const id = d.env.request_id
      // Defense-in-depth (#41 dedup): re-check hasSeen at delivery time — a
      // cross-batch twin (delivered in a PRIOR drain) is consumed, never re-executed.
      if (opts.hasSeen?.(id)) {
        seenThisPass.add(id)
        mark(d.m, id)
        return true
      }
      // FC4: the DURABLE consumption ledger survives restarts.
      // 'delivered' ⇒ the act completed in a prior daemon lifetime — consume
      // this redelivery, never re-execute. 'delivering' ⇒ the previous
      // lifetime died in the act window — redeliver WITH the replay marker.
      let replay = false
      if (dedup) {
        const state = await dedup.stateOf(id).catch(() => null)
        if (state === 'delivered') {
          logForDebugging(`[daemon] scribe durable dedup: ${id} already delivered — consuming redelivery`)
          seenThisPass.add(id)
          opts.markSeen?.(id)
          mark(d.m, id)
          return true
        }
        replay = state === 'delivering'
        // Record BEFORE the act (never blocks delivery on a ledger fault).
        await dedup.begin(id).catch(e => logForDebugging(`[daemon] dedup begin failed: ${e}`))
        faultPoint('bridge-before-act', id)
      }
      let ok = false
      try {
        ok = await roster.reply(opts.short, buildBackAgentUserFrame(d.env, { replay }))
      } catch (e) {
        logForDebugging(`[daemon] scribe dispatch drain: reply threw: ${e}`)
      }
      if (ok) {
        if (dedup) {
          faultPoint('bridge-before-complete', id)
          await dedup.complete(id).catch(e => logForDebugging(`[daemon] dedup complete failed: ${e}`))
          faultPoint('bridge-after-complete', id)
        }
        delivered++
        seenThisPass.add(id)
        opts.markSeen?.(id)
        opts.onDelivered?.(d.env)
        mark(d.m, id)
      } else {
        logForDebugging('[daemon] scribe dispatch drain: reply not accepted — leaving dispatch UNREAD for retry')
      }
      return ok
    }
    if (backPressureOn) {
      if (opts.isBusy!()) {
        logForDebugging(`[daemon] scribe back-pressure: Implementer busy — holding ${dispatches.length} dispatch(es) for retry`)
      } else {
        const chosen = ordered[0]! // exactly one; the rest stay UNREAD (one task at a time)
        // Routing: at this idle turn boundary, if the router wants a different model
        // and/or effort for the chosen task, RECONFIGURE first (a seat-validated
        // respawn) and HOLD the dispatch — it delivers next poll once the fresh
        // child matches. Never mid-task (we're idle here), so coherence is
        // preserved (a respawn is a clean transcript boundary).
        const want = opts.resolveRoute?.(chosen.env)
        const cur = want ? opts.currentRoute?.() : undefined
        const patch: { model?: string; effort?: string } = {}
        if (want && cur) {
          if (want.model !== undefined && want.model !== cur.model) patch.model = want.model
          if (want.effort !== undefined && want.effort !== cur.effort) patch.effort = want.effort
        }
        if (opts.reconfigureRoute && (patch.model !== undefined || patch.effort !== undefined)) {
          logForDebugging(
            `[daemon] router: ${chosen.env.request_id} routed ${patch.model ?? cur?.model ?? '?'}@${patch.effort ?? cur?.effort ?? '?'} (worker ${cur?.model ?? '?'}@${cur?.effort ?? '?'}) — reconfiguring before delivery (held)`,
          )
          try {
            opts.onRouteHeld?.(chosen.env, patch)
          } catch (e) {
            logForDebugging(`[daemon] onRouteHeld observer threw (dropped): ${e}`)
          }
          opts.reconfigureRoute(patch)
        } else {
          await deliverOne(chosen)
        }
        if (ordered.length > 1) logForDebugging(`[daemon] scribe back-pressure: held ${ordered.length - 1} dispatch(es) — one at a time`)
      }
    } else {
      for (const d of ordered) await deliverOne(d) // back-pressure off ⇒ deliver all (prior behavior)
    }
  }

  // HELD-TWIN GUARD: the mark predicate
  // matches by request_id, so a batch-deduped TWIN's mark entry would ALSO
  // sweep the HELD original (back-pressured / router-held / reply-refused —
  // still queued in `dispatches`, never delivered) — marking refined work
  // read while it never reached stdin: silent loss. A held id must never be
  // marked this pass; the surviving twin stays unread too and re-dedupes
  // next pass (idempotent) — a redundant record beats lost work.
  const heldIds = new Set<string>()
  for (const d of dispatches) {
    if (!seenThisPass.has(d.env.request_id)) heldIds.add(d.env.request_id)
  }
  const toMarkSafe = toMark.filter(t => !t.requestId || !heldIds.has(t.requestId))
  if (toMarkSafe.length > 0) {
    await markMessagesAsReadByPredicate(
      opts.agentName,
      x => {
        const xid = parseScribeEnvelope(x.text)?.request_id
        return toMarkSafe.some(t =>
          t.requestId && xid
            ? t.requestId === xid
            : t.text === x.text && t.timestamp === x.timestamp && t.from === x.from,
        )
      },
      opts.teamName,
    ).catch(() => {})
  }
  if (delivered > 0) logForDebugging(`[daemon] dispatch bridge delivered ${delivered} to ${opts.short} stdin`)
  return delivered
}

/**
 * Heal stranded ALIAS inboxes for a managed team's canonical agent: any
 * `inboxes/<alias>.json` whose basename canonicalizes to `canonicalAgent`
 * (e.g. `Mercury-Implement.json`, `Mercury-Implement.json` → `implementer`)
 * has its UNREAD messages MOVED into the canonical inbox (original
 * timestamps preserved — the lateness note in buildBackAgentUserFrame keys
 * off them), then marked read at the source. This is the recovery net for
 * mail stranded BEFORE the send seams canonicalized and
 * for any third-party writer that bypasses both seams.
 *
 * CASE-INSENSITIVE-FS GUARD: on APFS `Implementer.json` IS `implementer.json`
 * — moving between them would append a file onto itself forever. Any
 * basename that case-folds to the canonical name is SKIPPED (it is already
 * the canonical inbox). Returns messages moved; never throws.
 */
export async function healAliasInboxes(
  canonicalAgent: string,
  teamName: string,
): Promise<number> {
  if (!isManagedBusTeam(teamName)) return 0
  let moved = 0
  try {
    const inboxDir = dirname(getInboxPath(canonicalAgent, teamName))
    let entries: string[] = []
    try {
      entries = readdirSync(inboxDir)
    } catch {
      return 0 // no team dir yet — nothing stranded
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const alias = basename(entry, '.json')
      if (alias === canonicalAgent) continue // exact self
      const resolved = canonicalizeBusTarget(teamName, alias)
      if (!resolved.known || resolved.name !== canonicalAgent) continue
      // SAME-FILE identity guard, by inode not by name-fold: on
      // APFS `Implementer.json` IS `implementer.json` (healing would append
      // the file onto itself); on ext4 they are DISTINCT files and a pure
      // case-fold skip would strand real mail. stat both — same dev+ino ⇒
      // the same file ⇒ skip; ENOENT on the canonical ⇒ distinct ⇒ heal.
      try {
        const a = statSync(join(inboxDir, entry))
        const c = statSync(getInboxPath(canonicalAgent, teamName))
        if (a.dev === c.dev && a.ino === c.ino) continue
      } catch {
        /* canonical absent ⇒ genuinely distinct file — proceed */
      }
      const unread = await readUnreadMessages(alias, teamName)
      if (unread.length === 0) continue
      // DOUBLE-EXECUTION DEDUP (fable scroll-slice audit): the move is
      // at-least-once — a mark-read failure at the alias (lock contention,
      // transient EIO; both swallowed) left the copy unread, and the next
      // pass moved it AGAIN: the same executable dispatch delivered twice.
      // Dedup by ENVELOPE request_id only (globally unique by construction) —
      // a plain-text message dedups on the FULL record identity
      // (text+from+timestamp), never text alone: two genuinely distinct
      // "run the tests again" notes must both move (round-2 audit).
      const canonical = await getMailboxStore(canonicalAgent, teamName).read()
      const canonicalIds = new Set(
        canonical.map(x => parseScribeEnvelope(x.text)?.request_id).filter(Boolean),
      )
      const canonicalRecords = new Set(canonical.map(x => JSON.stringify([x.from, x.timestamp, x.text])))
      let movedHere = 0
      for (const m of unread) {
        const mid = parseScribeEnvelope(m.text)?.request_id
        const alreadyMoved = mid
          ? canonicalIds.has(mid)
          : canonicalRecords.has(JSON.stringify([m.from, m.timestamp, m.text]))
        if (alreadyMoved) {
          // Already moved by a prior pass — just retry the mark at the alias.
          await markMessagesAsReadByPredicate(
            alias,
            x => x.text === m.text && x.timestamp === m.timestamp && x.from === m.from,
            teamName,
          ).catch(() => {})
          continue
        }
        // OUTER record timestamp = NOW (fable audit, slice B: the cockpit
        // CHAT glance filters by record ts against the engagement epoch, so a
        // strand healed+delivered THIS session was invisible while the
        // Implementer visibly worked on it). The LATENESS signal keys on the
        // envelope's INNER timestamp (untouched in m.text) — both stay honest.
        const ok = await writeToMailbox(
          canonicalAgent,
          { from: m.from, text: m.text, timestamp: new Date().toISOString(), ...(m.color ? { color: m.color } : {}) },
          teamName,
        )
        if (!ok) continue // leave unread at the alias — retried next heal
        movedHere++
        await markMessagesAsReadByPredicate(
          alias,
          x => x.text === m.text && x.timestamp === m.timestamp && x.from === m.from,
          teamName,
        ).catch(() => {})
      }
      moved += movedHere
      if (movedHere > 0) {
        logForDebugging(
          `[daemon] bus heal: moved ${movedHere} stranded message(s) from alias inbox '${alias}' → '${canonicalAgent}' (team ${teamName})`,
        )
      }
    }
  } catch (e) {
    logForDebugging(`[daemon] bus heal failed (dropped): ${e}`)
  }
  return moved
}

/** A live subscription-driven drain: `drain()` nudges it (e.g. from the roster's
 *  busy→idle transition); `dispose()` tears down the watcher + timers. */
export interface DispatchDrainHandle {
  drain: () => void
  dispose: () => void
}

/**
 * Arm the event-driven dispatch drain for one back-agent inbox (reactive-substrate
 * Phase 2 — replaces the daemon's fixed 1s `setInterval` polls):
 *
 *   - SUBSCRIBES to the inbox store: a dispatch write lands ~50ms later, not at
 *     the next second boundary. The initial pass (immediate) covers startup.
 *   - SERIALIZES drains (a drain triggered mid-drain coalesces into one re-run,
 *     so two events can't interleave deliveries).
 *   - HELD-RETRY: back-pressured / reply-refused messages stay unread and produce
 *     NO further file event — after any drain that leaves unread messages behind,
 *     one retry timer (1s, the old cadence) re-runs the drain. The roster's onIdle
 *     nudge usually beats it (a held dispatch delivers the instant the worker's
 *     turn ends).
 *
 * `onDrained` runs after every pass with the delivered count (the roster tick +
 * governor continuation). Never throws; a faulted pass is logged and dropped
 *
 */
export function armDispatchDrain(
  roster: DispatchRoster,
  opts: Parameters<typeof drainScribeDispatches>[1] & {
    onDrained?: (delivered: number) => void
  },
): DispatchDrainHandle {
  let disposed = false
  let draining = false
  let rerun = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const pass = async (): Promise<void> => {
    // Heal-then-drain: stranded alias mail (a pre-canonicalization sender or
    // a third-party writer) moves into the canonical inbox FIRST so this very
    // pass delivers it. The heal is a no-op readdir for managed teams with no
    // alias files and skips unmanaged (crew) teams entirely.
    const healed = await healAliasInboxes(opts.agentName, opts.teamName)
    if (healed > 0) logForDebugging(`[daemon] bus heal fed ${healed} message(s) into this drain pass`)
    // LEAD-SIDE symmetry: reply-direction strands ('scribe.json',
    // 'Mercury-Amanuensis.json', party 'maintainer' variants) target the
    // FOREGROUND's inbox, which has no daemon drain of its own — heal them
    // into team-lead.json here; the fg's useInboxPoller then delivers them.
    // No-op for unmanaged teams and when the drain IS the lead's (crew).
    if (opts.agentName !== BUS_TEAM_LEAD_NAME) {
      const leadHealed = await healAliasInboxes(BUS_TEAM_LEAD_NAME, opts.teamName)
      if (leadHealed > 0) logForDebugging(`[daemon] bus heal recovered ${leadHealed} lead-directed strand(s) into team-lead`)
    }
    const delivered = await drainScribeDispatches(roster, opts)
    try {
      opts.onDrained?.(delivered)
    } catch (e) {
      logForDebugging(`[daemon] onDrained continuation threw (dropped): ${e}`)
    }
  }

  const drain = (): void => {
    if (disposed) return
    if (draining) {
      rerun = true
      return
    }
    draining = true
    void (async () => {
      try {
        do {
          rerun = false
          await pass()
        } while (rerun && !disposed)
        // Anything still unread is HELD (back-pressure / respawn window / a
        // reply the child refused) — arm the single retry timer.
        if (!disposed && !retryTimer) {
          const unread = await readUnreadMessages(opts.agentName, opts.teamName)
          if (unread.length > 0) {
            retryTimer = setTimeout(() => {
              retryTimer = null
              drain()
            }, HELD_RETRY_MS)
            retryTimer.unref?.()
          }
        }
      } catch (e) {
        logForDebugging(`[daemon] dispatch drain for ${opts.short} failed (dropping pass): ${e}`)
      } finally {
        draining = false
      }
      // An event that landed during the trailing unread-check window set `rerun`
      // after the while had exited — re-enter so it is never silently dropped.
      if (rerun && !disposed) drain()
    })()
  }

  const unsubscribe = getMailboxStore(opts.agentName, opts.teamName).subscribe(
    () => drain(),
    { immediate: true },
  )

  return {
    drain,
    dispose: () => {
      disposed = true
      unsubscribe()
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    },
  }
}
