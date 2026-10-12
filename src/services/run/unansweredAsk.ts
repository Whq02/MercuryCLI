import type { PermissionDecision } from '../../types/permissions.js'
import type { ErrorClass } from '../../rows/vocabulary.js'

export function askNobodyAnswered(decision: PermissionDecision | undefined): boolean {
  if (decision === undefined) return false
  if (decision.behavior === 'ask') return true
  if (decision.behavior !== 'deny') return false
  if (decision.unanswered === true) return true
  const reason = decision.decisionReason
  return reason.type === 'asyncAgent' || (reason.type === 'mode' && reason.mode === 'dontAsk')
}

export function unansweredAsksBlocker(tools: string[]): { message: string; class: ErrorClass; detail: string[] } {
  const names = tools.join(', ')
  return {
    message: `Blocked on the operator: ${names} asked for an answer nobody could give, so the run could not do what was asked`,
    class: 'blocked',
    detail: [`resume when: the ask can be answered — pre-approve a tool at launch with --allowed-tools ${tools.join(',')}, start in a permission mode that does not stop there with --mode, or run under a host that answers asks (mercury runner)`],
  }
}
