import type { UUID } from 'node:crypto'
import type { PersistedWorktreeSession } from '../../types/logs.js'

export type SessionMetaFields = {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  lastPrompt?: string
  mode?: 'coordinator' | 'normal'
  advisor?: boolean
  model?: string
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

const scalarFields = [
  ['last-prompt', 'lastPrompt', 'lastPrompt'],
  ['custom-title', 'customTitle', 'customTitle'],
  ['tag', 'tag', 'tag'],
  ['agent-name', 'agentName', 'agentName'],
  ['agent-color', 'agentColor', 'agentColor'],
  ['agent-setting', 'agentSetting', 'agentSetting'],
  ['mode', 'mode', 'mode'],
  ['advisor-switch', 'on', 'advisor'],
  ['model', 'model', 'model'],
  ['worktree-state', 'worktreeSession', 'worktreeSession'],
] as const

export class SessionMeta {
  fields: SessionMetaFields = {}

  constructor(private readonly io: {
    currentId: () => UUID
    currentFile: () => string | null
    append: (path: string, entry: Record<string, unknown>) => void
    tail: (path: string) => string
  }) {}

  write(entry: Record<string, unknown>, path: string): void {
    this.io.append(path, entry)
    if (entry.sessionId !== this.io.currentId()) return
    if (entry.type === 'pr-link') {
      this.fields.prNumber = entry.prNumber as number
      this.fields.prUrl = entry.prUrl as string
      this.fields.prRepository = entry.prRepository as string
      return
    }
    const field = scalarFields.find(([kind]) => kind === entry.type)
    if (field) (this.fields as Record<string, unknown>)[field[2]] = entry[field[1]]
  }

  restore(meta: Omit<SessionMetaFields, 'lastPrompt'>): void {
    const current = this.fields
    if (meta.customTitle) current.customTitle ??= meta.customTitle
    if (meta.tag !== undefined) current.tag = meta.tag || undefined
    for (const key of ['agentName', 'agentColor', 'agentSetting', 'mode', 'model', 'prUrl', 'prRepository'] as const) {
      if (meta[key]) (current as Record<string, unknown>)[key] = meta[key]
    }
    for (const key of ['advisor', 'worktreeSession', 'prNumber'] as const) {
      if (meta[key] !== undefined) (current as Record<string, unknown>)[key] = meta[key]
    }
  }

  clear(): void {
    this.fields = {}
  }

  cache<K extends keyof SessionMetaFields>(key: K, value: SessionMetaFields[K]): void {
    this.fields[key] = value
  }

  saveCached(kind: 'advisor-switch' | 'model' | 'worktree-state', value: unknown): void {
    const field = scalarFields.find(([type]) => type === kind)!
    if (kind === 'model' && (!value || this.fields.model === value)) return
    ;(this.fields as Record<string, unknown>)[field[2]] = value
    const path = this.io.currentFile()
    if (path) this.io.append(path, { type: kind, [field[1]]: value, sessionId: this.io.currentId() })
  }

  restamp(skipTitleRefresh = false): void {
    const path = this.io.currentFile()
    const sessionId = this.io.currentId()
    if (!path || !sessionId) return
    const fresh = new Map<string, string>()
    for (const line of this.io.tail(path).split('\n')) {
      try {
        const record = JSON.parse(line)
        if (record.payload?.kind !== 'session-meta') continue
        const { metaKind, fields } = record.payload
        const key = metaKind === 'custom-title' ? 'customTitle' : metaKind === 'tag' ? 'tag' : undefined
        if (key && typeof fields?.[key] === 'string') fresh.set(key, fields[key])
      } catch {}
    }
    if (!skipTitleRefresh && fresh.has('customTitle')) this.fields.customTitle = fresh.get('customTitle') || undefined
    if (fresh.has('tag')) this.fields.tag = fresh.get('tag') || undefined
    for (const [type, key, field] of scalarFields) {
      const value = this.fields[field]
      const present = field === 'advisor' || field === 'worktreeSession' ? value !== undefined : Boolean(value)
      if (present) this.io.append(path, { type, [key]: value, sessionId })
    }
    const { prNumber, prUrl, prRepository } = this.fields
    if (prNumber !== undefined && prUrl && prRepository) {
      this.io.append(path, { type: 'pr-link', sessionId, prNumber, prUrl, prRepository, timestamp: new Date().toISOString() })
    }
  }
}

export const SESSION_META_COMPAT_FIELDS = {
  currentSessionTag: 'tag',
  currentSessionTitle: 'customTitle',
  currentSessionAgentName: 'agentName',
  currentSessionAgentColor: 'agentColor',
  currentSessionLastPrompt: 'lastPrompt',
  currentSessionAgentSetting: 'agentSetting',
  currentSessionMode: 'mode',
  currentSessionAdvisor: 'advisor',
  currentSessionModel: 'model',
  currentSessionWorktree: 'worktreeSession',
  currentSessionPrNumber: 'prNumber',
  currentSessionPrUrl: 'prUrl',
  currentSessionPrRepository: 'prRepository',
} as const
