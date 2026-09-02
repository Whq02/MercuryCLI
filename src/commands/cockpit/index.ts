import type { Command } from '../../commands.js'

// /cockpit — the "One Operator Tower": one shell, tab between deck · fleet ·
// trace · substrate · policy with Tab/←→, esc to close. immediate:true so it
// opens instantly even mid-turn (out-of-band, like the other nav surfaces).
const cockpit = {
  type: 'local-jsx',
  immediate: true,
  name: 'cockpit',
  needsConcourse: true,
  // Mercury-only surface — hidden on a bare-stamp build.
  isEnabled: () => true,
  // `deck` is the cockpit's first/default tab and is referenced everywhere (the
  // DeckPane, "/cockpit deck", the docs) — but it had no command, so typing the
  // intuitive `/deck` fuzzy-fell to a skill whose DESCRIPTION contained "deck"
  // (e.g. /mercury-ui-design) and ENTER silently ran that skill's turn. An exact
  // alias makes `/deck` an exact-alias match (ranked #1) that opens the cockpit on
  // its deck tab (CockpitView defaults to the first tab = deck). Siblings already
  // have their own commands (/fleet /trace /substrate /policy).
  aliases: ['deck'],
  description:
    'Open the Mercury cockpit — tab between deck · fleet · trace · substrate · policy in one view',
  argumentHint: '[deck|fleet|trace|substrate|policy]',
  load: () => import('./cockpit.js'),
} satisfies Command

export default cockpit
