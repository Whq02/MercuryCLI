export const JOURNAL_TOOL_NAME = 'Journal'

export const JOURNAL_ENTRY_SHAPE =
  "where the project is, what the queued backlog is, and what the user asked for in this session, in their words — never Mercury's own standing instructions. Plain words, concise, no longer than a sentence."

export const JOURNAL_DESCRIPTION = `Write a brief entry into the journal: ${JOURNAL_ENTRY_SHAPE} Written to the journal in the Mercury home when the session ends; never under the project tree; Mercury never pushes, syncs or shares it.`

export const JOURNAL_PROMPT = `Write a brief entry into the journal: ${JOURNAL_ENTRY_SHAPE}

One entry per session (a later call replaces it), written at session end to the Mercury home beside project memory — never under the project tree, and never pushed, synced or shared. The next session sees the last entry only when memory.journalOnEntryPage is on; the operator reads it in /memory.`
