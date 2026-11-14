import { closeSync } from 'node:fs'
import { expandPath } from '../../utils/path.js'
import { openRegularFileSync } from '../../utils/regularFile.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ReadQueryRequest } from './readQuery.js'

export async function withReadViewSource<T>(request: ReadQueryRequest, source: string, read: (file: string) => Promise<T>, additional = false): Promise<T> {
  const { FileReadTool } = await import('./FileReadTool.js')
  const input = { file_path: source }
  const valid = await FileReadTool.validateInput!(input, request.context)
  if (!valid.result) throw new Error(valid.message)
  const decision = await FileReadTool.checkPermissions!(input, request.context)
  if (decision.behavior === 'deny') throw new Error(decision.message)
  const ask = typeof request.canUseTool === 'function' && request.parentMessage !== undefined
    ? (path: string) => (request.canUseTool as CanUseToolFn)(FileReadTool as never, { file_path: path }, request.context, request.parentMessage as never, `${request.context.toolUseId ?? 'read'}-view-source`)
    : null
  if (additional && decision.behavior === 'ask') {
    const answer = ask === null ? decision : await ask(source)
    if (answer.behavior !== 'allow') throw new Error(answer.message ?? decision.message)
  }
  request.context.abortController.signal.throwIfAborted()
  if (source.startsWith('ssh://')) {
    const { remoteReadTarget, remoteCopy } = await import('../../services/remoteFiles/bridge.js')
    const target = await remoteReadTarget(source, null, request.context, ask, false)
    if (target.kind !== 'file') throw new Error(`${source} is not a file.`)
    return remoteCopy(target.path, request.context.abortController.signal, read)
  }
  const file = expandPath(source)
  closeSync(openRegularFileSync(file).fd)
  return read(file)
}
