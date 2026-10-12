import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { JOURNAL_ENTRY_CAP, journalEnabled, stageJournalEntry, type JournalStageOutcome } from '../../mneme/journal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { JOURNAL_DESCRIPTION, JOURNAL_PROMPT, JOURNAL_TOOL_NAME } from './prompt.js'
import { renderJournalResult, renderJournalToolUse } from './UI.js'

const journalSchema = lazySchema(() =>
  z.strictObject({
    entry: z
      .string()
      .describe(
        `A brief entry: where the project is, what the queued backlog is, and constraints set by the operator. Plain words, concise, no longer than a sentence (under ${JOURNAL_ENTRY_CAP} characters).`,
      ),
  }),
)
type JournalSchema = ReturnType<typeof journalSchema>
export type JournalOutput = JournalStageOutcome

function safeSession(): string {
  try {
    return String(getSessionId())
  } catch {
    return 'boot'
  }
}

export function journalResultWords(output: JournalOutput): string {
  if (!output.staged) return `journal entry refused: ${output.reason}`
  return `journal entry ${output.replaced ? 'replaced' : 'staged'} (${output.chars} characters): it is written to the journal when this session ends; another ${JOURNAL_TOOL_NAME} call replaces it.`
}

export const JournalTool = buildTool({
  name: JOURNAL_TOOL_NAME,
  maxResultSizeChars: 2_000,
  get inputSchema(): JournalSchema {
    return journalSchema()
  },
  isEnabled() {
    return journalEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  capability: {
    intents: ["write this session's journal entry", 'leave an account of the session for the sessions that follow'],
    units: ['memory'],
    class: 'mutation',
    cancellation: 'not-applicable',
    latency: 'fast',
    proof: 'scripts/memory/prove-journal.ts',
  },
  async description() {
    return JOURNAL_DESCRIPTION
  },
  async prompt() {
    return JOURNAL_PROMPT
  },
  async call(input: z.infer<JournalSchema>) {
    return { data: stageJournalEntry(safeSession(), input.entry) }
  },
  mapToolResultToToolResultBlockParam(output: JournalOutput, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: journalResultWords(output),
      ...(output.staged ? {} : { is_error: true }),
    }
  },
  renderToolUseMessage: input => renderJournalToolUse(input),
  renderToolResultMessage: renderJournalResult,
} satisfies ToolDef<JournalSchema, JournalOutput>)
