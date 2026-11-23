import { realpathSync } from 'fs'
import { cwd } from 'process'
import { asSessionId, type SessionId } from 'src/sessions/transcripts/ids.js'
import { randomUUID } from 'src/platform/primitives/crypto.js'
import { passedOver } from 'src/platform/errors/passedOver.js'
import { createSignal } from 'src/platform/async/signal.js'

function startFolder(): string {
  if (typeof process === 'undefined' || typeof cwd !== 'function' || typeof realpathSync !== 'function') return ''
  const folder = cwd()
  try {
    return realpathSync(folder).normalize('NFC')
  } catch (error) {
    passedOver(error)
    return folder.normalize('NFC')
  }
}

export class SessionIdentityOwner {
  originalCwd: string
  projectRoot: string
  cwd: string
  sessionId: SessionId
  sessionProjectDir: string | null = null
  readonly planSlugCache: Map<string, string> = new Map()
  private readonly sessionSwitched = createSignal<[id: SessionId]>()
  private readonly cwdChanged = createSignal<[cwd: string]>()

  constructor() {
    const folder = startFolder()
    this.originalCwd = folder
    this.projectRoot = folder
    this.cwd = folder
    this.sessionId = asSessionId(randomUUID())
  }

  setOriginalCwd(nextCwd: string): void {
    this.originalCwd = nextCwd.normalize('NFC')
  }

  setProjectRoot(nextCwd: string): void {
    this.projectRoot = nextCwd.normalize('NFC')
  }

  setCwdState(nextCwd: string): void {
    const stored = nextCwd.normalize('NFC')
    this.cwd = stored
    this.cwdChanged.emit(stored)
  }

  switchSession(sessionId: SessionId, projectDir?: string | null): void {
    this.planSlugCache.delete(this.sessionId)
    this.sessionId = sessionId
    this.sessionProjectDir = projectDir ?? null
    this.sessionSwitched.emit(sessionId)
  }

  regenerateSessionId(): SessionId {
    this.planSlugCache.delete(this.sessionId)
    this.sessionId = asSessionId(randomUUID())
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
