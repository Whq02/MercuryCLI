import type { ReadQueryRequest, ReadQueryResult } from './readQuery.js'
import { formatReadQueryTarget } from './readQueryTarget.js'

export const READ_VIEW_IDENTITY = "A query's result, not the file's bytes: it gives no edit anchor and does not count as reading the file."

export function readViewWindow(request: ReadQueryRequest): { offset: number; limit: number } {
  const { parameters } = request.target
  const offset = parameters.offset === undefined ? 0 : Number(parameters.offset)
  const limit = parameters.limit === undefined ? 50 : Number(parameters.limit)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Result offset is a nonnegative integer; limit is a positive integer.')
  return { offset, limit }
}

export function readViewPage(request: ReadQueryRequest, kind: string, headings: string[], rows: string[], total = rows.length, window = readViewWindow(request)): ReadQueryResult {
  const budget = Math.max(1, Math.min(request.limits.maxSizeBytes, request.limits.maxTokens * 4))
  const shown: string[] = []
  let used = headings.join('\n').length + READ_VIEW_IDENTITY.length + request.target.source.length + 200
  for (const row of rows) {
    if (shown.length >= window.limit || (shown.length > 0 && used + row.length > budget)) break
    shown.push(row)
    used += row.length + 1
  }
  const end = window.offset + shown.length
  const more = end < total
  const lines = [`(target: ${kind} · source: ${request.target.source} · results: ${shown.length ? `${window.offset + 1}-${end}` : 'none'} · state: ${more ? 'page' : 'complete'})`, READ_VIEW_IDENTITY, ...headings, ...shown]
  if (more) {
    const target = formatReadQueryTarget(request.target.source, { ...request.target.parameters, offset: String(end), limit: String(window.limit) })
    lines.push(`[rows ${window.offset + 1}-${end} — Read(file_path: ${JSON.stringify(target)}) continues from there]`)
  }
  const content = lines.join('\n')
  return { content, numLines: lines.length }
}
