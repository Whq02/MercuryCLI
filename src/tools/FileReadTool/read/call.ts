import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ToolUseContext, CanUseToolFn } from '../../../Tool.js'
import { ideReadTextAvailable } from '../../../services/acp/ideToolBridge.js'
import type { RemoteRead } from '../../../services/remoteFiles/bridge.js'
import { isRemotePath } from '../../../services/remoteFiles/target.js'
import { hasBinaryExtension } from '../../../constants/files.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isENOENT } from '../../../utils/errors.js'
import { formatFileSize } from '../../../utils/format.js'
import { createUserMessage } from '../../../utils/messages/factories.js'
import { expandPath } from '../../../utils/path.js'
import { recogniseImage, renderOcr } from '../../../utils/ocr.js'
import { extractMediaTranscript, mediaFileFormat } from '../../../services/voice/fileTranscript.js'
import { isPDFExtension } from '../../../utils/pdfUtils.js'
import { resolveModelCapabilities } from '../../../utils/model/capabilities.js'
import { getEngineModel } from '../../../utils/model/model.js'
import { FileTooLargeError } from '../../../utils/readFileInRange.js'
import { notAFileKind, notAFileRefusal, readRegularFile } from '../../../utils/regularFile.js'
import type { Message } from '../../../types/message.js'
import { getDefaultFileReadingLimits, type FileReadingLimits } from '../limits.js'
import { resultRoomFor } from '../../../services/run/resultRoom.js'
import { isRichFormatReadable, parseRichFormatTarget, RICH_CONTAINER_MAX_BYTES } from '../readRichFormats.js'
import { cacheKeys } from '../../../utils/fileStateCache.js'
import { jsonQueryDiscovery, jsonQueryName, parseReadQueryTarget } from '../readQueryTarget.js'
import { classifyReadTarget, readTargetsEnabled } from '../readTarget.js'
import { MAX_RANGES_PER_READ, selectedPages, selectedCrop, type Input, type Output, type LaneResult } from './schema.js'
import { resultResolvedNames, resultPreRenderedBody, resultWithoutProfileHint } from './results.js'
import { cyberRiskReminderFor, takeReminder, cyberRiskReminderForCurrentModel } from './reminder.js'
import { MaxFileReadTokenExceededError } from './window.js'
import { remoteRangeSelector, remoteRichTarget, renamed, IMAGE_EXTENSIONS, hasImageSignature, extensionOf, resolveCanonicalNearMissPath, alternateScreenshotPath, friendlyNotFoundError, parseLineRangesList, splitPathRangeSelector } from './target.js'
import { cropImageBuffer, readImageLane } from './image.js'
import { readNotebookLane } from './notebookLane.js'
import { readPdfLane } from './pdfLane.js'
import { readMultiRangeTextLane } from './multiRangeLane.js'
import { readRichFormatLane } from './richFormatLane.js'
import { readTextLane } from './textLane.js'
import { readNonFileTarget, readUnchanged, discoverSkillsFor } from './callParts.js'

export async function readFileCall(input: Input, context: ToolUseContext, canUseTool: unknown, parentMessage: unknown, readToolItself: () => unknown) {
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
      ? await (await import('../readQuery.js')).readQuery(request)
      : await (await import('../readProfiles.js')).readProfiles(request, true)
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
    ? await (await import('../../../services/remoteFiles/bridge.js')).remoteReadTarget(
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

  const listed = await readNonFileTarget(input, remote, fullFilePath, context, settle)
  if (listed !== null) return listed

  const notAFile = remote !== null ? null : await stat(fullFilePath).then(notAFileKind, () => null)
  if (notAFile !== null) {
    logForDebugging(`read: ${fullFilePath} is ${notAFile}, not a file or a folder; it is not opened`)
    throw new Error(notAFileRefusal(effectiveRawPath, notAFile))
  }

  const unchanged = await readUnchanged(remote, fullFilePath, effectiveInput, context)
  if (unchanged !== null) return unchanged

  await discoverSkillsFor(remote, fullFilePath, context)

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
    const bridge = await import('../../../services/remoteFiles/bridge.js')
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
}
