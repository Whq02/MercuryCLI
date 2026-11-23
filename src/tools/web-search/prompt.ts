export const WEB_SEARCH_TOOL_NAME = 'WebSearch'
export const PROVIDER_SEARCH_TOOL_NAME = 'ProviderSearch'

export const SEARCH_QUERY_FIELD = 'Search words. Error messages route to Stack Exchange; npm/PyPI/crates + package to that registry; GitHub to public code; news to Hacker News; concepts to Wikipedia; else general search.'

export function getWebSearchPrompt(): string {
  return `Searches the web on any model and returns JSON hits {title, url, snippet, source_type} with notes (≤~2,000 tokens at chars/4; withheld hits counted; provider search adds its answer as a labelled unverified note). Source order: the session provider's own search, on this session's account; Brave/Tavily keys; the official API the query words select; SearXNG instances; DuckDuckGo page scraping unless the operator turned it off. Every source receives the query and the client's address; hits are unverified; cached repeats say so.

End answers with "Sources:" linking relevant hits as [Title](URL).`
}

export function getProviderSearchPrompt(): string {
  return `Searches through the session provider's own search, on this session's provider account, with no other source tried, returning JSON hits {title, url, snippet, source_type: provider} with notes (≤~2,000 tokens at chars/4; withheld hits counted; provider answer attached as a labelled unverified note). Hits are unverified.

End answers with "Sources:" linking relevant hits as [Title](URL).`
}
