import type { Command } from '../../commands.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'

// ============================================================================
// commands/browser/index.ts — `/browser`: the operator surface for
// the native browser driver.
//   /browser            → status (resolution provenance, versions, cache)
//   /browser install    → the ONE consented Chrome-for-Testing download
//                         (authoritative metadata · version + disk cost
//                         shown · lands in the managed cache, never in
//                         release archives)
//   /browser remove <buildId> → delete a managed build
// Downloads NEVER happen outside the explicit install verb.
// ============================================================================

const browser: Command = {
  type: 'local',
  name: 'browser',
  description:
    'Browser driver status · install/remove the managed Chrome-for-Testing build (explicit consented download)',
  argumentHint: '[status | install | remove <buildId>]',
  supportsNonInteractive: true,
  isEnabled: () => flagEnabled('MERCURY_BROWSER'),
  load: () => import('./browserCommand.js'),
}

export default browser
