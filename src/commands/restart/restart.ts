import { getSessionId } from '../../bootstrap/state.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async () => {
  const sessionId = hasFocusedSession() ? getFocusedSessionConnector().sessionId() : String(getSessionId())
  const isHostedRunner = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
  if (isHostedRunner) {
    const timer = setTimeout(() => {
      void daemonControlRpc(
        { op: 'sessionControl', action: 'resume', sessionId, by: 'operator', reason: 'update' } as never,
        { timeoutMs: 15_000 },
      ).catch(() => {})
    }, 50)
    timer.unref?.()
    return { type: 'text', value: 'Restarting this session on the installed build…' }
  }
  const reply = (await daemonControlRpc(
    { op: 'sessionControl', action: 'resume', sessionId, by: 'operator', reason: 'update' } as never,
    { timeoutMs: 15_000 },
  )) as { ok?: boolean; outcome?: string; detail?: string; error?: string }
  if (reply.ok === true && reply.outcome === 'applied') {
    return { type: 'text', value: reply.detail ?? 'Session restarted on the installed build.' }
  }
  return { type: 'text', value: `Session restart refused — ${reply.detail ?? reply.error ?? 'the daemon could not restart it'}` }
}
