import { realpathSync } from 'fs'
import { cwd } from 'process'
import { asSessionId, type SessionId } from 'src/types/ids.js'
import { randomUUID } from 'src/utils/crypto.js'
import { passedOver } from 'src/utils/passedOver.js'

function startFolder(): string {
  let folder: string
  try {
    folder = cwd()
  } catch (error) {
    passedOver(error)
    return ''
  }
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
  private readonly sessionSwitched = new Set<(id: SessionId) => void>()
  private readonly cwdChanged = new Set<(cwd: string) => void>()

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
    for (const listener of this.cwdChanged) listener(stored)
  }

  switchSession(sessionId: SessionId, projectDir?: string | null): void {
    this.planSlugCache.delete(this.sessionId)
    this.sessionId = sessionId
    this.sessionProjectDir = projectDir ?? null
    for (const listener of this.sessionSwitched) listener(sessionId)
  }

  regenerateSessionId(): SessionId {
    this.planSlugCache.delete(this.sessionId)
    this.sessionId = asSessionId(randomUUID())
    this.sessionProjectDir = null
    return this.sessionId
  }

  onSessionSwitch(listener: (id: SessionId) => void): () => void {
    this.sessionSwitched.add(listener)
    return () => {
      this.sessionSwitched.delete(listener)
    }
  }

  onCwdChange(listener: (cwd: string) => void): () => void {
    this.cwdChanged.add(listener)
    return () => {
      this.cwdChanged.delete(listener)
    }
  }
}
