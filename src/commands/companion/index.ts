import type { Command } from '../../commands.js'

// /companion — toggle the SESSION COMPANION in place (operator round-3,
// the boot-menu row only reaches splash launches; this is the
// zero-friction arm). Flips + persists (global config, the /critter-pick
// pattern) and repaints every companion surface immediately via the epoch
// store. `/companion on|off` sets explicitly; bare `/companion` toggles;
// `/companion tip` shows one tip now.
const command = {
  type: 'local',
  name: 'companion',
  description: 'Toggle the session companion — creature · moods · a word at the right moment · tips',
  argumentHint: '[on|off|tip]',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: false,
  // Acts on the SCREEN: runs in the screen process against the focused chat.
  seat: 'screen',
  load: () => import('./companion.js'),
} satisfies Command

export default command
