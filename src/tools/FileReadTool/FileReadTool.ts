import { buildTool, type CanUseToolFn, type Tool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { isRemotePath, remoteIdentity } from '../../services/remoteFiles/target.js'
import { displayAddressedTarget } from '../../utils/file.js'
import { getCwd } from '../../utils/cwd.js'
import { referenceReadDecision } from '../../services/resources/referencePaths.js'
import { getEngineModel } from '../../utils/model/model.js'
import { expandPath, hasControlCharacter } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { resolveModelCapabilities } from '../../utils/model/capabilities.js'
import { DESCRIPTION, FILE_READ_TOOL_NAME, LINE_FORMAT_INSTRUCTION, renderPromptTemplate } from './prompt.js'
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



export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  strict: true,
  straightQuoteInputs: ['file_path'],
  maxResultSizeChars: Infinity,
  get inputSchema() {
    return inputSchema()
  },
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context): Promise<ReturnType<typeof checkReadPermissionForTool>> {
    const query = parseReadQueryTarget(input.file_path)
    if (query !== null) {
      const decision = await FileReadTool.checkPermissions!({ ...input, file_path: query.source }, context)
      return decision.behavior === 'allow' ? { ...decision, updatedInput: input } : decision
    }
    if (isRemotePath(input.file_path)) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(FILE_READ_TOOL_NAME, input.file_path, remoteAlso(input.file_path.trim()), input, context, 'read')
    }
    const permissionContext = context.getAppState().toolPermissionContext
    if (readTargetsEnabled() && classifyReadTarget(input.file_path).kind === 'resource') {
      const judged = await referenceReadDecision(FileReadTool.name, input.file_path.trim(), input, permissionContext, getCwd())
      return judged ?? ({ behavior: 'allow', updatedInput: input } as ReturnType<typeof checkReadPermissionForTool>)
    }
    return checkReadPermissionForTool(FileReadTool, input, permissionContext)
  },
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input: Partial<Input> | undefined): string {
    const summary = input ? getToolUseSummary(input) : null
    return summary ? `Reading ${summary}` : 'Reading a file'
  },
  getPath(input: Partial<Input> | undefined): string {
    if (!input?.file_path) return getCwd()
    const source = parseReadQueryTarget(input.file_path)?.source ?? input.file_path
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source)) return source
    const named = splitPathRangeSelector(source, expandPath(source)).rawPath
    return parseRichFormatTarget(named)?.containerPath ?? named
  },
  backfillObservableInput(input: Input): void {
    const query = parseReadQueryTarget(input.file_path)
    const source = query?.source ?? input.file_path
    if (hasControlCharacter(source) || windowsPathNeedsPermission(source)) return
    const expanded = isRemotePath(source) ? remoteIdentity(source) : query !== null && classifyReadTarget(source).kind !== 'file' ? source : displayAddressedTarget(source, expandPath)
    input.file_path = query === null ? expanded : `${expanded}${query.suffix}`
  },
  preparePermissionMatcher(input: Input) {
    const source = parseReadQueryTarget(input.file_path)?.source ?? input.file_path
    return (rulePattern: string): boolean => matchWildcardPattern(rulePattern, source)
  },
  async description(): Promise<string> {
    let text = DESCRIPTION
    if (readTargetsEnabled()) {
      text +=
        ' Also reads directories (bounded listings), mercury:// resources, and routes http(s) URL targets to the WebFetch tool by name.'
      try {
        const { readSteeringLine } =
          require('../../services/projectIntel/steering.js') as typeof import('../../services/projectIntel/steering.js')
        const steering = readSteeringLine()
        if (steering) text += steering
      } catch {
      }
    }
    return text
  },
  async prompt(options?: { model?: string }): Promise<string> {
    const targetLines = readTargetsEnabled() ? readTargetPromptLines() : undefined
    const caps = resolveModelCapabilities(options?.model ?? getEngineModel())
    return renderPromptTemplate(
      LINE_FORMAT_INSTRUCTION,
      { pdf: caps.media.pdf, images: caps.media.images },
      targetLines,
    )
  },
  validateInput(input: Input, context: ToolUseContext) {
    return validateReadInput(input, context)
  },
  call(input: Input, context: ToolUseContext, canUseTool?: CanUseToolFn, parentMessage?: AssistantMessage) {
    return readFileCall(input, context, canUseTool, parentMessage, readToolItself)
  },
  mapToolResultToToolResultBlockParam,
  extractSearchText(): string {
    return ''
  },
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})

function readToolItself(): Tool {
  return FileReadTool
}

