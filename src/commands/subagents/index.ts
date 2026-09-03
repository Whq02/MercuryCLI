import type { Command } from '../../commands.js'

// /subagents [on|off] — the focused session's SUB-AGENTS switch (one of the
// two spawn switches, services/switchboard/spawnSwitches.ts): off removes
// the Agent tool from the session's roster and closes every spawn road at
// the next turn boundary; on restores them. Plain /subagents reads both
// switches. A thin command over the connector's one verb — the daemon's
// seat is the settlement owner, and its word is the receipt.
const subagents = {
  type: 'local',
  name: 'subagents',
  description: "Sub-agents for this session — on, off, or the current switch (the Agent tool and every spawn road)",
  argumentHint: '[on|off]',
  supportsNonInteractive: false,
  // Acts on the SCREEN's focused chat through its connector, never inside a
  // session's runner (the toggle is addressed to the session, not spoken).
  seat: 'screen',
  load: () => import('./subagents.js'),
} satisfies Command

export default subagents
