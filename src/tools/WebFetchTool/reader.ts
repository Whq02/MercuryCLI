import axios from 'axios'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { AbortError } from '../../utils/errors.js'
import { webUserAgent } from '../../utils/webUserAgent.js'
import { EgressBlockedError } from './fetchErrors.js'
import { FetchPacing } from './fetchPacing.js'
import { isPreapprovedHost } from './preapproved.js'
import { permittedFetchRedirect } from './fetchTransport.js'
import { PAYWALL_MESSAGE } from './pageAccess.js'
import { isPrivateReaderHost } from './privateHost.js'

export const READER_KEYLESS_RPM = 20
const pacing = new FetchPacing()

export function fetchReaderEnabled(): boolean {
  return flagEnabled('MERCURY_FETCH_READER')
}

type ReaderResult = { content?: string; notice: string }

export async function readHostedPage(url: string, signal: AbortSignal, pace = pacing): Promise<ReaderResult> {
  const parsed = new URL(url)
  if (!fetchReaderEnabled()) return { notice: 'The page has little text before scripts run; the hosted reader is off (MERCURY_FETCH_READER=0). These are its sparse words.' }
  if (isPreapprovedHost(parsed.hostname, parsed.pathname)) return { notice: 'The page has little text before scripts run; preapproved documentation is never sent to the hosted reader. These are its sparse words.' }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateReaderHost(parsed.hostname)) {
    return { notice: 'The page has little text before scripts run; this address is not sent to a hosted reader. These are its sparse words.' }
  }
  parsed.hash = ''
  return pace.run(60_000 / READER_KEYLESS_RPM, signal, async wait => {
    if (!fetchReaderEnabled()) return { notice: 'The hosted reader was turned off before the request; these are the page’s sparse words.' }
    if (wait > 0) return { notice: `r.jina.ai is cooling down for ${Math.ceil(wait / 1000)}s; no reader request was sent. These are the page’s sparse words; do not retry before that wait ends.` }
    try {
      const response = await axios.get<ArrayBuffer>(`https://r.jina.ai/${parsed.toString()}`, {
        signal,
        timeout: 60_000,
        maxRedirects: 0,
        maxContentLength: 10 * 1024 * 1024,
        responseType: 'arraybuffer',
        headers: { Accept: 'application/json', 'X-Engine': 'browser', 'X-Robots-Txt': 'Mercury', 'User-Agent': webUserAgent() },
      })
      if (signal.aborted) throw new AbortError()
      const body = JSON.parse(Buffer.from(response.data).toString('utf8')) as { code?: unknown; data?: { content?: unknown; url?: unknown } }
      if (body.code === 402) return { notice: PAYWALL_MESSAGE }
      if (body.code !== undefined && body.code !== 200) return { notice: 'The hosted reader could not serve this page; search for another source — do not retry this URL.' }
      if (typeof body.data?.url !== 'string' || !permittedFetchRedirect(parsed.toString(), body.data.url)) {
        return { notice: 'The hosted reader did not confirm this page’s host; its response was not used. These are the page’s sparse words.' }
      }
      if (typeof body.data.content !== 'string' || !body.data.content.trim()) return { notice: 'r.jina.ai returned no page text; these are the page’s sparse words. Search for another source.' }
      pace.answered()
      return { content: body.data.content, notice: 'read through r.jina.ai (the page needed a browser to render)' }
    } catch (error) {
      if (signal.aborted) throw new AbortError()
      if (axios.isAxiosError(error)) {
        const status = error.response?.status
        if (status === 402) return { notice: PAYWALL_MESSAGE }
        if (status === 403 && error.response?.headers['x-proxy-error'] === 'blocked-by-allowlist') throw new EgressBlockedError('r.jina.ai')
        if (status === 403 || status === 429 || status === 503) {
          const waitMs = pace.refuse(error.response?.headers['retry-after'])
          return { notice: `r.jina.ai ${status === 403 ? 'refused' : 'rate-limited'} the reader request; backed off for ${Math.ceil(waitMs / 1000)}s. These are the page’s sparse words; search for another source and do not retry before the wait ends.` }
        }
      }
      return { notice: 'The hosted reader could not return this page; these are the page’s sparse words. Search for another source.' }
    }
  })
}
