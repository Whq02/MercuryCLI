import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'


export type BackendType = 'tmux' | 'iterm2' | 'in-process'

export type PaneBackendType = 'tmux' | 'iterm2'

export type PaneId = string

export type CreatePaneResult = {
  paneId: PaneId
  isFirstTeammate: boolean
}

export type BackendDetectionResult = {
  backend: PaneBackend
  isNative: boolean
  needsIt2Setup?: boolean
}

export function isPaneBackend(type: BackendType): type is 'tmux' | 'iterm2' {
  return type === 'tmux' || type === 'iterm2'
}

export type PaneBackend = {
  readonly type: BackendType
  readonly displayName: string
  readonly supportsHideShow: boolean
  isAvailable(): Promise<boolean>
  isRunningInside(): Promise<boolean>
  createTeammatePaneInSwarmView(name: string, color: AgentColorName): Promise<CreatePaneResult>
  sendCommandToPane(paneId: PaneId, command: string, useExternalSession?: boolean): Promise<void>
  setPaneBorderColor(paneId: PaneId, color: AgentColorName, useExternalSession?: boolean): Promise<void>
  setPaneTitle(
    paneId: PaneId,
    name: string,
    color: AgentColorName,
    useExternalSession?: boolean,
  ): Promise<void>
  enablePaneBorderStatus(windowTarget?: string, useExternalSession?: boolean): Promise<void>
  rebalancePanes(windowTarget: string, hasLeader: boolean): Promise<void>
  killPane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>
  isPaneAlive?(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>
  hidePane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>
  showPane(paneId: PaneId, targetWindowOrPane: string, useExternalSession?: boolean): Promise<boolean>
}

export type TeammateIdentity = {
  name: string
  teamName: string
  color?: AgentColorName
  planModeRequired?: boolean
}

export type TeammateSpawnConfig = TeammateIdentity & {
  prompt: string
  cwd: string
  model?: string
  systemPrompt?: string
  systemPromptMode?: 'default' | 'replace' | 'append'
  worktreePath?: string
  parentSessionId: string
  permissions?: { allowedTools?: string[] }
  allowPermissionPrompts?: boolean
}

export type TeammateSpawnResult = {
  success: boolean
  agentId: string
  error?: string
  abortController?: AbortController
  taskId?: string
  paneId?: PaneId
}

export type TeammateMessage = {
  text: string
  from: string
  color?: string
  timestamp?: string
  summary?: string
}

export type TeammateExecutor = {
  readonly type: BackendType
  isAvailable(): Promise<boolean>
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>
  sendMessage(agentId: string, message: TeammateMessage): Promise<void>
  terminate(agentId: string, reason?: string): Promise<boolean>
  kill(agentId: string): Promise<boolean>
  isActive(agentId: string): Promise<boolean>
}
