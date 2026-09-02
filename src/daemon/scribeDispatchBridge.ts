import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseScribeEnvelope, OPERATOR_BROADCAST_LABEL, OPERATOR_NOTE_LABEL, type ScribeEnvelope, type DispatchEnvelope } from '../utils/scribe/scribeBus.js'
import { BUS_TEAM_LEAD_NAME, canonicalizeBusTarget, isManagedBusTeam } from '../utils/scribe/busIdentity.js'
import { getInboxPath, getMailboxStore, readUnreadMessages, markMessagesAsReadByPredicate, writeToMailbox } from '../utils/teammateMailbox.js'
import { dispatchDedup, type DispatchDedup } from '../utils/scribe/dispatchDedup.js'
import { faultPoint } from '../substrate/durablePublish.js'
import { logForDebugging } from '../utils/debug.js'

export const DISPATCH_REPLAY_NOTE =
  '[replayed after an interruption — this dispatch may have been partially or fully ' +
  'executed before the crash; verify the current state before redoing any work]\n\n'

const HELD_RETRY_MS = 1000

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

export function buildBackAgentUserFrame(
  env: ScribeEnvelope,
  frameOpts?: { replay?: boolean },
): string {
  let content = ''
  if (env.kind === 'dispatch') {
    const body = env.title ? `${env.title}\n\n${env.task}` : env.task
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
    content = `${env.broadcast ? OPERATOR_BROADCAST_LABEL : OPERATOR_NOTE_LABEL} ${env.text}`
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}

export function buildPlainBusFrame(from: string, text: string): string {
  const content =
    `[bus] plain message from ${from} (NOT a scribe envelope — bus kinds must be sent as ` +
    `structured SendMessage objects, e.g. message:{type:"dispatch", task:"…"}; if this text ` +
    `contains a task/spec, act on it and report back with a structured progress envelope):\n\n${text}`
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}

export type DispatchRoster = {
  reply: (short: string, text: string) => Promise<boolean>
}

export async function drainScribeDispatches(
  roster: DispatchRoster,
  opts: {
    short: string
    agentName: string
    teamName: string
    deliverReplies?: boolean
    isBusy?: () => boolean
    onClear?: () => void
    hasSeen?: (requestId: string) => boolean
    markSeen?: (requestId: string) => void
    resolveRoute?: (env: DispatchEnvelope) => { model?: string; effort?: string } | undefined
    currentRoute?: () => { model?: string; effort?: string }
    reconfigureRoute?: (patch: { model?: string; effort?: string }) => void
    onRouteHeld?: (env: DispatchEnvelope, patch: { model?: string; effort?: string }) => void
    onDelivered?: (env: ScribeEnvelope) => void
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
  const toMark: Array<{ text: string; timestamp: string; from: string; requestId?: string }> = []
  const mark = (m: { text: string; timestamp: string; from: string }, requestId?: string) =>
    toMark.push({ text: m.text, timestamp: m.timestamp, from: m.from, requestId })

  const parsed = unread.map(m => ({ m, env: parseScribeEnvelope(m.text) }))

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

  const fromDispatcher = (env: ScribeEnvelope | null): boolean =>
    !!env &&
    typeof env.from === 'string' &&
    env.from.length > 0 &&
    env.from !== 'implementer'

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

  const dispatches: Array<{ m: (typeof parsed)[number]['m']; env: DispatchEnvelope }> = []
  const seenThisPass = new Set<string>()
  for (const { m, env } of deduped) {
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
      logForDebugging(`[daemon] scribe control: cancel ref=${env.refRequestId ?? '?'} — dropping the queued target if present`)
      mark(m, env.request_id)
      continue
    }
    if (env && env.kind === 'control') {
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
    mark(m, env.request_id)
  }

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
      if (opts.hasSeen?.(id)) {
        seenThisPass.add(id)
        mark(d.m, id)
        return true
      }
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
        const chosen = ordered[0]!
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
      for (const d of ordered) await deliverOne(d)
    }
  }

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
      return 0
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const alias = basename(entry, '.json')
      if (alias === canonicalAgent) continue
      const resolved = canonicalizeBusTarget(teamName, alias)
      if (!resolved.known || resolved.name !== canonicalAgent) continue
      try {
        const a = statSync(join(inboxDir, entry))
        const c = statSync(getInboxPath(canonicalAgent, teamName))
        if (a.dev === c.dev && a.ino === c.ino) continue
      } catch {
      }
      const unread = await readUnreadMessages(alias, teamName)
      if (unread.length === 0) continue
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
          await markMessagesAsReadByPredicate(
            alias,
            x => x.text === m.text && x.timestamp === m.timestamp && x.from === m.from,
            teamName,
          ).catch(() => {})
          continue
        }
        const ok = await writeToMailbox(
          canonicalAgent,
          { from: m.from, text: m.text, timestamp: new Date().toISOString(), ...(m.color ? { color: m.color } : {}) },
          teamName,
        )
        if (!ok) continue
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

export interface DispatchDrainHandle {
  drain: () => void
  dispose: () => void
}

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
    const healed = await healAliasInboxes(opts.agentName, opts.teamName)
    if (healed > 0) logForDebugging(`[daemon] bus heal fed ${healed} message(s) into this drain pass`)
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
