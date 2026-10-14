export const OFFICIAL_SEARCH_SOURCES = ['stackexchange', 'npm', 'pypi', 'crates', 'github', 'hackernews', 'wikipedia'] as const
export type OfficialSearchSource = (typeof OFFICIAL_SEARCH_SOURCES)[number]

export const SEARCH_SOURCE_POLICIES = {
  stackexchange: { intervalMs: 1000, why: 'https://api.stackexchange.com/docs/throttle — respect backoff and quota_remaining; no identical request within a minute; over 30 requests/second is abusive. Client courtesy: one request/second; the response, not an invented daily allowance, supplies the quota. One follow-up /questions/{ids} request (filter=withbody) per search carries the top three excerpts, paced the same.', terms: 'Stack Exchange content: attribution required; CC BY-SA. https://stackexchange.com/legal/api-terms-of-use' },
  npm: { intervalMs: 1000, why: 'https://docs.npmjs.com/policies/open-source-terms/ — automating the Website is forbidden while the documented Public APIs may replicate registry data, and the registry /-/v1/search endpoint is one of those Public APIs; no unreasonable load; no fixed per-second read quota published. Client courtesy: one request/second.', terms: 'npm open-source terms apply; no excessive requests. https://docs.npmjs.com/policies/open-source-terms/' },
  pypi: { intervalMs: 1000, why: 'https://docs.pypi.org/api/json/ — exact project metadata, not full-text search. https://policies.python.org/pypi.org/Acceptable-Use-Policy/ forbids excessive bulk activity; no fixed read quota. Client courtesy: one request/second.', terms: 'PyPI acceptable-use policy applies; no excessive bulk activity. https://policies.python.org/pypi.org/Acceptable-Use-Policy/' },
  crates: { intervalMs: 1000, why: 'https://crates.io/data-access — maximum one request/second; identifying User-Agent with contact. API search is used because the sparse index cannot search descriptions.', terms: 'crates.io data access policy applies: one request/second and an identifying User-Agent. https://crates.io/data-access' },
  github: { intervalMs: 6000, windowMs: 60_000, maxRequests: 10, why: 'https://docs.github.com/en/rest/search/search#search-code — authentication required, 10 requests/minute. https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api — Retry-After, reset when remaining=0, otherwise at least one minute on a secondary limit.', terms: 'GitHub code search needs a token; repository content keeps its own licence. https://docs.github.com/en/site-policy/github-terms/github-terms-of-service' },
  hackernews: { intervalMs: 1000, windowMs: 3_600_000, maxRequests: 10_000, why: 'https://hn.algolia.com/api — 10,000 requests/hour per IP; client courtesy: one request/second. A story\'s own story_text rides as its excerpt; when a top-three story carries none, one follow-up search?tags=comment,(story_…) request per search fetches the top comments, paced the same.', terms: 'Hacker News search is served by Algolia. https://hn.algolia.com/api' },
  wikipedia: { intervalMs: 1000, why: 'https://www.mediawiki.org/wiki/API:Etiquette — serial requests, no hard read speed limit; informative User-Agent, cache, backoff and maxlag. Client courtesy: one request/second.', terms: 'Wikipedia text: CC BY-SA; attribute the linked page. https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use' },
} as const

export function officialSearchIntent(query: string): { source: OfficialSearchSource; words: string } | undefined {
  const q = query.trim()
  if (/\b\w*(?:Error|Exception)\b|\btraceback\b|\berror\s*(?::|[A-Z]?\d+)/i.test(q)) return { source: 'stackexchange', words: q }
  const npm = /\bnpm\s+(?:(?:install|i|package)\s+)?(.+)/i.exec(q)
  if (npm) return { source: 'npm', words: npm[1]! }
  const pypi = /\b(?:pypi|pip\s+install|python\s+package)\s+([a-z0-9][a-z0-9._-]*)\b/i.exec(q)
  if (pypi) return { source: 'pypi', words: pypi[1]! }
  const crates = /\b(?:crates?(?:\.io)?|cargo\s+add|rust\s+crate)\s+(.+)/i.exec(q)
  if (crates) return { source: 'crates', words: crates[1]! }
  if (/\b(?:github|source\s+code)\b|\brepo:[\w.-]+\//i.test(q)) return { source: 'github', words: q.replace(/\bgithub\s*/i, '') }
  if (/\b(?:news|hacker\s+news|HN)\b/i.test(q)) return { source: 'hackernews', words: q.replace(/\b(?:hacker\s+news|news|HN)\b/ig, '').trim() || q }
  if (/^(?:what\s+is|what\s+are|explain|define|wikipedia)\s+/i.test(q)) return { source: 'wikipedia', words: q.replace(/^(?:what\s+is|what\s+are|explain|define|wikipedia)\s+/i, '').replace(/\?$/, '') }
  return undefined
}
