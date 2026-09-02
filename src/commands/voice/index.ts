import type { Command } from '../../commands.js'

// /voice — the same action as pressing `v` in an empty composer: start a
// voice capture, or stop the one running (its take goes to the transcriber
// and the words land in the composer). Needs /speak on.
const voice = {
  type: 'local',
  name: 'voice',
  description: 'Start or stop a voice capture into the composer (the same as pressing v)',
  supportsNonInteractive: false,
  // Acts on the SCREEN: the composer is the screen's.
  seat: 'screen',
  load: () => import('./voice.js'),
} satisfies Command

export default voice
