import { stat } from 'node:fs/promises'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import type { ToolUseContext } from '../../../Tool.js'
import { changeTransactionEnabled } from '../../../services/changeTransaction/contracts.js'
import { fileGeneration } from '../../../services/changeTransaction/seenLines.js'
import { mintFileAnchor } from '../../../services/changeTransaction/snapshotAnchor.js'
import { ownerFromToolUseContext } from '../../../services/run/resolveOwner.js'
import { ideReadTextAvailable } from '../../../services/acp/ideToolBridge.js'
import type { RemoteRead } from '../../../services/remoteFiles/bridge.js'
import { remoteReadGeneration } from '../../../services/remoteFiles/target.js'
import { activateConditionalSkillsForPaths, addSkillDirectories, discoverSkillDirsForPaths } from '../../../skills/loadSkillsDir.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { getCwd } from '../../../utils/cwd.js'
import { logError } from '../../../utils/log.js'
import { readDenialFilter } from '../../../utils/permissions/filesystem.js'
import type { Message } from '../../../types/message.js'
import { classifyReadTarget, isDirectoryTarget, readTargetsEnabled, renderDirectoryNames, renderDirectoryTarget, renderDirectoryUnavailable, renderResourceTarget, renderUrlDelegation } from '../readTarget.js'
import type { Input, Output, LaneResult } from './schema.js'
import { readRangeElsewhere } from './source.js'

export async function readNonFileTarget(input: Input, remote: RemoteRead | null, fullFilePath: string, context: ToolUseContext, settle: (lane: LaneResult) => { data: Output; newMessages?: Message[] }) {
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
  return null
}

export async function readUnchanged(remote: RemoteRead | null, fullFilePath: string, effectiveInput: Input, context: ToolUseContext) {
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
  return null
}

export async function discoverSkillsFor(remote: RemoteRead | null, fullFilePath: string, context: ToolUseContext): Promise<void> {
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
}
