import { emptyArchiveDoc, emptyDoc, isArchiveDoc, type MnemeEntry, type MnemeSection, type MnemeTopicDoc } from './mnemeTopicDocs.js'
import { lastUsedMs, type PinRecord, type UsageRecord } from './mnemeUsage.js'

export const ARCHIVE_AFTER_DAYS = 90
export const INDEX_LIMIT = 40

const DAY_MS = 24 * 60 * 60 * 1000

export interface TidyInput {
  topics: Map<string, MnemeTopicDoc>
  archives: Map<string, MnemeTopicDoc>
  pins: readonly PinRecord[]
  usage: Record<string, UsageRecord>
  now: Date
}

export interface TidyResult {
  archived: number
  restored: number
  merged: number
  topicsArchived: string[]
  conserved: boolean
  touchedTopics: Set<string>
  touchedArchives: Set<string>
  removedTopics: Set<string>
  pinMoves: Array<[number, number]>
}

export function normaliseFact(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

interface LiveHolder {
  doc: MnemeTopicDoc
  section: MnemeSection
  entry: MnemeEntry
}

function mergeDuplicates(topics: Map<string, MnemeTopicDoc>, pins: readonly PinRecord[], nowIso: string, result: TidyResult): void {
  const asked = new Set(pins.filter(p => p.asked).map(p => p.seq))
  const pinned = new Set(pins.map(p => p.seq))
  const groups = new Map<string, LiveHolder[]>()
  for (const doc of topics.values()) {
    for (const section of doc.sections) {
      for (const entry of section.entries) {
        const key = normaliseFact(entry.text)
        if (!key) continue
        const list = groups.get(key) ?? []
        list.push({ doc, section, entry })
        groups.set(key, list)
      }
    }
  }
  const rank = (h: LiveHolder): number => (asked.has(h.entry.seq) ? 2 : pinned.has(h.entry.seq) ? 1 : 0)
  for (const holders of groups.values()) {
    if (holders.length < 2) continue
    const keeper = holders.reduce((best, h) => (rank(h) > rank(best) || (rank(h) === rank(best) && h.entry.seq > best.entry.seq) ? h : best))
    for (const h of holders) {
      if (h === keeper || asked.has(h.entry.seq)) continue
      const at = h.section.entries.indexOf(h.entry)
      if (at < 0) continue
      h.section.entries.splice(at, 1)
      h.doc.history.push({ ...h.entry, supersededBy: keeper.entry.seq })
      h.doc.updated = nowIso
      h.doc.updateLog.push(`${nowIso} seq ${h.entry.seq} merged into seq ${keeper.entry.seq} (the same fact twice)`)
      keeper.entry.supersedes = keeper.entry.supersedes ? `${keeper.entry.supersedes},${h.entry.seq}` : String(h.entry.seq)
      keeper.doc.updated = nowIso
      if (pinned.has(h.entry.seq)) result.pinMoves.push([h.entry.seq, keeper.entry.seq])
      result.merged++
      result.touchedTopics.add(h.doc.slug)
      result.touchedTopics.add(keeper.doc.slug)
    }
  }
}

export function seqCensus(docs: Iterable<MnemeTopicDoc>): string {
  const seqs: number[] = []
  for (const d of docs) {
    for (const s of d.sections) for (const e of s.entries) seqs.push(e.seq)
    for (const e of d.history) seqs.push(e.seq)
  }
  return seqs.sort((a, b) => a - b).join(',')
}

export function liveCount(doc: MnemeTopicDoc): number {
  let n = 0
  for (const s of doc.sections) n += s.entries.length
  return n
}

function topicLastUsedMs(doc: MnemeTopicDoc, usage: Record<string, UsageRecord>): number {
  let best = 0
  for (const s of doc.sections) for (const e of s.entries) best = Math.max(best, lastUsedMs(e.seq, e.time, usage))
  return best
}

function baseSlug(slug: string): string {
  const m = slug.match(/^(.*)-(\d+)$/)
  return m ? m[1]! : slug
}

export function indexTopics(topics: Iterable<MnemeTopicDoc>): Map<string, MnemeTopicDoc[]> {
  const groups = new Map<string, MnemeTopicDoc[]>()
  const docs = [...topics].filter(d => liveCount(d) > 0)
  const slugs = new Set(docs.map(d => d.slug))
  for (const d of docs) {
    const base = baseSlug(d.slug)
    const key = base !== d.slug && slugs.has(base) ? base : d.slug
    const list = groups.get(key) ?? []
    list.push(d)
    groups.set(key, list)
  }
  for (const list of groups.values()) list.sort((a, b) => a.slug.localeCompare(b.slug))
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function moveEntry(from: MnemeTopicDoc, to: MnemeTopicDoc, entry: MnemeEntry, heading: string): void {
  for (const s of from.sections) {
    const at = s.entries.indexOf(entry)
    if (at >= 0) {
      s.entries.splice(at, 1)
      break
    }
  }
  let section = to.sections.find(s => s.heading === heading)
  if (!section) {
    section = { heading, entries: [] }
    to.sections.push(section)
  }
  section.entries.push(entry)
}

function archiveFor(slug: string, topic: MnemeTopicDoc | undefined, archives: Map<string, MnemeTopicDoc>, nowIso: string): MnemeTopicDoc {
  let archive = archives.get(slug)
  if (!archive) {
    archive = emptyArchiveDoc(slug, topic?.summary ?? slug.replace(/-/g, ' '), nowIso)
    archives.set(slug, archive)
  }
  return archive
}

function topicFor(slug: string, archive: MnemeTopicDoc, topics: Map<string, MnemeTopicDoc>, nowIso: string): MnemeTopicDoc {
  let topic = topics.get(slug)
  if (!topic) {
    topic = emptyDoc(slug, archive.summary.replace(/ \(archived\)$/, ''), nowIso)
    topics.set(slug, topic)
  }
  return topic
}

export function tidyLibrary(input: TidyInput): TidyResult {
  const { topics, archives, pins, usage, now } = input
  const nowIso = now.toISOString()
  const pinned = new Set(pins.map(p => p.seq))
  const coldBefore = now.getTime() - ARCHIVE_AFTER_DAYS * DAY_MS
  const before = seqCensus([...topics.values(), ...archives.values()])
  const result: TidyResult = {
    archived: 0,
    restored: 0,
    merged: 0,
    topicsArchived: [],
    conserved: true,
    touchedTopics: new Set(),
    touchedArchives: new Set(),
    removedTopics: new Set(),
    pinMoves: [],
  }

  mergeDuplicates(topics, pins, nowIso, result)

  for (const [slug, archive] of [...archives.entries()]) {
    if (isArchiveDoc(archive) === false) continue
    const warm: Array<{ entry: MnemeEntry; heading: string }> = []
    for (const s of archive.sections) {
      for (const e of s.entries) {
        if (lastUsedMs(e.seq, e.time, usage) >= coldBefore || pinned.has(e.seq)) warm.push({ entry: e, heading: s.heading })
      }
    }
    if (warm.length === 0) continue
    const topic = topicFor(slug, archive, topics, nowIso)
    for (const { entry, heading } of warm) moveEntry(archive, topic, entry, heading)
    result.restored += warm.length
    topic.updated = nowIso
    topic.updateLog.push(`${nowIso} restored ${warm.length} fact(s) from the archive (used again)`)
    archive.updated = nowIso
    archive.updateLog.push(`${nowIso} ${warm.length} fact(s) restored to topic-${slug}`)
    result.touchedTopics.add(slug)
    result.touchedArchives.add(slug)
  }

  for (const [slug, topic] of [...topics.entries()]) {
    const cold: Array<{ entry: MnemeEntry; heading: string }> = []
    for (const s of topic.sections) {
      for (const e of s.entries) {
        if (!pinned.has(e.seq) && lastUsedMs(e.seq, e.time, usage) < coldBefore) cold.push({ entry: e, heading: s.heading })
      }
    }
    if (cold.length === 0) continue
    const archive = archiveFor(slug, topic, archives, nowIso)
    for (const { entry, heading } of cold) moveEntry(topic, archive, entry, heading)
    result.archived += cold.length
    topic.updated = nowIso
    topic.updateLog.push(`${nowIso} archived ${cold.length} fact(s) not used for ${ARCHIVE_AFTER_DAYS} days`)
    archive.updated = nowIso
    archive.updateLog.push(`${nowIso} +${cold.length} fact(s) from topic-${slug} (not used for ${ARCHIVE_AFTER_DAYS} days)`)
    result.touchedTopics.add(slug)
    result.touchedArchives.add(slug)
  }

  let groups = indexTopics(topics.values())
  if (groups.size > INDEX_LIMIT) {
    const candidates = [...groups.entries()]
      .filter(([, docs]) => docs.every(d => !d.sections.some(s => s.entries.some(e => pinned.has(e.seq)))))
      .map(([key, docs]) => ({ key, docs, used: Math.max(...docs.map(d => topicLastUsedMs(d, usage))) }))
      .sort((a, b) => a.used - b.used || a.key.localeCompare(b.key))
    for (const candidate of candidates) {
      if (groups.size <= INDEX_LIMIT) break
      for (const topic of candidate.docs) {
        const archive = archiveFor(topic.slug, topic, archives, nowIso)
        let moved = 0
        for (const s of [...topic.sections]) {
          for (const e of [...s.entries]) {
            moveEntry(topic, archive, e, s.heading)
            moved++
          }
        }
        archive.history.push(...topic.history)
        topic.history = []
        archive.updated = nowIso
        archive.updateLog.push(`${nowIso} whole topic archived to keep the index under ${INDEX_LIMIT} lines (${moved} fact(s))`)
        result.archived += moved
        result.touchedArchives.add(topic.slug)
        result.removedTopics.add(topic.slug)
        result.touchedTopics.delete(topic.slug)
        topics.delete(topic.slug)
      }
      result.topicsArchived.push(candidate.key)
      groups = indexTopics(topics.values())
    }
  }

  const after = seqCensus([...topics.values(), ...archives.values()])
  result.conserved = before === after
  return result
}
