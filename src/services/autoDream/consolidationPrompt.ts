import {
  DIR_EXISTS_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from '../../memdir/memdir.js'

/**
 * Builds the consolidation instruction text for the forked memory agent.
 * Extracted so auto-dream ships independently of feature flags; the manual
 * consolidation command shares it, which is why run-specific caveats belong
 * in the caller-supplied extra section rather than here.
 */
export function buildConsolidationPrompt(
  memoryRoot: string,
  transcriptDir: string,
  extra: string,
): string {
  const sections = [
    `Do a reflective pass over your memory files: synthesise recent learning into durable, well-organised memories so future sessions orient quickly.

Memory directory: ${memoryRoot}
${DIR_EXISTS_GUIDANCE}
Transcript directory: ${transcriptDir}
(The transcripts are large JSONL files — grep them narrowly for specific context; never read one whole.)`,
    `Work in four phases:

## Phase 1 — Orient
- List the memory directory.
- Read ${ENTRYPOINT_NAME} (the entry-point index).
- Skim the existing topic files so you improve them rather than duplicate them.
- Review recent entries in log/ or session/ subdirectories when they exist.`,
    `## Phase 2 — Gather
Look for new information worth persisting, in priority order:
1. Daily logs under a dated path layout (e.g. log/2026-08/2026-08-17.md).
2. Existing memories that have drifted from what the codebase now shows.
3. Narrow transcript searches when specific context is needed, e.g.:
   \`grep -l "topic" ${transcriptDir}/*.jsonl\` then a targeted
   \`grep -m 5 "detail" <file>\`.
Do not read transcripts exhaustively.`,
    `## Phase 3 — Consolidate
Write or update top-level memory files. Defer to the auto-memory section of
your system prompt as the source of truth for what to save, how to structure
it, and what not to save. Merge into existing topic files instead of creating
near-duplicates. Convert relative dates to absolute ones so they stay
interpretable. Delete contradicted facts at the source.`,
    `## Phase 4 — Prune and index
Keep ${ENTRYPOINT_NAME} under ${MAX_ENTRYPOINT_LINES} lines and roughly 25 KB. It is an
index, not a dump: one line per entry, under about 150 characters, in the
shape \`- [Title](file.md) — one-line hook\`, never containing memory content.
Remove stale pointers. Demote verbose entries over about 200 characters by
moving the detail into the topic file. Add pointers to newly important
memories. Resolve contradictions.`,
    `When you finish, give a brief summary of what was consolidated, updated or
pruned — and say so plainly if nothing changed.`,
  ]
  if (extra.trim() !== '') {
    sections.push(`## Additional context\n${extra}`)
  }
  return sections.join('\n\n')
}
