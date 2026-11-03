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

export const RECALL_PROMPT = `Search project memory for pointers, or read one full record.

- \`query\` — words, paths and topic names match. The answer is at most 20 pointers, each: a stable id (seq:<n> for a fact or ruling, pending:<ts> for a staged row, ledger:<ordinal> for a session or its handoff), a kind (fact · ruling · handoff · session), a one-line title (where it lives, when, from whom, which of your words matched) and footnotes (the session it came from, the ruling it fell under, what it supersedes or was superseded by).
- \`read\` — one entry with its breadcrumb and footnotes (doc:<slug> reads the whole page); a ledger read shows the session's entry and its handoff verbatim ("no note left" when none). Correct amends a record only after a full read.
- A pointer carries no content: open the record with read before you rely on it or quote it. Follow a footnote by reading the id it names.
- An empty result is flagged elidable — treat it as droppable context, not an error.
- Recall never writes anything.`

export const REFLECT_PROMPT = `Answer a question by synthesizing over recalled memory, with citations.

- Runs a Recall for your query, then one bounded model call over the hits. The synthesis cites the records it uses ([seq N] / [pending N]); a synthesis that cites nothing or invents ids is refused and the raw recall returned instead — grounding is structural, not advisory.
- No usable model/credentials degrades typed: you get the raw recall plus the reason.
- This costs a model call — use Recall alone when you just need the records. Reflect never writes anything.`

export const CORRECT_PROMPT = `Correct one memory record by its id from Recall.

- Only when the user asks for a memory to be remembered or changed, in their words ("remember: … instead of …", "update the note about …"). Never on your own judgement: a change said in passing is not an ask. The tool refuses a change when the user's latest message does not ask for a memory to be remembered or changed (a pinned rule the user asked for goes to its card instead, as below), and a crewmate's always: a crewmate's finding goes in its report.
- op 'supersede' — a new truth replaces the fact; pass content (or replacementId naming an existing seq that already carries the truth). The old fact moves to history with a superseded-by pointer.
- op 'amend' — fix the record's own wording; requires the full record to have been read this session (Recall read:"<id>" first) so a clipped preview can never destroy an unseen tail.
- op 'retract' — mark the fact wrong with a reason. A consolidated fact is never hard-deleted: history is the audit spine.
- A pending row (pending:<ts>) is a draft, not yet a fact: retract strikes it — its bytes leave the buffer and no history is kept; supersede or amend replaces it with a new pending row, and the new row keeps the old words as its history until consolidation files the fact. This is the road when the user asks to correct or forget something said minutes ago, before consolidation. A corrected or struck draft never lands on a page.
- A pinned rule marked "asked for by the user" changes only on the user's answer: the tool puts one card to them with the rule's words as stored and what will happen. Yes runs the op as /memory does (the old wording to history; a draft struck); No returns "the user kept the rule" and nothing changes. Under the sovereign permission mode the op runs without the card and its record says so. A session with no one to answer the card refuses: tell the user the road — in /memory, under pinned rules, ↵ opens the rule and c corrects it (the old wording goes to history), u unpins it. A rule they have unpinned is a plain fact again and Retain with replaces supersedes it when they restate it.
- Content that looks like a key, a token or a password is refused: memory never holds a secret.`
