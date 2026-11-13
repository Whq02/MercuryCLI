export const WEB_SEARCH_TOOL_NAME = 'WebSearch'
export const PROVIDER_SEARCH_TOOL_NAME = 'ProviderSearch'

export const SEARCH_QUERY_FIELD = 'Search words. Error messages route to Stack Exchange; npm/PyPI/crates + package to that registry; GitHub to public code; news to Hacker News; concepts to Wikipedia; else general search.'

export function getWebSearchPrompt(): string {
  return `Searches the web on any model and returns JSON hits {title, url, snippet, source_type} with notes (≤~2,000 tokens at chars/4; withheld hits counted; provider search adds its answer as a labelled unverified note). Source order: session provider search, Brave/Tavily keys, query-routed official API, SearXNG instances, DuckDuckGo scraping (unless disabled). Sources receive query and client IP; hits are unverified; cached repeats say so.

End answers with "Sources:" linking relevant hits as [Title](URL).`
}

export function getProviderSearchPrompt(): string {
  return `Searches only via this session provider's native search on its account, returning JSON hits {title, url, snippet, source_type: provider} with notes (≤~2,000 tokens at chars/4; withheld hits counted; provider answer attached as a labelled unverified note). Hits are unverified.

End answers with "Sources:" linking relevant hits as [Title](URL).`
}
