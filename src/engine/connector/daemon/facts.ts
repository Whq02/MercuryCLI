import { existsSync } from 'node:fs'
import type { PermissionMode } from '../../../permissions/rules/permissions.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import type { SpawnSwitchFacts } from '../../../daemon/switchboard/spawnSwitches.js'
import { readSessionFacts, sessionFactsPath, type OpenaiCatalogueFactV1, type SessionFactsV1 } from '../seatProjections.js'
import type { AdvisorFactsV1, EditOutcomeRowV1, McpRosterV1, ModelFactsV1, SeatIdentityV1, SkillsRosterV1, UsageFactsV1, WorkspaceFactsV1 } from '../types.js'
import type { BoardViewSnapshot } from '../../../crew/board/contracts.js'
import { emitAll, type Listeners } from './shared.js'

const BOTH_SWITCHES_ON: SpawnSwitchFacts = Object.freeze({
  subagents: Object.freeze({ on: true, source: 'default' as const }),
  workflows: Object.freeze({ on: true, source: 'default' as const }),
})

interface FactsNeeds {
  sessionId(): string
  recordModel(): string | undefined
  recordEffort(): string | undefined
  recordWorkspace(): { cwd: string; projectRoot: string }
  awaitingRunner(): boolean
  adoptUsage(usage: UsageFactsV1 | undefined): void
  adoptOpenaiCatalogue(list: OpenaiCatalogueFactV1): void
}

export class FactsPart {
  private facts: SessionFactsV1 | null
  private factsBusy: boolean
  private seedUnread = true
  private readonly modelListeners: Listeners = new Set()
  private readonly permissionListeners: Listeners = new Set()
  private readonly pendingSwarmBoard: BoardViewSnapshot = Object.freeze({ on: true, events: [], snapshot: 0, omitted: 0, peerTurns: 0 })

  constructor(private readonly needs: FactsNeeds) {
    this.facts = readSessionFacts(needs.sessionId())
    this.factsBusy = this.facts?.busy ?? false
  }

  read(): SessionFactsV1 | null {
    return this.facts
  }

  busy(): boolean {
    return this.factsBusy
  }

  dropBusy(): void {
    this.factsBusy = false
  }

  streamIdleTimeoutMs(): number | undefined {
    return typeof this.facts?.streamIdleTimeoutMs === 'number' ? this.facts.streamIdleTimeoutMs : undefined
  }

  strip(): void {
    if (this.facts !== null) this.facts = { ...this.facts, busy: false, work: [], mission: [], samples: [] }
  }

  seedAgain(): void {
    this.facts = readSessionFacts(this.needs.sessionId()) ?? this.facts
    this.seedUnread = true
  }

  dropRowsWithNoFile(): boolean {
    if (this.facts !== null && ((this.facts.work?.length ?? 0) > 0 || (this.facts.mission?.length ?? 0) > 0 || (this.facts.samples?.length ?? 0) > 0) && !existsSync(sessionFactsPath(this.needs.sessionId()))) {
      this.facts = { ...this.facts, work: [], mission: [], samples: [] }
      return true
    }
    return false
  }

  take(next: SessionFactsV1, held: SessionFactsV1): { prev: SessionFactsV1 | null; modelMoved: boolean; modeMoved: boolean } {
    const prev = this.facts
    this.facts = held
    const modelMoved =
      prev === null ||
      prev.model.effective !== next.model.effective ||
      prev.model.setting !== next.model.setting ||
      prev.pendingModel !== next.pendingModel ||
      prev.effort !== next.effort ||
      prev.effortSent !== next.effortSent
    const modeMoved = prev === null || prev.permissionMode !== next.permissionMode
    return { prev, modelMoved, modeMoved }
  }

  handOn(next: SessionFactsV1, prev: SessionFactsV1 | null): void {
    this.needs.adoptUsage(next.usage)
    if (next.openaiCatalogue !== undefined && (this.seedUnread || next.openaiCatalogue.fetchedAtMs !== prev?.openaiCatalogue?.fetchedAtMs)) {
      this.needs.adoptOpenaiCatalogue(next.openaiCatalogue)
    }
    this.seedUnread = false
  }

  followBusy(): boolean {
    if (this.facts !== null) this.factsBusy = this.facts.busy
    return this.factsBusy
  }

  wake(modelMoved: boolean, modeMoved: boolean): void {
    if (modelMoved) emitAll(this.modelListeners, 'model')
    if (modeMoved) emitAll(this.permissionListeners, 'permission')
    if (!modelMoved) emitAll(this.modelListeners, 'model')
  }

  wakeModel(): void {
    emitAll(this.modelListeners, 'model')
  }

  transcriptStoreFailing(): string | null {
    return this.facts?.transcriptStoreFailing ?? null
  }

  modelFacts(): ModelFactsV1 {
    const retained = this.needs.awaitingRunner() ? this.needs.recordModel() : undefined
    const retainedEffort = this.needs.awaitingRunner() ? this.needs.recordEffort() : undefined
    const effective = retained ?? this.facts?.model.effective ?? this.needs.recordModel() ?? getEngineModel()
    const effectiveSource: 'live' | 'record' | 'ambient' =
      this.facts !== null && !this.needs.awaitingRunner() ? 'live' : this.facts !== null || this.needs.recordModel() !== undefined ? 'record' : 'ambient'
    return {
      effective,
      effectiveSource,
      main: effective,
      setting: retained ?? this.facts?.model.setting ?? this.needs.recordModel() ?? null,
      sessionPin: retained ?? this.facts?.model.setting ?? this.needs.recordModel() ?? null,
      effort: retainedEffort ?? this.facts?.effort ?? this.needs.recordEffort() ?? null,
      ...(!this.needs.awaitingRunner() && this.facts?.effortSent !== undefined ? { effortSent: this.facts.effortSent } : {}),
      pendingSwitch: this.facts?.pendingModel !== undefined && this.facts.pendingModel !== null ? { setting: this.facts.pendingModel } : null,
    }
  }

  subscribeModel(listener: () => void): () => void {
    this.modelListeners.add(listener)
    return () => {
      this.modelListeners.delete(listener)
    }
  }

  showModel(target: string, busy: boolean): void {
    if (this.facts !== null) {
      this.facts = busy
        ? { ...this.facts, pendingModel: target }
        : { ...this.facts, model: { effective: target, setting: target }, pendingModel: null }
      emitAll(this.modelListeners, 'model')
    }
  }

  showEffort(level: string, busy: boolean): void {
    if (this.facts !== null && !busy) {
      this.facts = { ...this.facts, effort: level }
      emitAll(this.modelListeners, 'model')
    }
  }

  usage(): UsageFactsV1 {
    return (
      this.facts?.usage ?? {
        totalCostUSD: 0,
        totalAPIDurationMs: 0,
        totalDurationMs: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadInputTokens: 0,
        totalCacheCreationInputTokens: 0,
        hasUnknownModelCost: false,
      }
    )
  }

  identity(): SeatIdentityV1 {
    return this.facts?.identity ?? { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }
  }

  editOutcomes(): EditOutcomeRowV1[] | null {
    return this.facts?.editOutcomes ?? null
  }

  skillsRoster(): SkillsRosterV1 {
    return { skills: this.facts?.skills ?? [] }
  }

  mcpRoster(): McpRosterV1 {
    return { clients: this.facts?.mcp ?? [] }
  }

  spawnSwitches(): SpawnSwitchFacts {
    return this.facts?.spawnSwitches ?? BOTH_SWITCHES_ON
  }

  advisorFacts(): AdvisorFactsV1 | null {
    return this.facts?.advisor ?? null
  }

  swarmBoard(): BoardViewSnapshot | null {
    return this.facts?.swarm ?? null
  }

  pendingSwarm(): BoardViewSnapshot {
    return this.pendingSwarmBoard
  }

  subscribePermissionMode(listener: () => void): () => void {
    this.permissionListeners.add(listener)
    return () => {
      this.permissionListeners.delete(listener)
    }
  }

  showMode(mode: PermissionMode): SessionFactsV1 | null {
    const before = this.facts
    if (this.facts !== null) {
      this.facts = { ...this.facts, permissionMode: mode }
      emitAll(this.permissionListeners, 'permission')
    }
    return before
  }

  restoreMode(before: SessionFactsV1 | null, mode: PermissionMode): void {
    if (this.facts !== null && this.facts.permissionMode === mode) {
      this.facts = before !== null ? before : this.facts
      emitAll(this.permissionListeners, 'permission')
    }
  }

  workspace(): WorkspaceFactsV1 {
    if (this.facts !== null) return this.facts.workspace
    const { cwd, projectRoot } = this.needs.recordWorkspace()
    return { cwd, originalCwd: cwd, projectRoot }
  }
}
