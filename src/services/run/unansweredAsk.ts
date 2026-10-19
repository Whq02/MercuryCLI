import type { PermissionDecision } from '../../types/permissions.js'
import type { ErrorClass } from '../../rows/vocabulary.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'

export function askNobodyAnswered(decision: PermissionDecision | undefined): boolean {
  if (decision === undefined) return false
  if (decision.behavior === 'ask') return true
  if (decision.behavior !== 'deny') return false
  if (decision.unanswered === true) return true
  const reason = decision.decisionReason
  return reason.type === 'asyncAgent' || (reason.type === 'mode' && reason.mode === 'dontAsk')
}

interface UnansweredAsk {
  tool: string
  input?: Record<string, unknown>
}

const QUESTION_CHARS = 200

function clampQuestion(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > QUESTION_CHARS ? `${flat.slice(0, QUESTION_CHARS - 1)}…` : flat
}

function questionsOf(ask: UnansweredAsk): string[] {
  const raw = ask.input?.questions
  if (!Array.isArray(raw)) return []
  return raw
    .map(entry => (entry && typeof entry === 'object' ? (entry as { question?: unknown }).question : undefined))
    .filter((q): q is string => typeof q === 'string' && q.trim() !== '')
    .map(clampQuestion)
}

export function unansweredAsksBlocker(asks: ReadonlyArray<UnansweredAsk>): { message: string; class: ErrorClass; detail: string[] } {
  const questions = [...new Set(asks.filter(ask => ask.tool === ASK_USER_QUESTION_TOOL_NAME).flatMap(questionsOf))]
  const tools = [...new Set(asks.filter(ask => ask.tool !== ASK_USER_QUESTION_TOOL_NAME || questionsOf(ask).length === 0).map(ask => ask.tool))]
  const parts: string[] = []
  const detail: string[] = []
  if (questions.length > 0) {
    parts.push(`the run asked ${questions.map(q => `«${q}»`).join(' and ')} and nobody could answer`)
    detail.push('resume when: the question is answered — put the answer in the prompt and run again, or run under a host that answers asks (mercury runner)')
  }
  if (tools.length > 0) {
    const names = tools.join(', ')
    parts.push(`${names} asked for an answer nobody could give, so the run could not do what was asked`)
    detail.push(`resume when: the ask can be answered — pre-approve a tool at launch with --allowed-tools ${tools.join(',')}, start in a permission mode that does not stop there with --mode, or run under a host that answers asks (mercury runner)`)
  }
  return { message: `Blocked on the operator: ${parts.join('; ')}`, class: 'blocked', detail }
}
