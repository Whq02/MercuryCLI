import type { QuerySource } from '../../constants/querySource.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type { AgentDefinitionsResult } from '../../types/agent.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Tools } from '../../Tool.js'
import type { EffortValue } from '../../utils/effort.js'
import {
  buildRequestContextPlan,
  type RequestContextPlan,
} from '../../services/run/requestContextPlan.js'
import { processMainOwner } from '../../utils/run/resolveOwner.js'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import {
  analyzeContextUsage,
  type ContextData,
} from '../../services/context/analyzeContext.js'
import { getSourceDisplayName } from '../../utils/settings/constants.js'
import { formatTokens } from '../../utils/format.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const DEFAULT_QUERY_SOURCE: QuerySource = 'main_thread'

const FREE_SPACE_CATEGORY = 'Free space'
const AUTOCOMPACT_BUFFER_CATEGORY = 'Autocompact buffer'

function skipToolNamesFor(tools: Tools): ReadonlySet<string> {
  return new Set(
    tools.filter(tool => !Number.isFinite(tool.maxResultSizeChars)).map(tool => tool.name),
  )
}

export async function buildContextInspectionPlan(params: {
  messages: Message[]
  owner: OwnerKey
  engineModel: string
  effortValue?: EffortValue
  tools: Tools
  contentReplacementState: ContentReplacementState | undefined
  querySource?: QuerySource
}): Promise<RequestContextPlan> {
  return buildRequestContextPlan(
    {
      messages: params.messages,
      owner: params.owner,
      querySource: params.querySource ?? DEFAULT_QUERY_SOURCE,
      engineModel: params.engineModel,
      contentReplacementState: params.contentReplacementState,
      skipToolNames: skipToolNamesFor(params.tools),
      harnessContextPolicy: null,
      preserveBodies: true,
    },
    'inspect',
  )
}

export type CollectContextDataInput = Unbuilt

export async function collectContextData(input: CollectContextDataInput): Promise<ContextData> {
  const { options } = input
  const owner = input.owner ?? processMainOwner()
  const plan = await buildContextInspectionPlan({
    messages: input.messages,
    owner,
    engineModel: options.engineModel,
    effortValue: input.getAppState().effortValue,
    tools: options.tools,
    contentReplacementState: input.contentReplacementState,
    querySource: options.querySource,
  })
  const syntheticCarrier = {
    options: {
      isNonInteractiveSession: true,
      ...(options.customSystemPrompt !== undefined
        ? { customSystemPrompt: options.customSystemPrompt }
        : {}),
      ...(options.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: options.appendSystemPrompt }
        : {}),
    },
  } as Pick<ToolUseContext, 'options'>
  return analyzeContextUsage(
    plan.messages,
    options.engineModel,
    async () => input.getAppState().toolPermissionContext,
    options.tools,
    options.agentDefinitions,
    undefined,
    syntheticCarrier,
    undefined,
    plan.messages,
  )
}

export function renderContextUsageMarkdown(data: ContextData): string {
  return notBuilt('src/commands/context/context-noninteractive.ts:130')
}

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  return notBuilt('src/commands/context/context-noninteractive.ts:219')
}
