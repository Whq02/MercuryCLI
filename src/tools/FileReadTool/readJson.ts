import { randomUUID } from 'node:crypto'
import { closeSync, constants, copyFileSync, fstatSync, mkdirSync, mkdtempSync, read, rmSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { getMercuryTempDir } from '../../utils/permissions/filesystem.js'
import { openRegularFileSync } from '../../utils/regularFile.js'
import { ensureToolResultsDir, getToolResultPath } from '../../utils/toolResultStorage.js'
import { formatReadQueryTarget, jsonQueryName } from './readQueryTarget.js'
import { withJsonQuerySource } from './jsonQuerySource.js'
import { runJsonQuery } from './jsonQueryRuntime.js'
import { jsonQueryWindow } from './jsonQueryOutput.js'
import { jsonQuerySourceLines } from './jsonQueryProvenance.js'
import type { ReadQueryRequest, ReadQueryResult } from './readQuery.js'

function version(stats: Stats): string {
  return `s${stats.size}:m${stats.mtimeMs}:c${stats.ctimeMs}:i${stats.ino}:d${stats.dev}`
}

async function admitted(fd: number, name: string, signal: AbortSignal): Promise<boolean> {
  if (jsonQueryName(name)) return true
  if (/\.(?:png|jpe?g|gif|bmp|ico|webp|tiff?|pdf|mp4|mov|avi|mkv|webm|wmv|flv|m4v|mpe?g|mp3|wav|ogg|flac|aac|m4a|wma|aiff|opus)$/i.test(name)) return false
  const buffer = Buffer.alloc(65536)
  let at = 0
  for (;;) {
    signal.throwIfAborted()
    const got = await new Promise<number>((resolve, reject) => read(fd, buffer, 0, buffer.length, at, (error, count) => error ? reject(error) : resolve(count)))
    signal.throwIfAborted()
    if (got === 0) return false
    let start = at === 0 && got >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0
    for (; start < got; start++) {
      const byte = buffer[start]
      if (byte === 32 || byte === 9 || byte === 10 || byte === 13) continue
      return byte === 123 || byte === 91
    }
    at += got
  }
}

function pageNumber(value: string | undefined, fallback: number, minimum: number, name: string): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) throw new Error(`JSON query ${name} must be an integer of at least ${minimum}.`)
  return number
}

function bool(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true' || value === '') return true
  throw new Error(`JSON query ${name} must be true or false (1 or 0).`)
}

const PROVENANCE = "A query's result, not the file's bytes: it gives no edit anchor and does not count as reading the file."

export async function readJson(request: ReadQueryRequest): Promise<ReadQueryResult> {
  const { target, input, context, limits } = request
  const params = target.parameters
  const offset = pageNumber(params.offset, 0, 0, 'offset')
  const requestedLimit = pageNumber(params.limit, 100, 1, 'limit')
  if (!Number.isSafeInteger(offset + requestedLimit + 1)) throw new Error('JSON query offset plus limit is outside the integer range.')
  const raw = bool(params.raw, 'raw'), compact = bool(params.compact, 'compact')
  const query = params.q || params.query || '.'
  const signal = context.abortController.signal
  signal.throwIfAborted()
  const base = join(getMercuryTempDir(), 'json-queries')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(base, 'read-'))
  const artifacts: string[] = []
  let complete = false
  try {
    const result = await withJsonQuerySource(request, directory, async source => {
      const { fd, stats } = openRegularFileSync(source.path)
      try {
        if (stats.isDirectory() || !(await admitted(fd, source.name, signal))) return { content: '', numLines: 0, readSource: true }
        const initial = version(stats)
        const identity = source.identity ?? initial
        if (params.source !== undefined && params.source !== identity) {
          const content = `(target: JSON query · source: ${target.source} · state: changed)\n${PROVENANCE}\nThe source changed since this continuation was made; start the query again without source=.`
          return { content, numLines: 3 }
        }
        const sourceLines = /\.(?:jsonl|ndjson)(?:(?:\.(?:bak|backup|old|orig|save|tmp|\d+))|~)*$/i.test(source.name)
        const originRoom = Math.max(1, Math.floor((limits.maxTokens * 3 - target.source.length - PROVENANCE.length - 2048) / 2))
        const limit = sourceLines ? Math.min(requestedLimit, Math.max(1, Math.floor(originRoom / (String(stats.size + 1).length + 2)))) : requestedLimit
        const run = await runJsonQuery({ fd, directory, query, offset, limit, raw, compact, sourceLines }, signal)
        if (version(fstatSync(fd)) !== initial) throw new Error(`${target.source} changed while its query was running; Read it again.`)
        const origins = run.originsPath ? await jsonQuerySourceLines(fd, run.originsPath, run.shown, run.array, query, signal) : []
        if (version(fstatSync(fd)) !== initial) throw new Error(`${target.source} changed while its query was running; Read it again.`)
        const state = run.status !== 0 ? 'partial-error' : run.hasMore ? 'page' : 'complete'
        const span = run.shown === 0 ? 'none' : `${offset + 1}-${offset + run.shown}`
        const header = `(target: JSON query · source: ${target.source} · identity: ${identity} · results: ${span} · state: ${state})`
        const originLine = origins.length === 0 ? '' : `[source lines of values ${span}, in order (- = no single line): ${origins.map(line => line ?? '-').join(', ')}]`
        const view = await jsonQueryWindow(run.outputPath, run.outputLines, input, Math.max(0, limits.maxTokens * 3 - header.length - PROVENANCE.length - originLine.length - 1024), signal)
        const lines = [header, PROVENANCE, `Query input: ${run.sourceBytes} of ${stats.size} bytes consumed (${run.sourceReadBytes} bytes read, including buffering)${run.sourceBytes < stats.size ? '; remaining input was not evaluated' : ''}.`, ...(source.generated ? ['Input is the selected resource or archive entry, not the container file.'] : []), view.text]
        if (input.offset !== undefined || input.limit !== undefined || input.ranges?.length) lines.splice(3, 0, `Generated output lines ${view.lines} of ${run.outputLines}; these are not source line numbers.`)
        if (run.diagnostics) lines.push(`${run.status === 0 ? 'Query diagnostic' : 'Query error; any values above are partial'}:\n${run.diagnostics}`)
        if (view.cut) {
          await ensureToolResultsDir()
          const artifact = getToolResultPath(`json-query-${randomUUID()}`, false)
          copyFileSync(run.outputPath, artifact, constants.COPYFILE_EXCL)
          artifacts.push(artifact)
          lines.push(`Only part of the generated output is shown. The complete result page (${run.outputBytes} bytes) is at ${artifact}; Read that file to continue within this page.`)
        }
        if (originLine) lines.push(originLine)
        if (run.hasMore) {
          const next = formatReadQueryTarget(target.source, { ...params, source: identity, offset: String(offset + run.shown), limit: String(requestedLimit), ...(params.q === undefined && params.query === undefined ? { q: '.' } : {}) })
          lines.push(`[values ${span} — Read(file_path: ${JSON.stringify(next)}) continues from there]`)
        }
        const content = lines.join('\n')
        return { content, numLines: content.split('\n').length }
      } finally { closeSync(fd) }
    })
    signal.throwIfAborted()
    complete = true
    return result
  } finally {
    rmSync(directory, { recursive: true, force: true })
    if (!complete) for (const artifact of artifacts) rmSync(artifact, { force: true })
  }
}
