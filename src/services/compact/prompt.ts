import type { CompactMetadata } from '../../types/message.js'
import { otherToolsLine, type TurnReceiptCounts } from '../../utils/cockpit/turnReceipt.js'
import { shellDirectoryLeftByCd } from '../../utils/cwd.js'
import { historyPartDir } from '../../utils/sessionStorage/historyParts.js'
import { plural } from '../../utils/stringUtils.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

const NO_TOOLS_PREAMBLE: Unbuilt = unbuilt('src/services/compact/prompt.ts:7')

const NO_TOOLS_TRAILER: Unbuilt = unbuilt('src/services/compact/prompt.ts:9')

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

function withCustomInstructions(body: string, customInstructions: string | undefined): string {
  return notBuilt('src/services/compact/prompt.ts:76')
}

export function getCompactPrompt(
  customInstructions?: string,
  opts?: { runCapsulePresent?: boolean },
): string {
  return notBuilt('src/services/compact/prompt.ts:82')
}

const FROM_TEMPLATE: Unbuilt = unbuilt('src/services/compact/prompt.ts:91')

const UP_TO_TEMPLATE: Unbuilt = unbuilt('src/services/compact/prompt.ts:99')

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

export const NEWEST_MESSAGE_HAS_THE_FLOOR: Unbuilt =
  unbuilt('src/services/compact/prompt.ts:138')

export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
  newestMessageFollows?: boolean,
): string {
  return notBuilt('src/services/compact/prompt.ts:141')
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
