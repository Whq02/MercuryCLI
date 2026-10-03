import { termWrite } from '../../render-engine/cockpit/terminalOut.js'
import { env } from '../../utils/env.js'
import { BEL } from './ansi.js'
import { osc, OSC, wrapForMultiplexer } from './osc.js'

export type PingMethod = 'osc9' | 'bell'

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
): PingMethod {
  const method = opts.method ?? defaultPingMethod()
  const write =
    opts.write ??
    ((data: string) => termWrite(process.stdout, data, 'bell'))
  if (method === 'osc9') {
    write(buildOsc9Notification(message))
    return method
  }
  write(BEL)
  return method
}
