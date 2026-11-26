import { basename, join } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { workerTranscriptPath } from './workerTranscript.js'
import { isAuthFailureHusk, type ParkedSessionFact } from '../boot-face/bootCardFacts.js'
import {
  compareSessionRecency,
  lastConversationActivityMs,
  scanLastConversationActivityMsSync,
} from '../../sessions/transcripts/sessionIndex.js'
import {
  extractFirstPromptFromHead,
  extractLastJsonStringField,
  getProjectDir,
  isTranscriptFileName,
  LITE_READ_BUF_SIZE,
} from '../../sessions/transcripts/sessionStoragePortable.js'
import { historyHead, historyRange } from '../../sessions/transcripts/historyParts.js'
import { missionGoalBeside } from '../../sessions/mission-card/missionCard.js'
import { sessionTitleOf } from './sessionNaming.js'
import { stripTerminalControls } from '../../platform/text/strings.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function sanitizeLabel(raw: string): string {
  let out = ''
  for (const ch of stripTerminalControls(raw)) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    out += ch
    if (out.length >= 160) break
  }
  return out
}

export function transcriptWindowLines(
  rec: { sessionId: string; workspaceId: string },
  span: number,
  from: 'head' | 'tail',
): string[] | null {
  const path = workerTranscriptPath(rec)
  const extent = historyHead(path)
  const size = extent.before + extent.end - extent.start
  if (size === 0) return null
  const take = Math.min(size, span)
  const buf = from === 'head' ? historyRange(extent, 0, take) : historyRange(extent, size - take, size)
  return buf.toString('utf8').split('\n')
}

export function headBriefLabel(
  rec: { sessionId: string; workspaceId: string },
  maxChars = 200,
  opts: { promptsOnly?: boolean } = {},
): string | null {
  try {
    const lines = transcriptWindowLines(rec, LITE_READ_BUF_SIZE, 'head')
    if (lines === null) return null
    const flat = (missionGoalBeside(workerTranscriptPath(rec)) ?? extractFirstPromptFromHead(lines.join('\n'), opts))
      .replace(/\s+/g, ' ')
      .trim()
    if (flat.length === 0) return null
    return sanitizeLabel(flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat)
  } catch (error) {
    passedOver(error)
    return null
  }
}

export interface OlderChatFact {
  sessionId: string
  transcriptPath: string
  ageMs: number
  title: string
}

export interface OlderChatsCensusV1 {
  total: number
  entries: OlderChatFact[]
  readError?: string
}

const olderFactCache = new Map<
  string,
  { mtimeMs: number; size: number; husk: boolean; title: string | null; lastUsedMs: number | null }
>()
const OLDER_FACT_CACHE_CAP = 2048

function readTitleAndTail(rec: { sessionId: string; workspaceId: string }): { title: string | null; tailRaw: string | undefined } {
  let custom: string | undefined
  let tailRaw: string | undefined
  try {
    tailRaw = transcriptWindowLines(rec, LITE_READ_BUF_SIZE, 'tail')?.join('\n')
    const tailHit = tailRaw !== undefined ? extractLastJsonStringField(tailRaw, 'customTitle')?.trim() : undefined
    if (tailHit !== undefined && tailHit.length > 0) {
      custom = tailHit
    } else {
      const headRaw = transcriptWindowLines(rec, LITE_READ_BUF_SIZE, 'head')?.join('\n')
      const headHit = headRaw !== undefined ? extractLastJsonStringField(headRaw, 'customTitle')?.trim() : undefined
      if (headHit !== undefined && headHit.length > 0) custom = headHit
    }
  } catch (error) {
    passedOver(error)
  }
  const brief = headBriefLabel(rec, 48, { promptsOnly: true })
  const title =
    brief === null && custom === undefined
      ? null
      : sanitizeLabel(sessionTitleOf({ title: custom, workspaceId: rec.workspaceId }, () => brief))
  return { title, tailRaw }
}

function readTitleAndLastUsed(
  rec: { sessionId: string; workspaceId: string },
  file: string,
  size: number,
): { title: string | null; lastUsedMs: number | null } {
  const { title, tailRaw } = readTitleAndTail(rec)
  let lastUsedMs = tailRaw !== undefined ? lastConversationActivityMs(tailRaw) : null
  if (lastUsedMs === null && (size > LITE_READ_BUF_SIZE || historyHead(file).before > 0)) {
    lastUsedMs = scanLastConversationActivityMsSync(file)
  }
  return { title, lastUsedMs }
}

export function transcriptTitleOf(rec: { sessionId: string; workspaceId: string }): string | null {
  return readTitleAndTail(rec).title
}

function olderFactOf(
  projectDir: string,
  file: string,
  mtimeMs: number,
  size: number,
): { husk: boolean; title: string | null; lastUsedMs: number | null } {
  const held = olderFactCache.get(file)
  if (held !== undefined && held.mtimeMs === mtimeMs && held.size === size) return held
  const sessionId = basename(file).replace(/\.jsonl$/, '')
  const husk = isAuthFailureHusk(file, size)
  const { title, lastUsedMs } = husk
    ? { title: null, lastUsedMs: null }
    : readTitleAndLastUsed({ sessionId, workspaceId: projectDir }, file, size)
  if (olderFactCache.size >= OLDER_FACT_CACHE_CAP) olderFactCache.clear()
  const fact = { mtimeMs, size, husk, title, lastUsedMs }
  olderFactCache.set(file, fact)
  return fact
}

export function olderChatsCensus(
  projectDir: string,
  excludedSessionIds: ReadonlySet<string>,
  nowMs: number,
  opts: { excludeSessionId?: string; entryCap?: number; sessions?: readonly ParkedSessionFact[] } = {},
): OlderChatsCensusV1 {
  try {
    const entryCap = Math.max(0, opts.entryCap ?? 0)
    const skip = opts.excludeSessionId !== undefined ? `${opts.excludeSessionId}.jsonl` : null
    const candidates: Array<{ sessionId: string; file: string; mtimeMs: number; size: number; ageMs: number }> = []
    if (opts.sessions !== undefined) {
      for (const s of opts.sessions) {
        let st: { mtimeMs: number; size: number }
        try {
          st = statSync(s.transcriptPath)
        } catch (error) {
          passedOver(error)
          continue
        }
        candidates.push({ sessionId: s.sessionId, file: s.transcriptPath, mtimeMs: st.mtimeMs, size: st.size, ageMs: s.ageMs })
      }
    } else {
      const home = getProjectDir(projectDir)
      for (const f of readdirSync(home)) {
        if (!isTranscriptFileName(f) || f === skip) continue
        try {
          const st = statSync(join(home, f))
          if (st.size === 0) continue
          candidates.push({
            sessionId: f.slice(0, -'.jsonl'.length),
            file: join(home, f),
            mtimeMs: st.mtimeMs,
            size: st.size,
            ageMs: Math.max(0, nowMs - st.mtimeMs),
          })
        } catch (error) {
          passedOver(error)
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    let total = 0
    const ranked: Array<{ entry: OlderChatFact; mtimeMs: number; lastUsedMs: number | null }> = []
    for (const c of candidates) {
      if (excludedSessionIds.has(c.sessionId)) continue
      const fact = olderFactOf(projectDir, c.file, c.mtimeMs, c.size)
      if (fact.husk || fact.title === null) continue
      total += 1
      if (entryCap > 0) {
        const ageMs =
          opts.sessions !== undefined
            ? c.ageMs
            : Math.max(0, nowMs - (fact.lastUsedMs ?? Math.floor(c.mtimeMs)))
        ranked.push({
          entry: { sessionId: c.sessionId, transcriptPath: c.file, ageMs, title: fact.title },
          mtimeMs: c.mtimeMs,
          lastUsedMs: fact.lastUsedMs,
        })
      }
    }
    ranked.sort((a, b) =>
      compareSessionRecency(
        { lastUsedMs: a.lastUsedMs, mtimeMs: a.mtimeMs, sessionId: a.entry.sessionId },
        { lastUsedMs: b.lastUsedMs, mtimeMs: b.mtimeMs, sessionId: b.entry.sessionId },
      ),
    )
    const entries = ranked.slice(0, entryCap).map(r => r.entry)
    return { total, entries }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { total: 0, entries: [] }
    }
    const detail = errorMessage(error)
    logForDebugging(`[concourse] olderChatsCensus failed: ${detail}`, { level: 'warn' })
    passedOver(error)
    return { total: 0, entries: [], readError: detail }
  }
}
