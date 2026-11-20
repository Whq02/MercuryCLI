import { getSessionId } from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import type { QueryParams } from '../run-core/turn-machine.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import type { Message, MessageOrigin } from '../types/message.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { BatchedPrompt, QueuedCommand } from '../types/textInputTypes.js'
import type { FileStateCache } from '../utils/fileStateCache.js'
import { cloneFileStateCache } from '../utils/fileStateCache.js'
import type { ContentReplacementState } from '../utils/toolResultStorage.js'
import { headlessProfilerCheckpoint } from '../utils/headlessProfiler.js'
import { getSlashCommandToolSkills } from '../commands.js'
import { ensureExtensionsLoaded } from '../extensions/boot.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import { getCwd } from '../utils/cwd.js'
import { describeArtifactIdentity } from '../utils/artifactIdentity.js'
import type { RowDraft, SessionFacts } from './project.js'
import { ConversationState } from './turn/state.js'
import { turnRows } from './turn/turnRows.js'

export { closeRowOf } from './turn/close.js'

type CanUseTool = ToolUseContext extends never ? never : QueryParams['canUseTool']
type GetAppState = ToolUseContext['getAppState']
type SetAppState = ToolUseContext['setAppState']
type McpClients = ToolUseContext['options']['mcpClients']
type AgentDefinitions = ToolUseContext['options']['agentDefinitions']['activeAgents']

export type ConversationConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: McpClients
  agents: AgentDefinitions
  canUseTool: CanUseTool
  hostHoldsAsks?: boolean
  getAppState: GetAppState
  setAppState: SetAppState
  readFileState: FileStateCache
  contentReplacementState?: ContentReplacementState
  initialMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  maxTime?: { limitMs: number; at: number }
  jsonSchema?: Record<string, unknown>
  handleElicitation?: ToolUseContext['handleElicitation']
  partialRows?: boolean
  onLiveness?: () => void
  onToolRoundSettled?: (messages: readonly Message[]) => void
  setSDKStatus?: ToolUseContext['setSDKStatus']
  abortController?: AbortController
}

export type TurnOptions = {
  uuid?: string
  isMeta?: boolean
  operatorPrompt?: boolean
  mode?: 'prompt' | 'bash'
  batchUuids?: string[]
  batchTail?: BatchedPrompt[]
  initialNotices?: QueuedCommand[]
  origin?: MessageOrigin
  skipSlashCommands?: boolean
  syntaxInput?: string
  turn?: number
}

export async function sessionFactsOf(config: Pick<ConversationConfig, 'cwd' | 'tools' | 'mcpClients' | 'commands' | 'agents'>, model: string, mode: string, resumeOf?: string, toolsWithheld?: SessionFacts['toolsWithheld']): Promise<SessionFacts> {
  headlessProfilerCheckpoint('before_skills_extensions')
  const [skills, loaded] = await Promise.all([getSlashCommandToolSkills(config.cwd), ensureExtensionsLoaded({ cwd: config.cwd })])
  headlessProfilerCheckpoint('after_skills_extensions')
  const invocable = (entry: { userInvocable?: boolean }): boolean => entry.userInvocable !== false
  const build = describeArtifactIdentity(MACRO.VERSION).buildTree
  return {
    version: MACRO.VERSION,
    ...(build !== null ? { build } : {}),
    ...(resumeOf !== undefined ? { resumeOf } : {}),
    cwd: getCwd(),
    model,
    mode,
    tools: config.tools.map(tool => tool.name),
    ...(toolsWithheld !== undefined && toolsWithheld.length > 0 ? { toolsWithheld } : {}),
    mcpServers: config.mcpClients.map(client => ({ name: client.name, status: client.type })),
    commands: config.commands.filter(invocable).map(command => command.name),
    agents: (config.agents ?? []).map(agent => agent.agentType),
    skills: skills.filter(invocable).map(skill => skill.name),
    extensions: loaded.set.active.map(ext => ({ name: ext.manifest.name, path: ext.root, id: ext.entry.id })),
  }
}

export class Conversation {
  private readonly state: ConversationState

  constructor(config: ConversationConfig) {
    this.state = new ConversationState(config)
  }

  interrupt(): void {
    this.state.abortController.abort()
  }

  getMessages(): readonly Message[] {
    return this.state.mutableMessages
  }

  getReadFileState(): FileStateCache {
    return this.state.readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  setModel(model: string): void {
    this.state.userSpecifiedModel = model
  }

  turn(prompt: string | ContentBlockParam[], options?: TurnOptions): AsyncGenerator<RowDraft, void, unknown> {
    return turnRows.call(this.state, prompt, options)
  }
}

export type AskOptions = Omit<ConversationConfig, 'readFileState' | 'initialMessages'> & {
  prompt: string | ContentBlockParam[]
  promptUuid?: string
  isMeta?: boolean
  origin?: MessageOrigin
  skipSlashCommands?: boolean
  syntaxInput?: string
  batchUuids?: string[]
  batchTail?: BatchedPrompt[]
  initialNotices?: QueuedCommand[]
  promptMode?: 'prompt' | 'bash'
  operatorPrompt?: boolean
  turn?: number
  mutableMessages?: Message[]
  onTurnMessages?: (read: (() => readonly Message[]) | null) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
}

export async function* ask(options: AskOptions): AsyncGenerator<RowDraft, void, unknown> {
  const { prompt, promptUuid, isMeta, operatorPrompt, origin, skipSlashCommands, syntaxInput, batchUuids, batchTail, initialNotices, promptMode, turn, mutableMessages = [], onTurnMessages, getReadFileCache, setReadFileCache, ...config } = options
  const conversation = new Conversation({
    ...config,
    initialMessages: mutableMessages,
    readFileState: cloneFileStateCache(getReadFileCache()),
  })
  const seedLength = mutableMessages.length
  onTurnMessages?.(() => conversation.getMessages())
  try {
    yield* conversation.turn(prompt, {
      syntaxInput,
      uuid: promptUuid,
      isMeta,
      ...(operatorPrompt !== undefined ? { operatorPrompt } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(skipSlashCommands === true ? { skipSlashCommands: true } : {}),
      ...(promptMode !== undefined ? { mode: promptMode } : {}),
      ...(batchUuids !== undefined ? { batchUuids } : {}),
      ...(batchTail !== undefined ? { batchTail } : {}),
      ...(initialNotices !== undefined ? { initialNotices } : {}),
      ...(turn !== undefined ? { turn } : {}),
    })
  } finally {
    setReadFileCache(conversation.getReadFileState())
    const settled = conversation.getMessages()
    const seedIntact = seedLength === 0 || (settled.length >= seedLength && settled[seedLength - 1] === mutableMessages[seedLength - 1])
    if (seedIntact) {
      if (settled.length > seedLength) mutableMessages.push(...settled.slice(seedLength))
    } else {
      mutableMessages.length = 0
      mutableMessages.push(...settled)
    }
    onTurnMessages?.(null)
  }
}
