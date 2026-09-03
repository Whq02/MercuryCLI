import type { Command } from '../../commands.js'

// /speak — the master toggle for voice INPUT (the operator speaks, the
// words land in the composer). With it on, space in an empty composer starts
// a capture and `v` or esc ends it. Mercury never speaks aloud.
const speak = {
  type: 'local',
  name: 'speak',
  description: 'Voice input on or off — with it on, space in an empty composer dictates into it',
  argumentHint: '[on|off]',
  supportsNonInteractive: false,
  // Acts on the SCREEN: the composer's keys are the screen's.
  seat: 'screen',
  load: () => import('./speak.js'),
} satisfies Command

export default speak
