import { LIVE_COMMS_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'Live communication between the crew: read the crew state as it stands now — open tasks, unread messages, roster, file claims — and write to it in the same call (a message, a task, a file claim, your busy flag)'

export const LIVE_COMMS_TOOL_PROMPT = `Reads the crew's live state as it stands at this moment and, in the same call, writes to it. Every crewmate, daemon seat and the lead read and write the one store, so a write is visible to the next read by anyone, with no restart.

The read includes, for the crew this session belongs to:
- Open tasks (everything not completed) with id, status, owner, and blockers.
- Your unread inbound messages from crewmates.
- The crew roster (each crewmate's name, type, idle/busy status and what a busy crewmate says it is doing).
- Current file claims — which crewmate holds which paths, so you know what's already claimed before you edit.
- Derived health — any crewmate that is busy or drifting (busy but its claim has gone stale), surfaced only when notable.
- Tree conflicts — pairs of crewmates whose claimed paths overlap, so you coordinate before a clash reaches the claim guard.
- Handoffs addressed to you — work handed off by another agent; a "done" handoff with no evidence backing the success claim is flagged UNVERIFIED.

The writes (all optional, any combination in one call; the answer receipts each one and then shows the state after them):
- say: { to, message, summary? } — a message to a crewmate by name, or to "*" for everyone; it is delivered exactly as a SendMessage plain message is.
- task: { subject, detail?, status?, owner?, blockedBy?, id? } — open a crew task, or with an id move an existing one (status pending | in_progress | completed).
- claim: { paths } — claim repo-relative paths or globs for yourself; a path another crewmate holds is refused with the holder named. release: true drops every claim you hold.
- busy: true | false | { busy, doing? } — say whether you are working and, in a word, on what; the roster shows it to everyone.

Call ${LIVE_COMMS_TOOL_NAME} with no arguments when you wake up, when you're deciding what to pick up next, or before claiming a path — it's cheaper than guessing wrong and clashing. If this session isn't part of a crew, the read says so.`
