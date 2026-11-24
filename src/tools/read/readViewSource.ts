import { closeSync } from 'node:fs'
import { expandPath } from '../../platform/files/path.js'
import { isRemotePath } from '../../platform/remote-file-target/target.js'
import { openRegularFileSync } from './regularFile.js'
import type { ReadQueryRequest } from './readQuery.js'

export async function withReadViewSource<T>(request: ReadQueryRequest, source: string, read: (file: string) => Promise<T>, additional = false): Promise<T> {
  const { ReadTool } = await import('./ReadTool.js')
  const input = { file_path: source }
  const valid = await ReadTool.validateInput!(input, request.context)
  if (!valid.result) throw new Error(valid.message)
  const decision = await ReadTool.checkPermissions!(input, request.context)
  if (decision.behavior === 'deny') throw new Error(decision.message)
  const { canUseTool, parentMessage } = request
  const ask = typeof canUseTool === 'function' && parentMessage !== undefined
    ? (path: string) => canUseTool(ReadTool, { file_path: path }, request.context, parentMessage, `${request.context.toolUseId ?? 'read'}-view-source`)
    : null
  if (additional && decision.behavior === 'ask') {
    const answer = ask === null ? decision : await ask(source)
    if (answer.behavior !== 'allow') throw new Error(answer.message ?? decision.message)
  }
  request.context.abortController.signal.throwIfAborted()
  if (isRemotePath(source)) {
    const { remoteReadTarget, remoteCopy } = await import('../../platform/remote-files/bridge.js')
    const target = await remoteReadTarget(source, null, request.context, ask, false)
    if (target.kind !== 'file') throw new Error(`${source} is not a file.`)
    return remoteCopy(target.path, request.context.abortController.signal, read)
  }
  const file = expandPath(source)
  closeSync(openRegularFileSync(file).fd)
  return read(file)
}
