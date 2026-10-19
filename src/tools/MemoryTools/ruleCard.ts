import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionResult } from '../../types/permissions.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import type { CorrectOp, RetainItemInput, RuleAuthority } from '../../mneme/memoryVerbs.js'
import { observationOverflow, pendingRows } from '../../mneme/mnemeBuffer.js'
import { USER_ASKED_RULE_ROAD } from '../../mneme/mnemeCorrect.js'
import { listArchiveDocs, listTopicDocs } from '../../mneme/mnemeLibrary.js'
import { memorySecretRefusal } from '../../mneme/mnemeSecretGuard.js'
import { readPins } from '../../mneme/mnemeUsage.js'

export const RULE_CARD_KEEP = 'keepRule'

interface AskedRule {
  id: string
  words: string
}

interface RuleChange {
  rule: AskedRule
  change: string
}

type RuleVerdict = { ok: true; via: RuleAuthority } | { ok: false; code: 'user-kept-rule' | 'user-asked-rule'; message: string }

const said = (text: string): string => text.replace(/[\r\n]+/g, ' ').trim()

function liveWords(seq: number, dir: string): string | null {
  for (const doc of [...listTopicDocs(dir), ...listArchiveDocs(dir)]) {
    for (const section of doc.sections) {
      const entry = section.entries.find(e => e.seq === seq)
      if (entry) return entry.text
    }
  }
  return null
}

export function askedRuleOf(id: string, dir: string): AskedRule | null {
  const seqMatch = /^seq:(\d+)$/.exec(id.trim())
  if (seqMatch) {
    const seq = Number(seqMatch[1])
    if (!readPins(dir).some(pin => pin.seq === seq && pin.asked === true)) return null
    const words = liveWords(seq, dir)
    return words === null ? null : { id: `seq:${seq}`, words }
  }
  if (!id.startsWith('pending:')) return null
  const ts = id.slice('pending:'.length)
  const rows = pendingRows(dir).filter(row => row.ts === ts)
  return rows.length === 1 && rows[0]!.asked === true ? { id, words: rows[0]!.text } : null
}

const ruleName = (rule: AskedRule): string => (rule.id.startsWith('seq:') ? `seq ${rule.id.slice('seq:'.length)}` : rule.id)

export function correctionChange(
  input: { op: CorrectOp; id: string; content?: string; replacementId?: string },
  dir: string,
): string {
  const draft = input.id.startsWith('pending:')
  const replacement = input.op === 'supersede' && input.replacementId ? /^seq:(\d+)$/.exec(input.replacementId.trim()) : null
  if (input.op === 'retract') return draft ? 'unpinned and struck; it is still a draft, so it leaves no history' : 'unpinned and struck; its wording is kept in history'
  if (replacement) {
    const seq = Number(replacement[1])
    const words = liveWords(seq, dir) ?? ''
    return draft ? `unpinned and struck; seq ${seq}, "${words}", carries the truth` : `replaced by seq ${seq}, "${words}"; the old wording goes to history and the pin moves to seq ${seq}`
  }
  const next = said(input.content ?? '')
  return draft ? `corrected to "${next}"; the new wording takes the draft's place, pinned, with the old words kept as its history` : `corrected to "${next}"; the old wording goes to history and the pin follows the new one`
}

export function askedReplacements(items: readonly RetainItemInput[], dir: string): Array<{ index: number; change: RuleChange }> {
  const out: Array<{ index: number; change: RuleChange }> = []
  items.forEach((item, index) => {
    const content = (item.content ?? '').trim()
    if (!content) return
    const context = item.context?.trim() ?? ''
    const text = context ? `${content} (context: ${context})` : content
    if (observationOverflow(text) !== null || memorySecretRefusal(text) !== null) return
    const rule = askedRuleOf(item.replaces?.trim() ?? '', dir)
    if (rule === null || !rule.id.startsWith('seq:')) return
    out.push({ index, change: { rule, change: `replaced by "${said(text)}"; the old wording goes to history and the pin follows the new one` } })
  })
  return out
}

export function ruleCardText(toolName: string, changes: readonly RuleChange[], reason?: string): string {
  const lead = changes.length === 1 ? `${toolName} asks to change a rule you asked Mercury to remember.` : `${toolName} asks to change ${changes.length} rules you asked Mercury to remember.`
  const blocks = changes.map(({ rule, change }) => `${ruleName(rule)}: "${rule.words}"\nIt will be ${change}.`)
  const why = reason !== undefined && reason.trim() !== '' ? [`Mercury's reason: ${said(reason)}`] : []
  return [lead, ...blocks, ...why].join('\n')
}

const cards = new WeakMap<object, string>()

function underSovereign(context: Pick<ToolUseContext, 'getAppState'>): boolean {
  try {
    return modeBypassesPermissions(context.getAppState().toolPermissionContext.mode)
  } catch {
    return false
  }
}

export function ruleCardAsk(context: unknown): PermissionResult | null {
  const card = typeof context === 'object' && context !== null ? cards.get(context) : undefined
  return card === undefined ? null : { behavior: 'ask', message: card, decisionReason: { type: 'safetyCheck', reason: card, operatorOnly: true } }
}

export async function askRuleCard(input: {
  tool: Tool
  toolInput: Record<string, unknown>
  card: string
  rules: readonly AskedRule[]
  context: ToolUseContext
  canUseTool: CanUseToolFn | undefined
  parentMessage: AssistantMessage | undefined
}): Promise<RuleVerdict> {
  const names = input.rules.map(ruleName).join(', ')
  const plural = input.rules.length > 1
  const noOne = (why: string): RuleVerdict => ({
    ok: false,
    code: 'user-asked-rule',
    message: `${names} ${plural ? 'are rules' : 'is a rule'} the user asked Mercury to remember and ${why}, so nothing changed — the user changes ${plural ? 'them' : 'it'} ${USER_ASKED_RULE_ROAD}`,
  })
  const kept: RuleVerdict = { ok: false, code: 'user-kept-rule', message: `the user kept the ${plural ? 'rules' : 'rule'} — ${names} ${plural ? 'stay' : 'stays'} as ${plural ? 'they are' : 'it is'}, word for word; nothing changed` }
  if (underSovereign(input.context)) return { ok: true, via: 'sovereign' }
  if (typeof input.canUseTool !== 'function' || input.parentMessage === undefined) return noOne('this session has no one to answer the card that changes it')
  const cardContext: ToolUseContext = { ...input.context }
  cards.set(cardContext, input.card)
  try {
    const decision = await input.canUseTool(input.tool, input.toolInput, cardContext, input.parentMessage, input.context.toolUseId ?? '')
    if (decision.behavior === 'allow') {
      const answered = decision.updatedInput as Record<string, unknown> | undefined
      if (answered?.[RULE_CARD_KEEP] === true) return kept
      return { ok: true, via: decision.decisionReason?.type === 'bypassedAsk' ? 'sovereign' : 'card' }
    }
    if (decision.behavior === 'deny') {
      if (decision.unanswered === true) return noOne('nobody answered the card that changes it')
      const reason = decision.decisionReason?.type
      if (reason === 'asyncAgent' || reason === 'mode') return noOne('this session cannot put the card that changes it to the user')
      return kept
    }
    return input.context.abortController.signal.aborted ? kept : noOne('this session has no one to answer the card that changes it')
  } finally {
    cards.delete(cardContext)
  }
}
