import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { fileGeneration } from '../../services/changeTransaction/seenLines.js'
import { mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { ideReadTextAvailable } from '../../services/acp/ideToolBridge.js'
import type { RemoteRead } from '../../services/remoteFiles/bridge.js'
import { isRemotePath, remoteIdentity, remoteReadGeneration } from '../../services/remoteFiles/target.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import { hasBinaryExtension } from '../../constants/files.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { displayAddressedTarget } from '../../utils/file.js'
import { formatFileSize } from '../../utils/format.js'
import { getCwd } from '../../utils/cwd.js'
import { referenceReadDecision, referenceReadPaths } from '../../services/resources/referencePaths.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { mapNotebookCellsToToolResult } from '../../utils/notebook.js'
import { controlCharacterPathRefusal, expandPath, hasControlCharacter } from '../../utils/path.js'
import { checkReadPermissionForTool, matchingRuleForInput, readDenialFilter } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { recogniseImage, renderOcr } from '../../utils/ocr.js'
import { extractMediaTranscript, mediaFileFormat } from '../../services/voice/fileTranscript.js'
import { isPDFExtension, parsePDFPageRange } from '../../utils/pdfUtils.js'
import { resolveModelCapabilities } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../utils/model/model.js'
import { FileTooLargeError } from '../../utils/readFileInRange.js'
import { notAFileKind, notAFileRefusal, readRegularFile } from '../../utils/regularFile.js'
import type { CanUseToolFn } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getDefaultFileReadingLimits, type FileReadingLimits } from './limits.js'
import { resultRoomFor } from '../../services/run/resultRoom.js'
import { DESCRIPTION, FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB, LINE_FORMAT_INSTRUCTION, MAX_PDF_PAGES_PER_REQUEST, renderPromptTemplate } from './prompt.js'
import { isRichFormatReadable, parseRichFormatTarget, RICH_CONTAINER_MAX_BYTES } from './readRichFormats.js'
import { cacheKeys } from '../../utils/fileStateCache.js'
import { jsonQueryDiscovery, jsonQueryName, parseReadQueryTarget } from './readQueryTarget.js'
import {
  classifyReadTarget,
  isDirectoryTarget,
  readTargetPromptLines,
  readTargetsEnabled,
  renderDirectoryNames,
  renderDirectoryTarget,
  renderDirectoryUnavailable,
  renderResourceTarget,
  renderUrlDelegation,
} from './readTarget.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'
import { MAX_RANGES_PER_READ, inputSchema, selectedPages, selectedCrop, type Input, type Output, outputSchema, type LaneResult } from './read/schema.js'
import { resultResolvedNames, resultPreRenderedBody, resultWithoutProfileHint } from './read/results.js'
import { cyberRiskReminderFor, takeReminder, cyberRiskReminderForCurrentModel } from './read/reminder.js'
import { MaxFileReadTokenExceededError } from './read/window.js'
import { readRangeElsewhere } from './read/source.js'
import { remoteRangeSelector, remoteRichTarget, remoteAlso, renamed, isBlockingDevicePath, IMAGE_EXTENSIONS, hasImageSignature, extensionOf, resolveCanonicalNearMissPath, alternateScreenshotPath, friendlyNotFoundError, parseLineRangesList, splitPathRangeSelector } from './read/target.js'
import { cropImageBuffer, readImageLane } from './read/image.js'
import { readNotebookLane } from './read/notebookLane.js'
import { readPdfLane } from './read/pdfLane.js'
import { readMultiRangeTextLane } from './read/multiRangeLane.js'
import { readRichFormatLane } from './read/richFormatLane.js'
import { readTextLane } from './read/textLane.js'
import { serializeTextResult } from './read/serialize.js'

export type { Input, Output } from './read/schema.js'
export { hasImageSignature } from './read/target.js'
export { imageReadCaptions, readImageWithTokenBudget } from './read/image.js'
export { MaxFileReadTokenExceededError } from './read/window.js'
export { registerFileReadListener, resultResolvedNames } from './read/results.js'
export { unresolvedConflictBlocks } from './read/serialize.js'



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
  async validateInput(input: Input, context: ToolUseContext) {
    const query = parseReadQueryTarget(input.file_path)
    if (query !== null) input = { ...input, file_path: query.source }
    if (input.scale !== undefined && selectedCrop(input.crop) === undefined) return { result: false as const, message: 'scale requires an image crop.', errorCode: 1 }
    if (input.lossless && (input.outline || (!(input.ranges?.length) && (input.offset === undefined || input.limit === undefined)))) {
      return { result: false as const, message: 'lossless requires offset + limit or ranges, without outline.', errorCode: 1 }
    }
    const pathRefusal = controlCharacterPathRefusal(input.file_path)
    if (pathRefusal !== null) {
      return { result: false as const, message: pathRefusal, errorCode: 1 }
    }
    const pages = selectedPages(input.pages)
    let parsedRange: { firstPage: number; lastPage: number } | null = null
    if (pages !== undefined) {
      parsedRange = parsePDFPageRange(pages)
      if (parsedRange === null) {
        return {
          result: false as const,
          message: `Invalid pages parameter: "${input.pages}". Accepted formats are a single page ("3") or an inclusive range ("1-5"). Pages are 1-indexed.`,
          errorCode: 7,
        }
      }
      const width = parsedRange.lastPage - parsedRange.firstPage + 1
      if (!Number.isFinite(width) || width > MAX_PDF_PAGES_PER_REQUEST) {
        return {
          result: false as const,
          message: `The requested page range spans more than the ${MAX_PDF_PAGES_PER_REQUEST}-page per-request maximum. Request at most ${MAX_PDF_PAGES_PER_REQUEST} pages at a time.`,
          errorCode: 8,
        }
      }
    }

    if (input.ranges !== undefined) {
      const parsed = parseLineRangesList(input.ranges)
      if (!Array.isArray(parsed)) {
        return {
          result: false as const,
          message: parsed.tooMany
            ? `Too many line ranges in ranges (maximum ${MAX_RANGES_PER_READ} ranges per Read call).`
            : `Invalid line range "${parsed.invalid}" in ranges. Accepted formats are "N", "N-M", "N+K", "N-", or "-N" (last N lines).`,
          errorCode: 7,
        }
      }
    }

    if (isRemotePath(input.file_path)) {
      const { remoteValidation } = await import('../../services/remoteFiles/bridge.js')
      return remoteValidation(input.file_path, remoteAlso(input.file_path.trim()), 'read', 'Reading', context, true)
    }

    if (readTargetsEnabled()) {
      const target = classifyReadTarget(input.file_path)
      if (target.kind === 'resource') {
        const rules = context.getAppState().toolPermissionContext
        for (const named of await referenceReadPaths(input.file_path.trim(), getCwd())) {
          const denied = matchingRuleForInput(named, rules, 'read', 'deny')
          if (denied) return { result: false as const, message: ruleSentence(`Reading ${named}`, 'deny', denied), errorCode: 1 }
        }
      }
      if (target.kind === 'resource' || target.kind === 'url') return { result: true as const }
    }

    const rawExpanded = expandPath(input.file_path)
    const splitTarget = splitPathRangeSelector(input.file_path, rawExpanded)
    const richTarget = parseRichFormatTarget(splitTarget.rawPath)
    const expanded = richTarget !== null ? expandPath(richTarget.containerPath) : splitTarget.expandedPath
    const targetRawPath = richTarget !== null ? richTarget.containerPath : splitTarget.rawPath

    const permissionContext = context.getAppState().toolPermissionContext
    const readDeny = matchingRuleForInput(expanded, permissionContext, 'read', 'deny')
    if (readDeny) {
      return {
        result: false as const,
        message: ruleSentence(`Reading ${targetRawPath}`, 'deny', readDeny),
        errorCode: 1,
      }
    }

    if (windowsPathNeedsPermission(targetRawPath)) return { result: true as const }

    if (isBlockingDevicePath(expanded)) {
      return {
        result: false as const,
        message: `Reading ${targetRawPath} is not allowed: it is a device file that would hang or produce infinite output.`,
        errorCode: 9,
      }
    }

    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext, canUseTool?: unknown, parentMessage?: unknown) {
    const ownRead = parentMessage !== undefined
    const declaredLimits: FileReadingLimits =
      (context.fileReadingLimits as FileReadingLimits | undefined) ?? getDefaultFileReadingLimits()
    const room = ownRead ? resultRoomFor(parentMessage) : null
    let granted: FileReadingLimits | undefined
    const reserve = (): FileReadingLimits => {
      if (granted !== undefined) return granted
      const share = room === null ? declaredLimits.maxTokens : room.reserve(context.toolUseId ?? '', declaredLimits.maxTokens)
      granted = share < declaredLimits.maxTokens ? { ...declaredLimits, maxTokens: share, room: true } : declaredLimits
      return granted
    }
    let summaryFoundNone = false
    let query = parseReadQueryTarget(input.file_path)
    if (query?.parameters.view === 'raw') {
      input = { ...input, file_path: query.source, offset: input.offset ?? 1 }
      query = null
    }
    const automaticProfile = query === null && classifyReadTarget(input.file_path).kind === 'file' && /\.(?:cpuprofile|sample\.txt)$/i.test(input.file_path) && input.offset === undefined && input.limit === undefined && !input.ranges?.length && !input.outline
    if (query !== null || automaticProfile) {
      const request = { target: query ?? { source: input.file_path, suffix: '#read?view=profile', parameters: { view: 'profile' } }, input, context, limits: reserve(), canUseTool, parentMessage }
      const rendered = query !== null
        ? await (await import('./readQuery.js')).readQuery(request)
        : await (await import('./readProfiles.js')).readProfiles(request, true)
      if (rendered?.readSource) input = { ...input, file_path: request.target.source }
      else if (rendered === null) summaryFoundNone = true
      else {
        const data: Output = {
          type: 'text',
          file: { filePath: input.file_path, content: rendered.content, numLines: rendered.numLines, startLine: 1, totalLines: rendered.numLines },
        }
        data.file.reminder = takeReminder(parentMessage, context.messages)
          ? context.options?.engineModel ? cyberRiskReminderFor(context.options.engineModel) : cyberRiskReminderForCurrentModel()
          : ''
        resultPreRenderedBody.set(data, rendered.content)
        return { data }
      }
    }
    const remoteEntry = isRemotePath(input.file_path) ? remoteRichTarget(input.file_path.trim()) : null
    const remoteInner = remoteEntry?.subtarget !== undefined ? remoteEntry : null
    const remote: RemoteRead | null = isRemotePath(input.file_path)
      ? await (await import('../../services/remoteFiles/bridge.js')).remoteReadTarget(
          remoteInner?.containerPath ?? input.file_path.trim(),
          remoteInner === null ? remoteRangeSelector(input.file_path.trim()) : null,
          context,
          typeof canUseTool === 'function' && parentMessage !== undefined
            ? path => (canUseTool as CanUseToolFn)(readToolItself() as never, { ...input, file_path: path }, context, parentMessage as never, `${context.toolUseId ?? 'read'}-resolved`)
            : null,
          readTargetsEnabled(),
        )
      : null
    const rawExpanded = remote !== null ? remote.path : expandPath(input.file_path)
    const splitTarget = remote !== null ? { rawPath: remote.path, expandedPath: remote.path, ...(remote.kind === 'file' && remote.ranges !== undefined ? { ranges: remote.ranges } : {}) } : splitPathRangeSelector(input.file_path, rawExpanded)
    const remoteRich = remote === null || remote.kind !== 'file' ? null : (remoteInner ?? remoteRichTarget(remote.path))
    const richTarget = remote !== null ? (remoteRich === null ? null : { ...remoteRich, containerPath: remote.path }) : parseRichFormatTarget(splitTarget.rawPath)
    const effectiveRawPath = richTarget !== null ? richTarget.containerPath : splitTarget.rawPath
    const fullFilePath = remote !== null ? remote.path : richTarget !== null ? expandPath(richTarget.containerPath) : splitTarget.expandedPath
    const effectiveInput: Input =
      splitTarget.ranges !== undefined && (input.ranges === undefined || input.ranges.length === 0)
        ? { ...input, file_path: effectiveRawPath, ranges: splitTarget.ranges }
        : input
    const ext = extensionOf(effectiveRawPath)
    let image = IMAGE_EXTENSIONS.has(ext)
    const ignoredParameterNotes = (): Message[] => {
      const kind = ext === '' ? 'a file with no extension' : `.${ext}`
      const notes: string[] = []
      if (selectedCrop(effectiveInput.crop) !== undefined && !image) notes.push(`crop ignored — ${kind} is not an image; the file was read as usual. Send crop only for an image file.`)
      if (selectedPages(effectiveInput.pages) !== undefined && !isPDFExtension(ext)) notes.push(`pages ignored — ${kind} is not a PDF; the file was read as usual. Send pages only for a PDF.`)
      return notes.map(content => createUserMessage({ content, isMeta: true }))
    }
    const settle = (lane: LaneResult): { data: Output; newMessages?: Message[] } => {
      if (lane.data.type === 'text' && lane.data.file.content !== '') {
        lane.data.file.reminder = takeReminder(parentMessage, context.messages)
          ? context.options?.engineModel ? cyberRiskReminderFor(context.options.engineModel) : cyberRiskReminderForCurrentModel()
          : ''
      }
      if (summaryFoundNone || richTarget?.subtarget !== undefined) resultWithoutProfileHint.add(lane.data)
      const newMessages = [...(lane.newMessages ?? []), ...ignoredParameterNotes()]
      return { data: lane.data, ...(newMessages.length > 0 ? { newMessages } : {}) }
    }

    if (remote !== null && remote.kind !== 'file') {
      const rendered =
        remote.kind === 'hosts'
          ? remote
          : remote.names === null
            ? renderDirectoryUnavailable(remote.path.slice(remote.path.lastIndexOf('/') + 1), remote.failure)
            : renderDirectoryNames(remote.path, remote.names)
      return settle({
        data: {
          type: 'text',
          file: {
            filePath: remote.path,
            content: rendered.content,
            numLines: rendered.numLines,
            startLine: 1,
            totalLines: rendered.numLines,
          },
        } satisfies Output,
      })
    }

    if (remote === null && readTargetsEnabled()) {
      const target = classifyReadTarget(input.file_path)
      if (target.kind === 'resource') {
        const rendered = await renderResourceTarget(input.file_path.trim(), {
          owner: ownerFromToolUseContext(context),
          cwd: getCwd(),
          getAppState: context.getAppState,
          engineModel: context.options?.engineModel,
        })
        return settle({
          data: {
            type: 'text',
            file: {
              filePath: input.file_path,
              content: rendered.content,
              numLines: rendered.numLines,
              startLine: 1,
              totalLines: rendered.numLines,
            },
          } satisfies Output,
        })
      }
      if (target.kind === 'url') {
        const rendered = renderUrlDelegation(input.file_path)
        return settle({
          data: {
            type: 'text',
            file: {
              filePath: input.file_path,
              content: rendered.content,
              numLines: rendered.numLines,
              startLine: 1,
              totalLines: rendered.numLines,
            },
          } satisfies Output,
        })
      }
      if (isDirectoryTarget(fullFilePath)) {
        const rendered = renderDirectoryTarget(fullFilePath, readDenialFilter(context.getAppState().toolPermissionContext, fullFilePath))
        return settle({
          data: {
            type: 'text',
            file: {
              filePath: input.file_path,
              content: rendered.content,
              numLines: rendered.numLines,
              startLine: 1,
              totalLines: rendered.numLines,
            },
          } satisfies Output,
        })
      }
    }

    const notAFile = remote !== null ? null : await stat(fullFilePath).then(notAFileKind, () => null)
    if (notAFile !== null) {
      logForDebugging(`read: ${fullFilePath} is ${notAFile}, not a file or a folder; it is not opened`)
      throw new Error(notAFileRefusal(effectiveRawPath, notAFile))
    }

    const entry = context.readFileState.get(fullFilePath)
    if (
      (remote !== null || !ideReadTextAvailable()) &&
      entry &&
      entry.offset !== undefined &&
      !entry.isPartialView &&
      (effectiveInput.ranges === undefined || effectiveInput.ranges.length === 0) &&
      (effectiveInput.offset === undefined || effectiveInput.offset >= 0) &&
      entry.offset === (effectiveInput.offset ?? 0) &&
      entry.limit === effectiveInput.limit &&
      effectiveInput.line_anchors !== true &&
      effectiveInput.outline !== true
    ) {
      try {
        const before = remoteReadGeneration(entry)
        const unchanged =
          remote !== null
            ? before !== undefined && (await readRangeElsewhere(fullFilePath, 0, 0, undefined, context.abortController.signal)) !== null && fileGeneration(fullFilePath) === before
            : Math.floor((await stat(fullFilePath)).mtimeMs) === entry.timestamp
        if (unchanged) {
          const anchor = entry.offset === 0 && entry.limit === undefined && changeTransactionEnabled() ? mintFileAnchor(entry.content) : undefined
          return {
            data: { type: 'file_unchanged', file: { filePath: fullFilePath, ...(anchor !== undefined ? { anchor } : {}) } } satisfies Output,
          }
        }
      } catch {
      }
    }

    if (remote === null && !isEnvTruthy(flagEnv('MERCURY_BARE'))) {
      try {
        const dirs = await discoverSkillDirsForPaths([fullFilePath], getCwd())
        const fresh = dirs.filter(dir => !context.dynamicSkillDirTriggers?.has(dir))
        for (const dir of fresh) context.dynamicSkillDirTriggers?.add(dir)
        if (fresh.length > 0) {
          void Promise.resolve(addSkillDirectories(fresh, { filePaths: [fullFilePath], cwd: getCwd() })).catch(() => undefined)
        }
        activateConditionalSkillsForPaths([fullFilePath], getCwd())
      } catch (err) {
        logError(err)
      }
    }

    const parsedRanges =
      effectiveInput.ranges !== undefined && effectiveInput.ranges.length > 0
        ? parseLineRangesList(effectiveInput.ranges)
        : null
    if (parsedRanges !== null && !Array.isArray(parsedRanges)) {
      throw new Error(
        parsedRanges.tooMany
          ? `Too many line ranges in ranges (maximum ${MAX_RANGES_PER_READ} ranges per Read call).`
          : `Invalid line range "${parsedRanges.invalid}" in ranges. Accepted formats are "N", "N-M", "N+K", "N-", or "-N" (last N lines).`,
      )
    }

    const readAsText = (resolvedPath: string, keyPath: string): Promise<LaneResult> =>
      Array.isArray(parsedRanges) && parsedRanges.length > 0
        ? readMultiRangeTextLane(resolvedPath, keyPath, effectiveInput, parsedRanges, ext, context, declaredLimits, ownRead, reserve)
        : readTextLane(resolvedPath, keyPath, effectiveInput, ext, context, declaredLimits, ownRead, reserve)
    const dispatchHere = async (resolvedPath: string, keyPath: string): Promise<LaneResult> => {
      const media = !ideReadTextAvailable() ? mediaFileFormat(resolvedPath) : null
      if (media !== null) {
        const text = await extractMediaTranscript(resolvedPath, media, context.abortController.signal)
        return readRichFormatLane(resolvedPath, { kind: 'document', containerPath: resolvedPath, ext: media }, effectiveInput, Array.isArray(parsedRanges) ? parsedRanges : null, context, declaredLimits, ownRead, reserve, { text, ownBytes: false })
      }
      if (ext !== '' && hasBinaryExtension(effectiveRawPath) && !isPDFExtension(ext) && !IMAGE_EXTENSIONS.has(ext) && !isRichFormatReadable(splitTarget.rawPath)) {
        throw new Error(`This tool cannot read binary files, and .${ext} looks binary — reach for a tool built for that format instead.`)
      }
      if (ext === 'ipynb') return readNotebookLane(resolvedPath, keyPath, effectiveInput, context, declaredLimits, reserve)
      image = IMAGE_EXTENSIONS.has(ext) || (ext === '' && !ideReadTextAvailable() && hasImageSignature(resolvedPath))
      if (image) {
        const crop = selectedCrop(effectiveInput.crop)
        if (effectiveInput.ocr || !resolveModelCapabilities(context.options?.engineModel ?? getEngineModel()).media.images) {
          let bytes: Buffer = await readRegularFile(resolvedPath)
          if (crop) bytes = (await cropImageBuffer(bytes, crop, resolvedPath, effectiveInput.scale)).buffer
          const ocr = await recogniseImage(bytes, context.abortController.signal)
          if (!ocr.ok) throw new Error(ocr.message)
          return readRichFormatLane(resolvedPath, { kind: 'document', containerPath: resolvedPath, ext }, effectiveInput, Array.isArray(parsedRanges) ? parsedRanges : null, context, declaredLimits, ownRead, reserve, { text: renderOcr(ocr), ownBytes: false })
        }
        return readImageLane(resolvedPath, keyPath, context, reserve(), crop, effectiveInput.scale)
      }
      if (isPDFExtension(ext)) return readPdfLane(resolvedPath, keyPath, effectiveInput, context, declaredLimits, ownRead, reserve)
      if (richTarget !== null) {
        return readRichFormatLane(
          resolvedPath,
          richTarget,
          effectiveInput,
          Array.isArray(parsedRanges) && parsedRanges.length > 0 ? parsedRanges : null,
          context,
          declaredLimits,
          ownRead,
          reserve,
        )
      }
      return readAsText(resolvedPath, keyPath)
    }
    const dispatch = async (resolvedPath: string): Promise<LaneResult> => {
      if (remote === null || remote.kind !== 'file') return dispatchHere(resolvedPath, resolvedPath)
      const bridge = await import('../../services/remoteFiles/bridge.js')
      const asBytes =
        (ext !== '' && hasBinaryExtension(effectiveRawPath)) ||
        ext === 'ipynb' ||
        richTarget !== null ||
        bridge.remoteLeadLooks(resolvedPath, remote.lead, head => mediaFileFormat(head) !== null || (ext === '' && hasImageSignature(head)))
      if (!asBytes) return readAsText(resolvedPath, resolvedPath)
      if (richTarget !== null && richTarget.kind !== 'document' && remote.size > RICH_CONTAINER_MAX_BYTES) {
        throw new Error(`Container file (${formatFileSize(remote.size)}) exceeds the maximum allowed container size (${formatFileSize(RICH_CONTAINER_MAX_BYTES)}): ${resolvedPath}`)
      }
      return bridge.remoteCopy(resolvedPath, context.abortController.signal, async copy => {
        try {
          const read = await dispatchHere(copy, resolvedPath)
          const body = resultPreRenderedBody.get(read.data)
          if (body !== undefined) resultPreRenderedBody.set(read.data, renamed(body, copy, resolvedPath))
          return renamed(read, copy, resolvedPath)
        } catch (error) {
          if (error instanceof Error) error.message = renamed(error.message, copy, resolvedPath)
          throw error
        } finally {
          for (const key of cacheKeys(context.readFileState)) if (key.startsWith(copy)) context.readFileState.delete(key)
        }
      })
    }

    let lane: LaneResult
    try {
      lane = await dispatch(fullFilePath)
    } catch (err) {
      if (jsonQueryName(fullFilePath) && (err instanceof FileTooLargeError || err instanceof MaxFileReadTokenExceededError)) err.message += `\n${jsonQueryDiscovery(fullFilePath)}`
      if (!isENOENT(err) || remote !== null) throw err
      const alternate = resolveCanonicalNearMissPath(fullFilePath) ?? alternateScreenshotPath(fullFilePath)
      if (alternate !== null) {
        try {
          lane = await dispatch(alternate)
          if (alternate !== fullFilePath) {
            resultResolvedNames.set(lane.data, basename(alternate))
          }
          return settle(lane)
        } catch (retryErr) {
          if (!isENOENT(retryErr)) throw retryErr
        }
      }
      throw await friendlyNotFoundError(input.file_path, fullFilePath)
    }
    return settle(lane)
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    switch (data.type) {
      case 'image':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: [
            ...(data.file.caption ? [{ type: 'text' as const, text: data.file.caption }] : []),
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: data.file.type,
                data: data.file.base64,
              },
            },
          ],
        }
      case 'notebook':
        return mapNotebookCellsToToolResult(data.file.cells as never, toolUseID)
      case 'pdf':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `PDF file: ${data.file.filePath} (${formatFileSize(data.file.originalSize)}). The document content was provided alongside this result.`,
        }
      case 'parts':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `Extracted ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)}) as images.`,
        }
      case 'file_unchanged':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `${FILE_UNCHANGED_STUB}${data.file.anchor !== undefined ? `\n(anchor: ${data.file.anchor})` : ''}`,
        }
      case 'text': {
        const body = serializeTextResult(data.file, data)
        if (data.file.content === '') {
          return { tool_use_id: toolUseID, type: 'tool_result' as const, content: body }
        }
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `${body}${data.file.reminder ?? cyberRiskReminderForCurrentModel()}`,
        }
      }
    }
  },
  extractSearchText(): string {
    return ''
  },
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})

function readToolItself(): unknown {
  return FileReadTool
}

