export const WEB_SEARCH_TOOL_NAME = 'WebSearch'
export const PROVIDER_SEARCH_TOOL_NAME = 'ProviderSearch'

export const SEARCH_QUERY_FIELD = 'The search words. An error message selects Stack Exchange; npm, PyPI or crates with a package name selects that registry; GitHub selects public code; news selects Hacker News; a concept question selects Wikipedia; other wording goes to general search.'

export function getWebSearchPrompt(): string {
  return `Searches the web, on any session model, and returns JSON hits {title, url, snippet, source_type} with notes, under about 2,000 tokens by a characters/4 estimate; hits withheld to fit are counted in a note, every hit names its source, and the provider's own search adds the provider's answer as a labelled, unverified note beside its links. Sources are tried in order: the session provider's own search, on this session's account; stored Brave or Tavily keys; the official API the query words select; the operator's SearXNG instances; DuckDuckGo page scraping unless the operator turned it off. Every source receives the query and the client's address. Hits are unverified evidence; a repeated query may come from the session cache and says so.

End the answer with a "Sources:" section linking every relevant result as [Title](URL).`
}

export function getProviderSearchPrompt(): string {
  return `Searches the web through the session provider's own search, on this session's provider account, with no other source tried, and returns JSON hits {title, url, snippet, source_type: provider} with notes, under about 2,000 tokens by a characters/4 estimate; hits withheld to fit are counted in a note, and the provider's own answer rides as a labelled, unverified note beside its links. Hits are unverified evidence.

End the answer with a "Sources:" section linking every relevant result as [Title](URL).`
}
