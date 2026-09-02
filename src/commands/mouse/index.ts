import type { Command } from '../../commands.js'

// /mouse — runtime SGR mouse-tracking toggle (uniqueness-program P8). Mouse OFF
// hands the pointer back to the terminal so NATIVE drag-select/copy works (the
// operator-reported "can't copy from the REPL"); ON restores the clickable TUI.
const mouse = {
  type: 'local',
  name: 'mouse',
  description: 'Toggle mouse capture — off = native terminal select/copy, on = clickable TUI',
  argumentHint: '[on|off]',
  supportsNonInteractive: false,
  // Acts on the SCREEN: runs in the screen process against the focused chat.
  seat: 'screen',
  load: () => import('./mouse.js'),
} satisfies Command

export default mouse
