export const RECORD_CONVENTION_TOOL_NAME = 'RecordConvention'

export const RECORD_CONVENTION_DESCRIPTION =
  'Record a durable project convention the user stated — how this project is built, run or tested, what not to touch — into the project instruction estate (MERCURY.md, or the guide it explicitly points at), for everyone who works in the project. Not for one-off task details, and not for a rule the user asks Mercury to remember about how to work with them: that is pinned memory (Retain with pin).'

export function buildRecordConventionPrompt(): string {
  return `Writes one user-stated project convention into MERCURY.md (created when absent) or its explicit @import guide, returning the written path. Exact restatements write nothing; replaces swaps a matching rule line in place across the estate.`
}
