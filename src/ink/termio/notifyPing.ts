import { termWrite } from '../../render-engine/cockpit/terminalOut.js'
import { env } from '../../utils/env.js'
import { BEL } from './ansi.js'
import { osc, OSC, wrapForMultiplexer } from './osc.js'

export type PingMethod = 'osc9' | 'osc9+bell' | 'bell' | 'none'

export interface TerminalPingReceipt {
  method: PingMethod
  emitted: boolean
}

const MAX_PING_MESSAGE = 200

function sanitizePingMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .trim()
    .slice(0, MAX_PING_MESSAGE)
}

export function buildOsc9Notification(message: string): string {
  return wrapForMultiplexer(osc(OSC.ITERM2, `\n\n${sanitizePingMessage(message)}`))
}

export function defaultPingMethod(terminalId: string | null = env.terminal): PingMethod {
  return terminalId === 'iTerm.app' ? 'osc9' : 'bell'
}

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
