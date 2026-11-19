import type { ToolEffectOutcome } from '../../../Tool.js'
import {
  BROWSER_CLOSE_BOUND_MS,
  BROWSER_FINISH_BOUND_MS,
  browserTransfers,
  closeBrowserSessionDetailed,
} from '../../../services/browser/browserSession.js'
import type { Transfer } from '../../../services/browser/browserTransfers.js'
import { WAIT_CAP_MS, WAIT_DEFAULT_MS } from './schema.js'
import { transferWords } from './downloads.js'
import type { OpDone, OpRun } from './ops.js'

export async function provisionOp({ input }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const { installManagedBrowser, planBrowserInstall } = await import(
    '../../../services/browser/browserInstall.js'
  )
  const buildId = input.buildId ?? (await planBrowserInstall()).buildId
  const installed = await installManagedBrowser(buildId)
  result = `provisioned Chrome for Testing ${installed.buildId} — ${(installed.sizeBytes / 1024 / 1024).toFixed(0)} MB on disk\n  ${installed.executablePath}\n  remove any time: /browser remove ${installed.buildId}`
  outcome = 'succeeded'
  return { result, outcome }
}

export async function downloadOp({ input, owner, tab, context }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const all = browserTransfers(owner)
  if (input.downloadId !== undefined && input.downloadId !== '') {
    const wanted = all.find(transfer => transfer.id === input.downloadId)
    if (wanted === undefined) {
      result = `no download ${input.downloadId} — op:"download" without downloadId lists the ${all.length} of this session`
      outcome = 'failed'
      return { result, outcome }
    }
    if (wanted.state === 'pending') {
      const outer = context.abortController?.signal
      const deadline = Math.min(Math.max(input.timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, deadline)
        const stop = (): void => {
          clearTimeout(timer)
          reject(outer?.reason ?? new Error('interrupted'))
        }
        if (outer?.aborted) stop()
        else outer?.addEventListener('abort', stop, { once: true })
        void wanted.done.then(() => {
          clearTimeout(timer)
          outer?.removeEventListener('abort', stop)
          resolve()
        })
      })
    }
    result = `download: ${transferWords(wanted)}`
    outcome = wanted.state === 'failed' ? 'failed' : wanted.state === 'complete' ? 'succeeded' : 'no-change'
    return { result, outcome }
  }
  const first = Math.min(Math.max(Math.floor(input.offset ?? 0), 0), all.length)
  const shown = all.slice(first, first + Math.max(Math.floor(input.limit ?? 50), 1))
  const count = (state: Transfer['state']): number => all.filter(transfer => transfer.state === state).length
  result =
    all.length === 0
      ? 'downloads: none — a download that an act starts is saved in the session scratchpad and named in that act’s answer'
      : [
          `downloads: ${all.length} (${count('complete')} complete, ${count('pending')} arriving, ${count('failed')} failed)${first > 0 ? `, from ${first}` : ''}`,
          ...shown.map(transfer => `  tab ${transfer.tab}: ${transferWords(transfer)}`),
          ...(first + shown.length < all.length ? [`  … ${all.length - first - shown.length} more — continue with offset: ${first + shown.length}`] : []),
        ].join('\n')
  return { result, outcome }
}

export async function closeOp({ input, owner, tab }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const closed = await closeBrowserSessionDetailed(owner, input.tab)
  if (closed.open.length > 0) {
    result = closed.closed.length === 0 ? `no tab ${tab} — open: ${closed.open.join(', ')}` : `tab ${tab} closed — open: ${closed.open.join(', ')}`
    outcome = closed.closed.length === 0 ? 'no-change' : 'succeeded'
    return { result, outcome }
  }
  const several = closed.closed.length > 1 ? `, ${closed.closed.length} tabs: ${closed.closed.join(', ')}` : ''
  result =
    closed.outcome === 'closed'
      ? `session closed (browser reaped${several}; origin approvals wiped)`
      : closed.outcome === 'killed'
        ? `session closed — the browser did not answer within ${BROWSER_CLOSE_BOUND_MS / 1000}s and its process was ended (origin approvals wiped${several})`
        : closed.outcome === 'unfinished'
          ? `session closed — the browser did not finish quitting within ${BROWSER_FINISH_BOUND_MS / 1000}s and its process was ended (origin approvals wiped${several})`
          : closed.outcome === 'gone'
            ? 'closed (the browser was already gone)'
            : 'no open session'
  outcome = closed.outcome === 'none' ? 'no-change' : 'succeeded'
  return { result, outcome }
}
