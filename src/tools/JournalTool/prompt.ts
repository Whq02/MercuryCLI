export const JOURNAL_TOOL_NAME = 'Journal'

export const JOURNAL_DESCRIPTION =
  "Write this session's journal entry: your own account, in the first person, for the sessions that follow — what happened, what the operator wanted, what you noticed about how they like to work, what you got wrong. Written to the journal in the Mercury home when the session ends; never under the project tree; Mercury never pushes, syncs or shares it."

export const JOURNAL_PROMPT = `Write this session's journal entry, in your own words.

- One entry per session: what happened, what the operator wanted, what you noticed about how they like to work, what you got wrong. First person, plain words, kept short (under 4000 characters). A fault is yours and said so; no praise of the work and no grand words.
- Not for project facts or conventions: those go to the instruction file or Retain. What you noticed about the operator goes here and never into the instruction file.
- The entry is written to the journal when this session ends; a later call replaces the earlier one. The journal lives in the Mercury home beside the project's memory, never under the project tree, and Mercury never pushes, syncs or shares it. The next session reads the last entry only when the operator's setting (memory.journalOnEntryPage) says so; the operator reads it in /memory.`
