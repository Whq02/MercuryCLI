// ============================================================================
//  askPing — the needs-you terminal ping wire.
//
//  Subscribes to the durable obligations owner and fires ONE coalesced ping
//  per store settle when a NEW open obligation appears. Edge detection is a
//  seen-obligationId set: a burst landing in one settle is one ping;
//  settles/answers/completions and revision bumps on already-seen rows
//  never ping (the ruled never-on-completions law). Obligation ids never
//  revive — a settled row never reopens and a reused ref mints a fresh id —
//  so the seen set prunes to the still-open rows each pass.
//
//  Channel truth rides the notifier's OWN resolver (one authority:
//  preferredNotifChannel × terminal identity); disabled pings nothing. The
//  host-signal tap (useObligationSignals → notificationPolicy) is the
//  desktop-notification lane and stays independent — this is the ruled
//  audible ping, mounted by the switchboard surface owner.
// ============================================================================
import {
  postTerminalNotification,
  type PingMethod,
  type TerminalPingReceipt,
} from '../../ink/termio/notifyPing.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { env } from '../../utils/env.js'
import { openObligations, subscribeObligations } from '../crew/obligations.js'
import { resolveNotificationMethod } from '../notifier.js'

export interface AskPingHandle {
  stop(): void
  /** stop() alias for effect-cleanup call sites. */
  dispose(): void
}

/** The notifier's resolution folded onto the ping's closed mechanism:
 *  OSC 9 exactly where the in-repo capability owner proves it (iTerm2);
 *  the BEL floor everywhere else (kitty/ghostty speak other protocols —
 *  for the ping that counts as the family refusing OSC 9); disabled and
 *  unknown-channel stay silent. */
export function pingMethodFor(channel: string, terminalId: string): PingMethod {
  const effective = resolveNotificationMethod(channel, terminalId).effective
  if (effective === 'disabled' || effective === 'none') return 'none'
  if (effective === 'iterm2') return 'osc9'
  if (effective === 'iterm2_with_bell') return 'osc9+bell'
  return 'bell'
}

export interface StartAskPingOptions {
  /** Prover seam — the crew store dir (production: the project default). */
  dir?: string
  /** Injected writer (the UI passes ink's writeRaw; default process.stdout). */
  write?: (data: string) => void
  /** Prover seam — the ping sink; production posts the real bytes. */
  post?: (message: string, method: PingMethod) => TerminalPingReceipt
  /** Prover seams — pin the channel/terminal facts (the ambient-state law);
   *  production reads the live config + terminal identity. */
  channel?: string
  terminalId?: string
}

/**
 * Start the wire. The FIRST pass only baselines the already-open backlog —
 * those rows are on the needs-you rail already; the ping is for a new ask
 * landing while the operator is away, never a boot chorus.
 */
export function startAskPing(opts: StartAskPingOptions = {}): AskPingHandle {
  const seen = new Set<string>()
  let baselined = false
  let stopped = false
  // Store events serialize onto one chain — overlapping reads would race
  // the seen-set update and double-ping a single settle.
  let chain: Promise<void> = Promise.resolve()

  const post =
    opts.post ??
    ((message: string, method: PingMethod) =>
      postTerminalNotification(message, {
        method,
        ...(opts.write !== undefined ? { write: opts.write } : {}),
      }))

  const evaluate = async (): Promise<void> => {
    if (stopped) return
    const rows = await openObligations({ scope: 'switchboard', ...(opts.dir !== undefined ? { dir: opts.dir } : {}) })
    if (stopped) return
    const fresh = rows.filter(r => !seen.has(r.obligationId))
    seen.clear()
    for (const r of rows) seen.add(r.obligationId)
    if (!baselined) {
      baselined = true
      return
    }
    if (fresh.length === 0) return
    const method = pingMethodFor(
      opts.channel ?? getGlobalConfig().preferredNotifChannel,
      opts.terminalId ?? env.terminal ?? '',
    )
    if (method === 'none') return
    const message =
      fresh.length === 1
        ? `needs you — ${fresh[0]!.question}`
        : `needs you — ${fresh.length} questions waiting`
    post(message, method)
  }

  const run = (): void => {
    chain = chain.then(() =>
      evaluate().catch(e => logForDebugging(`[ask-ping] evaluate failed: ${e}`)),
    )
  }

  run() // the baseline pass — subscribeObligations is immediate:false
  const unsub = subscribeObligations(run, { scope: 'switchboard', ...(opts.dir !== undefined ? { dir: opts.dir } : {}) })

  const stop = (): void => {
    if (stopped) return
    stopped = true
    unsub()
  }
  return { stop, dispose: stop }
}
