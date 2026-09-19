import { format } from 'node:util'

const ISO_LINE_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

export function stampDaemonLogLine(line: string): string {
  return ISO_LINE_START.test(line) ? line : `${new Date().toISOString()} ${line}`
}

let installed = false

export function installStampedDaemonLog(): void {
  if (installed) return
  installed = true
  const original = console.error.bind(console)
  console.error = ((...args: unknown[]): void => {
    original(stampDaemonLogLine(format(...args)))
  }) as typeof console.error
}
