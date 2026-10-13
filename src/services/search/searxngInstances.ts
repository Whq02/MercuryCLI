import { flagEnv } from '../../substrate/flagRegistry.js'

export interface SearxngInstance {
  url: string
  terms: string
  apiAllowed: boolean
  checked: string
  why: string
}

export const SEARXNG_INSTANCES: readonly SearxngInstance[] = []
export const SEARXNG_RATE_POLICY = { intervalMs: 3000, why: 'https://docs.searxng.org/dev/search_api.html — JSON must be enabled by the host; a 403 is a refusal, not permission to scrape. No universal rate published; client courtesy is serial requests three seconds apart, with Retry-After respected.' }

export function configuredSearxngInstances(raw = flagEnv('MERCURY_SEARCH_SEARXNG_INSTANCES')): { instances: readonly SearxngInstance[]; error?: string } {
  if (!raw?.trim()) return { instances: SEARXNG_INSTANCES }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('not a list')
    const instances: SearxngInstance[] = []
    for (const row of parsed) {
      if (typeof row !== 'object' || row === null || typeof row.url !== 'string' || typeof row.terms !== 'string' || row.apiAllowed !== true || typeof row.checked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.checked)) throw new Error('invalid entry')
      const url = new URL(row.url), terms = new URL(row.terms)
      for (const address of [url, terms]) {
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)
        if ((address.protocol !== 'https:' && !(loopback && address.protocol === 'http:')) || address.username || address.password || address.search || address.hash) throw new Error('invalid URL')
      }
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      if (!instances.some(instance => instance.url === url.href)) instances.push({ url: url.href, terms: terms.href, apiAllowed: true, checked: row.checked, why: 'The operator configured this instance after reading its policy and confirming automated JSON API access is permitted.' })
    }
    return { instances }
  } catch {
    return { instances: [], error: 'MERCURY_SEARCH_SEARXNG_INSTANCES needs a JSON array of {url, terms, apiAllowed: true, checked: "YYYY-MM-DD"}; use HTTPS bases without credentials, queries or fragments (HTTP is allowed only on loopback). Configure only instances whose policy you read and which permits automated JSON API access.' }
  }
}
