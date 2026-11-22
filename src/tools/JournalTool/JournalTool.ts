import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { JOURNAL_ENTRY_CAP, journalEnabled, stageJournalEntry, type JournalStageOutcome } from '../../mneme/journal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { JOURNAL_DESCRIPTION, JOURNAL_PROMPT, JOURNAL_TOOL_NAME } from './prompt.js'
import { renderJournalResult, renderJournalToolUse } from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const journalSchema = lazySchema(() =>
  z.strictObject({
    entry: z
      .string()
      .describe(
        `One-sentence entry under ${JOURNAL_ENTRY_CAP} characters.`,
      ),
  }),
)
type JournalSchema = ReturnType<typeof journalSchema>
type JournalOutput = JournalStageOutcome

export function journalResultWords(output: JournalOutput): string {
  if (!output.staged) return `journal entry refused: ${output.reason}`
  return `journal entry ${output.replaced ? 'replaced' : 'staged'} (${output.chars} characters): it is written to the journal when this session ends; another ${JOURNAL_TOOL_NAME} call replaces it.`
}

export const JournalTool: Unbuilt = unbuilt('src/tools/JournalTool/JournalTool.ts:26')
