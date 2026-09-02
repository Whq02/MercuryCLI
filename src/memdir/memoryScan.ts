// ============================================================================
//  src/memdir/memoryScan.ts — directory scan → header list → manifest
//  formatting. A separate module so the memory-extraction path can import
//  the scan without pulling the side-query/API-client chain (closed an
//  import cycle).
// ============================================================================
import { readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { readCardMeta } from './experienceCards.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { scribeScopeEnabled } from '../utils/scribe/scribeGates.js'
import { open as openFile } from 'node:fs/promises'
import { partiallySanitizeUnicode } from '../utils/sanitization.js'
import { logForDebugging } from '../utils/debug.js'
import { parseMemoryType, type MemoryType } from './memoryTypes.js'
import { mapWithConcurrency } from '../utils/concurrency.js'

const INDEX_BASENAME = 'MEMORY.md'
const SUPERSEDED_MARKER = '.superseded.'
const SCAN_HEADER_LINES = 30
const SCAN_CAP = 200
/** Bounded header-read fan-out: N simultaneous opens on a spinning disk
 *  queue as effectively random seeks (SCAN_CAP bounds only the OUTPUT), and
 *  the memory directory only grows with machine age. */
const SCAN_READ_WIDTH = 8

export type MemoryHeader = {
  /** The path relative to the memory directory. */
  filename: string
  absolutePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
  problemClass: string | null
  transferabilityScope: string | null
}

/**
 * Scan a memory directory. Excluded: the index file, superseded audit
 * copies (they stay on disk for inspection and reversion but must never be
 * recall candidates), files whose FIRST path segment is an excluded scope
 * (a root-level file has no separator, so its whole name is tested — which
 * never matches a scope), and cards whose freshness is superseded or stale
 * (mirroring the promote gate so recall and promotion agree). Reads are
 * concurrent and settled; rejected reads drop silently; a failed directory
 * read returns the empty list. Newest first, capped at 200.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
  excludeScopes?: readonly string[],
): Promise<MemoryHeader[]> {
  const excluded = excludeScopes ?? (scribeScopeEnabled() ? ['scribe'] : [])
  let entries: string[]
  try {
    const found = await readdir(memoryDir, { recursive: true, withFileTypes: false })
    entries = (found as string[]).map(String)
  } catch {
    return []
  }
  const candidates = entries.filter(relative => {
    if (!relative.endsWith('.md')) return false
    const base = relative.includes(sep) ? relative.slice(relative.lastIndexOf(sep) + 1) : relative
    if (base === INDEX_BASENAME) return false
    if (base.includes(SUPERSEDED_MARKER)) return false
    const firstSegment = relative.includes(sep)
      ? relative.slice(0, relative.indexOf(sep))
      : relative
    if (relative.includes(sep) && excluded.includes(firstSegment)) return false
    return true
  })
  const rows = await mapWithConcurrency(candidates, SCAN_READ_WIDTH, async relative => {
    try {
      const absolutePath = join(memoryDir, relative)
      if (signal.aborted) return null
      // One pass: read the header prefix and stat through the same handle —
      // read-then-sort halves the syscalls versus stat-sort-read. (A shared
      // ranged reader was searched for — readFileRanged / readRange /
      // firstLines / readHead spellings across utils and tools — and none
      // exists; this inline read is the re-derivation, receipt-noted.)
      const handle = await openFile(absolutePath, 'r')
      let prefix: string
      let mtimeMs: number
      try {
        const stat = await handle.stat()
        mtimeMs = stat.mtimeMs
        const buffer = Buffer.alloc(Math.min(stat.size, 16384))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        prefix = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
      prefix = prefix.split('\n').slice(0, SCAN_HEADER_LINES).join('\n')
      const parsed = parseFrontmatter(prefix)
      const card = readCardMeta(parsed.frontmatter as Record<string, unknown>)
      if (card?.freshness === 'superseded' || card?.freshness === 'stale') return null
      const data = parsed.frontmatter as {
        description?: unknown
        type?: unknown
      }
      const header: MemoryHeader = {
        filename: relative,
        absolutePath,
        mtimeMs,
        description: typeof data.description === 'string' ? data.description : null,
        type: parseMemoryType(data.type),
        problemClass: card?.problemClass ?? null,
        transferabilityScope: card?.scope ?? null,
      }
      return header
    } catch {
      // Rejected reads drop silently — the settled contract, kept.
      return null
    }
  })
  const headers = rows.filter((value): value is MemoryHeader => value !== null)
  headers.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return headers.slice(0, SCAN_CAP)
}

/** Each field sanitized in its OWN try/catch — the sanitizer throws past 10
 *  normalization iterations, and one bad field must not blank the manifest. */
function sanitizeField(raw: string): string {
  try {
    return partiallySanitizeUnicode(raw)
  } catch (error) {
    logForDebugging(`memory manifest: field sanitization failed: ${String(error)}`)
    return raw
  }
}

/**
 * One line per header: a bullet, a bracketed type tag (trailing space) when
 * a type exists, the RAW filename (the recall round trip re-validates picks
 * against the raw name set — normalizing here would silently drop
 * decomposed-Unicode names), the ISO timestamp in parentheses, then the
 * description and the class/scope suffixes under the precision gate.
 */
export function formatMemoryManifest(memories: MemoryHeader[], precision = true): string {
  return memories
    .map(memory => {
      const typeTag = memory.type ? `[${memory.type}] ` : ''
      const description =
        memory.description !== null ? `: ${sanitizeField(memory.description)}` : ''
      const classSuffix =
        precision && memory.problemClass != null
          ? ` | class=${sanitizeField(memory.problemClass)}`
          : ''
      const scopeSuffix =
        precision && memory.transferabilityScope != null
          ? ` | scope=${sanitizeField(memory.transferabilityScope)}`
          : ''
      return `- ${typeTag}${memory.filename} (${new Date(memory.mtimeMs).toISOString()})${description}${classSuffix}${scopeSuffix}`
    })
    .join('\n')
}
