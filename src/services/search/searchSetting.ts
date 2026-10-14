import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'

export const DUCKDUCKGO_SETTING_KEY = 'duckduckgoScraping'
export const DUCKDUCKGO_SETTING_LABEL = 'DuckDuckGo page scraping'
export const DUCKDUCKGO_OFF_DOORS = 'turned off in /config or by MERCURY_SEARCH_KEYLESS=0'
export const DUCKDUCKGO_TERMS = "DuckDuckGo page scraping is on; its terms and acceptable-use policy apply, and automated requests may be refused; /config or MERCURY_SEARCH_KEYLESS=0 turns it off. https://duckduckgo.com/terms · https://duckduckgo.com/acceptable-use"

export function duckduckgoScrapingEnabled(): boolean {
  if (duckduckgoScrapingPinned()) return flagEnabled('MERCURY_SEARCH_KEYLESS')
  return !isConfigReadingAllowed() || getGlobalConfig()[DUCKDUCKGO_SETTING_KEY] !== false
}
export function setDuckduckgoScraping(enabled: boolean): void {
  saveGlobalConfig(config => ({ ...config, [DUCKDUCKGO_SETTING_KEY]: enabled }))
}
export function duckduckgoScrapingPinned(): boolean { return flagEnv('MERCURY_SEARCH_KEYLESS') !== undefined }
