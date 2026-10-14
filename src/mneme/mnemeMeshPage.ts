import { factMemoryState } from './memoryRefs.js'
import { pendingRows } from './mnemeBuffer.js'
import { currentLedger, footnoteContext, footnotesOf } from './mnemeFootnotes.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { listArchiveDocs, listTopicDocs } from './mnemeLibrary.js'
import { readSignalLog, signalCounts, type SignalCounts } from './mnemeSignal.js'
import { ARCHIVE_PREFIX, expandSeqRange, isArchiveDoc, type MnemeEntry } from './mnemeTopicDocs.js'
import { readPins, readUsage } from './mnemeUsage.js'
import type { LedgerEntry } from './types.js'

export const MESH_PAGE_NAME = 'memory-mesh'
export const MESH_PAGE_TITLE = 'Memory — the library as a page'
export const MESH_FIRST_WORDS = 8

export type MeshNodeKind = 'fact' | 'ruling' | 'pending' | 'history' | 'session'
export type MeshEdgeKind = 'supersedes' | 'ruling' | 'session'

export interface MeshNode {
  id: string
  kind: MeshNodeKind
  firstWords: string
  text: string
  topic: string
  time: string
  source: string
  session?: number
  pinned: boolean
  stale: boolean
  counts: SignalCounts
}

export interface MeshEdge {
  from: string
  to: string
  kind: MeshEdgeKind
}

export interface MemoryMesh {
  nodes: MeshNode[]
  edges: MeshEdge[]
  outside: number
  library: string
  at: string
}

export function firstWords(text: string, n: number = MESH_FIRST_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.length <= n ? words.join(' ') : `${words.slice(0, n).join(' ')} …`
}

export function memoryMesh(dir: string = mnemeLibraryDir(), opts: { sessions?: readonly LedgerEntry[]; now?: Date; projectRoot?: string | null } = {}): MemoryMesh {
  const sessions = opts.sessions ?? currentLedger()
  const now = opts.now ?? new Date()
  const ctx = footnoteContext(dir, sessions)
  const pins = readPins(dir)
  const pinned = new Set(pins.map(pin => pin.seq))
  const usage = readUsage(dir)
  const counts = signalCounts(readSignalLog(dir))
  const countsOf = (id: string): SignalCounts => ({ offered: counts[id]?.offered ?? 0, opened: counts[id]?.opened ?? 0, cited: counts[id]?.cited ?? 0 })
  const nodes: MeshNode[] = []
  const edges: MeshEdge[] = []
  const seen = new Set<string>()
  const linkFrom = (id: string, notes: ReturnType<typeof footnotesOf>, supersedes: string | undefined): void => {
    if (supersedes) for (const seq of expandSeqRange(supersedes)) edges.push({ from: id, to: `seq:${seq}`, kind: 'supersedes' })
    if (notes.ruling) edges.push({ from: id, to: notes.ruling, kind: 'ruling' })
    if (notes.session !== undefined) edges.push({ from: id, to: `ledger:${notes.session}`, kind: 'session' })
  }
  const addEntry = (entry: MnemeEntry, topic: string, history: boolean): void => {
    const id = `seq:${entry.seq}`
    if (seen.has(id)) return
    seen.add(id)
    const notes = footnotesOf(entry, ctx)
    const state = history ? null : factMemoryState(entry, { pins, usage, now, libraryDir: dir, projectRoot: opts.projectRoot ?? null })
    nodes.push({
      id,
      kind: history ? 'history' : pinned.has(entry.seq) ? 'ruling' : 'fact',
      firstWords: firstWords(entry.text),
      text: entry.text,
      topic,
      time: entry.time,
      source: entry.source,
      ...(notes.session !== undefined ? { session: notes.session } : {}),
      pinned: pinned.has(entry.seq),
      stale: state?.status === 'stale',
      counts: countsOf(id),
    })
    linkFrom(id, notes, entry.supersedes)
  }
  for (const doc of [...listTopicDocs(dir), ...listArchiveDocs(dir)]) {
    const topic = isArchiveDoc(doc) ? `${ARCHIVE_PREFIX}${doc.slug}` : doc.slug
    for (const section of doc.sections) for (const entry of section.entries) addEntry(entry, topic, false)
    for (const entry of doc.history) addEntry(entry, topic, true)
  }
  for (const row of pendingRows(dir)) {
    const id = `pending:${row.ts}`
    if (seen.has(id)) continue
    seen.add(id)
    const notes = footnotesOf({ seq: 0, time: row.ts, source: row.source }, ctx)
    nodes.push({ id, kind: 'pending', firstWords: firstWords(row.text), text: row.text, topic: row.topicHint ?? 'general', time: row.ts, source: row.source, ...(notes.session !== undefined ? { session: notes.session } : {}), pinned: false, stale: false, counts: countsOf(id) })
    linkFrom(id, notes, undefined)
  }
  for (const s of sessions) {
    const id = `ledger:${s.ordinal}`
    if (seen.has(id)) continue
    seen.add(id)
    const note = s.handoff?.text ?? ''
    nodes.push({ id, kind: 'session', firstWords: `session ${s.ordinal} · ${s.startedAt.slice(0, 10)}`, text: note === '' ? 'no note left' : note, topic: 'lineage', time: s.startedAt, source: s.sessionId, session: s.ordinal, pinned: false, stale: false, counts: countsOf(id) })
  }
  const drawn = edges.filter(edge => seen.has(edge.from) && seen.has(edge.to))
  return { nodes, edges: drawn, outside: edges.length - drawn.length, library: dir, at: now.toISOString() }
}

export function meshSummary(mesh: MemoryMesh): string {
  const count = (kind: MeshNodeKind): number => mesh.nodes.filter(node => node.kind === kind).length
  const links = (kind: MeshEdgeKind): number => mesh.edges.filter(edge => edge.kind === kind).length
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  return [
    plural(count('fact'), 'fact'),
    plural(count('ruling'), 'pinned rule'),
    `${count('pending')} pending`,
    `${count('history')} in history`,
    plural(count('session'), 'session'),
    `${plural(links('supersedes') + links('ruling') + links('session'), 'link')} (${links('supersedes')} supersedes · ${links('ruling')} ruling · ${links('session')} session)`,
  ].join(' · ')
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function meshAnchor(id: string): string {
  return `rec-${id.replace(/[^A-Za-z0-9]+/g, '-')}`
}

const BOX_W = 230
const BOX_H = 58
const COL_GAP = 290
const ROW_GAP = 76
const PAD = 24

function clip(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`
}

export function renderMemoryMeshPage(mesh: MemoryMesh): string {
  const columns = new Map<number, MeshNode[]>()
  for (const node of mesh.nodes) {
    const column = node.session ?? 0
    columns.set(column, [...(columns.get(column) ?? []), node])
  }
  const order = [...columns.keys()].sort((a, b) => a - b)
  const place = new Map<string, { x: number; y: number }>()
  for (const [c, key] of order.entries()) {
    const list = columns.get(key)!.sort((a, b) => Number(b.kind === 'session') - Number(a.kind === 'session') || a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
    list.forEach((node, r) => place.set(node.id, { x: PAD + c * COL_GAP, y: PAD + 30 + r * ROW_GAP }))
  }
  const width = PAD * 2 + Math.max(1, order.length) * COL_GAP
  const height = PAD * 2 + 30 + Math.max(1, ...[...columns.values()].map(list => list.length)) * ROW_GAP
  const heads = order.map((key, c) => `<text class="col" x="${PAD + c * COL_GAP}" y="${PAD + 12}">${key === 0 ? 'no session recorded' : `session ${key}`}</text>`)
  const lines = mesh.edges.map(edge => {
    const a = place.get(edge.from)!
    const b = place.get(edge.to)!
    return `<line class="edge ${edge.kind}" data-edge="${escapeHtml(`${edge.from}|${edge.to}|${edge.kind}`)}" x1="${a.x + BOX_W / 2}" y1="${a.y + BOX_H / 2}" x2="${b.x + BOX_W / 2}" y2="${b.y + BOX_H / 2}" marker-end="url(#arrow-${edge.kind})"/>`
  })
  const boxes = mesh.nodes.map(node => {
    const p = place.get(node.id)!
    const marks = [node.pinned ? 'pinned' : '', node.stale ? 'stale' : '', node.kind === 'history' ? 'history' : '', node.kind === 'pending' ? 'pending' : ''].filter(Boolean).join(' · ')
    const tally = `offered ${node.counts.offered} · opened ${node.counts.opened} · cited ${node.counts.cited}`
    return [
      `<a href="#${meshAnchor(node.id)}"><g class="node ${node.kind}${node.pinned ? ' pinned' : ''}${node.stale ? ' stale' : ''}" data-node="${escapeHtml(node.id)}" data-kind="${node.kind}" data-pinned="${node.pinned}" data-stale="${node.stale}">`,
      `<rect x="${p.x}" y="${p.y}" width="${BOX_W}" height="${BOX_H}" rx="7"/>`,
      `<text x="${p.x + 9}" y="${p.y + 17}" class="id">${escapeHtml(node.id)}${marks ? ` · ${escapeHtml(marks)}` : ''}</text>`,
      `<text x="${p.x + 9}" y="${p.y + 34}" class="words">${escapeHtml(clip(node.firstWords, 40))}</text>`,
      node.kind === 'session' ? '' : `<text x="${p.x + 9}" y="${p.y + 50}" class="tally">${tally}</text>`,
      '</g></a>',
    ].join('')
  })
  const byId = new Map(mesh.nodes.map(node => [node.id, node]))
  const records = mesh.nodes.map(node => {
    const out = mesh.edges.filter(edge => edge.from === node.id)
    const into = mesh.edges.filter(edge => edge.to === node.id)
    const link = (id: string): string => `<a href="#${meshAnchor(id)}">${escapeHtml(id)}</a>${byId.get(id) ? ` <span class="muted">${escapeHtml(byId.get(id)!.firstWords)}</span>` : ''}`
    const word = (kind: MeshEdgeKind, outward: boolean): string => kind === 'supersedes' ? (outward ? 'supersedes' : 'superseded by') : kind === 'ruling' ? (outward ? 'made under ruling' : 'governs') : outward ? 'made in' : 'made here'
    const rows = [...out.map(edge => `<li>${word(edge.kind, true)} ${link(edge.to)}</li>`), ...into.map(edge => `<li>${word(edge.kind, false)} ${link(edge.from)}</li>`)]
    const marks = [node.pinned ? '<span class="mark pin">pinned</span>' : '', node.stale ? '<span class="mark stale">stale</span>' : '', node.kind === 'history' ? '<span class="mark">history</span>' : '', node.kind === 'pending' ? '<span class="mark">pending</span>' : ''].join('')
    return [
      `<section class="record" id="${meshAnchor(node.id)}">`,
      `<h3>${escapeHtml(node.id)} <span class="kind">${node.kind}</span>${marks}</h3>`,
      `<blockquote>${escapeHtml(node.text)}</blockquote>`,
      `<p class="meta">${escapeHtml([node.topic, node.time, node.source].filter(Boolean).join(' · '))}${node.kind === 'session' ? '' : ` · offered ${node.counts.offered} · opened ${node.counts.opened} · cited ${node.counts.cited}`}</p>`,
      rows.length > 0 ? `<ul>${rows.join('')}</ul>` : '',
      '</section>',
    ].join('')
  })
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(MESH_PAGE_TITLE)}</title>`,
    '<style>',
    'body{margin:0;padding:20px 24px 48px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1d2330;background:#f7f8fa}',
    'h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}h3{font-size:14px;margin:0 0 6px}',
    '.muted,.meta{color:#5b6475}.summary{margin:0 0 14px;color:#38404f}',
    '.legend span{display:inline-block;margin-right:16px}.legend i{display:inline-block;width:26px;height:0;border-top:2px solid;vertical-align:middle;margin-right:6px}',
    '.legend .supersedes i{border-color:#b4442c}.legend .ruling i{border-color:#2d5fb3;border-top-style:dashed}.legend .session i{border-color:#8a93a3;border-top-style:dotted}',
    '.mesh{overflow:auto;background:#fff;border:1px solid #dde1e8;border-radius:8px}',
    'svg text{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}svg .col{fill:#5b6475;font-weight:600}',
    '.node rect{fill:#fff;stroke:#9aa3b2;stroke-width:1.2}.node.ruling rect{stroke:#2d5fb3;stroke-width:2}.node.pending rect{stroke-dasharray:4 3}',
    '.node.history rect{fill:#f1f2f5}.node.session rect{fill:#eef3fb;stroke:#8a93a3}.node.stale{opacity:.55}.node:hover rect{stroke:#1d2330}',
    '.node .id{font-weight:600;fill:#1d2330}.node .words{fill:#38404f}.node .tally{fill:#6b7385;font-size:11px}',
    '.edge{stroke-width:1.4;fill:none}.edge.supersedes{stroke:#b4442c}.edge.ruling{stroke:#2d5fb3;stroke-dasharray:6 4}.edge.session{stroke:#8a93a3;stroke-dasharray:2 4}',
    '.record{background:#fff;border:1px solid #dde1e8;border-radius:8px;padding:12px 14px;margin:0 0 10px}.record:target{border-color:#2d5fb3;box-shadow:0 0 0 2px #c9d8f2}',
    '.record blockquote{margin:6px 0;padding:0 0 0 10px;border-left:3px solid #dde1e8;white-space:pre-wrap}.record ul{margin:6px 0 0;padding-left:18px}',
    '.kind{font-weight:400;color:#5b6475;margin-left:6px}.mark{font-size:11px;font-weight:600;border:1px solid #9aa3b2;border-radius:9px;padding:0 6px;margin-left:6px}.mark.pin{border-color:#2d5fb3;color:#2d5fb3}.mark.stale{border-color:#b4442c;color:#b4442c}',
    '</style></head><body>',
    `<h1>${escapeHtml(MESH_PAGE_TITLE)}</h1>`,
    `<p class="summary">${escapeHtml(meshSummary(mesh))}${mesh.outside > 0 ? ` · ${mesh.outside} link(s) point outside the library` : ''}</p>`,
    `<p class="muted">Drawn ${escapeHtml(mesh.at)} from ${escapeHtml(mesh.library)}. The page reads the library and writes nothing back; open a node for its record.</p>`,
    '<p class="legend"><span class="supersedes"><i></i>supersedes</span><span class="ruling"><i></i>made under a ruling</span><span class="session"><i></i>made in a session</span></p>',
    `<div class="mesh"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="the memory library as a graph">`,
    '<defs>',
    ...(['supersedes', 'ruling', 'session'] as const).map(kind => `<marker id="arrow-${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="edge ${kind}"/></marker>`),
    '</defs>',
    ...heads,
    ...lines,
    ...boxes,
    '</svg></div>',
    '<h2>Records</h2>',
    ...records,
    '</body></html>',
  ].join('\n')
}
