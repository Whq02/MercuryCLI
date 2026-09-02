import type { Command } from '../../commands.js'
import { routerEnabled } from '../../utils/router/routerGates.js'

// ============================================================================
// commands/router — the route fabric operator surface.
//
// `/router` opens the board (active/recent route plans × profile chips × node
// states, the "why this route?" glance + drill-in); `/router <posture>` sets
// the PERSISTED posture (adaptive|quality|balanced|fast|fixed — applies from
// the NEXT route decision, never mid-turn); `/router pin opus|sonnet|auto`
// pins the executor model class; `/router explain` prints the last decision;
// `/router reset-history` empties the bounded outcome memory; `/router
// engines` prints the engine readiness receipt (status · account ·
// catalogue — honest codes, never "configured"); OpenAI sign-in/out moved
// to their one homes: /logins connects (browser
// PKCE or device code), the /accounts board disconnects — the retired
// connect/disconnect arms answer with that steering;
// `/router source sub|api|clear` sets the preferred OpenAI account source
// `/router key [provider] [clear]` is the MASKED API-key entry for the key
// lanes (zai · moonshot · deepseek · compat · huggingface · local; masked
// input → the auth-scoped secret store; the value never echoes anywhere) —
// the terminal's account door beside /logins, named plainly wherever
// accounts are offered (the operator's ruled refusal sentence).
// MERCURY_ROUTER gated: OFF ⇒ absent ⇒ byte-identical.
// ============================================================================

export const routerCommand = {
  type: 'local-jsx',
  name: 'router',
  description:
    'Route fabric — plans, postures, pins, engines, why the last decision happened; /router key <provider> connects an API key (masked entry)',
  argumentHint: '[adaptive|quality|balanced|fast|fixed | pin opus|sonnet|auto | explain | engines | source sub|api|clear | key [provider] [clear] | reset-history]',
  isEnabled: () => routerEnabled(),
  isHidden: false,
  load: () => import('./router.js'),
} satisfies Command

export default routerCommand
