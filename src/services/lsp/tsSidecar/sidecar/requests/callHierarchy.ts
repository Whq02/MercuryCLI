import { type LspRange, type LspCallHierarchyItem, offsetAt, spanToRange, fromUri } from '../lsp.js'
import { callItemOf } from '../convert.js'
import type { DocContext, RequireState } from '../needs.js'

export function prepareCallHierarchyRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, offset } = docContext(params)
  const prepared = project.service.prepareCallHierarchy(file, offset)
  if (!prepared) return null
  const items = Array.isArray(prepared) ? prepared : [prepared]
  return items
    .map(i => callItemOf(st, i))
    .filter((i): i is LspCallHierarchyItem => i !== undefined)
}

export function incomingCallsRequest(params: unknown, requireState: RequireState): unknown {
  const st = requireState()
  const p = params as { item: LspCallHierarchyItem }
  const file = st.normalize(fromUri(p.item.uri))
  const text = st.textOf(file) ?? ''
  const project = st.projectFor(file)
  const offset = offsetAt(text, p.item.selectionRange.start)
  const calls = project.service.provideCallHierarchyIncomingCalls(
    file,
    offset,
  )
  const out: { from: LspCallHierarchyItem; fromRanges: LspRange[] }[] =
    []
  for (const call of calls) {
    const from = callItemOf(st, call.from)
    if (!from) continue
    const fromText = st.textOf(st.normalize(call.from.file)) ?? ''
    out.push({
      from,
      fromRanges: call.fromSpans.map(s =>
        spanToRange(fromText, s.start, s.length),
      ),
    })
  }
  return out
}

export function outgoingCallsRequest(params: unknown, requireState: RequireState): unknown {
  const st = requireState()
  const p = params as { item: LspCallHierarchyItem }
  const file = st.normalize(fromUri(p.item.uri))
  const text = st.textOf(file) ?? ''
  const project = st.projectFor(file)
  const offset = offsetAt(text, p.item.selectionRange.start)
  const calls = project.service.provideCallHierarchyOutgoingCalls(
    file,
    offset,
  )
  const out: { to: LspCallHierarchyItem; fromRanges: LspRange[] }[] = []
  for (const call of calls) {
    const to = callItemOf(st, call.to)
    if (!to) continue
    out.push({
      to,
      fromRanges: call.fromSpans.map(s =>
        spanToRange(text, s.start, s.length),
      ),
    })
  }
  return out
}
