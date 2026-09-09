

export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'

export function interruptedToolsLine(toolNames: readonly string[]): string {
  const names = [...new Set(toolNames)]
  const list = names.length === 0 ? 'the running tool' : names.join(', ')
  return `the interrupt ended ${list} — the turn is over`
}


export type TurnCutKind = 'operator' | 'idle-timeout' | 'parent-stop' | 'cut'
export type TurnCut = { kind: TurnCutKind; detail?: string }

export type TurnCutReason =
  | 'interrupt'
  | 'crew-stop'
  | 'user-skip'
  | 'user-retry'
  | 'user-kill'
  | 'stalled'
  | 'workflow-abort'
  | 'throttled'
  | 'terminal-400'
  | 'workflow-permission-timeout'

export const TURN_CUT_WORDS: Record<Exclude<TurnCutReason, 'interrupt' | 'crew-stop' | 'user-skip' | 'user-retry' | 'user-kill' | 'stalled' | 'workflow-abort'>, string> = {
  throttled: 'the retry budget was spent',
  'terminal-400': 'the provider refused the request outright',
  'workflow-permission-timeout': 'the permission ask timed out',
}

export function abortWithCut(controller: Pick<AbortController, 'abort'>, reason: TurnCutReason): void {
  controller.abort(reason)
}

const OPERATOR_CUT_REASONS = new Set(['interrupt', 'crew-stop', 'user-skip', 'user-retry', 'user-kill'])
const IDLE_TIMEOUT_WORDS = 'a no-progress timeout (the provider went quiet)'
const PARENT_STOP_WORDS = 'the workflow that ran this agent stopped'

export function turnCutOf(reason: unknown): TurnCut {
  if (reason === undefined || reason === null) return { kind: 'operator' }
  if (typeof reason === 'string') {
    if (OPERATOR_CUT_REASONS.has(reason)) return { kind: 'operator' }
    if (reason === 'stalled') return { kind: 'idle-timeout' }
    if (reason === 'workflow-abort') return { kind: 'parent-stop' }
    const words = (TURN_CUT_WORDS as Record<string, string | undefined>)[reason]
    return { kind: 'cut', detail: words ?? reason }
  }
  if (typeof reason === 'object') {
    const named = reason as { name?: unknown; message?: unknown; code?: unknown }
    if (named.name === 'AbortError') return { kind: 'operator' }
    const message = typeof named.message === 'string' && named.message !== '' ? named.message : undefined
    if (named.name === 'DeadlineExceededError' || named.code === 'DEADLINE_EXCEEDED') {
      return { kind: 'idle-timeout', ...(message !== undefined ? { detail: message } : {}) }
    }
    return { kind: 'cut', ...(message !== undefined ? { detail: message } : {}) }
  }
  return { kind: 'cut', detail: String(reason) }
}

export function turnCutWhy(cut: TurnCut): string | null {
  if (cut.kind === 'operator') return null
  if (cut.kind === 'idle-timeout') return `${IDLE_TIMEOUT_WORDS}${cut.detail ? `: ${cut.detail}` : ''}`
  if (cut.kind === 'parent-stop') return PARENT_STOP_WORDS
  return cut.detail ?? 'the run was aborted'
}

export function turnCutLine(cut: TurnCut, toolUse: boolean): string {
  const why = turnCutWhy(cut)
  if (why === null) return toolUse ? INTERRUPT_MESSAGE_FOR_TOOL_USE : INTERRUPT_MESSAGE
  const during = toolUse ? ' during tool use' : ''
  return cut.kind === 'idle-timeout' ? `[Request cut off${during} by ${why}]` : `[Request cut off${during}: ${why}]`
}

export function turnCutResultText(cut: TurnCut): string {
  const why = turnCutWhy(cut)
  if (why === null) return 'Interrupted by user'
  return cut.kind === 'idle-timeout' ? `Cut off by ${why}` : `Cut off: ${why}`
}

export function turnCutOfText(text: string): TurnCut | null {
  if (text === INTERRUPT_MESSAGE || text === INTERRUPT_MESSAGE_FOR_TOOL_USE) return { kind: 'operator' }
  const match = /^\[Request cut off(?: during tool use)?(?: by (.+)|: (.+))\]$/s.exec(text)
  if (match === null) return null
  const timeout = match[1]
  if (timeout !== undefined) {
    const detail = timeout.startsWith(`${IDLE_TIMEOUT_WORDS}: `) ? timeout.slice(IDLE_TIMEOUT_WORDS.length + 2) : undefined
    return { kind: 'idle-timeout', ...(detail !== undefined ? { detail } : {}) }
  }
  const rest = match[2] ?? ''
  if (rest === PARENT_STOP_WORDS) return { kind: 'parent-stop' }
  return { kind: 'cut', detail: rest }
}

export function isTurnCutText(text: string): boolean {
  return turnCutOfText(text) !== null
}
