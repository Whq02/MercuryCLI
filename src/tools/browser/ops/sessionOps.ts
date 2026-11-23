import type { ToolEffectOutcome } from '../../kit/tool.js'
import { BROWSER_CLOSE_BOUND_MS, BROWSER_FINISH_BOUND_MS, closeBrowserSessionDetailed } from '../../../integrations/browser/browserSession.js'
import type { Transfer } from '../../../integrations/browser/browserTransfers.js'
import { transferWords } from './downloads.js'
import type { OpDone, OpRun } from './ops.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export async function provisionOp({ input }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const { installManagedBrowser, planBrowserInstall } = await import(
    '../../../integrations/browser/browserInstall.js'
  )
  const buildId = input.buildId ?? (await planBrowserInstall()).buildId
  const installed = await installManagedBrowser(buildId)
  result = `provisioned Chrome for Testing ${installed.buildId} — ${(installed.sizeBytes / 1024 / 1024).toFixed(0)} MB on disk\n  ${installed.executablePath}\n  remove any time: /browser remove ${installed.buildId}`
  outcome = 'succeeded'
  return { result, outcome }
}

export async function downloadOp(wanted: Transfer, outer: AbortSignal | undefined, deadline: number): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  await new Promise<void>((resolve, reject) => {
    const timer = startTimeout(resolve, deadline)
    const stop = (): void => {
      stopTimeout(timer)
      reject(outer?.reason ?? new Error('interrupted'))
    }
    if (outer?.aborted) stop()
    else outer?.addEventListener('abort', stop, { once: true })
    void wanted.done.then(() => {
      stopTimeout(timer)
      outer?.removeEventListener('abort', stop)
      resolve()
    })
  })
  result = `download: ${transferWords(wanted)}`
  outcome = wanted.state === 'failed' ? 'failed' : wanted.state === 'complete' ? 'succeeded' : 'no-change'
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
