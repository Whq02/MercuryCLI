// ============================================================================
//  needsYouJump — the needs-you badge's JUMP word per world (pure).
//
//  The ⚑ badge counts what waits on the operator (the one attention view);
//  beside it the jump names where to go. The fleet world names the board and
//  its chord (the resolver's own display for app:openSurfaceSwitcher). THE
//  PLAIN WORLD (a `--chat` boot, or the concourse switched off) has no board:
//  when every waiting ask is the focused chat's own (the screen's command
//  queue — a permission waiting right here) the jump says so; otherwise the
//  honest door to another session is the estate's resume door — the face's
//  Continue/Resume, spelled /resume from inside the chat. A need is a need
//  in both worlds: the badge itself never hides.
// ============================================================================

export interface NeedsYouJumpFacts {
  /** The plain world for this boot (surfaceRoute.chatOnlyBoot). */
  plain: boolean
  /** Every needs-you item belongs to the focused chat itself. */
  ownOnly: boolean
  /** The board chord's display — the resolver's, never a copied string. */
  boardChord: string
}

export function needsYouJump(facts: NeedsYouJumpFacts): string {
  if (!facts.plain) return `${facts.boardChord} board`
  return facts.ownOnly ? 'this chat' : '/resume'
}
