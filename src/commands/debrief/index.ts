import type { Command } from '../../commands.js'

// ============================================================================
// commands/debrief/index.ts — the /debrief descriptor.
// ----------------------------------------------------------------------------
// On-demand "where we left off": the session-summary service already powers
// the while-you-were-away card; this command surfaces the same summary when
// the user asks for it. Interactive-only — a -p run has just printed its own
// transcript, so a debrief there adds nothing.
// ============================================================================

const debriefCommand: Command = {
  type: 'local',
  name: 'debrief',
  description: 'Generate a one-line session debrief now',
  supportsNonInteractive: false,
  load: () => import('./debrief.js'),
}

export default debriefCommand
