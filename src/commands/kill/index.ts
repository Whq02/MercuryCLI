import type { Command } from '../../commands.js'

// ============================================================================
// commands/kill/index.ts — runtime control of the capability kill-switch.
// ----------------------------------------------------------------------------
// The kill-switch (the headline Mercury safety feature) was env-only: to disable a
// tool mid-session the operator had to quit + relaunch with a new MERCURY_KILL. The
// mutable, deny-only killStore (killCapability / restoreCapability / listCapabilityKills)
// was built for runtime mutation but had ZERO callers. These two text commands wire it
// up. Deny-only by construction (can only refuse a tool, never grant one ⇒ fail-safe);
// the enforcement floor (toolExecution → isCapabilityKilled) is untouched.
//
// The kill-switch is a Mercury-substrate feature —
// the gate module is unchanged, and an empty store has no opinion ⇒ OFF byte-identical.
// ============================================================================

export const kill = {
  type: 'local',
  name: 'kill',
  description: 'Disable a tool/capability for this session (kill-switch); no arg lists current kills',
  argumentHint: '[<tool> | <agent>:<tool>]',
  isEnabled: () => true,
  load: () => import('./kill.js'),
} as Command

export const unkill = {
  type: 'local',
  name: 'unkill',
  description: 'Re-enable a tool/capability previously killed this session',
  argumentHint: '<tool> | <agent>:<tool>',
  isEnabled: () => true,
  load: () => import('./unkill.js'),
} as Command

export default kill
