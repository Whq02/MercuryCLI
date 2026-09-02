import type { Command } from '../../commands.js'
import { experienceCardsEnabled } from '../../memdir/experienceCards.js'

// ============================================================================
// commands/remember/index.ts — `/remember <lesson>`: bank a transferable lesson
// as an experience card at runtime.
// ----------------------------------------------------------------------------
// Closes a SEVERED loop: Mercury's experience-card lifecycle (the structured,
// candidate→approved, distill-on-green-gate memory in src/memdir/experienceCards.ts)
// is hardened + green-tested but had ZERO runtime callers — writeExperienceCard was
// only ever reached from scripts/. The doctrine tells the agent to bank lessons and
// the recall path renders them, but nothing could write one mid-session. This wires it.
//
// The bundled skill roster registers nothing under this name (bundled skills
// win name collisions — skills/bundled/index.ts holds the name back), so the
// command is the one /remember. Card-gated ⇒ OFF (MERCURY_EXPERIENCE_CARDS=0)
// the command is absent ⇒ byte-identical.
// ============================================================================

export const remember: Command = {
  type: 'local',
  name: 'remember',
  description: 'Bank a transferable lesson as an experience card — or `project: <rule>` to record a convention in the project instruction estate',
  argumentHint: '<a lesson worth keeping across sessions — or project: <a durable convention for this project>>',
  isEnabled: () => experienceCardsEnabled() && true,
  // Interactive-session-scoped (matches the prior undefined→falsy runtime behavior);
  // banking a lesson is a deliberate in-session act, not a headless `-p` flow.
  supportsNonInteractive: false,
  // A banked lesson is the operator's own journal line — the command-privacy
  // law: it never enters a model conversation or starts a turn on any seat.
  userPrivate: true,
  load: () => import('./remember.js'),
}

export default remember
