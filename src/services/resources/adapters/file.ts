
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import { mintFileAnchor } from '../../changeTransaction/snapshotAnchor.js'
import {
  boundedTextView,
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

const DIR_ENTRY_CAP = 200
const MAX_TEXT_BYTES = 2_000_000

export const fileAdapter: ResourceAdapter = {
  kind: 'file',
  describe: 'files and directories (mercury://file/<path>?lines=A-B&q=…)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (!ref.id) return { state: 'absent', note: 'file refs need a path: mercury://file/<path>' }
    const candidates = path.isAbsolute(ref.id)
      ? [ref.id]
      : [...new Set([path.resolve(ctx.cwd, ref.id), path.resolve(getOriginalCwd(), ref.id)])]
    let abs = candidates[0]!
    let info
    for (const candidate of candidates) {
      try {
        info = statSync(candidate)
        abs = candidate
        break
      } catch {
      }
    }
    if (!info) {
      return {
        state: 'absent',
        note: `no such file or directory: ${candidates.join(' · ')}`,
      }
    }
    const version = `m${Math.floor(info.mtimeMs)}-s${info.size}`
    if (info.isDirectory()) {
      let entries
      try {
        entries = readdirSync(abs, { withFileTypes: true })
      } catch (e) {
        return { state: 'busy', note: `cannot list ${abs}: ${e instanceof Error ? e.message : String(e)}` }
      }
      const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
      const shown = sorted.slice(0, DIR_ENTRY_CAP)
      return {
        state: 'ok',
        resource: {
          ref: ref.canonical,
          kind: 'file',
          title: path.basename(abs) || abs,
          summary: `directory · ${sorted.length} entries${sorted.length > shown.length ? ` (showing ${shown.length})` : ''}`,
          version,
          mutable: true,
          children: shown.map(e => ({
            ref: formatRef('file', path.join(abs, e.name)),
            title: e.name + (e.isDirectory() ? '/' : ''),
            summary: e.isDirectory() ? 'directory' : 'file',
          })),
        },
      }
    }
    if (info.size > MAX_TEXT_BYTES) {
      return {
        state: 'ok',
        resource: {
          ref: ref.canonical,
          kind: 'file',
          title: path.basename(abs),
          summary: `file too large for a resource view (${info.size} bytes) — use Read with offset/limit`,
          version,
          mutable: true,
        },
      }
    }
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch (e) {
      return { state: 'busy', note: `cannot read ${abs}: ${e instanceof Error ? e.message : String(e)}` }
    }
    const view = boundedTextView(text, ref.selectors)
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'file',
        title: path.basename(abs),
        summary: `file · ${info.size} bytes · anchor ${mintFileAnchor(text)}`,
        version,
        mutable: true,
        text: view.text,
        page: view.page,
      },
    }
  },
}
