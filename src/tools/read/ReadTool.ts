import { buildTool, type CanUseToolFn, type Tool, type ToolUseContext } from '../kit/tool.js'
import type { AssistantMessage } from '../../engine/message-shapes/message.js'
import { isRemotePath, remoteIdentity } from '../../platform/remote-file-target/target.js'
import { displayAddressedTarget } from '../../platform/files/file.js'
import { getCwd } from '../../platform/files/cwd.js'
import { referenceReadDecision } from '../../integrations/resources/referencePaths.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { expandPath, hasControlCharacter } from '../../platform/files/path.js'
import { checkReadPermissionForTool } from '../../permissions/rules/filesystem.js'
import { windowsPathNeedsPermission } from '../../permissions/rules/windowsPath.js'
import { matchWildcardPattern } from '../../permissions/rules/shellRuleMatching.js'
import { resolveModelCapabilities } from '../../models/facts/capabilities.js'
import { DESCRIPTION, READ_TOOL_NAME, LINE_FORMAT_INSTRUCTION, renderPromptTemplate } from '../kit/names/fileRead.js'
import { parseRichFormatTarget } from './readRichFormats.js'
import { parseReadQueryTarget } from './readQueryTarget.js'
import { classifyReadTarget, readTargetPromptLines, readTargetsEnabled } from './readTarget.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './rows.js'
import { inputSchema, type Input, outputSchema } from './call/schema.js'
import { remoteAlso, splitPathRangeSelector } from './call/target.js'
import { validateReadInput } from './call/validate.js'
import { readFileCall } from './call/call.js'

export type { Input, Output } from './call/schema.js'
export { hasImageSignature } from './call/target.js'
export { imageReadCaptions, readImageWithTokenBudget } from './call/image.js'
export { MaxFileReadTokenExceededError } from './call/window.js'
export { registerFileReadListener, resultResolvedNames } from './call/results.js'
export { unresolvedConflictBlocks } from './call/serialize.js'
import { mapToolResultToToolResultBlockParam } from './call/resultBlock.js'
import { passedOver } from '../../platform/errors/passedOver.js'


export const ReadTool = buildTool({
  name: READ_TOOL_NAME,
  strict: true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: Infinity,
  straightQuoteInputs: ['file_path'],
  get inputSchema() {
    return inputSchema()
  },
  outputSchema,
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input?: Partial<Input>) {
    const summary = getToolUseSummary(input)
    return summary ? `Reading ${summary}` : 'Reading a file'
  },
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
  extractSearchText: () => '',
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  mapToolResultToToolResultBlockParam,
  getPath(input?: { file_path?: string }): string {
    const raw = input?.file_path
    if (!raw) return getCwd()
    const query = parseReadQueryTarget(raw)
    const source = query !== null ? query.source : raw
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source)) return source
    const { rawPath: withoutRange } = splitPathRangeSelector(source, expandPath(source))
    const rich = parseRichFormatTarget(withoutRange)
    if (rich?.subtarget !== undefined) return rich.containerPath
    return withoutRange
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const query = parseReadQueryTarget(input.file_path)
    if (query !== null) {
      const verdict = await readToolItself().checkPermissions(
        { ...input, file_path: query.source },
        context,
      )
      if (verdict.behavior === 'allow') {
        return { ...verdict, updatedInput: input }
      }
      return verdict
    }
    if (isRemotePath(input.file_path)) {
      const { remotePermission } = await import('../../platform/remote-files/bridge.js')
      return remotePermission(
        READ_TOOL_NAME,
        input.file_path,
        remoteAlso(input.file_path.trim()),
        input,
        context,
        'read',
      )
    }
    const permissionContext = context.getAppState().toolPermissionContext
    if (readTargetsEnabled() && classifyReadTarget(input.file_path).kind === 'resource') {
      const decision = await referenceReadDecision(
        READ_TOOL_NAME,
        input.file_path.trim(),
        input,
        permissionContext,
        getCwd(),
      )
      return decision ?? { behavior: 'allow', updatedInput: input }
    }
    return checkReadPermissionForTool(readToolItself(), input, permissionContext)
  },
  preparePermissionMatcher(input: Input) {
    const query = parseReadQueryTarget(input.file_path)
    const source = query !== null ? query.source : input.file_path
    return (rulePattern: string) => matchWildcardPattern(rulePattern, source)
  },
  backfillObservableInput(input: Input) {
    const query = parseReadQueryTarget(input.file_path)
    const source = query !== null ? query.source : input.file_path
    if (hasControlCharacter(source) || windowsPathNeedsPermission(source)) return
    let resolved: string
    if (isRemotePath(source)) {
      resolved = remoteIdentity(source)
    } else if (classifyReadTarget(source).kind !== 'file') {
      resolved = source
    } else {
      resolved = displayAddressedTarget(source, expandPath)
    }
    input.file_path = query !== null ? `${resolved}${query.suffix}` : resolved
  },
  async description() {
    let text = DESCRIPTION
    if (readTargetsEnabled()) {
      text +=
        ' Also reads directories (bounded listings), mercury:// resources, and routes http(s) URL targets to the WebFetch tool by name.'
    }
    try {
      const { readSteeringLine } = await import('../../sessions/project-intel/steering.js')
      const steering = readSteeringLine()
      if (steering) text += steering
    } catch (error) {
      passedOver(error)
    }
    return text
  },
  async prompt(options) {
    const media = resolveModelCapabilities(options?.model ?? getEngineModel()).media
    return renderPromptTemplate(
      LINE_FORMAT_INSTRUCTION,
      media,
      readTargetsEnabled() ? readTargetPromptLines() : undefined,
    )
  },
  validateInput(input: Input, context: ToolUseContext) {
    return validateReadInput(input, context)
  },
  call(
    input: Input,
    context: ToolUseContext,
    canUseTool?: CanUseToolFn,
    parentAssistantMessage?: AssistantMessage,
  ) {
    return readFileCall(input, context, canUseTool, parentAssistantMessage, readToolItself)
  },
})

function readToolItself(): Tool {
  return ReadTool
}

