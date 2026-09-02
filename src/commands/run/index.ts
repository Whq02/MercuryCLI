import type { Command } from '../../commands.js'

// ============================================================================
// commands/run/index.ts — `/run`: the live run inspector.
//
// The operator window onto the durable-run kernel: the SAME RunSnapshot the
// stop evaluator reads — objective + lifecycle, deliverables, next action/
// blocker, typed tool effects + changed paths, verification evidence,
// context epoch, IDE feedback, and the bounded event timeline. Reconcile
// (g) runs through the real coordinator; pause/resume/cancel appear only
// when valid, cancel behind a confirm card. Always enabled — with no active
// run it explains how one begins (never dead chrome).
// ============================================================================

const command = {
  type: 'local-jsx',
  name: 'run',
  description: 'Live run inspector — objective, deliverables, effects, evidence, next action',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./run.js'),
} satisfies Command

export default command
