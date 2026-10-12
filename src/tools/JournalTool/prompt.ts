export const JOURNAL_TOOL_NAME = 'Journal'

export const JOURNAL_DESCRIPTION =
  "Write a brief entry into the journal: where the project is, what the queued backlog is, and constraints set by the operator. Plain words, concise, no longer than a sentence. Written to the journal in the Mercury home when the session ends; never under the project tree; Mercury never pushes, syncs or shares it."

export const JOURNAL_PROMPT = `Write a brief entry into the journal: where the project is, what the queued backlog is, and constraints set by the operator. Plain words, concise, no longer than a sentence.

- One entry per session; a later call replaces the earlier one. The entry is written to the journal when this session ends. The journal lives in the Mercury home beside the project's memory, never under the project tree, and Mercury never pushes, syncs or shares it. The next session reads the last entry only when the operator's setting (memory.journalOnEntryPage) says so; the operator reads it in /memory.`
