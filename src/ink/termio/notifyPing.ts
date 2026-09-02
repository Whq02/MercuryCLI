// ============================================================================
//  termio/notifyPing — the terminal notification ping.
//
//  One ruled mechanism, nothing richer: OSC 9 (the iTerm2 notification
//  family) where the terminal family is proven to speak it, plain BEL
//  everywhere else. Desktop-notification ROUTING stays with
//  services/notifier.ts (the owning resolver); this file owns only the ping
//  bytes and their multiplexer law.
//
//  tmux law (the OSC 52 idiom in osc.ts setClipboardWithReceipt): the OSC 9
//  sequence rides DCS passthrough so the outer terminal sees it — the BEL
//  terminator inside the wrap is opaque payload there, never a bell. The
//  BEL FALLBACK is deliberately UNWRAPPED: raw \x07 triggers tmux's own
//  bell-action (window flag), which IS the fallback notification (osc.ts's
//  do-not-wrap-BEL warning; useTerminalNotification's notifyBell does the
//  same).
// ============================================================================
import { termWrite } from '../../render-engine/cockpit/terminalOut.js'
import { env } from '../../utils/env.js'
import { BEL } from './ansi.js'
import { osc, OSC, wrapForMultiplexer } from './osc.js'

export type PingMethod = 'osc9' | 'osc9+bell' | 'bell' | 'none'

export interface TerminalPingReceipt {
  method: PingMethod
  /** EMISSION only — delivery is the terminal's side, never claimed from
   *  emission alone (the notifier's law). */
  emitted: boolean
}

const MAX_PING_MESSAGE = 200

/** OSC payloads must not carry control bytes — an embedded ESC or BEL would
 *  terminate or corrupt the sequence mid-flight. */
function sanitizePingMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .trim()
    .slice(0, MAX_PING_MESSAGE)
}

/** The OSC 9 notification bytes, multiplexer-wrapped. The `\n\n` prefix is
 *  the useTerminalNotification idiom: OSC 9's first token must never read
 *  as a subcommand digit (`9;4;…` is the progress protocol). */
export function buildOsc9Notification(message: string): string {
  return wrapForMultiplexer(osc(OSC.ITERM2, `\n\n${sanitizePingMessage(message)}`))
}

/** The family default when the caller resolves nothing richer: OSC 9 is
 *  proven in this codebase for iTerm2 only (the notifier's own auto
 *  resolution); every other family gets the BEL floor. */
export function defaultPingMethod(terminalId: string | null = env.terminal): PingMethod {
  return terminalId === 'iTerm.app' ? 'osc9' : 'bell'
}

/**
 * Post one terminal notification ping. `method` is normally resolved by the
 * caller through the notifier's own resolver (askPing does); absent, the
 * family default above applies. `write` defaults to process.stdout — the
 * same stream ink's writeRaw wraps (options.stdout.write) — and UI callers
 * may inject that writeRaw instead.
 */
export function postTerminalNotification(
  message: string,
  opts: { method?: PingMethod; write?: (data: string) => void } = {},
): TerminalPingReceipt {
  const method = opts.method ?? defaultPingMethod()
  if (method === 'none') return { method, emitted: false }
  const write =
    opts.write ??
    ((data: string) => termWrite(process.stdout, data, 'bell'))
  if (method === 'osc9' || method === 'osc9+bell') {
    write(buildOsc9Notification(message))
    if (method === 'osc9+bell') write(BEL)
    return { method, emitted: true }
  }
  write(BEL)
  return { method, emitted: true }
}
