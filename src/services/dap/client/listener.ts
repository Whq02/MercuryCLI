import { connect as netConnect } from 'node:net'
import { DapCancelledError, throwIfDapAborted } from '../dapCancellation.js'
import { REQUEST_TIMEOUT_MS, type DapAdapterSpec, type DapListenerDial, type DapListenerTarget } from './shared.js'

export function listenerAttachTarget(
  spec: Pick<DapAdapterSpec, 'attachShape' | 'buildAttachArgs'>,
  options: { mode?: 'launch' | 'attach'; port?: number; host?: string },
): DapListenerTarget | null {
  if (options.mode !== 'attach' || options.port === undefined) return null
  if (spec.attachShape !== 'connect' || spec.buildAttachArgs !== undefined) return null
  return { host: options.host ?? '127.0.0.1', port: options.port }
}

export function listenerRefusedLine(target: DapListenerTarget, refused: string, adapterKey: string): string {
  const where = `${target.host}:${target.port}`
  const start =
    adapterKey === 'python'
      ? `start the program with its listener first — python -m debugpy --listen ${where} --wait-for-client <script> — then attach again`
      : `start the program with its debug listener on ${where} first, then attach again`
  return `nothing is listening at ${where} (${refused}) — ${start}`
}

export function dialListener(target: DapListenerTarget, deadlineMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<DapListenerDial> {
  throwIfDapAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (outcome: DapListenerDial): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const socket = netConnect({ host: target.host, port: target.port })
    const onAbort = (): void => {
      if (settled) return
      settled = true
      socket.destroy()
      signal?.removeEventListener('abort', onAbort)
      reject(new DapCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.setTimeout(deadlineMs)
    socket.once('connect', () => {
      socket.setTimeout(0)
      settle({ socket })
    })
    socket.once('timeout', () => {
      socket.destroy()
      settle({ refused: `no answer from ${target.host}:${target.port} within ${deadlineMs}ms` })
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle({ refused: error.code ?? error.message })
    })
  })
}
