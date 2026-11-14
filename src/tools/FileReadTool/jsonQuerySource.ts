import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRemotePath, remoteGeneration } from '../../services/remoteFiles/target.js'
import { parseMercuryRef } from '../../services/resources/contracts.js'
import { fileReferenceCandidates } from '../../services/resources/referencePaths.js'
import { getCwd } from '../../utils/cwd.js'
import { expandPath } from '../../utils/path.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ReadQueryRequest } from './readQuery.js'
import { parseRichFormatTarget, renderArchiveTarget } from './readRichFormats.js'

interface JsonQuerySource {
  path: string
  name: string
  identity?: string
  generated?: boolean
}

export async function withJsonQuerySource<T>(request: ReadQueryRequest, directory: string, read: (source: JsonQuerySource) => Promise<T>): Promise<T> {
  const source = request.target.source
  const signal = request.context.abortController.signal
  const temporary = async (text: string, name: string, identity?: string): Promise<T> => {
    const path = join(directory, 'input.json')
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' })
    return read({ path, name, identity: identity ?? createHash('sha256').update(text).digest('hex'), generated: true })
  }
  const here = async (path: string, name: string, identity?: string): Promise<T> => {
    const rich = parseRichFormatTarget(name)
    if (rich?.kind === 'archive' && rich.subtarget !== undefined) {
      const rendered = await renderArchiveTarget(path, rich.ext, rich.subtarget)
      return temporary(rendered.text, rich.subtarget, identity)
    }
    return read({ path, name, identity })
  }
  if (isRemotePath(source)) {
    const bridge = await import('../../services/remoteFiles/bridge.js')
    const slash = source.indexOf('/', source.indexOf('://') + 3)
    const rich = slash < 0 ? null : parseRichFormatTarget(source.slice(slash))
    const named = rich?.subtarget !== undefined ? `${source.slice(0, slash)}${rich.containerPath}` : source
    const remote = await bridge.remoteReadTarget(named, null, request.context,
      typeof request.canUseTool === 'function' && request.parentMessage !== undefined
        ? async path => {
            const { FileReadTool } = await import('./FileReadTool.js')
            return (request.canUseTool as CanUseToolFn)(FileReadTool as never, { ...request.input, file_path: path }, request.context, request.parentMessage as never, `${request.context.toolUseId ?? 'read'}-resolved`)
          }
        : null, false)
    if (remote.kind !== 'file') throw new Error(`${source} is not a JSON file.`)
    await bridge.readRangeViaRemote(remote.path, 0, 0, undefined, signal)
    const before = remoteGeneration(remote.path)
    return bridge.remoteCopy(remote.path, signal, async copy => {
      try {
        const result = await here(copy, source.slice(slash), before ?? undefined)
        await bridge.readRangeViaRemote(remote.path, 0, 0, undefined, signal)
        if (remoteGeneration(remote.path) !== before) throw new Error(`${source} changed on the remote machine while its query was running; Read it again.`)
        return result
      } catch (error) {
        if (error instanceof Error) error.message = error.message.replaceAll(copy, source)
        throw error
      }
    })
  }
  const ref = parseMercuryRef(source.trim())
  if (ref?.kind === 'file' && !source.includes('?')) {
    const paths = fileReferenceCandidates(ref.id, getCwd())
    const path = paths.find(file => existsSync(file)) ?? paths[0]!
    return here(path, ref.id)
  }
  if (ref !== null) {
    if (ref.kind === 'artifact' && !source.includes('?')) {
      const slash = ref.id.indexOf('/')
      if (slash >= 0) {
        const { getArtifact } = await import('../../utils/artifacts/store.js')
        const artifact = await getArtifact(ref.id.slice(0, slash), ref.id.slice(slash + 1))
        if (artifact) return temporary(artifact.content, artifact.meta.name, artifact.meta.sha256)
      }
    }
    const { resolveResource } = await import('../../services/resources/registry.js')
    const resolved = await resolveResource(source, { owner: ownerFromToolUseContext(request.context), cwd: getCwd(), getAppState: request.context.getAppState, engineModel: request.context.options?.engineModel })
    if (resolved.state !== 'ok' || resolved.resource.text === undefined) throw new Error(`${source}: ${resolved.state === 'ok' ? 'the resource has no text to query' : resolved.note}`)
    return temporary(resolved.resource.text, `${ref.id}.json`, resolved.resource.version)
  }
  const rich = parseRichFormatTarget(source)
  return here(expandPath(rich?.containerPath ?? source), source)
}
