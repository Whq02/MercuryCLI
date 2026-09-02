export const RETAIN_TOOL_NAME = 'Retain'
export const RECALL_TOOL_NAME = 'Recall'
export const REFLECT_TOOL_NAME = 'Reflect'
export const CORRECT_TOOL_NAME = 'Correct'

export const RETAIN_DESCRIPTION =
  'Store durable facts into project memory (the MNEME observation buffer). Per-item outcomes — a failed store is reported, never swallowed.'
export const RECALL_DESCRIPTION =
  'Search project memory: topic documents AND still-unconsolidated observations, with stable ids and provenance signatures. Read a full record by id.'
export const REFLECT_DESCRIPTION =
  'Synthesize an answer OVER recalled memory with citations to the records used. Costs one model call; falls back to raw recall when synthesis cannot be grounded.'
export const CORRECT_DESCRIPTION =
  'Correct project memory: supersede a fact with a new truth, amend its wording (after reading the full record), or retract it with a reason. History is always retained.'

export const RETAIN_PROMPT = `Store one or more durable facts into project memory.

- Each item is ONE self-contained fact (content), with optional context (where it came from) and topic (routing hint).
- The response reports a PER-ITEM outcome: stored (with its id), already-staged (this session), or refused with the reason. A refusal means the fact was NOT stored — surface it, never assume success.
- Facts stage as pending observations and consolidate into topic documents automatically; they are recallable seconds after storing, labeled pending until consolidation.
- This writes the OBSERVATIONAL memory log. The curated memory index (MEMORY.md) is a different store with its own lifecycle — Retain never touches it.
- Use for: decisions made, facts discovered, constraints learned, outcomes worth keeping across sessions. Not for: secrets, transcripts, or anything the repo already records.`

export const RECALL_PROMPT = `Search project memory, or read one full record.

- \`query\` — grep topic documents AND pending (unconsolidated) observations. Hits carry: a stable id (seq:<n> for consolidated rows, pending:<ts> for staged ones), a bounded preview (clipped previews say so), the provenance signature, and a consolidated|pending label.
- \`read\` — fetch ONE full record by id (seq:<n> · doc:<slug> · pending:<ts>), heading-expanded for topic rows. Reading a record in full is REQUIRED before amending it with Correct.
- An empty result is flagged elidable — treat it as droppable context, not an error.
- Recall never writes anything.`

export const REFLECT_PROMPT = `Answer a question by synthesizing OVER recalled memory, with citations.

- Runs a Recall for your query, then one bounded model call over the hits. The synthesis MUST cite the records it uses ([seq N] / [pending N]); a synthesis that cites nothing or invents ids is REFUSED and the raw recall returned instead — grounding is structural, not advisory.
- No usable model/credentials degrades typed: you get the raw recall plus the reason.
- This costs a model call — use Recall alone when you just need the records. Reflect never writes anything.`

export const CORRECT_PROMPT = `Correct one consolidated memory record (id seq:<n>, from Recall).

- op 'supersede' — a NEW truth replaces the fact; pass content (or replacementId naming an existing seq that already carries the truth). The old fact moves to history with a superseded-by pointer.
- op 'amend' — fix the RECORD's own wording; requires the full record to have been read this session (Recall read:"seq:<n>" first) so a clipped preview can never destroy an unseen tail.
- op 'retract' — mark the fact wrong with a reason. Nothing is ever hard-deleted: history is the audit spine.
- Always pass reason. Pending rows are not correctable — they resolve at consolidation.`
