import { getCwd } from '../../../platform/files/cwd.js'
import { getInstructionSliceForProfile } from '../../../sessions/instructions/instructionFiles.js'
import { isInstructionProfile, resolveRequestedInstructionProfile } from '../../../sessions/instructions/profile.js'
import type { InstructionProfile } from '../../../sessions/instruction-contracts/contracts.js'
import { INSTRUCTIONS_CONTEXT_KEY } from '../../../engine/attachments/userContextReminder.js'
import type { Message } from '../../../engine/message-shapes/message.js'
import type { AgentId } from '../../../sessions/transcripts/ids.js'
import type { Tool, ToolUseContext } from '../../kit/tool.js'
import type { MCPServerConnection } from '../../../integrations/mcp-shapes/mcpServerRecords.js'
import { getSystemContext, getUserContext, isInstructionDiscoveryDisabled } from '../../../engine/requestContext.js'
import { createFileStateCacheWithSizeLimit } from '../../../platform/files/fileStateCache.js'
import { registerAgentHooks } from '../../../integrations/event-hooks/registerFrontmatterHooks.js'
import { fireHooks } from '../../../integrations/event-hooks/fire.js'
import { hasHooksFor } from '../../../integrations/event-hooks/matching.js'
import { hookMayMeetCopy, worktreeHoldOf } from './worktreeReadiness.js'
import { HOOK_EVENTS } from '../../../integrations/event-hooks/contract.js'
import { hookRowsOfResult } from '../../../integrations/event-hooks/rows.js'
import { createAttachmentMessage } from '../../../engine/attachments/attachments.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../kit/names/syntheticOutput.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { createUserMessage, extractTextContent } from '../../../engine/messages/messages.js'
import { getAgentTranscriptPath, readAgentMetadata, registerAgentTranscriptDestination, writeAgentMetadata } from '../../../sessions/transcripts/sessionStorage.js'
import { swarmBrief } from '../../../crew/board/seam.js'
import { asSystemPrompt } from '../../../engine/system-prompt/systemPromptType.js'
import { isRestrictedToExtensionsOnly, isSourceAdminTrusted } from '../../../platform/settings/extensionOnlyPolicy.js'
import type { MercuryAgentSeat } from '../../../engine/system-prompt/mercuryContract.js'
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js'
import { REVIEW_BRIEF } from '../reviewerPolicy.js'
import { agentPostureOf, agentToolsOf, childContextOf, runStartRecordOf } from './setup.js'
import { type AgentRun, sdkStatusOf } from './watch.js'
import type { connectAgentMcpServers, landAgentTranscriptRows, resolveAgentEffort, RecoveryAccountant, RunAgentParams } from '../runCrewmate.js'

type PrepareNeeds = Pick<RunAgentParams, 'name' | 'description' | 'override' | 'agentDefinition' | 'instructionProfileOverride' | 'toolUseContext' | 'isAsync' | 'canShowPermissionPrompts' | 'allowedTools' | 'effortOverride' | 'useExactTools' | 'promptMessages' | 'cwd' | 'availableTools' | 'structuredOutputSpec' | 'worktreePath' | 'thinkingConfigOverride' | 'querySource' | 'contentReplacementState' | 'seatHolder' | 'onWait' | 'preserveToolUseResults' | 'onQueryProgress' | 'onCacheSafeParams' | 'model' | 'launchedAt'> & {
  agentId: AgentId
  swarm: boolean
  abortController: AbortController
  slimAgentGateOn: () => boolean
  withoutInstructionBlob: (context: { [k: string]: string }) => { [k: string]: string }
  readOnlyScout: boolean
  resolveAgentEffort: typeof resolveAgentEffort
  hookScope: { sessionId: string; crewmateId: AgentId }
  resolvedAgentModel: string
  rootSetAppState: ToolUseContext['setAppState']
  preloadSkills: (definition: AgentDefinition, toolUseContext: ToolUseContext) => Promise<Message[]>
  connectAgentMcpServers: typeof connectAgentMcpServers
  mcp: { clients: MCPServerConnection[]; tools: Tool[]; cleanup: () => Promise<void> }
  reviewReceipt: string | undefined
  buildAgentSystemPrompt: (definition: AgentDefinition, toolUseContext: ToolUseContext, resolvedAgentModel: string, enabledToolNames: ReadonlySet<string>, agentId: AgentId, seat: MercuryAgentSeat) => Promise<string[]>
  seat: MercuryAgentSeat
  isFork: boolean
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>
  childContextRef: { current: ToolUseContext | undefined }
  agentKind: NonNullable<RunAgentParams['agentKind']>
  run: AgentRun
  accountant: RecoveryAccountant
  touchThrough: (declaredMs: number) => void
  initialMessages: Message[]
  landAgentTranscriptRows: typeof landAgentTranscriptRows
  resolvedEffort: ReturnType<typeof resolveAgentEffort>
}

export async function prepareAgentRun({ agentId, name, description, swarm, abortController, override, agentDefinition, slimAgentGateOn, withoutInstructionBlob, instructionProfileOverride, readOnlyScout, toolUseContext, isAsync, canShowPermissionPrompts, allowedTools, effortOverride, useExactTools, resolveAgentEffort, hookScope, promptMessages, resolvedAgentModel, cwd, rootSetAppState, preloadSkills, connectAgentMcpServers, mcp, availableTools, structuredOutputSpec, reviewReceipt, worktreePath, buildAgentSystemPrompt, seat, thinkingConfigOverride, isFork, querySource, readFileState, contentReplacementState, childContextRef, agentKind, seatHolder, onWait, preserveToolUseResults, run, onQueryProgress, accountant, touchThrough, initialMessages, onCacheSafeParams, landAgentTranscriptRows, model, launchedAt, resolvedEffort }: PrepareNeeds) {
  let userContext = override?.userContext ?? (await getUserContext())
  const systemContext = { ...(override?.systemContext ?? (await getSystemContext())) }

  if (
    agentDefinition.omitProjectInstructions &&
    slimAgentGateOn() &&
    !override?.userContext
  ) {
    userContext = withoutInstructionBlob(userContext)
  }

  const sessionResolution = resolveRequestedInstructionProfile()
  const requestedProfile =
    (instructionProfileOverride &&
    isInstructionProfile(instructionProfileOverride)
      ? instructionProfileOverride
      : undefined) ??
    agentDefinition.instructionProfile ??
    sessionResolution.profile
  let instructionCapture:
    | { profile: InstructionProfile; digest: string }
    | undefined
  if (
    !agentDefinition.omitProjectInstructions &&
    !isInstructionDiscoveryDisabled() &&
    isInstructionProfile(requestedProfile)
  ) {
    if (requestedProfile !== sessionResolution.profile) {
      try {
        const slice = await getInstructionSliceForProfile(requestedProfile)
        if (override?.userContext === undefined) {
          userContext = { ...userContext }
          if (slice.instructionPrompt) {
            userContext[INSTRUCTIONS_CONTEXT_KEY] = slice.instructionPrompt
          } else {
            userContext = withoutInstructionBlob(userContext)
          }
        }
        instructionCapture = {
          profile: requestedProfile,
          digest: slice.bundle.bundleDigest,
        }
      } catch (error) {
        logForDebugging(
          `runAgent: instruction slice for '${requestedProfile}' failed: ${errorMessage(error)}`,
        )
      }
    } else {
      instructionCapture = { profile: requestedProfile, digest: '' }
    }
  }

  if (readOnlyScout) {
    for (const key of Object.keys(systemContext)) {
      if (/gitstatus/i.test(key)) delete systemContext[key]
    }
  }

  const { posture, agentGetAppState } = agentPostureOf({ toolUseContext, agentDefinition, isAsync, canShowPermissionPrompts, allowedTools, effortOverride, useExactTools, resolveAgentEffort })

  const hookContextMessages: Message[] = []
  try {
    if (agentDefinition.hooks !== undefined || HOOK_EVENTS.some(event => hookMayMeetCopy(event) && hasHooksFor(event, hookScope, toolUseContext.getAppState()))) await worktreeHoldOf({ agentId, abortController })
    const started = await fireHooks(
      'crewmate.start',
      { ...(name !== undefined ? { name } : {}), prompt: promptMessages.map(message => {
        if (message.type !== 'user' && message.type !== 'assistant') return ''
        const content = message.message.content
        return typeof content === 'string' ? content : extractTextContent(content, '\n')
      }).filter(Boolean).join('\n'), model: resolvedAgentModel, directory: cwd ?? getCwd() },
      { scope: hookScope, signal: abortController.signal, toolUseContext, crewmateType: agentDefinition.agentType },
    )
    for (const row of hookRowsOfResult(started)) hookContextMessages.push(createAttachmentMessage(row) as Message)
    for (const context of started.answer.contexts) hookContextMessages.push(createUserMessage({ content: context, isMeta: true }))
  } catch (error) {
    logForDebugging(`runAgent: the crewmate.start hooks failed: ${errorMessage(error)}`)
  }

  if (
    agentDefinition.hooks &&
    (!isRestrictedToExtensionsOnly('hooks') ||
      isSourceAdminTrusted(agentDefinition.source))
  ) {
    registerAgentHooks(rootSetAppState, hookScope, agentDefinition.hooks, agentDefinition.agentType)
  }

  const skillMessages = await preloadSkills(agentDefinition, toolUseContext)

  const agentMcp = await connectAgentMcpServers(
    agentDefinition.mcpServers,
    agentDefinition,
    [
      ...toolUseContext.options.mcpClients,
      ...(toolUseContext.getAppState?.().mcp.clients ?? []),
    ],
  )
  mcp.clients = agentMcp.clients
  mcp.tools = agentMcp.tools
  mcp.cleanup = agentMcp.cleanup

  const tools = agentToolsOf({ availableTools, swarm, mcp, structuredOutputSpec, reviewReceipt, worktreePath, readOnlyScout })

  const enabledToolNames = new Set(tools.map(tool => tool.name))
  const systemPrompt: string[] =
    override?.systemPrompt ??
    (await buildAgentSystemPrompt(
      agentDefinition,
      toolUseContext,
      resolvedAgentModel,
      enabledToolNames,
      agentId,
      seat,
    ))
  if (reviewReceipt !== undefined) systemPrompt.push(REVIEW_BRIEF, `Your declared review receipt is ${reviewReceipt}. Only its Review section is editable. Run bun verification under scripts, bash suite runners, or bun run typecheck in the frozen worktree; a with-box-lock.sh wrapper with a literal temporary BASE is accepted. Verification commands have a fresh temporary home and filesystem confinement: sources and the report are read-only, temporary results are writable. Ordinary permission checks still apply; unavailable confinement refuses without running.`)
  if (structuredOutputSpec !== undefined) {
    systemPrompt.push(
      `When the task is COMPLETE, deliver the final answer by calling the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool with data matching its schema${
        structuredOutputSpec.mode === 'strict'
          ? ' — the dispatch FAILS without a conforming call'
          : ' — prose alone is accepted but the caller loses the parsed data'
      }. Prose before the call is welcome; the structured payload is the contract.`,
    )
  }
  const swarmWords = swarm ? swarmBrief(agentId, override?.swarmBrief) : null
  if (swarmWords !== null) systemPrompt.push(swarmWords)

  const { childContext, thinkingOverride } = childContextOf({ toolUseContext, posture, thinkingConfigOverride, agentId, agentDefinition, abortController, agentGetAppState, isAsync, tools, resolvedAgentModel, mcp, isFork, querySource, readFileState, contentReplacementState, childContextRef, worktreePath, agentKind, seatHolder, description, onWait, preserveToolUseResults })
  childContext.setSDKStatus = sdkStatusOf(run, { onQueryProgress, accountant, touchThrough })

  const messages: Message[] = [
    ...initialMessages,
    ...hookContextMessages,
    ...skillMessages,
  ]

  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: asSystemPrompt(systemPrompt),
      userContext,
      systemContext,
      toolUseContext: childContext,
      forkContextMessages: messages,
    })
  }

  try {
    registerAgentTranscriptDestination(
      agentId,
      getAgentTranscriptPath(agentId),
    )
  } catch (error) {
    logForDebugging(`runAgent: the transcript of crewmate ${agentId} could not be registered, so its rows may land beside the session's: ${errorMessage(error)}`)
    passedOver(error)
  }
  await landAgentTranscriptRows(messages, agentId)

  let latestRecord: Awaited<ReturnType<typeof readAgentMetadata>> = null
  let recordUnread = false
  try {
    latestRecord = await readAgentMetadata(agentId)
  } catch (error) {
    recordUnread = true
    logForDebugging(`runAgent: the record of crewmate ${agentId} could not be read, so it is left as it is and this launch is not recorded: ${errorMessage(error)}`)
    passedOver(error)
  }
  if (!recordUnread) {
    await writeAgentMetadata(agentId, runStartRecordOf({ latestRecord, model, effortOverride, agentDefinition, swarm, worktreePath, cwd, description, name, launchedAt, swarmWords, thinkingOverride, structuredOutputSpec, instructionCapture, resolvedAgentModel, resolvedEffort })).catch((error: unknown) => {
      logForDebugging(`runAgent: the record of crewmate ${agentId} could not be saved, so a resume falls back to the default agent type, model and directory: ${errorMessage(error)}`)
    })
  }
  return { userContext, systemContext, systemPrompt, childContext, messages }
}
