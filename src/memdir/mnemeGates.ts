/* ============================================================================
   MNEME — topic-document long-term memory (paper-triad Slice B).

   Methodology adapted from "Infini Memory" (arXiv:2606.10677 — P3 of the
   paper triad; no code vendored): a WRITE/MAINTAIN/READ lifecycle over a
   library of topic DOCUMENTS, beside (not replacing) experience cards.
   Observations stage in a CURRENT buffer; consolidation groups them into
   per-topic markdown docs whose every entry carries a parsable
   `<seq=…, time=…, source=…>` signature — the paper's core trick: temporal
   and provenance cues MOVE WITH entries through rewrites, so recency and
   grounding survive reorganization. Fact revision is supersede-not-duplicate
   with the old fact RETAINED under history (MERCURY_CARD_SUPERSEDE semantics at
   fact granularity).

   Anti-gaming spine (the THEMIS doctrine applied to memory): an LLM rewriter
   may PROPOSE a consolidation draft, but a deterministic post-validator
   checks it — every input seq conserved (live or explicitly superseded),
   signatures intact, nothing invented — and a draft that loses evidence is
   REFUSED. The default rewriter is deterministic verbatim-grouping
   (trivially faithful). Grounding per the confabulation finding
   (GTFA databank): entries carry their captured source, never a model's
   retelling of it.

   Gate: MERCURY_MNEME (opt-in, registered in flagRegistry). OFF ⇒ no files, no
   buffer writes, no MCP verbs — byte-identical.
   The full lifecycle: pending rows visible to
   catalog/grep (mnemeRetrieval.grepAll/pendingSummary), first-class
   corrections (mnemeCorrect), maintenance that actually runs
   (mnemeMaintenance — boot + turn-end due-checks), exactly-once crash
   recovery (batch manifests in mnemeConsolidate).
   Storage: <autoMemPath>/library/ (the memdir class):
     current.jsonl        the staging buffer (O_APPEND rows)
     library.json         {seqCounter, lastConsolidatedAt} (atomic)
     topic-<slug>.md      one document per topic
   ============================================================================ */

import { join } from 'node:path'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { getAutoMemPath } from './paths.js'

export function mnemeEnabled(): boolean {
  return flagEnabled('MERCURY_MNEME')
}

/** The library root. Overridable per call for tests; production callers use
 *  the default (inside the project's auto-memory dir). */
export function mnemeLibraryDir(): string {
  return join(getAutoMemPath(), 'library')
}
