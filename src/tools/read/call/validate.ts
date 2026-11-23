import type { ToolUseContext } from '../../kit/tool.js'
import { isRemotePath } from '../../../platform/remote-file-target/target.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { referenceReadPaths } from '../../../integrations/resources/referencePaths.js'
import { controlCharacterPathRefusal, expandPath } from '../../../platform/files/path.js'
import { matchingRuleForInput } from '../../../permissions/rules/filesystem.js'
import { windowsPathNeedsPermission } from '../../../permissions/rules/windowsPath.js'
import { ruleSentence } from '../../../permissions/rules/ruleReason.js'
import { parsePDFPageRange } from '../../kit/pdfSupport.js'
import { MAX_PDF_PAGES_PER_REQUEST } from '../../kit/names/fileRead.js'
import { parseRichFormatTarget } from '../readRichFormats.js'
import { parseReadQueryTarget } from '../readQueryTarget.js'
import { classifyReadTarget, readTargetsEnabled } from '../readTarget.js'
import { MAX_RANGES_PER_READ, selectedPages, selectedCrop, type Input } from './schema.js'
import { remoteAlso, isBlockingDevicePath, parseLineRangesList, splitPathRangeSelector } from './target.js'

export async function validateReadInput(input: Input, context: ToolUseContext) {
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
    const { remoteValidation } = await import('../../../platform/remote-files/bridge.js')
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
}
