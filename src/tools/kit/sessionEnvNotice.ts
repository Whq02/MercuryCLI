import { makeOwnerKey, parseOwnerKey, type OwnerKey } from '../../engine/run-owner/ownerKey.js'
import { registerOwnerScopedStore } from '../../engine/run-owner/ownerLifecycle.js'
import { OwnerScopedStore } from '../../engine/run-owner/ownerScopedStore.js'
import { currentOwner, processMainOwner } from '../../engine/run-owner/resolveOwner.js'

export function scrubbedSessionEnvNotice(scrubbed: readonly string[] | undefined): string {
  if (scrubbed === undefined || scrubbed.length === 0) return ''
  return `[session env scrubbed: ${scrubbed.join(', ')} — Mercury's own stamps, not the operator's; inherit_session_env: true keeps them]`
}

export function shortScrubbedSessionEnvNotice(named: readonly string[]): string {
  if (named.length === 0) return ''
  return `[session env scrubbed: ${named.join(', ')}]`
}

function noticeKey(owner: OwnerKey): OwnerKey {
  const id = parseOwnerKey(owner)
  return makeOwnerKey({ workspace: '', sessionId: id.sessionId, lane: id.lane })
}

const sessionEnvNoticeShown = new OwnerScopedStore<{ shown: boolean }>({
  name: 'session-env-notice',
  retain: (_state, owner) => parseOwnerKey(owner).sessionId === parseOwnerKey(processMainOwner()).sessionId,
  create: () => ({ shown: false }),
})
registerOwnerScopedStore({
  name: sessionEnvNoticeShown.name,
  dispose(owner) {
    sessionEnvNoticeShown.dispose(noticeKey(owner))
  },
  disposeAsync(owner) {
    return sessionEnvNoticeShown.disposeAsync(noticeKey(owner))
  },
  drainPending() {
    return sessionEnvNoticeShown.drainPending()
  },
  clearAllForShutdown() {
    sessionEnvNoticeShown.clearAllForShutdown()
  },
  get size() {
    return sessionEnvNoticeShown.size
  },
})

export function sessionEnvNoticeForResult(args: {
  scrubbed: readonly string[] | undefined
  commandText: string | undefined
}): string {
  const scrubbed = args.scrubbed
  if (scrubbed === undefined || scrubbed.length === 0) return ''
  const state = sessionEnvNoticeShown.get(noticeKey(currentOwner()))
  if (!state.shown) {
    state.shown = true
    return scrubbedSessionEnvNotice(scrubbed)
  }
  const text = args.commandText ?? ''
  const named = scrubbed.filter(name => text.includes(name))
  return shortScrubbedSessionEnvNotice(named)
}

export function resetSessionEnvNoticeOnFold(): void {
  sessionEnvNoticeShown.dispose(noticeKey(currentOwner()))
}
