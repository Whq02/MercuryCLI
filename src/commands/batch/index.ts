import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isScribeModeOn } from '../../utils/scribeMode.js'
import {
  getBatchMode,
  setBatchMode,
  approveBatch,
  denyBatch,
  batchGateStatus,
} from '../../utils/scribe/scribeBatchGate.js'
import { buildScribeBatchLedger } from '../../components/mercury-ui/scribeChatTabs.js'
import { getCommandQueueSnapshot } from '../../utils/messageQueueManager.js'

/**
 * /batch — the operator's approve/deny brake on the Scribe's queued work batch (#47).
 *
 * On bypass/Mercury mode the default is AUTO: batches dispatch automatically, no
 * friction (byte-identical to no gate). `/batch deny` (or `pause`) flips to a MANUAL
 * hold — the source dispatch gate then HOLDS new dispatches until `/batch approve`,
 * so the Implementer's queue never advances without the operator's go-ahead. Only
 * `dispatch` work is held; the Scribe keeps refining/relaying (progress/escalate/
 * control flow freely), so a pause can never wedge it.
 *
 *   /batch            show the approval mode + the queued batches
 *   /batch approve    release the held batch (stays manual; the next batch re-gates)
 *   /batch deny|pause pause dispatching (manual hold)
 *   /batch auto       return to auto-approve (the default)
 *   /batch manual     require explicit approval for each batch
 *
 * Fork+scribe gated, supportsNonInteractive. OFF ⇒ never offered (byte-identical).
 */
const call: LocalCommandCall = async args => {
  const sub = (args ?? '').trim().toLowerCase()
  switch (sub) {
    case 'approve':
    case 'ok':
    case 'go':
      approveBatch()
      return { type: 'text', value: `· batch approved — dispatching released. (${batchGateStatus()})` }
    case 'deny':
    case 'pause':
    case 'hold':
      denyBatch()
      return { type: 'text', value: `· batch paused — new dispatches held until /batch approve. (${batchGateStatus()})` }
    case 'auto':
      setBatchMode('auto')
      return { type: 'text', value: `· batch mode: auto — batches dispatch automatically.` }
    case 'manual':
      setBatchMode('manual')
      return { type: 'text', value: `· batch mode: manual — each batch needs /batch approve.` }
    case '':
    case 'status': {
      const batches = buildScribeBatchLedger(getCommandQueueSnapshot())
      const queued = batches.reduce((n, b) => n + b.items.length, 0)
      const lines = [
        `batch gate: ${batchGateStatus()}`,
        queued === 0
          ? 'queue: empty — nothing waiting to dispatch.'
          : `queue: ${queued} prompt(s) in ${batches.length} batch(es) → ${batches.map(b => `${b.category}·${b.items.length}`).join(', ')}`,
        'commands: /batch approve · deny · auto · manual',
      ]
      return { type: 'text', value: lines.join('\n') }
    }
    default:
      return {
        type: 'text',
        value: `· unknown /batch "${sub}". Use: /batch [approve|deny|auto|manual] (no arg = status). Currently ${getBatchMode()}.`,
      }
  }
}

const batch = {
  type: 'local',
  name: 'batch',
  description: 'Approve / deny the Scribe’s queued work batch (#47; auto on bypass/Mercury)',
  isEnabled: () => isScribeModeOn(),
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default batch
