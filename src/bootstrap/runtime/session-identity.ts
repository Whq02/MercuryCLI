import { realpathSync } from 'fs'
import { cwd } from 'process'
import type { SessionId } from 'src/types/ids.js'
// eslint-disable-next-line custom-rules/bootstrap-isolation -- the sanctioned crypto leaf (see note)
import { randomUUID } from 'src/utils/crypto.js'
import { createSignal } from 'src/utils/signal.js'

export class SessionIdentityOwner {
  originalCwd: string
  projectRoot: string
  cwd: string
  sessionId: SessionId
  parentSessionId: SessionId | undefined = undefined
  sessionProjectDir: string | null = null
  readonly planSlugCache: Map<string, string> = new Map()
  private readonly sessionSwitched = createSignal<[id: SessionId]>()
  private readonly cwdChanged = createSignal<[cwd: string]>()

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
    this.originalCwd = nextCwd.normalize('NFC')
  }

  setProjectRoot(nextCwd: string): void {
    this.projectRoot = nextCwd.normalize('NFC')
  }

  setCwdState(nextCwd: string): void {
    this.cwd = nextCwd.normalize('NFC')
    this.cwdChanged.emit(this.cwd)
  }

  switchSession(sessionId: SessionId, projectDir: string | null = null): void {
    this.planSlugCache.delete(this.sessionId)
    this.sessionId = sessionId
    this.sessionProjectDir = projectDir
    this.sessionSwitched.emit(sessionId)
  }

  regenerateSessionId(
    options: { setCurrentAsParent?: boolean } = {},
  ): SessionId {
    if (options.setCurrentAsParent) {
      this.parentSessionId = this.sessionId
    }
    this.planSlugCache.delete(this.sessionId)
    this.sessionId = randomUUID() as SessionId
    this.sessionProjectDir = null
    return this.sessionId
  }

  onSessionSwitch(listener: (id: SessionId) => void): () => void {
    return this.sessionSwitched.subscribe(listener)
  }

  onCwdChange(listener: (cwd: string) => void): () => void {
    return this.cwdChanged.subscribe(listener)
  }
}
