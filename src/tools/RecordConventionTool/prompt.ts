export const RECORD_CONVENTION_TOOL_NAME = 'RecordConvention'

export const RECORD_CONVENTION_DESCRIPTION =
  'Record a durable project convention the user stated into the project instruction estate (MERCURY.md, or the guide it explicitly points at). Use when the user states a standing rule for this project — not for one-off task details.'

export function buildRecordConventionPrompt(): string {
  return `Record one durable, user-stated project convention into the project instruction estate, so every future session here operates under it.

Use it the moment the user STATES a standing rule, correction, or convention for this project — "always use bun here", "never touch the vendored dir", "tests run with the wrapper script". No magic word arms this; the statement itself does. Then SAY you recorded it and where.

The write follows the estate's own laws:
- The entry is MERCURY.md at the project root. A project without one gets a minimal entry born with the first rule.
- The pointer law: when MERCURY.md is a thin pointer at a fuller guide (an explicit @import), the rule lands in the pointed guide, never stacked into the pointer file. The tool follows the pointer for you and names the file it wrote.
- An exact restatement of an existing rule is a no-op (reported honestly). To MERGE — the user refined or corrected an existing rule — pass \`replaces\` with a distinctive substring of the old rule line, and the tool swaps that line in place wherever in the estate it lives.

NOT for: one-off task details, session-scoped choices, or private lessons about your own working method (those belong in your own memory, not the shared estate). When the user asks to remember something personal-to-them rather than project-shared, pick the private memory surface instead and name the choice.

Deeper curation — folding several related rules into one, deleting stale lines — is ordinary editing: read the estate file and edit it directly. This tool is the capture verb, not the whole gardener.`
}
