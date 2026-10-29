
import { getInitialSettings } from './settings/settings.js'


type AttributionTexts = {
  commit: string
  pr: string
}

const DEFAULT_PR_ATTRIBUTION = 'Generated with [Mercury CLI](https://mercury-cli.ai)'
const DEFAULT_COMMIT_TRAILER = 'Co-Authored-By: Mercury <https://mercury-cli.ai>'

export function getAttributionTexts(): AttributionTexts {
  const settings = getInitialSettings()
  const attribution = settings.credit?.lines
  if (attribution) {
    return {
      commit: attribution.commit ?? DEFAULT_COMMIT_TRAILER,
      pr: attribution.pr ?? DEFAULT_PR_ATTRIBUTION,
    }
  }
  if (settings.credit?.mercury === false) {
    return { commit: '', pr: '' }
  }
  return { commit: DEFAULT_COMMIT_TRAILER, pr: DEFAULT_PR_ATTRIBUTION }
}
