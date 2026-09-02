// ============================================================================
//  resources/adapters/structure — mercury://structure/*.
//  Feature-owned kind, registered from the structure slice (the registry
//  never imports an unbuilt subsystem):
//    mercury://structure                 — recorded queries + previews
//    mercury://structure/query/<id>     — one bounded query result
//    mercury://structure/preview/<id>   — one preview (state · files ·
//                                          before/after · applied refs)
// ============================================================================

import { structureEnabled } from '../../structure/contracts.js'
import {
  getPreview,
  getQuery,
  listPreviews,
  listQueries,
  structureIdExpired,
} from '../../structure/store.js'
import { registerResourceAdapter } from '../registry.js'
import type { ResourceAdapter, ResourceChild } from '../contracts.js'

export const structureAdapter: ResourceAdapter = {
  kind: 'structure',
  describe: 'structural queries + previewed codemods (query/<id> · preview/<id>)',
  async resolve(ref, ctx) {
    if (!structureEnabled()) {
      return { state: 'unavailable', note: 'the structural plane is disabled (MERCURY_STRUCTURE=0)' }
    }
    const [sub, id] = [ref.id.split('/')[0], ref.id.split('/').slice(1).join('/')]
    if (!sub) {
      const children: ResourceChild[] = [
        ...listQueries(ctx.owner).map(q => ({
          ref: `mercury://structure/query/${q.id}`,
          title: q.id,
          summary: `${q.query.pattern ? `pattern ${JSON.stringify(q.query.pattern.slice(0, 40))}` : q.query.select}${q.query.name ? ` '${q.query.name}'` : ''} — ${q.matches.length} match(es)`,
        })),
        ...listPreviews(ctx.owner).map(p => ({
          ref: `mercury://structure/preview/${p.id}`,
          title: p.id,
          summary: `[${p.state}] ${p.transform.action} · ${p.matchCount} match(es) · ${p.files.length} file(s)`,
        })),
      ]
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://structure',
          kind: 'structure',
          title: 'structural plane',
          summary: `${children.length} recorded object(s) this conversation`,
          mutable: true,
          children,
        },
      }
    }
    if (sub === 'query') {
      const q = getQuery(ctx.owner, id)
      if (!q) {
        if (structureIdExpired(ctx.owner, id)) {
          return { state: 'expired', note: `query '${id}' fell off the bounded ring (16 kept) — re-run the query` }
        }
        return { state: 'absent', note: `no query '${id}' in this conversation` }
      }
      return {
        state: 'ok',
        resource: {
          ref: `mercury://structure/query/${q.id}`,
          kind: 'structure',
          title: q.id,
          summary: `${q.matches.length} match(es) · ${q.parsed} parsed of ${q.scanned} scanned${q.truncated ? ' · TRUNCATED' : ''}`,
          mutable: false,
          structured: {
            query: q.query,
            matches: q.matches.map(m => ({
              id: m.id,
              file: m.file,
              range: m.range,
              kind: m.kind,
              context: m.context,
            })),
            parseFailures: q.parseFailures,
            truncated: q.truncated,
          },
        },
      }
    }
    if (sub === 'preview') {
      const p = getPreview(ctx.owner, id)
      if (!p) {
        if (structureIdExpired(ctx.owner, id)) {
          return { state: 'expired', note: `preview '${id}' fell off the bounded ring (16 kept) — re-preview` }
        }
        return { state: 'absent', note: `no preview '${id}' in this conversation` }
      }
      return {
        state: 'ok',
        resource: {
          ref: `mercury://structure/preview/${p.id}`,
          kind: 'structure',
          title: `${p.id} [${p.state}]`,
          summary: `${p.transform.action} · ${p.matchCount} match(es) · ${p.files.length} file(s) · ~${p.totalChangedLines} changed line(s)`,
          mutable: p.state === 'proposed',
          structured: {
            state: p.state,
            queryId: p.queryId,
            transform: p.transform,
            files: p.files.map(f => ({
              file: f.file,
              edits: f.edits.length,
              before: f.before,
              after: f.after,
              anchor: f.anchor,
              changedLines: f.changedLines,
            })),
            diagnosticsPlanned: p.diagnosticsPlanned,
            ...(p.note !== undefined && { note: p.note }),
            ...(p.changedPaths !== undefined && { changedPaths: p.changedPaths }),
            ...(p.receiptRef !== undefined && { receiptRef: p.receiptRef }),
            ...(p.transactionRef !== undefined && { transactionRef: p.transactionRef }),
            ...(p.evidenceRefs !== undefined && { evidenceRefs: p.evidenceRefs }),
          },
        },
      }
    }
    return { state: 'absent', note: `unknown structure sub-resource '${sub}' — use query/<id> or preview/<id>` }
  },
  async list(ctx) {
    return [
      ...listQueries(ctx.owner).map(q => ({
        ref: `mercury://structure/query/${q.id}`,
        title: q.id,
        summary: `${q.matches.length} match(es)`,
      })),
      ...listPreviews(ctx.owner).map(p => ({
        ref: `mercury://structure/preview/${p.id}`,
        title: p.id,
        summary: `[${p.state}] ${p.transform.action}`,
      })),
    ]
  },
}

registerResourceAdapter(structureAdapter)
