import { TEAM_BRIEF_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'Get a consolidated brief of the current team: open tasks, unread messages, roster, and file leases'

export const TEAM_BRIEF_TOOL_PROMPT = `Returns a single consolidated snapshot of the current team's coordination state, so you don't have to call TaskList, read your mailbox, the roster, and the lease store separately.

The brief includes, for the team this session belongs to:
- Open tasks (everything not completed) with id, status, owner, and blockers.
- Your unread inbound messages from teammates.
- The team roster (each member's name, type, and idle/busy status).
- Current file leases — which agent holds which path globs, so you know what's already claimed before you edit.
- Derived health — any teammate that is busy or drifting (busy but its lease has gone stale), surfaced only when notable.
- Tree conflicts — pairs of teammates whose leased globs overlap, so you coordinate before a clash reaches the lease guard.
- Handoffs addressed to you — work handed off by another agent; a "done" handoff with no evidence backing the success claim is flagged UNVERIFIED.

Read-only. Call ${TEAM_BRIEF_TOOL_NAME} when you wake up, when you're deciding what to pick up next, or before claiming a file path — it's cheaper than guessing wrong and clashing. If this session isn't part of a team, the brief says so.`
