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
  dispose(): void
}

export function pingMethodFor(channel: string, terminalId: string): PingMethod {
  const effective = resolveNotificationMethod(channel, terminalId).effective
  if (effective === 'disabled' || effective === 'none') return 'none'
  if (effective === 'iterm2') return 'osc9'
  if (effective === 'iterm2_with_bell') return 'osc9+bell'
  return 'bell'
}

export interface StartAskPingOptions {
  dir?: string
  write?: (data: string) => void
  post?: (message: string, method: PingMethod) => TerminalPingReceipt
  channel?: string
  terminalId?: string
}

export function startAskPing(opts: StartAskPingOptions = {}): AskPingHandle {
  const seen = new Set<string>()
  let baselined = false
  let stopped = false
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

  run()
  const unsub = subscribeObligations(run, { scope: 'switchboard', ...(opts.dir !== undefined ? { dir: opts.dir } : {}) })

  const stop = (): void => {
    if (stopped) return
    stopped = true
    unsub()
  }
  return { stop, dispose: stop }
}
