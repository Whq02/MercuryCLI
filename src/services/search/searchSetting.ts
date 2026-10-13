import { flagEnv } from '../../substrate/flagRegistry.js'
import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'

export const DUCKDUCKGO_SETTING_KEY = 'duckduckgoScraping'
export const DUCKDUCKGO_SETTING_LABEL = 'DuckDuckGo scraping'
export const DUCKDUCKGO_TERMS = "DuckDuckGo scraping is enabled; its terms and acceptable-use policy apply, and automated requests may be refused. https://duckduckgo.com/terms · https://duckduckgo.com/acceptable-use"

export function duckduckgoScrapingEnabled(): boolean {
  const pin = flagEnv('MERCURY_SEARCH_KEYLESS')
  if (pin !== undefined) return pin === '1'
  return isConfigReadingAllowed() && getGlobalConfig()[DUCKDUCKGO_SETTING_KEY] === true
}
export function setDuckduckgoScraping(enabled: boolean): void {
  saveGlobalConfig(config => ({ ...config, [DUCKDUCKGO_SETTING_KEY]: enabled }))
}
export function duckduckgoScrapingPinned(): boolean { return flagEnv('MERCURY_SEARCH_KEYLESS') !== undefined }
