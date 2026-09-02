import type { Command } from '../../commands.js'

// /accent — live session-only identity-accent override ("colour the REPL",
// QoL program). Named token swatches or #hex; reset restores the
// derived critter/scribe/fable chain. Rides the same live observable /critter
// uses, so the whole chrome re-tints synchronously.
const accent = {
  type: 'local',
  name: 'accent',
  description: 'Colour the REPL — override the identity accent (name, #hex, or reset)',
  argumentHint: '[name|#hex|reset]',
  supportsNonInteractive: false,
  // Acts on the SCREEN: runs in the screen process against the focused chat.
  seat: 'screen',
  load: () => import('./accent.js'),
} satisfies Command

export default accent
