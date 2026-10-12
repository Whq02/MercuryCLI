export const RETAIN_TOOL_NAME = 'Retain'
export const RECALL_TOOL_NAME = 'Recall'
export const REFLECT_TOOL_NAME = 'Reflect'
export const CORRECT_TOOL_NAME = 'Correct'

export const RETAIN_DESCRIPTION =
  'Store durable facts into project memory; a rule the user asks Mercury to remember about how to work with them is pinned in their words and on the shelf at once (a project convention about the code goes to the instruction file instead). Per-item outcomes — a failed store is reported, never swallowed.'
export const RECALL_DESCRIPTION =
  'Search project memory for pointers — facts, pinned rulings, the sessions of this project and the handoffs they left — each an id, a one-line title and footnotes (which session, which ruling, superseded by what). Read one full record by id.'
export const REFLECT_DESCRIPTION =
  'Synthesize an answer over recalled memory with citations to the records used. Costs one model call; falls back to raw recall when synthesis cannot be grounded.'
export const CORRECT_DESCRIPTION =
  'Correct project memory: supersede a fact with a new truth, amend its wording (after reading the full record), or retract it with a reason. History is always retained.'

export const RETAIN_PROMPT = `Store one or more durable facts into project memory.

- Each item is one self-contained fact (content), with optional context (where it came from) and topic (routing hint).
- The response reports a per-item outcome: stored (with its id), already-staged (this session), or refused with the reason; a refused fact was not stored.
- One fact holds at most 2,000 characters, content and context together; a longer one is refused whole with its count, never cut — split it into facts under the limit. The disk holds exactly what the result says was stored; tell the user what was stored and what was refused, nothing more.
- Facts stage as pending observations and consolidate into topic pages automatically; they are recallable seconds after storing, labeled pending until consolidation.
- When the user asks you to remember a rule or a preference about how to work with them ("remember: …", "always …", "from now on …", "keep this as a rule"), store their words as said with pin: true — it is on the pinned shelf at once, loaded into every session, marked as asked for by the user, and never reworded, merged or dropped by Mercury. This is the door for a remembered rule; a project convention about the code (how it is built, run or tested, what not to touch) goes to the instruction file, never here. Never pin on your own judgement.
- When the user says the new rule replaces a pinned one ("instead of …", "that replaces the old rule"), pass replaces: "seq:<n>" naming that rule from the pinned shelf: the new rule takes its place and the old one is kept as history. Two rules that merely share words are not a conflict — both stay. A rule marked asked for by the user is never replaced by you: tell the user to change it in /memory.
- Use for: decisions made, facts discovered, constraints learned, outcomes worth keeping across sessions. Not for: secrets, transcripts, or anything the repo already records.`

export const RECALL_PROMPT = `Search project memory for pointers, or read one full record.

- \`query\` — searches the topic pages, the archive, the pending (unconsolidated) observations, and the lineage ledger: the sessions of this project and the handoff notes they left. Words, paths and topic names match; a phrase or regex matches literally. The answer is at most 20 pointers, each: a stable id (seq:<n> for a fact or ruling, pending:<ts> for a staged row, ledger:<ordinal> for a session or its handoff), a kind (fact · ruling · handoff · session), a one-line title (where it lives, when, from whom, which of your words matched) and footnotes (the session it came from, the ruling it fell under, what it supersedes or was superseded by).
- \`read\` — fetch one full record by id (seq:<n> · doc:<slug> · pending:<ts> · ledger:<ordinal>), heading-expanded for topic rows, with its footnotes; a ledger read shows the session's entry and its handoff verbatim ("no note left" when none). Correct amends a record only after a full read.
- A pointer carries no content: open the record with read before you rely on it or quote it. Follow a footnote by reading the id it names.
- An empty result is flagged elidable — treat it as droppable context, not an error.
- Recall never writes anything.`

export const REFLECT_PROMPT = `Answer a question by synthesizing over recalled memory, with citations.

- Runs a Recall for your query, then one bounded model call over the hits. The synthesis cites the records it uses ([seq N] / [pending N]); a synthesis that cites nothing or invents ids is refused and the raw recall returned instead — grounding is structural, not advisory.
- No usable model/credentials degrades typed: you get the raw recall plus the reason.
- This costs a model call — use Recall alone when you just need the records. Reflect never writes anything.`

export const CORRECT_PROMPT = `Correct one consolidated memory record (id seq:<n>, from Recall).

- op 'supersede' — a new truth replaces the fact; pass content (or replacementId naming an existing seq that already carries the truth). The old fact moves to history with a superseded-by pointer.
- op 'amend' — fix the record's own wording; requires the full record to have been read this session (Recall read:"seq:<n>" first) so a clipped preview can never destroy an unseen tail.
- op 'retract' — mark the fact wrong with a reason. Nothing is ever hard-deleted: history is the audit spine.
- A pinned rule marked "asked for by the user" is the user's: every op on it is refused — the user changes or unpins it in /memory. Tell the user that when they want it changed.
- Every op carries a reason. Pending rows are not correctable — they resolve at consolidation.`
