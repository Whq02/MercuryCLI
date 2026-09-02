import type { Command } from '../../commands.js'

// /sovereign — the read-only indicator of the permission-bypass posture.
// Reports the live tool-permission-prompt bypass state (the in-UI parity of
// --dangerously-skip-permissions) so the operator never loses track of an
// active bypass. The always-visible standing badge is MercuryFrame's own
// `modeBand` (the crimson "⊠ sovereign mode on" band, read reactively from
// the live permission mode); the <SovereignBanner> the panel exports is NOT
// mounted in the frame (it would double that band) — it heads the panel and
// is a reusable export. Read-only here: this surface reports the posture and
// never toggles it. The panel lives beside /authority + /policy (it loads
// ../authority/sovereignPanel.js).
const command = {
  type: 'local-jsx',
  name: 'sovereign',
  description: 'Sovereign posture — the permission-bypass indicator (read-only)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../authority/sovereignPanel.js'),
} satisfies Command

export default command
