export const RECORD_CONVENTION_TOOL_NAME = 'RecordConvention'

export const RECORD_CONVENTION_DESCRIPTION =
  'Record a durable project convention the user stated — how this project is built, run or tested, what not to touch — into the project instruction estate (MERCURY.md, or the guide it explicitly points at), for everyone who works in the project. Not for one-off task details, and not for a rule the user asks Mercury to remember about how to work with them: that is pinned memory (Retain with pin).'

export function buildRecordConventionPrompt(): string {
  return `Writes one durable project convention the user stated into the project's instruction estate — MERCURY.md at the project root, born with the first rule when absent, or the guide it points at with an explicit @import — and returns the file it wrote. An exact restatement of an existing rule writes nothing; replaces swaps the existing rule line in place wherever in the estate it lives.`
}
