export const RETAIN_TOOL_NAME = 'Retain'
export const RECALL_TOOL_NAME = 'Recall'
export const REFLECT_TOOL_NAME = 'Reflect'
export const CORRECT_TOOL_NAME = 'Correct'

export const RETAIN_DESCRIPTION =
  'Store durable facts into project memory; a rule the user asks Mercury to remember about how to work with them is pinned in their words and on the shelf at once (a project convention about the code goes to the instruction file instead). Replacing a rule the user asked for puts a yes/no card to them first (under sovereign, no card). Per-item outcomes — a failed store is reported, never swallowed.'
export const RECALL_DESCRIPTION =
  'Search project memory for pointers — facts, pinned rulings, the sessions of this project and the handoffs they left — each an id, a one-line title and footnotes (which session, which ruling, superseded by what). Read one full record by id.'
export const REFLECT_DESCRIPTION =
  'Synthesize an answer over recalled memory with citations to the records used. Costs one model call; falls back to raw recall when synthesis cannot be grounded.'
export const CORRECT_DESCRIPTION =
  'Correct project memory: supersede a fact with a new truth, amend its wording (after reading the full record), or retract it with a reason. A consolidated fact keeps its history; a pending row is a draft and is struck or replaced. A rule the user asked Mercury to remember changes only on their yes to a card (under sovereign, no card).'

export const RETAIN_PROMPT = `Store facts in project memory. Returns each item's stored id, already-staged status or refusal reason. Facts stage as pending observations and consolidate into topic pages. Memory is plaintext.`

export const RECALL_PROMPT = `Searches project memory and returns pointers, or reads one full record. A search returns at most 20 pointers, each a stable id (seq:<n> for a fact or ruling, pending:<ts> for a staged row, ledger:<ordinal> for a session or its handoff), a kind (fact · ruling · handoff · session), a one-line title (where it lives, when, from whom, which of your words matched) and footnotes (the session it came from, the ruling it fell under, what it supersedes or was superseded by). A pointer carries no content: open the record with read before you rely on it or quote it. A read returns the entry with its breadcrumb and footnotes; a ledger read is the session's entry and its handoff verbatim. An empty result is flagged elidable: droppable context, not an error. It never writes.`

export const REFLECT_PROMPT = `Answers a question over project memory: one search for the query, then one bounded model call over the hits, whose synthesis cites the records it uses ([seq N] / [pending N]). A synthesis that cites nothing or invents ids, or a run with no usable model or credentials, returns the raw search instead with the reason. It never writes.`

export const CORRECT_PROMPT = `Changes one memory record by id: supersede replaces the fact with a new truth and moves the old one to history with a superseded-by pointer; amend fixes the record's own wording; retract marks it wrong with a reason. A consolidated fact is never deleted: its history stays. A pending row (pending:<ts>) is a draft, not yet a fact: retract strikes it and no history is kept; supersede or amend replaces it with a new pending row, and the new row keeps the old words as its history until consolidation files the fact. A rule the user asked for changes only on their answer to a card the call puts to them with the rule's words as stored and what will happen: Yes runs the op, No returns "the user kept the rule" and nothing changes; under the sovereign permission mode the op runs without the card and its record says so.`
