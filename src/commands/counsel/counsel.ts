import type { LocalCommandCall } from '../../types/command.js'
import {
  counselEnabled,
  counselStatus,
  defaultCounselRunner,
  formatCounselCard,
  runCounsel,
} from '../../services/counsel/counsel.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'

// `/counsel` — status; `/counsel run` — a manual review NOW (the explicit
// pre-finish check). Manual works whenever the lane is armed.
export const call: LocalCommandCall = async (args, _context) => {
  const owner = processMainOwner()
  if (!counselEnabled()) {
    return {
      type: 'text',
      value:
        'Counsel is OFF (the default — reviews cost model calls). Arm it with MERCURY_COUNSEL=manual (/counsel run only) or MERCURY_COUNSEL=auto (a review fires after every 5 new change receipts; its card lands at the next turn boundary). Cost rides the btw-grade side-question path (shares the prompt cache).',
    }
  }
  const wantRun = (args ?? '').trim() === 'run'
  if (!wantRun) {
    const status = counselStatus(owner)
    return {
      type: 'text',
      value: [
        `counsel: armed (mode ${status.mode}) · ${status.pendingReceipts} un-reviewed receipt(s)`,
        status.lastResult
          ? `last review: ${formatCounselCard(status.lastResult)}`
          : 'no review has run yet',
        'Run one now: /counsel run',
      ].join('\n'),
    }
  }
  const result = await runCounsel(owner, getCwd(), defaultCounselRunner)
  return { type: 'text', value: formatCounselCard(result) }
}
