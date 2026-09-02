import type { Command } from '../../commands.js'
import { experienceCardsEnabled } from '../../memdir/experienceCards.js'

// ============================================================================
// commands/cards/index.ts — `/cards`: browse + promote the experience-card memory.
// ----------------------------------------------------------------------------
// Closes the OTHER half of the severed experience-card loop. /remember + the
// RememberLesson tool wired the WRITE path (candidates get banked); recall renders
// them as unverified hypotheses — but promoteExperienceCard (the proven, gate-
// guarded candidate→approved flip) had ZERO runtime callers, so a candidate could
// never be promoted in-session. /cards lists every card (candidate vs approved) and
// promotes the selected candidate (the `p` key) via that proven path.
//
// Card gated (mirrors /remember): OFF (MERCURY_EXPERIENCE_CARDS=0) the
// command is absent ⇒ byte-identical. Non-ant only, so it never collides with the
// ant-only `remember` review skill.
// ============================================================================

const command = {
  type: 'local-jsx',
  name: 'cards',
  description: 'Browse + promote experience-card memory (candidate → approved)',
  isEnabled: () => experienceCardsEnabled() && true,
  isHidden: false,
  load: () => import('./cards.js'),
} satisfies Command

export default command
