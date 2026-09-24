import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { SHELL_CALL_OUTPUT_LINES, SHELL_CALLS_KEPT, type WorkshopShellCall } from './contracts.js'

export interface ShellCallLedger {
  readonly calls: WorkshopShellCall[]
  open(ordinal: number, kind: string, payload: Record<string, unknown>): WorkshopShellCall | null
  settle(call: WorkshopShellCall | null, value: unknown): void
  refuse(call: WorkshopShellCall | null): void
}

export function lastOutputLines(text: string, limit: number = SHELL_CALL_OUTPUT_LINES): string[] {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines.slice(-limit)
}

export function shellCallLedger(): ShellCallLedger {
  const calls: WorkshopShellCall[] = []
  return {
    calls,
    open(ordinal, kind, payload) {
      if (kind !== 'tool' || payload.name !== BASH_TOOL_NAME) return null
      const input = payload.input as { command?: unknown } | null | undefined
      const call: WorkshopShellCall = { ordinal, command: typeof input?.command === 'string' ? input.command : '' }
      calls.push(call)
      while (calls.length > SHELL_CALLS_KEPT) calls.shift()
      return call
    },
    settle(call, value) {
      if (call === null || typeof value !== 'object' || value === null) return
      const answer = value as { code?: unknown; stdout?: unknown }
      if (typeof answer.code === 'number' || answer.code === null) call.code = answer.code
      if (typeof answer.stdout === 'string') call.outputTail = lastOutputLines(answer.stdout)
    },
    refuse(call) {
      if (call !== null) call.refused = true
    },
  }
}
