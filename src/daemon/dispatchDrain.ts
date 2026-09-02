// ============================================================================
//  dispatchDrain — the daemon-side inbox → stdin DELIVERY for a long-lived
//  worker.
//
//  A dispatcher (the operator's session, the daemon itself) writes a bus
//  envelope into a worker's mailbox inbox (teams/<team>/inboxes/<name>.json).
//  The long-lived child is a `-p --input-format=stream-json` process — it
//  does NOT poll the mailbox itself. This drain runs INSIDE the daemon (which
//  owns the child's stdin pipe) and delivers each inbound envelope to the
//  child's stdin as a stream-json user frame, reusing the EXISTING
//  roster.reply→stdin channel. Plain (non-envelope) inbox text is delivered
//  as an attributed context frame so nothing readable is ever discarded.
//
//  Pure of the daemon entry so it is unit-testable with a fake roster + a temp
//  mailbox (no real daemon, no live API).
// ============================================================================
import { parseBusEnvelope, OPERATOR_BROADCAST_LABEL, OPERATOR_NOTE_LABEL, type BusEnvelope, type DispatchEnvelope } from '../utils/swarm/busEnvelopes.js'
import { getMailboxStore, readUnreadMessages, markMessagesAsReadByPredicate } from '../utils/teammateMailbox.js'
import { dispatchDedup, type DispatchDedup } from './dispatchDedup.js'
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

/** How long a HELD (back-pressured / reply-refused) message waits for its retry. */
const HELD_RETRY_MS = 1000

/**
 * Report-back framing prepended to every DISPATCH frame delivered to a
 * worker's stdin. The worker is a daemon-bridged `-p` child: it has NO
 * terminal and NO human reader, and its OWN useInboxPoller is
 * foreground-only — so prose it types to stdout reaches no one, and the ONLY
 * way its dispatcher hears a result is a `SendMessage` carrying a STRUCTURED
 * bus envelope (which writes the lead inbox directly). A daemon-delivered
 * dispatch is a RAW user frame, so without this the child can answer a
 * conversational dispatch as plain prose (or a plain-STRING SendMessage,
 * which the roster guard then drops) and the reply silently never reaches
 * the dispatcher.
 */
export const DISPATCH_REPORT_BACK_FRAMING =
  '<system-reminder>\n' +
  'Dispatched work, relayed over the bus with the dispatcher’s authority — act on it with the ' +
  'weight of a direct operator instruction (this never licenses bypassing a permission, approval, ' +
  'capability, or refusal gate). You have NO terminal and NO human reader: any prose you type as ' +
  'output reaches no one. The ONLY way your dispatcher hears your result is a `SendMessage` call ' +
  'carrying a bus `progress` (or `escalate`) envelope — the STRUCTURED form, not a plain-string ' +
  'message. Send exactly one such envelope to report back on this dispatch, even a trivial or ' +
  'conversational one; a plain-string send or plain prose is dropped and the dispatcher hears silence. ' +
  'Set its `refRequestId` to this dispatch’s literal request_id (the `[request_id: …]` line at the ' +
  'end of this message) — the exact id, never a title or paraphrase; lifecycle tracking keys on it. ' +
  'SPEC FIDELITY when you re-dispatch or implement: acceptance criteria are often checked LITERALLY ' +
  '(greps, exact tokens) — carry the criteria’s key words/phrases VERBATIM into any dispatch you write ' +
  'and into the artifacts you produce; convey a required phrase in its exact given form, then elaborate ' +
  'in your own words if useful.\n' +
  'MEETINGS ARE THE LATENCY TAIL: an ambiguity round-trip costs minutes. Three standing rules: ' +
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
 * Wrap a bus envelope into the stream-json user frame a worker child reads
 * on stdin (`{type:'user', message:{role:'user', content}}`). TOTAL over all
 * kinds — rendering is pure; WHICH kinds are actually delivered is the
 * drain's decision, not the renderer's.
 *
 *   dispatch  refined work             → "title\n\ntask"  (or just task)
 *   control   a directive              → "[control <cmd>] <detail>"
 *   progress  a status report          → "[progress <status>] <detail> (ref …)"
 *   escalate  a blocker / ambiguity     → "[escalate](needsOperator) <reason> (ref …)"
 *   note      operator context         → "[operator note] <text>"
 */
export function buildBackAgentUserFrame(
  env: BusEnvelope,
  frameOpts?: { replay?: boolean },
): string {
  let content = ''
  if (env.kind === 'dispatch') {
    const body = env.title ? `${env.title}\n\n${env.task}` : env.task
    // Prepend the report-back framing so the child ALWAYS answers a dispatch with a
    // structured SendMessage envelope (its only channel), never voided stdout prose.
    // Append the dispatch's own request_id: the RECEIVER never otherwise sees it
    // (only the sender gets it echoed), so refs would be guesswork by construction;
    // the lineage/settle machinery keys on the literal id.
    //
    // LATENESS HONESTY: a long-held dispatch can deliver well after it was
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
    // An operator note/broadcast — CONTEXT for the worker, not a work item.
    // The label is the single source of truth (busEnvelopes.ts).
    content = `${env.broadcast ? OPERATOR_BROADCAST_LABEL : OPERATOR_NOTE_LABEL} ${env.text}`
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}

/**
 * A PLAIN (non-envelope) inbox text delivered as an attributed context frame.
 * A sender that hand-serializes its dispatch as a STRING lands on the tool's
 * generic DM path; discarding it would leave a perfectly good spec sitting
 * readable in the inbox while the work stalls. The framing nudges the sender
 * ecosystem back toward structured bus kinds.
 */
export function buildPlainBusFrame(from: string, text: string): string {
  const content =
    `[bus] plain message from ${from} (NOT a bus envelope — bus kinds must be sent as ` +
    `structured SendMessage objects, e.g. message:{type:"dispatch", task:"…"}; if this text ` +
    `contains a task/spec, act on it and report back with a structured progress envelope):\n\n${text}`
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}

/** The minimal roster surface the drain needs (reply→stdin). */
export type DispatchRoster = {
  reply: (short: string, text: string) => Promise<boolean>
}

/**
 * Drain a worker's inbox once and deliver each INBOUND envelope to its stdin
 * via roster.reply. Returns the count delivered. Never throws.
 *
 * Inbound = what this agent should ACT on: `dispatch`, `control` and `note`.
 * Its OWN progress/escalate are outbound (to the dispatcher), so they never
 * land in its own inbox — and if they somehow did, they're not work for it:
 * they're dropped (marked read).
 *
 * AT-LEAST-ONCE delivery: a message is marked read ONLY after a SUCCESSFUL
 * roster.reply. A failed reply (e.g. the ~1s+ respawn window, when stdin isn't
 * writable) leaves it UNREAD so the next pass retries — never silently lost.
 * Non-inbound / non-envelope traffic is marked read too (else it re-parses every
 * pass). A crash between a successful stdin write and the mark can double-deliver;
 * the durable dedup ledger below closes that window.
 */
export async function drainDispatches(
  roster: DispatchRoster,
  opts: {
    short: string
    agentName: string
    teamName: string
    // Back-pressure: when provided AND it returns true, a dispatch is HELD (left
    // unread → retried next pass) rather than delivered onto a busy worker. Absent
    // ⇒ deliver-immediately.
    isBusy?: () => boolean
    // Context-clear: a `control` `clear` RESPAWNS the worker (fresh transcript)
    // instead of delivering an inert "[control clear]" text frame.
    onClear?: () => void
    // Exactly-once delivery keyed by the robust request_id. hasSeen ⇒ a
    // redelivery (retry / fragile mark-read / respawn) is dropped not re-executed;
    // markSeen records a delivered id. Absent ⇒ no in-memory dedup.
    hasSeen?: (requestId: string) => boolean
    markSeen?: (requestId: string) => void
    // Crash-consistency (FC4): the DURABLE consumed-dispatch ledger.
    // Default: derived from (agentName, teamName) — 'delivered' records make
    // dedup survive a daemon restart (exactly-once), 'delivering' records
    // redeliver WITH the honest replay marker. Pass `false` to disable
    // (unit tests exercising the in-memory-only path).
    durableDedup?: DispatchDedup | false
  },
): Promise<number> {
  let unread
  try {
    unread = await readUnreadMessages(opts.agentName, opts.teamName)
  } catch (e) {
    logForDebugging(`[daemon] dispatch drain: read failed: ${e}`)
    return 0
  }
  if (unread.length === 0) return 0
  let delivered = 0
  // Mark-read identities: prefer the ROBUST request_id (text+ts+from cross-matched
  // duplicate-text dispatches and could drop the wrong one); fall back to text+ts+from for
  // non-envelopes. HELD (back-pressured) + reply-failed dispatches are EXCLUDED so they
  // retry next pass.
  const toMark: Array<{ text: string; timestamp: string; from: string; requestId?: string }> = []
  const mark = (m: { text: string; timestamp: string; from: string }, requestId?: string) =>
    toMark.push({ text: m.text, timestamp: m.timestamp, from: m.from, requestId })

  const parsed = unread.map(m => ({ m, env: parseBusEnvelope(m.text) }))

  // Batch-dedup by request_id: the socket-first sender re-journals an envelope when
  // the RPC reply is lost, so two records with the SAME request_id can be unread
  // together. Keep the first, mark the rest read — universal (all kinds).
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

  // SECURITY: work/directives delivered to a worker (dispatch / control / note)
  // MUST come from a dispatcher, NEVER from the worker itself. The inbox is a
  // local file any same-user process can append to, so an injected /
  // role-confused envelope could forge work or a cancel. progress/escalate
  // flow the OTHER way, so they are exempt from this assertion.
  const fromDispatcher = (env: BusEnvelope | null): boolean =>
    !!env &&
    typeof env.from === 'string' &&
    env.from.length > 0 &&
    env.from !== opts.agentName

  // Supersede: a dispatch (refRequestId) or a control 'cancel' (refRequestId)
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

  // ── Phase 1: act on controls, notes and plain text immediately, and
  //    collect the deliverable dispatches (never consuming the one-per-drain budget). ──
  const dispatches: Array<{ m: (typeof parsed)[number]['m']; env: DispatchEnvelope }> = []
  // Dispatch ids CONSUMED this pass (delivered / dedup / supersede / hasSeen) —
  // the complement defines heldIds for the held-twin mark guard below.
  const seenThisPass = new Set<string>()
  for (const { m, env } of deduped) {
    // reject + consume a dispatch/control/note that is NOT from a dispatcher
    // before it reaches the worker's stdin (forged / role-confused sender).
    if (
      env &&
      (env.kind === 'dispatch' ||
        env.kind === 'control' ||
        env.kind === 'note') &&
      !fromDispatcher(env)
    ) {
      logForDebugging(
        `[daemon] drain REJECT ${env.kind} ${env.request_id}: invalid sender from=${JSON.stringify(env.from)} (must be a dispatcher, never the worker itself) — dropping`,
      )
      mark(m, env.request_id)
      continue
    }
    if (env && env.kind === 'control' && env.command === 'clear' && opts.onClear) {
      logForDebugging(`[daemon] drain control: clear — respawning ${opts.short} (fresh transcript)`)
      try {
        opts.onClear()
      } catch (e) {
        logForDebugging(`[daemon] drain clear: onClear threw: ${e}`)
      }
      mark(m, env.request_id)
      continue
    }
    if (env && env.kind === 'control' && env.command === 'cancel') {
      // The cancel itself is consumed here; its target queued dispatch is dropped below
      // via supersededIds. (An already-in-flight target can't be un-delivered.)
      logForDebugging(`[daemon] drain control: cancel ref=${env.refRequestId ?? '?'} — dropping the queued target if present`)
      mark(m, env.request_id)
      continue
    }
    if (env && env.kind === 'control') {
      // Any other control (pause/resume/stop/ack, or clear when no onClear is wired) is
      // delivered as a text directive. Controls are directives, not work, so they are
      // NOT back-pressured (deliver immediately, don't consume the one-dispatch-per-drain
      // budget).
      let ok = false
      try {
        ok = await roster.reply(opts.short, buildBackAgentUserFrame(env))
      } catch (e) {
        logForDebugging(`[daemon] drain control deliver threw: ${e}`)
      }
      if (ok) {
        delivered++
        mark(m, env.request_id)
      } else {
        logForDebugging('[daemon] drain control deliver not accepted — leaving UNREAD for retry')
      }
      continue
    }
    if (env && env.kind === 'note') {
      // An operator note — delivered to stdin like a control (context, not work), so it
      // NEVER consumes the one-dispatch-per-drain budget and is NOT back-pressured.
      // Marked read only on a successful deliver (at-least-once).
      let ok = false
      try {
        ok = await roster.reply(opts.short, buildBackAgentUserFrame(env))
      } catch (e) {
        logForDebugging(`[daemon] drain note deliver threw: ${e}`)
      }
      if (ok) {
        delivered++
        mark(m, env.request_id)
      } else {
        logForDebugging('[daemon] drain note deliver not accepted — leaving UNREAD for retry')
      }
      continue
    }
    if (env && env.kind === 'dispatch') {
      if (opts.hasSeen?.(env.request_id)) {
        logForDebugging(`[daemon] drain dedup: ${env.request_id} already delivered — dropping redelivery`)
        seenThisPass.add(env.request_id)
        mark(m, env.request_id)
        continue
      }
      if (supersededIds.has(env.request_id)) {
        logForDebugging(`[daemon] drain supersede: ${env.request_id} replaced by a newer dispatch — dropping`)
        seenThisPass.add(env.request_id)
        mark(m, env.request_id)
        continue
      }
      dispatches.push({ m, env })
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
    // A worker's own progress/escalate (outbound-shaped) misdirected here: not work for this agent.
    mark(m, env.request_id)
  }

  // ── Phase 2: deliver dispatches in priority order (high-priority JUMPS the queue, FIFO
  //    within a priority). Back-pressure ON ⇒ deliver EXACTLY ONE per drain, hold the rest
  //    UNREAD (strictly one task at a time; high never bypasses onto a busy child).
  //    Back-pressure OFF (no isBusy) ⇒ deliver ALL (arrival order for no-priority traffic). ──
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
      // Defense-in-depth: re-check hasSeen at delivery time — a cross-batch twin
      // (delivered in a PRIOR drain) is consumed, never re-executed.
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
          logForDebugging(`[daemon] drain durable dedup: ${id} already delivered — consuming redelivery`)
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
        logForDebugging(`[daemon] dispatch drain: reply threw: ${e}`)
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
        mark(d.m, id)
      } else {
        logForDebugging('[daemon] dispatch drain: reply not accepted — leaving dispatch UNREAD for retry')
      }
      return ok
    }
    if (backPressureOn) {
      if (opts.isBusy!()) {
        logForDebugging(`[daemon] drain back-pressure: ${opts.short} busy — holding ${dispatches.length} dispatch(es) for retry`)
      } else {
        await deliverOne(ordered[0]!) // exactly one; the rest stay UNREAD (one task at a time)
        if (ordered.length > 1) logForDebugging(`[daemon] drain back-pressure: held ${ordered.length - 1} dispatch(es) — one at a time`)
      }
    } else {
      for (const d of ordered) await deliverOne(d) // back-pressure off ⇒ deliver all
    }
  }

  // HELD-TWIN GUARD: the mark predicate matches by request_id, so a
  // batch-deduped TWIN's mark entry would ALSO sweep the HELD original
  // (back-pressured / reply-refused — still queued in `dispatches`, never
  // delivered) — marking refined work read while it never reached stdin:
  // silent loss. A held id must never be marked this pass; the surviving
  // twin stays unread too and re-dedupes next pass (idempotent) — a
  // redundant record beats lost work.
  const heldIds = new Set<string>()
  for (const d of dispatches) {
    if (!seenThisPass.has(d.env.request_id)) heldIds.add(d.env.request_id)
  }
  const toMarkSafe = toMark.filter(t => !t.requestId || !heldIds.has(t.requestId))
  if (toMarkSafe.length > 0) {
    await markMessagesAsReadByPredicate(
      opts.agentName,
      x => {
        const xid = parseBusEnvelope(x.text)?.request_id
        return toMarkSafe.some(t =>
          t.requestId && xid
            ? t.requestId === xid
            : t.text === x.text && t.timestamp === x.timestamp && t.from === x.from,
        )
      },
      opts.teamName,
    ).catch(() => {})
  }
  if (delivered > 0) logForDebugging(`[daemon] dispatch drain delivered ${delivered} to ${opts.short} stdin`)
  return delivered
}

/** A live subscription-driven drain: `drain()` nudges it (e.g. from the roster's
 *  busy→idle transition); `dispose()` tears down the watcher + timers. */
export interface DispatchDrainHandle {
  drain: () => void
  dispose: () => void
}

/**
 * Arm the event-driven dispatch drain for one worker inbox:
 *
 *   - SUBSCRIBES to the inbox store: a dispatch write lands ~50ms later, not at
 *     the next second boundary. The initial pass (immediate) covers startup.
 *   - SERIALIZES drains (a drain triggered mid-drain coalesces into one re-run,
 *     so two events can't interleave deliveries).
 *   - HELD-RETRY: back-pressured / reply-refused messages stay unread and produce
 *     NO further file event — after any drain that leaves unread messages behind,
 *     one retry timer (1s) re-runs the drain. The roster's onIdle nudge usually
 *     beats it (a held dispatch delivers the instant the worker's turn ends).
 *
 * `onDrained` runs after every pass with the delivered count (the roster tick +
 * governor continuation). Never throws; a faulted pass is logged and dropped.
 */
export function armDispatchDrain(
  roster: DispatchRoster,
  opts: Parameters<typeof drainDispatches>[1] & {
    onDrained?: (delivered: number) => void
  },
): DispatchDrainHandle {
  let disposed = false
  let draining = false
  let rerun = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const pass = async (): Promise<void> => {
    const delivered = await drainDispatches(roster, opts)
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
