import type { Transfer } from '../../../integrations/browser/browserTransfers.js'
import { type Input, WAIT_CAP_MS, WAIT_DEFAULT_MS } from './schema.js'
import { type LiveSession, bytesWords } from './page.js'
import { withDeadline } from '../../../platform/async/deadline.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export const DOWNLOADS_NOT_FOLLOWED = 'downloads are not followed here; fetch the file with WebFetch or Bash instead'

export const namedTransfers = new WeakSet<Transfer>()

export function transferWords(transfer: Transfer): string {
  namedTransfers.add(transfer)
  if (transfer.state === 'complete') {
    return `saved to ${transfer.path} (${bytesWords(transfer.bytes ?? 0)}, ${transfer.type ?? 'type unknown'}, suggested name ${transfer.name}, from ${transfer.url}, sha256 ${transfer.sha256}) — download ${transfer.id}, in the session scratchpad`
  }
  if (transfer.state === 'failed') return `download ${transfer.id} failed: ${transfer.failure} (${transfer.name} from ${transfer.url})`
  const idle = Math.floor((Date.now() - transfer.movedAt) / 1000)
  return `download ${transfer.id} is still arriving (${bytesWords(transfer.received)}${transfer.total !== null ? ` of ${bytesWords(transfer.total)}` : ''} of ${transfer.name} from ${transfer.url}${idle >= 5 ? `; no new bytes for ${idle} s` : ''}) — op:"download" with downloadId:"${transfer.id}" waits for it`
}

export function downloadWords(notice: NonNullable<LiveSession['downloads']['last']>): string {
  if (notice.transfer !== null) return `a download — ${transferWords(notice.transfer)}`
  const facts = [notice.type, notice.bytes !== null ? bytesWords(notice.bytes) : null, `saves as ${notice.filename}`].filter(
    (f): f is string => f !== null && f !== '',
  )
  return `a download (${facts.join(', ')}) — ${DOWNLOADS_NOT_FOLLOWED}`
}

export function downloadVia(input: Input): 'open' | 'click' | null {
  if (input.op !== 'download' || (input.downloadId !== undefined && input.downloadId !== '')) return null
  if (input.url !== undefined && input.url !== '') return 'open'
  if (input.selector !== undefined && input.selector !== '') return 'click'
  return null
}

export function downloadAct(input: Input): Input {
  const via = downloadVia(input)
  return via === null ? input : { ...input, op: via, timeoutMs: undefined }
}

export async function downloadSought(s: LiveSession, before: number, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<string> {
  s.touched = true
  if (s.downloads.count > before) return ''
  const budget = Math.min(Math.max(timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
  const interrupted = await new Promise<boolean>(resolve => {
    const stop = (): void => {
      stopTimeout(timer)
      resolve(true)
    }
    const timer = startTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve(false)
    }, budget)
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    s.downloads.waiters.push(() => {
      stopTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolve(false)
    })
  })
  const began = s.downloads.last
  if (s.downloads.count === before || began === null) {
    return `\n  note: ${interrupted ? 'the wait for a download was interrupted' : `no download has begun in ${budget >= 1000 ? `${Math.round(budget / 1000)} s` : `${budget} ms`}`} — this tab stays followed: one that begins later is saved and named in the next answer on it`
  }
  await withDeadline(began.transfer?.done ?? began.done, 1000, () => {}, { signal, onAbort: () => {}, unref: true })
  return `\n  note: the page started ${downloadWords(began)}`
}
