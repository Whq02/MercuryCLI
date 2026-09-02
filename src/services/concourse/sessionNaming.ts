// ============================================================================
//  services/concourse/sessionNaming — THE ONE NAMING OWNER (session-aware
//  naming — the operator: "it still says
//  'concourse' as a session tag … use something more neutral — maybe 'new
//  session' — and then it gets named after the first message … session-aware
//  naming").
//
//  THREE STAGES, the title always the best available — and NEVER a worker
//  id, never "concourse", in ANY world:
//    1  before any message: the fact — "new session · <project> · ready";
//    2  at the first message: the first line of the prompt, trimmed (the
//       brief the board and the parked rows already derive — zero cost);
//    3  the MODEL-MINTED short title, minted ONCE per session at the second
//       assistant turn (services/concourse/sessionTitleMint rides the
//       estate's existing small call — utils/sessionTitle.generateSessionTitle
//       — and stores it on the record through the daemon's set-title door;
//       the mint FILLS AN EMPTY TITLE ONLY, so a dispatch-typed or /title'd
//       name is never overwritten, and titleMintedAt stamps once so it
//       never runs twice; a mint that cannot run leaves stage 2 standing —
//       the name never regresses).
//  The worker id stays a fact in the detail column and the debug log.
//
//  Pure: every surface (the board's rows, the hop's connector record, the
//  chat's tag through it) derives from sessionTitleOf; the callers supply
//  the brief through their own one reader (headBriefLabel).
// ============================================================================

import { projectDisplayName } from '../../utils/bootCardFacts.js'

/** Stage 1 — the fact, never an invented name. */
export function newSessionTitle(workspaceDir: string): string {
  return `new session · ${projectDisplayName(workspaceDir)} · ready`
}

/** The poison detector: a roster short leaking as a title. */
export function isWorkerIdTitle(title: string): boolean {
  return /^concourse-w\d+$/.test(title.trim())
}

/** THE THREE STAGES in one door: the stored title (minted or typed) wins;
 *  else the chat's own first words; else the stage-1 fact. The worker id is
 *  deliberately not an input — it can never leak out of this door. */
export function sessionTitleOf(
  rec: { title?: string; workspaceId: string },
  briefOf: () => string | null,
): string {
  const stored = (rec.title ?? '').trim()
  if (stored.length > 0) return stored
  const brief = briefOf()
  if (brief !== null && brief.trim().length > 0) return brief.trim()
  return newSessionTitle(rec.workspaceId)
}

/** THE MINT'S GATE (stage 3): an un-ended session whose title is empty,
 *  never minted before, with its SECOND assistant turn on record. Never at
 *  turn one (a one-shot question never pays), never twice (the stamp),
 *  never over a standing name (typed or minted). */
export function shouldMintTitle(
  rec: { title?: string; titleMintedAt?: number; endedAt?: number },
  assistantTurns: number,
): boolean {
  if (rec.endedAt !== undefined) return false
  if ((rec.title ?? '').trim().length > 0) return false
  if (rec.titleMintedAt !== undefined) return false
  return assistantTurns >= 2
}
