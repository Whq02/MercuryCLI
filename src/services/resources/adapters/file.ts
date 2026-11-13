
import { closeSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import type { ToolPermissionContext } from '../../../Tool.js'
import { getPathsForPermissionCheck } from '../../../utils/fsOperations.js'
import { readDenialFilter } from '../../../utils/permissions/filesystem.js'
import { mercurySecretPath } from '../../../utils/permissions/protectedPaths.js'
import { NotARegularFileError, notAFileKind, notAFileRefusal, openRegularFileSync } from '../../../utils/regularFile.js'
import { mintFileAnchor } from '../../changeTransaction/snapshotAnchor.js'
import {
  boundedTextView,
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'
import { fileReferenceCandidates } from '../referencePaths.js'

const DIR_ENTRY_CAP = 200
const MAX_TEXT_BYTES = 2_000_000

export const fileAdapter: ResourceAdapter = {
  kind: 'file',
  describe: 'files and directories (mercury://file/<path>?lines=A-B&q=…)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (!ref.id) return { state: 'absent', note: 'file refs need a path: mercury://file/<path>' }
    const candidates = fileReferenceCandidates(ref.id, ctx.cwd)
    for (const candidate of candidates) {
      const secret = mercurySecretPath(candidate, ctx.cwd)
      if (secret !== null) {
        return {
          state: 'unavailable',
          note: `Reading ${candidate} is refused: ${secret} holds Mercury's own credentials; use the product's sign-in and account surfaces instead.`,
        }
      }
    }
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
    const notAFile = notAFileKind(info)
    if (notAFile !== null) return { state: 'unavailable', note: notAFileRefusal(abs, notAFile) }
    const version = `m${Math.floor(info.mtimeMs)}-s${info.size}`
    if (info.isDirectory()) {
      let entries
      try {
        const rules = (ctx.getAppState?.() as { toolPermissionContext?: ToolPermissionContext } | undefined)?.toolPermissionContext
        const denied = rules === undefined ? undefined : readDenialFilter(rules, abs)
        entries = readdirSync(abs, { withFileTypes: true })
          .filter(e => mercurySecretPath(path.join(abs, e.name), ctx.cwd) === null)
          .filter(e => denied === undefined || !(e.isSymbolicLink() ? getPathsForPermissionCheck(path.join(abs, e.name)).some(form => denied(form)) : denied(path.join(abs, e.name))))
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
    let held: ReturnType<typeof openRegularFileSync>
    try {
      held = openRegularFileSync(abs, info)
    } catch (e) {
      if (e instanceof NotARegularFileError) return { state: 'unavailable', note: e.message }
      return { state: 'busy', note: `cannot read ${abs}: ${e instanceof Error ? e.message : String(e)}` }
    }
    try {
      const size = held.stats.size
      const heldVersion = `m${Math.floor(held.stats.mtimeMs)}-s${size}`
      if (size > MAX_TEXT_BYTES) {
        return {
          state: 'ok',
          resource: {
            ref: ref.canonical,
            kind: 'file',
            title: path.basename(abs),
            summary: `file too large for a resource view (${size} bytes) — use Read with offset/limit`,
            version: heldVersion,
            mutable: true,
          },
        }
      }
      let text: string
      try {
        text = readFileSync(held.fd, 'utf8')
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
          summary: `file · ${size} bytes · anchor ${mintFileAnchor(text)}`,
          version: heldVersion,
          mutable: true,
          text: view.text,
          page: view.page,
        },
      }
    } finally {
      closeSync(held.fd)
    }
  },
}
