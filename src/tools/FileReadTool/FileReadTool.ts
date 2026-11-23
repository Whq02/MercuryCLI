import { buildTool, type CanUseToolFn, type Tool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { isRemotePath, remoteIdentity } from '../../utils/remoteFiles/target.js'
import { displayAddressedTarget } from '../../utils/file.js'
import { getCwd } from '../../utils/cwd.js'
import { referenceReadDecision } from '../../services/resources/referencePaths.js'
import { getEngineModel } from '../../services/model/model.js'
import { expandPath, hasControlCharacter } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { resolveModelCapabilities } from '../../utils/model/capabilities.js'
import { DESCRIPTION, FILE_READ_TOOL_NAME, LINE_FORMAT_INSTRUCTION, renderPromptTemplate } from '../../constants/tools/fileRead.js'
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
} from './UI.js'
import { inputSchema, type Input, outputSchema } from './read/schema.js'
import { remoteAlso, splitPathRangeSelector } from './read/target.js'
import { validateReadInput } from './read/validate.js'
import { readFileCall } from './read/call.js'

export type { Input, Output } from './read/schema.js'
export { hasImageSignature } from './read/target.js'
export { imageReadCaptions, readImageWithTokenBudget } from './read/image.js'
export { MaxFileReadTokenExceededError } from './read/window.js'
export { registerFileReadListener, resultResolvedNames } from './read/results.js'
export { unresolvedConflictBlocks } from './read/serialize.js'
import { mapToolResultToToolResultBlockParam } from './read/resultBlock.js'
import { passedOver } from '../../utils/passedOver.js'


export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
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
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(
        FILE_READ_TOOL_NAME,
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
        FILE_READ_TOOL_NAME,
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
      const { readSteeringLine } = await import('../../services/projectIntel/steering.js')
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
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
  ) {
    return readFileCall(input, context, canUseTool, parentAssistantMessage, readToolItself)
  },
})

function readToolItself(): Tool {
  return FileReadTool
}

