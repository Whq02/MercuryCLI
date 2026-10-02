export const RECORD_CONVENTION_TOOL_NAME = 'RecordConvention'

export const RECORD_CONVENTION_DESCRIPTION =
  'Record a durable project convention the user stated — how this project is built, run or tested, what not to touch — into the project instruction estate (MERCURY.md, or the guide it explicitly points at), for everyone who works in the project. Not for one-off task details, and not for a rule the user asks Mercury to remember about how to work with them: that is pinned memory (Retain with pin).'

export function buildRecordConventionPrompt(): string {
  return `Record one durable, user-stated project convention into the project instruction estate, so every future session here operates under it.

Use it the moment the user STATES a convention or a correction for this project — "always use bun here", "never touch the vendored dir", "tests run with the wrapper script". No magic word arms this; the statement itself does. Then SAY you recorded it and where.

The other door: a rule the user asks you to REMEMBER about how to work with them — a preference, a standing order to Mercury ("remember: …", "from now on, always …", "keep this as a rule") — is pinned memory, not a project convention: store it with Retain and pin, in their words, and leave the instruction file alone. A project convention binds everyone who works here; a remembered rule is the user's own.

The write follows the estate's own laws:
- The entry is MERCURY.md at the project root. A project without one gets a minimal entry born with the first rule.
- The pointer law: when MERCURY.md is a thin pointer at a fuller guide (an explicit @import), the rule lands in the pointed guide, never stacked into the pointer file. The tool follows the pointer for you and names the file it wrote.
- An exact restatement of an existing rule is a no-op (reported honestly). To MERGE — the user refined or corrected an existing rule — pass \`replaces\` with a distinctive substring of the old rule line, and the tool swaps that line in place wherever in the estate it lives.

NOT for: one-off task details, session-scoped choices, a rule the user asks you to remember (the pinned door above), or private lessons about your own working method (those belong in your own memory, not the shared estate). Name the choice when you record.

Deeper curation — folding several related rules into one, deleting stale lines — is ordinary editing: read the estate file and edit it directly. This tool is the capture verb, not the whole gardener.`
}
