import { realpathSync } from 'fs'
import { cwd } from 'process'
import type { SessionId } from 'src/types/ids.js'
import { randomUUID } from 'src/utils/crypto.js'
import { createSignal } from 'src/utils/signal.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export class SessionIdentityOwner {
  originalCwd: string
  projectRoot: string
  cwd: string
  sessionId: SessionId
  sessionProjectDir: string | null = unbuilt('src/bootstrap/runtime/session-identity.ts:12')
  readonly planSlugCache: Map<string, string> = unbuilt('src/bootstrap/runtime/session-identity.ts:13')
  private readonly sessionSwitched: Unbuilt = unbuilt('src/bootstrap/runtime/session-identity.ts:14')
  private readonly cwdChanged: Unbuilt = unbuilt('src/bootstrap/runtime/session-identity.ts:15')

  constructor() {
    let resolvedCwd = ''
    if (
      typeof process !== 'undefined' &&
      typeof process.cwd === 'function' &&
      typeof realpathSync === 'function'
    ) {
      const rawCwd = cwd()
      try {
        resolvedCwd = realpathSync(rawCwd).normalize('NFC')
      } catch {
        resolvedCwd = rawCwd.normalize('NFC')
      }
    }
    this.originalCwd = resolvedCwd
    this.projectRoot = resolvedCwd
    this.cwd = resolvedCwd
    this.sessionId = randomUUID() as SessionId
  }

  setOriginalCwd(nextCwd: string): void {
    return notBuilt('src/bootstrap/runtime/session-identity.ts:37')
  }

  setProjectRoot(nextCwd: string): void {
    return notBuilt('src/bootstrap/runtime/session-identity.ts:41')
  }

  setCwdState(nextCwd: string): void {
    return notBuilt('src/bootstrap/runtime/session-identity.ts:45')
  }

  switchSession(sessionId: SessionId, projectDir?: string | null): void {
    return notBuilt('src/bootstrap/runtime/session-identity.ts:50')
  }

  regenerateSessionId(): SessionId {
    return notBuilt('src/bootstrap/runtime/session-identity.ts:57')
  }

  onSessionSwitch(listener: (id: SessionId) => void): () => void {
    return notBuilt('src/bootstrap/runtime/session-identity.ts:64')
  }

  onCwdChange(listener: (cwd: string) => void): () => void {
    return notBuilt('src/bootstrap/runtime/session-identity.ts:68')
  }
}
