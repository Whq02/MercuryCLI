export interface SearxngInstance {
  url: string
  terms: string
  apiAllowed: boolean
  checked: string
  why: string
}

export const SEARXNG_INSTANCES: readonly SearxngInstance[] = [
  { url: 'https://searx.tiekoetter.com/', terms: 'https://searx.tiekoetter.com/info/en/about', apiAllowed: false, checked: '2026-10-13', why: 'Listed by https://searx.space/data/instances.json with 99.91% yearly uptime. Policy read was rate-limited; automated API use is not verified.' },
  { url: 'https://search.inetol.net/', terms: 'https://search.inetol.net/info/en/about', apiAllowed: false, checked: '2026-10-13', why: 'Listed by https://searx.space/data/instances.json with 98.17% yearly uptime. Policy read was rate-limited; automated API use is not verified.' },
]
export const SEARXNG_RATE_POLICY = { intervalMs: 3000, why: 'https://docs.searxng.org/dev/search_api.html — JSON must be enabled by the host; a 403 is a refusal, not permission to scrape. No universal rate published; client courtesy is serial requests three seconds apart, with Retry-After respected.' }
