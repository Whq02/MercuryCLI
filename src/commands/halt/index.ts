import type { Command } from '../../commands.js'

// /halt — a clear manual BREAK: hard-stop every running daemon + subagent
// (rostered/fleet workers via the daemon shutdown RPC, and in-process agent
// tasks) when you need everything to stop NOW. Reports what it killed.
const halt = {
  type: 'local',
  name: 'halt',
  // Mercury-only surface — hidden on a bare-stamp build.
  isEnabled: () => true,
  description: 'Hard stop — kill all running daemons + subagents (the manual break)',
  supportsNonInteractive: true,
  // The brake is the SCREEN's (its estate is the operator's daemons and
  // tasks) and it fires INTERRUPT-FIRST: the stop command must act while a
  // turn runs, never queue behind the very work it is stopping — and never
  // ride into a session runner, where its daemon-shutdown body would kill
  // the daemon hosting every session (the operator's vanished-board
  // incident).
  seat: 'screen',
  interruptFirst: true,
  load: () => import('./halt.js'),
} satisfies Command

export default halt
