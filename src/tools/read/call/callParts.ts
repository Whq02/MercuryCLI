import type { ToolUseContext } from '../../kit/tool.js'
import type { RemoteRead } from '../../../platform/remote-files/bridge.js'
import { readDenialFilter } from '../../../permissions/rules/filesystem.js'
import type { Message } from '../../../engine/message-shapes/message.js'
import { renderDirectoryNames, renderDirectoryTarget, renderDirectoryUnavailable, renderUrlDelegation } from '../readTarget.js'
import type { Input, Output, LaneResult } from './schema.js'

export function readRemoteListing(remote: Exclude<RemoteRead, { kind: 'file' }>, settle: (lane: LaneResult) => { data: Output; newMessages?: Message[] }) {
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

export function readUrlTarget(input: Input, settle: (lane: LaneResult) => { data: Output; newMessages?: Message[] }) {
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

export function readDirectoryTarget(input: Input, fullFilePath: string, context: ToolUseContext, settle: (lane: LaneResult) => { data: Output; newMessages?: Message[] }) {
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
