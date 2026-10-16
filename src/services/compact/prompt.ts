import type { CompactMetadata } from '../../types/message.js'
import { otherToolsLine, type TurnReceiptCounts } from '../../utils/cockpit/turnReceipt.js'
import { plural } from '../../utils/stringUtils.js'

const NO_TOOLS_PREAMBLE = `Reply with prose only — no tool calls of any kind. Do not invoke Read, Bash, Grep, Glob, Edit, Write, Task, or any other tool. Any tool call will be refused outright, and because you have exactly one turn, a refused call means this summarisation attempt produces nothing and fails. The conversation below already contains everything you need; there is nothing to look up.`

const NO_TOOLS_TRAILER = `Remember: prose only, no tool calls. Produce the summary now.`

const AGENTS_IN_FLIGHT_SECTION = `10. Agents in flight: every agent still running or owed a result at the turnover — crewmates, workflow runs and their crewmates, background shells — with the name or id a message reaches it by (the SendMessage address), what it was asked, and what is owed back (a result not yet retrieved, a notification pending). A running agent is never re-spawned; a pending result is collected, not re-derived. Write "none" when nothing runs.`

const SUMMARY_SECTIONS = `Your summary must contain these ten numbered sections:
1. Operator Intent: every explicit request, in detail.
2. Technical Ground: technologies, patterns and frameworks in play.
3. Files and Code Touched: files examined, modified or created — with particular attention to the most recent messages, full code snippets where applicable, and a note on why each file matters.
4. Errors and Corrections: every error hit, how it was fixed, and any operator feedback about it.
5. Problems Worked: problems solved and any ongoing troubleshooting.
6. Operator Messages: every message the operator sent that is not a tool result.
7. Open Work: work the operator explicitly asked for that is not yet done.
8. Where Work Stands: precisely what was being worked on most recently, with file names and code snippets.
9. Next Move (optional): the next step directly in line with the operator's most recent explicit request and the task in flight. Do not start tangential or already-completed work without confirming first. Include verbatim quotes from the most recent conversation showing exactly what task was in hand and where it stopped.
${AGENTS_IN_FLIGHT_SECTION}`

const OUTPUT_EXAMPLE = `Structure your output like this:
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

const EXTRA_INSTRUCTIONS_NOTE = `The included context may contain additional summarisation instructions — for example a MERCURY.md section saying "when compacting, always preserve the full list of failing tests", or an operator note reading "focus the summary on the database migration work". Follow any such instructions when producing the summary.`

const BASE_TEMPLATE = `Write the running record of this conversation: a summary detailed enough that development continues without losing context. Weigh the operator's explicit requests and your own prior actions heavily, and keep the technical grain — code patterns, architectural decisions, exact detail.

${SUMMARY_SECTIONS}

${OUTPUT_EXAMPLE}

${EXTRA_INSTRUCTIONS_NOTE}`

const RUN_CAPSULE_STEERING = `A machine-generated continuation record accompanies your summary. It already holds the factual inventories — what the run is for, the state of each deliverable, which files changed, which attempts failed, where verification stands, and what happens next — so repeating them is wasted effort. Spend your budget on what only you can supply: constraints and decisions the operator has imposed that are still binding, the reasoning that ruled out the approaches already discarded, the non-obvious context behind the approach now in flight, and pointers to the files and symbols the next turn should simply re-read. Keep verbatim fragments only where they carry weight and cannot be recovered from the repository.`

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

const FROM_TEMPLATE = `Summarise ONLY the recent portion of this conversation — the messages after the retained earlier context. The earlier messages are being kept intact and need no summary.

${SUMMARY_SECTIONS.replace('the conversation', 'the recent messages')}

${OUTPUT_EXAMPLE}

${EXTRA_INSTRUCTIONS_NOTE}`

const UP_TO_TEMPLATE = `Summarise this conversation. Your summary will be placed at the START of a continuing session, with newer messages following it that you cannot see — so it must be thorough enough that someone reading only your summary plus those newer messages can continue the work.

Your summary must contain these ten numbered sections:
1. Operator Intent: every explicit request, in detail.
2. Technical Ground: technologies, patterns and frameworks in play.
3. Files and Code Touched: files examined, modified or created — with full code snippets where applicable and a note on why each file matters.
4. Errors and Corrections: every error hit, how it was fixed, and any operator feedback about it.
5. Problems Worked: problems solved and any ongoing troubleshooting.
6. Operator Messages: every message the operator sent that is not a tool result.
7. Open Work: work the operator explicitly asked for that is not yet done.
8. Delivered This Stretch: what was finished by the end of this portion of the conversation.
9. Context to Carry: the context, decisions and state needed to understand and continue the work in the subsequent messages.
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
