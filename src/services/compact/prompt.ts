import type { CompactMetadata } from '../../types/message.js'
import { otherToolsLine, type TurnReceiptCounts } from '../../utils/cockpit/turnReceipt.js'
import { plural } from '../../utils/stringUtils.js'

const NO_TOOLS_PREAMBLE = `Reply with prose only — no tool calls of any kind. Do not invoke Read, Bash, Grep, Glob, Edit, Write, Crewmate, or any other tool: tool calls are refused, and with only one turn a refused call fails this summarisation. Everything needed is in the conversation below.`

const NO_TOOLS_TRAILER = `Remember: prose only, no tool calls. Produce the summary now.`

const AGENTS_IN_FLIGHT_SECTION = `10. Agents in flight: every agent still running or owed a result at turnover (crewmates, workflows and their crewmates, background shells) — SendMessage address (name or id), what was asked, and what is owed back. Never re-spawn running agents or re-derive pending results. Write "none" if none.`

const SUMMARY_SECTIONS = `Your summary must contain these ten numbered sections:
1. Operator Intent: every explicit request, in detail.
2. Technical Ground: technologies, patterns and frameworks in play.
3. Files and Code Touched: files examined, modified or created (especially recent ones), key code snippets where needed, and why each file matters.
4. Errors and Corrections: every error hit, how it was fixed, and any operator feedback.
5. Problems Worked: problems solved and ongoing troubleshooting.
6. Operator Messages: every message the operator sent that is not a tool result.
7. Open Work: work the operator explicitly asked for that is not yet done.
8. Where Work Stands: what was being worked on most recently, with file names and code snippets.
9. Next Move (optional): the immediate next step aligned with the operator's latest explicit request and active task (never start tangential or finished work without confirming), with verbatim quotes showing where work stopped.
${AGENTS_IN_FLIGHT_SECTION}`

const OUTPUT_EXAMPLE = `Output format:
<summary>
1. Operator Intent:
   [...]
2. Technical Ground:
   [...]
3. Files and Code Touched:
   [...]
4. Errors and Corrections:
   [...]
5. Problems Worked:
   [...]
6. Operator Messages:
   [...]
7. Open Work:
   [...]
8. Where Work Stands:
   [...]
9. Next Move (optional):
   [...]
10. Agents in flight:
   [...]
</summary>`

export const SUMMARY_SECTION_TITLES: ReadonlyArray<string> = [
  'Operator Intent',
  'Technical Ground',
  'Files and Code Touched',
  'Errors and Corrections',
  'Problems Worked',
  'Operator Messages',
  'Open Work',
  'Where Work Stands',
  'Next Move (optional)',
  'Agents in flight',
  'Delivered This Stretch',
  'Context to Carry',
]

const EXTRA_INSTRUCTIONS_NOTE = `Follow any summarisation instructions present in context (such as MERCURY.md rules or operator notes).`

const BASE_TEMPLATE = `Summarise this conversation thoroughly enough for work to continue seamlessly, weighting explicit operator requests and prior actions heavily and preserving exact technical detail, code patterns and architectural decisions.

${SUMMARY_SECTIONS}

${OUTPUT_EXAMPLE}

${EXTRA_INSTRUCTIONS_NOTE}`

const RUN_CAPSULE_STEERING = `A machine-generated continuation record accompanies your summary and already carries factual inventories (objective, deliverable states, changed files, failed attempts, verification state, next action) — do not repeat them. Spend your budget on what only you know: binding operator constraints/decisions, why discarded approaches were ruled out, non-obvious context for the active approach, and file/symbol pointers to re-read (quoting verbatim only what the repo does not hold).`

function withCustomInstructions(body: string, customInstructions: string | undefined): string {
  const trimmed = customInstructions?.trim()
  if (trimmed === undefined || trimmed === '') return body
  return `${body}\n\n## Additional instructions\n${trimmed}`
}

export function getCompactPrompt(
  customInstructions?: string,
  opts?: { runCapsulePresent?: boolean },
): string {
  const parts = [NO_TOOLS_PREAMBLE, BASE_TEMPLATE]
  if (opts?.runCapsulePresent === true) parts.push(RUN_CAPSULE_STEERING)
  return `${withCustomInstructions(parts.join('\n\n'), customInstructions)}\n\n${NO_TOOLS_TRAILER}`
}

const FROM_TEMPLATE = `Summarise only the recent messages after the retained earlier context (which stays intact and needs no summary).

${SUMMARY_SECTIONS}

${OUTPUT_EXAMPLE}

${EXTRA_INSTRUCTIONS_NOTE}`

const UP_TO_TEMPLATE = `Summarise this prefix of the conversation: your summary will sit at the start of a continuing session ahead of newer unseen messages, so keep everything needed to continue seamlessly alongside them.

Your summary must contain these ten numbered sections:
1. Operator Intent: every explicit request, in detail.
2. Technical Ground: technologies, patterns and frameworks in play.
3. Files and Code Touched: files examined, modified or created, key code snippets where needed, and why each file matters.
4. Errors and Corrections: every error hit, how it was fixed, and any operator feedback.
5. Problems Worked: problems solved and ongoing troubleshooting.
6. Operator Messages: every message the operator sent that is not a tool result.
7. Open Work: work the operator explicitly asked for that is not yet done.
8. Delivered This Stretch: what was finished by the end of this prefix.
9. Context to Carry: context, decisions and state needed to understand and continue the subsequent messages.
${AGENTS_IN_FLIGHT_SECTION}

${OUTPUT_EXAMPLE}

${EXTRA_INSTRUCTIONS_NOTE}`

export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: 'from' | 'up_to' = 'from',
): string {
  const parts = [
    NO_TOOLS_PREAMBLE,
    direction === 'from' ? FROM_TEMPLATE : UP_TO_TEMPLATE,
  ]
  return `${withCustomInstructions(parts.join('\n\n'), customInstructions)}\n\n${NO_TOOLS_TRAILER}`
}

function formatCompactSummary(summary: string): string {
  let out = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  const summaryBlock = /<summary>([\s\S]*?)<\/summary>/.exec(out)
  if (summaryBlock !== null) {
    out = out.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(summaryBlock[1] as string).trim()}`)
  }
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

export const NEWEST_MESSAGE_HAS_THE_FLOOR =
  "The operator's newest message follows below, after the preserved messages: it was sent after everything above and it has the floor. Answer it first and in full; carry the task in flight on only afterwards, and only if that message does not change it. No acknowledgement of the summary, no recap of what was happening."

export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
  newestMessageFollows?: boolean,
): string {
  const parts = [
    'The context window turned over; this session carries on from an earlier stretch of the same conversation. The summary below holds the earlier portion.',
    formatCompactSummary(summary),
  ]
  if (transcriptPath !== undefined && transcriptPath !== '') {
    parts.push(
      `When a precise artifact from before the turnover matters — an exact snippet, an error text, something you wrote — the complete transcript is on disk at: ${transcriptPath}`,
    )
  }
  if (recentMessagesPreserved === true) {
    parts.push('The most recent messages of the conversation are preserved verbatim after this summary.')
  }
  if (newestMessageFollows === true) {
    parts.push(NEWEST_MESSAGE_HAS_THE_FLOOR)
  } else if (suppressFollowUpQuestions === true) {
    parts.push(
      'Pick the work up exactly where it stopped, with no questions back to the operator. Resume directly — no acknowledgement of the summary, no recap of what was happening, no "I\'ll continue" preface. Carry the last task on as if the break never happened.',
    )
  }
  return parts.join('\n\n')
}

const FOLDED_WORK_MAX_FILES = 24
const FOLDED_WORK_MAX_TOOLS = 12
const FOLDED_WORK_MAX_RECEIPTS = 8

function receiptWords(c: TurnReceiptCounts): string {
  const parts: string[] = []
  const delta = `${c.adds > 0 ? ` +${c.adds}` : ''}${c.dels > 0 ? ` −${c.dels}` : ''}`
  if (c.scratchpadEdits > 0) parts.push(`${c.scratchpadEdits} scratchpad ${plural(c.scratchpadEdits, 'edit')}${c.fileEdits === 0 ? delta : ''}`)
  if (c.fileEdits > 0) parts.push(`${c.fileEdits} file ${plural(c.fileEdits, 'edit')}${delta}`)
  if (c.reads > 0) parts.push(`${c.reads} ${plural(c.reads, 'read')}`)
  if (c.searches > 0) parts.push(`${c.searches} ${plural(c.searches, 'search', 'searches')}`)
  if (c.fetches > 0) parts.push(`${c.fetches} ${plural(c.fetches, 'fetch', 'fetches')}`)
  if (c.commands > 0) parts.push(`${c.commands} shell ${plural(c.commands, 'command')}`)
  if (c.browser > 0) parts.push(`${c.browser} browser ${plural(c.browser, 'action')}`)
  if (c.agents > 0) parts.push(`${c.agents} ${plural(c.agents, 'crewmate')}`)
  const others = otherToolsLine(c)
  if (others !== null) parts.push(others)
  return parts.join(' · ')
}

export function renderFoldedWork(work: CompactMetadata['work'] | undefined): string | null {
  if (work === undefined) return null
  const { recap, receipts } = work
  const tools = [...recap.toolCounts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (recap.turns === 0 && tools.length === 0 && recap.files.length === 0 && receipts.length === 0) return null
  const lines: string[] = ['## Folded work (deterministic — from the fold\'s receipts, not summarized)']
  const toolWords = tools.length === 0 ? 'none' : tools.slice(0, FOLDED_WORK_MAX_TOOLS).map(([name, n]) => `${name}×${n}`).join(', ') + (tools.length > FOLDED_WORK_MAX_TOOLS ? ` …+${tools.length - FOLDED_WORK_MAX_TOOLS} more` : '')
  lines.push(`Operator turns folded: ${recap.turns} · tool calls: ${toolWords} · failed tool calls: ${recap.toolFailures}`)
  for (const receipt of receipts.slice(0, FOLDED_WORK_MAX_RECEIPTS)) {
    const words = receiptWords(receipt.counts)
    if (words !== '') lines.push(`Folded part of a turn that continues below: ${words}`)
  }
  if (recap.files.length > 0) {
    const shown = recap.files.slice(0, FOLDED_WORK_MAX_FILES)
    lines.push(`Files the folded tools touched (re-READ on demand — contents not carried): ${shown.join(', ')}${recap.files.length > shown.length ? ` …+${recap.files.length - shown.length} more` : ''}`)
  }
  return lines.join('\n')
}
