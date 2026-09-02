import { flagSpellings } from '../../substrate/flagRegistry.js'
import { daemonSnapshot } from '../cockpit/daemonSnapshot.js'
import { scribeBusLiveEnabled } from './scribeGates.js'
import { logForDebugging } from '../debug.js'
import { mintImmediateReceipt } from '../model/seatReceipts.js'
import type { DaemonRequest } from '../../daemon/protocol.js'
import { getImplementerWorkflowsPosture } from './workflowsPosture.js'
import {
  clearDeadSupervisorRecords,
  daemonControlRpc,
} from '../../daemon/controlSocket.js'
import { spawnOwnedDaemon, shouldReapAutoStartedDaemon } from '../../daemon/ownedDaemon.js'
import { daemonHaltStanddownActive } from '../daemonStanddown.js'

export { shouldReapAutoStartedDaemon }

export function decideScribeDaemonAction(
  daemonState: 'live' | 'unavailable' | 'off' | string,
): 'noop' | 'spawn' {
  return daemonState === 'live' ? 'noop' : 'spawn'
}

export function buildScribeDaemonExtraEnv(): Record<string, string | undefined> {
  const pair = (name: string, value: string | undefined): Record<string, string | undefined> =>
    Object.fromEntries(flagSpellings(name).map(sp => [sp, value]))
  return {
    ...pair('MERCURY_DAEMON_SCRIBE_ENGAGE', '1'),
    ...pair('MERCURY_DAEMON_SCRIBE_WORKFLOWS', getImplementerWorkflowsPosture() ? '1' : undefined),
  }
}

function spawnScribeDaemon(projectDir: string): void {
  spawnOwnedDaemon(projectDir, {
    label: 'scribe',
    extraEnv: buildScribeDaemonExtraEnv(),
  })
}

export function ensureScribeDaemon(projectDir: string): void {
  if (!scribeBusLiveEnabled()) return
  if (daemonHaltStanddownActive()) {
    logForDebugging('[scribe] ensureScribeDaemon: standing down — /halt was the operator word; re-engage Scribe to bring the daemon back')
    return
  }
  let state: string
  try {
    state = daemonSnapshot().state
  } catch (e) {
    logForDebugging(`[scribe] ensureScribeDaemon: probe failed: ${e}`)
    return
  }
  if (decideScribeDaemonAction(state) === 'spawn') {
    spawnScribeDaemon(projectDir)
    return
  }
  void (async () => {
    try {
      const ping = await daemonControlRpc({ op: 'ping' }, { timeoutMs: 1000 })
      if (ping.ok) {
        const verify = setTimeout(() => {
          void (async () => {
            try {
              const has = await daemonControlRpc(
                { op: 'has', short: 'implementer' } as DaemonRequest,
                { timeoutMs: 2000 },
              )
              if (has.ok && has.op === 'has' && !has.present) {
                mintImmediateReceipt(
                  '▲ Scribe engaged, but the running daemon was started without Scribe Mode and will never host the Implementer — dispatches will wait unanswered. Run `mercury daemon stop`, then re-engage Scribe (pick it again in /model) to bring up the right daemon.',
                  'warning',
                )
              }
            } catch {
            }
          })()
        }, 4000)
        verify.unref?.()
        return
      }
    } catch {
    }
    logForDebugging(
      '[scribe] recorded daemon is pid-alive but not serving (stale/reused-pid/wedged) — clearing + respawning',
    )
    try {
      await clearDeadSupervisorRecords()
    } catch {
    }
    spawnScribeDaemon(projectDir)
  })()
}
