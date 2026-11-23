import { getInitialSettings } from './settings/settings.js'

type AttributionTexts = {
  commit: string
  pr: string
}

const DEFAULT_COMMIT_ATTRIBUTION = 'Co-Authored-By: Mercury <https://mercury-cli.ai>'
const DEFAULT_PR_ATTRIBUTION = 'Generated with [Mercury CLI](https://mercury-cli.ai)'

export function getAttributionTexts(): AttributionTexts {
  const credit = getInitialSettings().credit
  if (credit?.lines !== undefined) {
    return {
      commit: credit.lines.commit ?? DEFAULT_COMMIT_ATTRIBUTION,
      pr: credit.lines.pr ?? DEFAULT_PR_ATTRIBUTION,
    }
  }
  if (credit?.mercury === false) {
    return { commit: '', pr: '' }
  }
  return {
    commit: DEFAULT_COMMIT_ATTRIBUTION,
    pr: DEFAULT_PR_ATTRIBUTION,
  }
}
