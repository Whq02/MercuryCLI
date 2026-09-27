import { gbWords } from '../localServer/localServerMemory.js'
import { parseOllamaTags } from '../localServer/localServerTruth.js'
import { readJson, rec, resolveSetupIo, str } from './setupIo.js'
import { type PullProgress, type PullResult, type SetupIo } from './setupTypes.js'

export async function modelListed(root: string, tag: string, seam: SetupIo = {}): Promise<boolean> {
  const io = resolveSetupIo(seam)
  const tags = await readJson(io, `${root}/api/tags`)
  if (tags === undefined) return false
  return parseOllamaTags(tags).some(m => m.name === tag)
}

export function pullProgressLine(p: Omit<PullProgress, 'line'>): string {
  const digest = p.digest ? p.digest.replace(/^sha256:/, '').slice(0, 8) : undefined
  const status = /^pulling (sha256:)?[0-9a-f]{12,}/.test(p.status) && digest ? `pulling ${digest}` : p.status
  if (p.total !== undefined && p.total > 0) {
    const completed = p.completed ?? 0
    const percent = p.percent ?? Math.min(100, Math.floor((completed / p.total) * 100))
    return `${status} ${percent}% · ${gbWords(completed)} of ${gbWords(p.total)}`
  }
  return status
}

class Lines {
  private rest = ''
  push(chunk: Uint8Array): string[] {
    this.rest += Buffer.from(chunk).toString('utf8')
    const lines = this.rest.split('\n')
    this.rest = lines.pop() ?? ''
    return lines.map(l => l.trim()).filter(l => l !== '')
  }
  flush(): string[] {
    const tail = this.rest.trim()
    this.rest = ''
    return tail === '' ? [] : [tail]
  }
}

export async function pullModel(root: string, tag: string, onProgress: (p: PullProgress) => void, seam: SetupIo = {}): Promise<PullResult> {
  const io = resolveSetupIo(seam)
  const words = (rest: string): string => `${tag}: ${rest}`
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  io.signal?.addEventListener('abort', onOuterAbort, { once: true })
  let idle = setTimeout(() => controller.abort(), io.pullIdleMs)
  idle.unref?.()
  const touch = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(), io.pullIdleMs)
    idle.unref?.()
  }
  let rows = 0
  let lastStatus = ''
  let totalBytes: number | undefined
  try {
    let response: Response
    try {
      response = await io.fetchImpl(`${root}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ model: tag, stream: true }),
        signal: controller.signal,
      })
    } catch (error) {
      const why = io.signal?.aborted ? 'cancelled' : controller.signal.aborted ? `no row for ${Math.round(io.pullIdleMs / 1000)} s` : String(error instanceof Error ? error.message : error)
      return { skipped: false, success: false, lastStatus, rows, error: why, words: words(`pull failed: ${why}`) }
    }
    if (!response.ok || !response.body) {
      let detail = `HTTP ${response.status}`
      try {
        const body = rec(await response.json())
        if (str(body?.error)) detail = `HTTP ${response.status}: ${str(body?.error)}`
      } catch {
        detail = `HTTP ${response.status}`
      }
      return { skipped: false, success: false, lastStatus, rows, error: detail, words: words(`pull refused: ${detail}`) }
    }
    const reader = response.body.getReader()
    const lines = new Lines()
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        const why = io.signal?.aborted ? 'cancelled' : controller.signal.aborted ? `no row for ${Math.round(io.pullIdleMs / 1000)} s` : String(error instanceof Error ? error.message : error)
        return { skipped: false, success: false, lastStatus, rows, ...(totalBytes !== undefined ? { totalBytes } : {}), error: why, words: words(`pull broke off after ${rows} rows: ${why}`) }
      }
      touch()
      const batch = chunk.done ? lines.flush() : lines.push(chunk.value!)
      for (const line of batch) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const row = rec(parsed)
        if (!row) continue
        rows++
        if (str(row.error)) {
          const why = str(row.error)!
          void reader.cancel().catch(() => {})
          return { skipped: false, success: false, lastStatus, rows, ...(totalBytes !== undefined ? { totalBytes } : {}), error: why, words: words(`pull failed: ${why}`) }
        }
        const status = str(row.status) ?? ''
        lastStatus = status
        const digest = str(row.digest)
        const total = typeof row.total === 'number' && Number.isFinite(row.total) && row.total > 0 ? row.total : undefined
        const completed = typeof row.completed === 'number' && Number.isFinite(row.completed) && row.completed >= 0 ? row.completed : undefined
        if (total !== undefined && totalBytes === undefined) totalBytes = total
        const progress: Omit<PullProgress, 'line'> = {
          status,
          ...(digest !== undefined ? { digest } : {}),
          ...(completed !== undefined ? { completed } : {}),
          ...(total !== undefined ? { total } : {}),
          ...(total !== undefined ? { percent: Math.min(100, Math.floor(((completed ?? 0) / total) * 100)) } : {}),
        }
        onProgress({ ...progress, line: pullProgressLine(progress) })
        if (status === 'success') {
          void reader.cancel().catch(() => {})
          return { skipped: false, success: true, lastStatus: status, rows, ...(totalBytes !== undefined ? { totalBytes } : {}), words: words(`success${totalBytes !== undefined ? ` · ${gbWords(totalBytes)}` : ''} · ${rows} rows`) }
        }
      }
      if (chunk.done) break
    }
    return { skipped: false, success: false, lastStatus, rows, ...(totalBytes !== undefined ? { totalBytes } : {}), error: 'the stream ended without a success row', words: words(`the stream ended after ${rows} rows without success (last: ${lastStatus || 'none'})`) }
  } finally {
    clearTimeout(idle)
    io.signal?.removeEventListener('abort', onOuterAbort)
  }
}
