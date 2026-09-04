import { getLocalMonthYear } from '../../constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'
export const PROVIDER_SEARCH_TOOL_NAME = 'ProviderSearch'

export function getWebSearchPrompt(): string {
  const monthYear = getLocalMonthYear()
  const currentYear = Number(monthYear.split(' ').at(-1))
  return `- Mercury's VENDORED web search: works for any model on any provider, a local model included
- Brings in fresh information — current events, recent data; hands back search hits (title, url, and a snippet when the backend carries one), links arriving as markdown hyperlinks
- The road to information past the knowledge cutoff
- The harness chooses this tool's backend — a Brave Search or Tavily key stored in Mercury when one exists, else keyless DuckDuckGo — and it NEVER spends your provider account. The keyless door can be rate-limited by a busy client: the walk retries once, then cools that door down and answers with ONE typed line naming the way out (never a guessed result); a query that already landed this session answers from the cache. Every result says which backend answered ("via …"); pass that on when the user asks where the hits came from
- When this session's provider carries its own native search, that door is the separate ${PROVIDER_SEARCH_TOOL_NAME} tool, which has no keyless rate limit — on such a session reach for ${PROVIDER_SEARCH_TOOL_NAME} first for a plain live search; choose this tool for domain-filtered, provider-neutral, or account-free results, and whenever ${PROVIDER_SEARCH_TOOL_NAME} is not listed

CRITICAL REQUIREMENT — the answer done, a "Sources:" section is REQUIRED, carrying every relevant search-result URL as a markdown link — [Title](URL). This is mandatory and is never skipped. Example layout:

<the answer>

Sources:
- [Title of first source](https://example.com/one)
- [Title of second source](https://example.com/two)

Usage notes:
- Domain filters can whitelist or block specific sites
- Results lean US-English by default

IMPORTANT — the current month and year is ${monthYear}. Date searches with ${currentYear} when hunting fresh information, documentation, or current events: search "latest framework docs ${currentYear}", not "latest framework docs ${currentYear - 1}".`
}

export function getProviderSearchPrompt(): string {
  const monthYear = getLocalMonthYear()
  const currentYear = Number(monthYear.split(' ').at(-1))
  return `- Your PROVIDER'S OWN live web search, run inside a provider-side call — the provider's citations, freshness and result limits apply, and the search spends this session's own provider account; it has no keyless rate limit
- Listed only because this session's model family carries a native search construct on its wire (Anthropic web search · OpenAI web search)
- Hands back search hit groups plus the search model's own commentary; domain filters (allowed/blocked) are honoured
- If this tool fails (rate limit, account, provider error) the error is one typed line — the vendored ${WEB_SEARCH_TOOL_NAME} tool is the other door and never spends the provider account
- Choose per query: this tool first for a plain live search on this session — the provider's own retrieval and citations; ${WEB_SEARCH_TOOL_NAME} for neutral keyed/keyless results any model could get, a domain-filtered list, or when the provider account must not be spent

CRITICAL REQUIREMENT — the answer done, a "Sources:" section is REQUIRED, carrying every relevant search-result URL as a markdown link — [Title](URL). This is mandatory and is never skipped.

IMPORTANT — the current month and year is ${monthYear}. Date searches with ${currentYear} when hunting fresh information, documentation, or current events.`
}
