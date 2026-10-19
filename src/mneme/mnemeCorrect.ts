


import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { appendObservation, currentBufferPath, observationOverflow, pendingRows, type MnemeObservation } from './mnemeBuffer.js'
import { publishLibraryFile } from './mnemeLibrary.js'
import { memorySecretRefusal } from './mnemeSecretGuard.js'
import {
  acquireConsolidateLock,
  claimBufferFile,
  listArchiveDocs,
  listTopicDocs,
  readLibraryMeta,
  releaseConsolidateLock,
  validateDraft,
  writeLibraryMeta,
  writeDoc,
} from './mnemeConsolidate.js'
import {
  applyRevision,
  expandSeqRange,
  fileNameFor,
  liveSeqs,
  parseTopicDoc,
  type MnemeEntry,
  type MnemeTopicDoc,
} from './mnemeTopicDocs.js'
import { publishFrontPage } from './mnemeFrontPage.js'
import { isPinned, movePin, readPins, unpinFact } from './mnemeUsage.js'

function allDocs(dir: string): MnemeTopicDoc[] {
  return [...listTopicDocs(dir), ...listArchiveDocs(dir)]
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')
const sigSafe = (s: string): string => s.replace(/[,<>\r\n]+/g, '-')

export type MnemeCorrectResult =
  | { ok: true; action: 'corrected' | 'retired' | 'pointed'; seq: number; targetSeq: number; slug: string }
  | {
      ok: false
      code: 'off' | 'unknown-target' | 'already-superseded' | 'busy' | 'invalid' | 'secret' | 'user-asked-rule' | 'error'
      message: string
      supersededBy?: number
    }

export const USER_ASKED_RULE_ROAD = 'in /memory, under pinned rules, ↵ opens the rule: c corrects it (the old wording goes to history, the pin follows the new one), u unpins it'

export function userAskedRuleMessage(ref: number | string): string {
  return `${typeof ref === 'number' ? `seq ${ref}` : ref} is a rule the user asked Mercury to remember — only the user changes it: ${USER_ASKED_RULE_ROAD}`
}

function userAskedRule(targetSeq: number, dir: string, byUser: boolean | undefined): MnemeCorrectResult | null {
  if (byUser === true) return null
  const pin = readPins(dir).find(p => p.seq === targetSeq)
  return pin?.asked ? { ok: false, code: 'user-asked-rule', message: userAskedRuleMessage(targetSeq) } : null
}

interface Holder {
  doc: MnemeTopicDoc
  heading: string
  entry: MnemeEntry
}

function findTarget(
  targetSeq: number,
  dir: string,
): { live?: Holder; history?: { slug: string; supersededBy?: number } } {
  for (const doc of allDocs(dir)) {
    for (const s of doc.sections) {
      const entry = s.entries.find(e => e.seq === targetSeq)
      if (entry) return { live: { doc, heading: s.heading, entry } }
    }
    const h = doc.history.find(e => e.seq === targetSeq)
    if (h) return { history: { slug: doc.slug, supersededBy: h.supersededBy } }
  }
  return {}
}

function verifyLanded(dir: string, written: MnemeTopicDoc, newSeq: number, targetSeq: number, expectLive: boolean): boolean {
  try {
    const p = join(dir, fileNameFor(written))
    if (!existsSync(p)) return false
    const doc = parseTopicDoc(readFileSync(p, 'utf8'))
    if (!doc) return false
    const liveHasNew = liveSeqs(doc).has(newSeq)
    const hist = doc.history.find(e => e.seq === targetSeq)
    return (expectLive ? liveHasNew : !liveSeqs(doc).has(targetSeq)) && !!hist && hist.supersededBy === newSeq
  } catch {
    return false
  }
}

export function correctFact(input: {
  targetSeq: number
  text: string
  source: string
  dir?: string
  now?: Date
  byUser?: boolean
}): MnemeCorrectResult {
  if (!mnemeEnabled()) return { ok: false, code: 'off', message: 'memory is off (memory.enabled is false in settings).' }
  const dir = input.dir ?? mnemeLibraryDir()
  const text = oneLine(String(input.text ?? '')).trim()
  const source = sigSafe(String(input.source ?? '')).trim()
  if (!text || !source) return { ok: false, code: 'invalid', message: 'correction needs non-empty text and source' }
  const secret = memorySecretRefusal(text)
  if (secret !== null) return { ok: false, code: 'secret', message: `the correction ${secret}` }
  if (!Number.isInteger(input.targetSeq) || input.targetSeq < 1) {
    return { ok: false, code: 'invalid', message: `targetSeq must be a positive integer, got ${String(input.targetSeq)}` }
  }
  if (!acquireConsolidateLock(dir)) {
    return { ok: false, code: 'busy', message: 'a consolidation/correction is in progress — retry in a moment' }
  }
  try {
    const found = findTarget(input.targetSeq, dir)
    if (!found.live) {
      if (found.history) {
        return {
          ok: false,
          code: 'already-superseded',
          message: `seq ${input.targetSeq} is history in topic-${found.history.slug}${found.history.supersededBy ? ` (superseded by ${found.history.supersededBy})` : ''} — correct the CURRENT entry instead`,
          supersededBy: found.history.supersededBy,
        }
      }
      return { ok: false, code: 'unknown-target', message: `seq ${input.targetSeq} is not in this library` }
    }
    const asked = userAskedRule(input.targetSeq, dir, input.byUser)
    if (asked) return asked
    const { doc, heading } = found.live
    const meta = readLibraryMeta(dir)
    const newSeq = meta.seqCounter + 1
    const nowIso = (input.now ?? new Date()).toISOString()
    const draftRow = { ts: nowIso, source, text, topicHint: doc.slug, seq: newSeq }
    const libraryLive = new Set<number>()
    for (const d of allDocs(dir)) for (const s of liveSeqs(d)) libraryLive.add(s)
    const verdict = validateDraft(
      { blocks: [{ topicSlug: doc.slug, heading, entries: [{ text, seq: newSeq, time: nowIso, source, supersedes: String(input.targetSeq) }] }] },
      { rows: [draftRow], libraryLiveSeqs: libraryLive },
    )
    if (!verdict.ok) return { ok: false, code: 'invalid', message: `correction draft refused: ${verdict.reason}` }

    writeLibraryMeta({ version: 1, seqCounter: newSeq, lastConsolidatedAt: meta.lastConsolidatedAt }, dir)
    const entry: MnemeEntry = { text, seq: newSeq, time: nowIso, source, supersedes: String(input.targetSeq) }
    applyRevision(doc, entry, heading)
    doc.updated = nowIso
    doc.updateLog.push(`${nowIso} corrected seq ${input.targetSeq} → ${newSeq}`)
    writeDoc(doc, dir)
    if (!verifyLanded(dir, doc, newSeq, input.targetSeq, true)) {
      return { ok: false, code: 'error', message: 'post-write verification failed — the correction may not have landed; re-read and retry' }
    }
    if (isPinned(input.targetSeq, dir)) {
      movePin(input.targetSeq, newSeq, dir, input.byUser === true)
      publishFrontPage(dir, input.now ?? new Date())
    }
    return { ok: true, action: 'corrected', seq: newSeq, targetSeq: input.targetSeq, slug: doc.slug }
  } catch (e) {
    return { ok: false, code: 'error', message: String(e).slice(0, 200) }
  } finally {
    releaseConsolidateLock(dir)
  }
}

export function retireFact(input: {
  targetSeq: number
  reason: string
  source: string
  dir?: string
  now?: Date
  byUser?: boolean
}): MnemeCorrectResult {
  if (!mnemeEnabled()) return { ok: false, code: 'off', message: 'memory is off (memory.enabled is false in settings).' }
  const dir = input.dir ?? mnemeLibraryDir()
  const reason = oneLine(String(input.reason ?? '')).trim()
  const source = sigSafe(String(input.source ?? '')).trim()
  if (!reason || !source) return { ok: false, code: 'invalid', message: 'retire needs a non-empty reason and source' }
  if (!Number.isInteger(input.targetSeq) || input.targetSeq < 1) {
    return { ok: false, code: 'invalid', message: `targetSeq must be a positive integer, got ${String(input.targetSeq)}` }
  }
  if (!acquireConsolidateLock(dir)) {
    return { ok: false, code: 'busy', message: 'a consolidation/correction is in progress — retry in a moment' }
  }
  try {
    const found = findTarget(input.targetSeq, dir)
    if (!found.live) {
      if (found.history) {
        return {
          ok: false,
          code: 'already-superseded',
          message: `seq ${input.targetSeq} is already history in topic-${found.history.slug}`,
          supersededBy: found.history.supersededBy,
        }
      }
      return { ok: false, code: 'unknown-target', message: `seq ${input.targetSeq} is not in this library` }
    }
    const asked = userAskedRule(input.targetSeq, dir, input.byUser)
    if (asked) return asked
    const { doc, heading, entry: target } = found.live
    const meta = readLibraryMeta(dir)
    const newSeq = meta.seqCounter + 1
    const nowIso = (input.now ?? new Date()).toISOString()
    writeLibraryMeta({ version: 1, seqCounter: newSeq, lastConsolidatedAt: meta.lastConsolidatedAt }, dir)
    const tombstone: MnemeEntry = {
      text: `retired: ${reason} (was: ${target.text.slice(0, 120)})`,
      seq: newSeq,
      time: nowIso,
      source,
      supersedes: String(input.targetSeq),
    }
    applyRevision(doc, tombstone, heading)
    const section = doc.sections.find(s => s.heading === heading)
    if (section) {
      const at = section.entries.findIndex(e => e.seq === newSeq)
      if (at >= 0) {
        doc.history.push(section.entries[at]!)
        section.entries.splice(at, 1)
      }
    }
    doc.updated = nowIso
    doc.updateLog.push(`${nowIso} retired seq ${input.targetSeq} (${reason.slice(0, 60)})`)
    writeDoc(doc, dir)
    if (!verifyLanded(dir, doc, newSeq, input.targetSeq, false)) {
      return { ok: false, code: 'error', message: 'post-write verification failed — the retirement may not have landed; re-read and retry' }
    }
    if (isPinned(input.targetSeq, dir)) {
      unpinFact(input.targetSeq, dir)
      publishFrontPage(dir, input.now ?? new Date())
    }
    return { ok: true, action: 'retired', seq: newSeq, targetSeq: input.targetSeq, slug: doc.slug }
  } catch (e) {
    return { ok: false, code: 'error', message: String(e).slice(0, 200) }
  } finally {
    releaseConsolidateLock(dir)
  }
}

export function pointFact(input: {
  targetSeq: number
  replacementSeq: number
  reason: string
  source: string
  dir?: string
  now?: Date
  byUser?: boolean
}): MnemeCorrectResult {
  if (!mnemeEnabled()) return { ok: false, code: 'off', message: 'memory is off (memory.enabled is false in settings).' }
  const dir = input.dir ?? mnemeLibraryDir()
  const reason = oneLine(String(input.reason ?? '')).trim()
  const source = sigSafe(String(input.source ?? '')).trim()
  if (!reason || !source) return { ok: false, code: 'invalid', message: 'pointing at an existing truth needs a non-empty reason and source' }
  for (const seq of [input.targetSeq, input.replacementSeq]) {
    if (!Number.isInteger(seq) || seq < 1) return { ok: false, code: 'invalid', message: `seq must be a positive integer, got ${String(seq)}` }
  }
  if (input.targetSeq === input.replacementSeq) return { ok: false, code: 'invalid', message: `seq ${input.targetSeq} cannot replace itself` }
  if (!acquireConsolidateLock(dir)) {
    return { ok: false, code: 'busy', message: 'a consolidation/correction is in progress — retry in a moment' }
  }
  try {
    const found = findTarget(input.targetSeq, dir)
    if (!found.live) {
      if (found.history) {
        return {
          ok: false,
          code: 'already-superseded',
          message: `seq ${input.targetSeq} is already history in topic-${found.history.slug}`,
          supersededBy: found.history.supersededBy,
        }
      }
      return { ok: false, code: 'unknown-target', message: `seq ${input.targetSeq} is not in this library` }
    }
    const replacement = findTarget(input.replacementSeq, dir)
    if (!replacement.live) return { ok: false, code: 'unknown-target', message: `replacement seq ${input.replacementSeq} is not live in this library` }
    const asked = userAskedRule(input.targetSeq, dir, input.byUser)
    if (asked) return asked
    const { doc, heading, entry: target } = found.live
    const holder = replacement.live.doc.id === doc.id ? doc : replacement.live.doc
    const successor = holder === doc ? doc.sections.flatMap(s => s.entries).find(e => e.seq === input.replacementSeq)! : replacement.live.entry
    const meta = readLibraryMeta(dir)
    const newSeq = meta.seqCounter + 1
    const nowIso = (input.now ?? new Date()).toISOString()
    writeLibraryMeta({ version: 1, seqCounter: newSeq, lastConsolidatedAt: meta.lastConsolidatedAt }, dir)
    const section = doc.sections.find(s => s.heading === heading)!
    section.entries = section.entries.filter(e => e.seq !== input.targetSeq)
    doc.history.push({ ...target, supersededBy: input.replacementSeq })
    doc.history.push({
      text: `superseded by seq ${input.replacementSeq}: ${reason} (was: ${target.text.slice(0, 120)})`,
      seq: newSeq,
      time: nowIso,
      source,
      supersedes: String(input.targetSeq),
    })
    doc.updated = nowIso
    doc.updateLog.push(`${nowIso} seq ${input.targetSeq} superseded by ${input.replacementSeq} (${reason.slice(0, 60)})`)
    const already = successor.supersedes ? expandSeqRange(successor.supersedes).includes(input.targetSeq) : false
    if (!already) successor.supersedes = successor.supersedes ? `${successor.supersedes},${input.targetSeq}` : String(input.targetSeq)
    if (holder !== doc) {
      holder.updated = nowIso
      holder.updateLog.push(`${nowIso} seq ${input.replacementSeq} now supersedes ${input.targetSeq} (in topic-${doc.slug})`)
    }
    writeDoc(doc, dir)
    if (holder !== doc) writeDoc(holder, dir)
    if (!verifyPointed(dir, doc, holder, newSeq, input.targetSeq, input.replacementSeq)) {
      return { ok: false, code: 'error', message: 'post-write verification failed — the supersede may not have landed; re-read and retry' }
    }
    if (isPinned(input.targetSeq, dir)) {
      movePin(input.targetSeq, input.replacementSeq, dir, input.byUser === true)
      publishFrontPage(dir, input.now ?? new Date())
    }
    return { ok: true, action: 'pointed', seq: newSeq, targetSeq: input.targetSeq, slug: doc.slug }
  } catch (e) {
    return { ok: false, code: 'error', message: String(e).slice(0, 200) }
  } finally {
    releaseConsolidateLock(dir)
  }
}

function verifyPointed(dir: string, written: MnemeTopicDoc, holder: MnemeTopicDoc, auditSeq: number, targetSeq: number, replacementSeq: number): boolean {
  try {
    const doc = parseTopicDoc(readFileSync(join(dir, fileNameFor(written)), 'utf8'))
    const other = holder === written ? doc : parseTopicDoc(readFileSync(join(dir, fileNameFor(holder)), 'utf8'))
    if (!doc || !other) return false
    const moved = doc.history.find(e => e.seq === targetSeq)
    const audit = doc.history.find(e => e.seq === auditSeq)
    const successor = other.sections.flatMap(s => s.entries).find(e => e.seq === replacementSeq)
    return (
      !liveSeqs(doc).has(targetSeq) &&
      moved?.supersededBy === replacementSeq &&
      audit?.supersedes === String(targetSeq) &&
      successor !== undefined &&
      expandSeqRange(successor.supersedes ?? '').includes(targetSeq)
    )
  } catch {
    return false
  }
}

export type PendingCorrectResult =
  | { ok: true; struck: MnemeObservation; row: MnemeObservation | null }
  | { ok: false; code: 'off' | 'unknown-target' | 'busy' | 'invalid' | 'secret' | 'user-asked-rule' | 'error'; message: string }

function parseBufferRow(line: string): MnemeObservation | null {
  try {
    const row = JSON.parse(line) as MnemeObservation
    return typeof row?.ts === 'string' && typeof row?.text === 'string' && typeof row?.source === 'string' ? row : null
  } catch {
    return null
  }
}

function bufferFiles(dir: string): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return [...names.filter(n => /^consuming-.*\.jsonl$/.test(n)).sort().map(n => join(dir, n)), currentBufferPath(dir)]
}

function dropRowFrom(file: string, ts: string, dir: string): MnemeObservation | null {
  if (!existsSync(file)) return null
  const current = currentBufferPath(dir)
  const isCurrent = file === current
  const claim = isCurrent ? claimBufferFile(dir, 'striking') : file
  if (claim === null) return null
  let struck: MnemeObservation | null = null
  const kept: string[] = []
  for (const line of readFileSync(claim, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const row = parseBufferRow(line)
    if (row !== null && row.ts === ts) {
      struck = struck ?? row
      continue
    }
    kept.push(line)
  }
  if (isCurrent) {
    if (kept.length > 0) appendFileSync(current, `${kept.join('\n')}\n`, 'utf8')
    unlinkSync(claim)
  } else if (kept.length > 0) {
    publishLibraryFile(file, `${kept.join('\n')}\n`)
  } else {
    unlinkSync(file)
  }
  return struck
}

export function strikePendingRow(input: { ts: string; dir?: string; byUser?: boolean }): PendingCorrectResult {
  if (!mnemeEnabled()) return { ok: false, code: 'off', message: 'memory is off (memory.enabled is false in settings).' }
  const dir = input.dir ?? mnemeLibraryDir()
  const targets = pendingRows(dir).filter(row => row.ts === input.ts)
  if (targets.length === 0) return { ok: false, code: 'unknown-target', message: `no pending row pending:${input.ts} — it was consolidated (recall again for its seq:<n>), struck, or never existed` }
  if (targets.length > 1) return { ok: false, code: 'invalid', message: `${targets.length} pending rows share the time pending:${input.ts} — nothing was struck; they resolve at consolidation, correct the consolidated facts instead` }
  if (targets[0]!.asked === true && input.byUser !== true) return { ok: false, code: 'user-asked-rule', message: userAskedRuleMessage(`pending:${input.ts}`) }
  if (!acquireConsolidateLock(dir)) {
    return { ok: false, code: 'busy', message: 'a consolidation/correction is in progress — retry in a moment' }
  }
  try {
    let struck: MnemeObservation | null = null
    for (const file of bufferFiles(dir)) {
      const dropped = dropRowFrom(file, input.ts, dir)
      struck = struck ?? dropped
    }
    if (struck === null) return { ok: false, code: 'unknown-target', message: `no pending row pending:${input.ts} — it was consolidated or struck a moment ago` }
    if (pendingRows(dir).some(row => row.ts === input.ts)) {
      return { ok: false, code: 'error', message: 'post-write verification failed — the pending row is still on disk; retry' }
    }
    return { ok: true, struck, row: null }
  } catch (e) {
    return { ok: false, code: 'error', message: String(e).slice(0, 200) }
  } finally {
    releaseConsolidateLock(dir)
  }
}

export function pinPendingRow(input: { ts: string; dir?: string; byUser?: boolean }): PendingCorrectResult {
  if (!mnemeEnabled()) return { ok: false, code: 'off', message: 'memory is off (memory.enabled is false in settings).' }
  const dir = input.dir ?? mnemeLibraryDir()
  const target = pendingRows(dir).find(row => row.ts === input.ts)
  if (target !== undefined && target.pin === true && target.asked === true) return { ok: true, struck: target, row: target }
  const struck = strikePendingRow({ ts: input.ts, dir, ...(input.byUser === undefined ? {} : { byUser: input.byUser }) })
  if (!struck.ok) return struck
  const before = pendingRows(dir).length
  const written = appendObservation(
    {
      text: struck.struck.text,
      source: struck.struck.source,
      ...(struck.struck.topicHint ? { topicHint: struck.struck.topicHint } : {}),
      ...(struck.struck.replaces !== undefined ? { replaces: struck.struck.replaces } : {}),
      pin: true,
      asked: true,
    },
    dir,
  )
  const after = pendingRows(dir)
  if (!written || after.length <= before) {
    return { ok: false, code: 'error', message: `the row was struck but its pinned copy did not land (a disk error) — retain the fact again, pinned: ${struck.struck.text.slice(0, 120)}` }
  }
  return { ok: true, struck: struck.struck, row: after[after.length - 1]! }
}

export function replacePendingRow(input: { ts: string; text: string; source: string; dir?: string; byUser?: boolean }): PendingCorrectResult {
  if (!mnemeEnabled()) return { ok: false, code: 'off', message: 'memory is off (memory.enabled is false in settings).' }
  const dir = input.dir ?? mnemeLibraryDir()
  const text = oneLine(String(input.text ?? '')).trim()
  const source = sigSafe(String(input.source ?? '')).trim()
  if (!text || !source) return { ok: false, code: 'invalid', message: 'correction needs non-empty text and source' }
  const overflow = observationOverflow(text)
  if (overflow !== null) return { ok: false, code: 'invalid', message: `the correction is ${overflow}` }
  const secret = memorySecretRefusal(text)
  if (secret !== null) return { ok: false, code: 'secret', message: `the correction ${secret}` }
  const struck = strikePendingRow({ ts: input.ts, dir, ...(input.byUser === undefined ? {} : { byUser: input.byUser }) })
  if (!struck.ok) return struck
  const before = pendingRows(dir).length
  const written = appendObservation(
    {
      text,
      source,
      ...(struck.struck.topicHint ? { topicHint: struck.struck.topicHint } : {}),
      ...(struck.struck.pin === true ? { pin: true } : {}),
      ...(struck.struck.asked === true ? { asked: true } : {}),
      ...(struck.struck.replaces !== undefined ? { replaces: struck.struck.replaces } : {}),
      history: { ts: struck.struck.ts, text: struck.struck.text },
    },
    dir,
  )
  const after = pendingRows(dir)
  if (!written || after.length <= before) {
    return { ok: false, code: 'error', message: `the old draft was struck but the replacement did not land (a disk error) — retain the corrected fact again: ${text.slice(0, 120)}` }
  }
  return { ok: true, struck: struck.struck, row: after[after.length - 1]! }
}
