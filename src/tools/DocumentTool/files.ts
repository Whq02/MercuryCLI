import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { marked } from 'marked'
import type { ToolPermissionContext } from '../../Tool.js'
import { controlCharacterPathRefusal, expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool, checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import { memoryWriteRefusal } from '../../utils/memoryFileDetection.js'
import type { DocumentInput, DocumentProduct } from './schema.js'

export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export function documentPath(path: string): string {
  const refusal = controlCharacterPathRefusal(path)
  if (refusal) throw new Error(refusal)
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) throw new Error('Document paths must be local files')
  return expandPath(path)
}
export function imagePaths(markdown: string): string[] {
  const paths: string[] = []
  marked.walkTokens(marked.lexer(markdown), token => { if (token.type === 'image') paths.push(token.href) })
  return paths
}
export function documentPaths(input: DocumentInput): { reads: string[]; writes: string[] } {
  const reads = [input.source, input.template, ...(input.sources ?? []), ...(input.blocks ?? []).flatMap(b => b.kind === 'image' ? [b.path] : []), ...imagePaths(input.markdown ?? '')].filter((p): p is string => p !== undefined).map(documentPath)
  const writes = [input.output, ...(input.parts ?? []).map(p => p.output)].filter((p): p is string => p !== undefined).map(documentPath)
  if (writes.length !== new Set(writes).size) throw new Error('Document outputs must have distinct paths')
  for (const file of writes) {
    const refusal = memoryWriteRefusal(file)
    if (refusal) throw new Error(refusal)
  }
  return { reads: [...new Set(reads)], writes }
}
export function documentPermission(input: DocumentInput, context: ToolPermissionContext) {
  const paths = documentPaths(input)
  const decisions = [
    ...paths.reads.map(path => checkReadPermissionForTool({ name: 'Read', getPath: () => path }, input, context)),
    ...paths.writes.map(path => checkWritePermissionForTool({ name: 'Write', getPath: () => path }, input, context)),
  ]
  const denied = decisions.find(d => d.behavior === 'deny')
  if (denied) return denied
  const asks = decisions.filter(d => d.behavior === 'ask')
  if (asks.length) return { ...asks[0]!, message: asks.map(d => d.message).join('\n'), suggestions: [] }
  return { behavior: 'allow' as const, updatedInput: input }
}
function physical(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(physical(parent), basename(path))
}
export type Destination = { path: string; physical: string; before: Buffer | null; mode?: number }
export function captureDestinations(input: DocumentInput): Destination[] {
  const targets = documentPaths(input).writes.map(path => {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat && !stat.isFile()) throw new Error(`Not a regular output file: ${path}`)
    const before = stat ? readFileSync(path) : null
    if (before && input.expectedSha256?.[path] !== digest(before)) throw new Error(`Existing output needs its current expectedSha256 from inspect: ${path}`)
    return { path, physical: physical(path), before, mode: stat?.mode }
  })
  if (new Set(targets.map(t => t.physical)).size !== targets.length) throw new Error('Document outputs resolve to the same file')
  return targets
}
export function commitDocuments(product: DocumentProduct, targets: Destination[], signal: AbortSignal): string[] {
  const wanted = new Map(targets.map(t => [t.path, t]))
  if (product.files.length !== wanted.size || new Set(product.files.map(f => f.path)).size !== wanted.size || product.files.some(f => !wanted.has(f.path))) throw new Error('Document output paths changed during rendering')
  const staged: { temp: string; target: Destination }[] = []
  const changed: Destination[] = []
  const check = (t: Destination): void => {
    signal.throwIfAborted()
    if (physical(t.path) !== t.physical) throw new Error(`Output path changed during rendering: ${t.path}`)
    const now = existsSync(t.path) ? readFileSync(t.path) : null
    if ((now === null) !== (t.before === null) || (now && t.before && !now.equals(t.before))) throw new Error(`Output changed during rendering: ${t.path}`)
  }
  try {
    targets.forEach(check)
    for (const file of product.files) {
      const target = wanted.get(file.path)!
      mkdirSync(dirname(target.path), { recursive: true })
      const temp = resolve(dirname(target.path), `.document-${randomUUID()}`)
      staged.push({ temp, target })
      writeFileSync(temp, file.bytes, { flag: 'wx', mode: target.mode ?? 0o600 })
    }
    targets.forEach(check)
    for (const { temp, target } of staged) {
      renameSync(temp, target.path)
      changed.push(target)
    }
    for (const file of product.files) if (!readFileSync(file.path).equals(Buffer.from(file.bytes))) throw new Error(`Document read-back differs: ${file.path}`)
    return changed.map(t => t.path)
  } catch (error) {
    const failed: string[] = []
    for (const target of changed.reverse()) {
      try {
        if (target.before) writeFileSync(target.path, target.before)
        else rmSync(target.path)
      } catch { failed.push(target.path) }
    }
    if (failed.length) throw new Error(`Document rollback incomplete for ${failed.join(', ')}: ${String(error)}`)
    throw error
  } finally {
    for (const { temp } of staged) rmSync(temp, { force: true })
  }
}
