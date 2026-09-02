import { randomUUID, type UUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { getSessionId } from '../../bootstrap/state.js'
import {
  createLane,
  dropLane,
  laneForChildSession,
  lanesEnabled,
  promoteHandoff,
  readLane,
  returnLane,
} from '../../services/contextLanes/lanes.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { LogOption, SerializedMessage } from '../../types/logs.js'
import type { ContentReplacementRecord } from '../../utils/toolResultStorage.js'
import { binaryName } from '../../utils/config/derived.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { saveCustomTitle, searchSessionsByCustomTitle } from '../../utils/sessionStorage.js'
import {
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
} from '../../utils/sessionStorage/paths.js'

/** The literal fallback title (contract data — prover-pinned). */
const FALLBACK_TITLE = 'Branched conversation'

/** `return|promote|drop`, optionally followed by whitespace and anything. */
const LANE_VERB_PATTERN = /^(return|promote|drop)(?:\s+([\s\S]*))?$/

/**
 * The saved-title collision derives from re-parsed earlier titles, so the
 * suffix format is contract data: `<base> (Branch)`, then `<base> (Branch N)`.
 */
function titleWithBranchSuffix(base: string, n: number): string {
  return n <= 1 ? `${base} (Branch)` : `${base} (Branch ${n})`
}

/**
 * The derived first-line title of a conversation's first user message. The
 * whitespace collapse is not cosmetic: a pasted stack trace would otherwise
 * put line breaks into the saved title and wreck the resume hint.
 */
export function deriveFirstPrompt(
  firstUserMessage: { message?: { content?: unknown } } | undefined,
): string {
  const content = firstUserMessage?.message?.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const block = content.find(b => (b as { type?: string }).type === 'text') as
      | { text?: string }
      | undefined
    text = block?.text ?? ''
  }
  if (!text) return FALLBACK_TITLE
  const collapsed = text.replace(/\s+/g, ' ').trim().slice(0, 100)
  return collapsed === '' ? FALLBACK_TITLE : collapsed
}

type TranscriptRecord = {
  type?: string
  uuid?: string
  sessionId?: string
  parentUuid?: string | null
  isSidechain?: boolean
  message?: { content?: unknown }
  replacements?: unknown[]
  [key: string]: unknown
}

function isMainConversationMessage(record: TranscriptRecord): boolean {
  return (
    (record.type === 'user' || record.type === 'assistant' || record.type === 'system' || record.type === 'progress') &&
    typeof record.uuid === 'string' &&
    record.isSidechain !== true
  )
}

function parseTranscriptLines(raw: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as TranscriptRecord)
    } catch {
      // Damaged lines are skipped, not fatal.
    }
  }
  return records
}

/** First user message among the kept records. */
function firstUserRecord(records: TranscriptRecord[]): TranscriptRecord | undefined {
  return records.find(record => record.type === 'user')
}

type ForkOutcome = {
  newSessionId: UUID
  forkPath: string
  descriptor: LogOption
  title: string
}

/**
 * Choose the persisted title: always suffixed so branch provenance is
 * obvious; collisions pick the lowest unused integer ≥ 2 among titles
 * saved by earlier runs.
 */
async function chooseBranchTitle(base: string): Promise<string> {
  const unnumbered = titleWithBranchSuffix(base, 1)
  const exact = await searchSessionsByCustomTitle(unnumbered, { exact: true })
  if (exact.length === 0) return unnumbered
  const family = await searchSessionsByCustomTitle(`${base} (Branch`, {})
  const used = new Set<number>()
  const pattern = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(Branch(?: (\\d+))?\\)$`,
  )
  for (const log of family) {
    const title = log.customTitle
    if (!title) continue
    const match = pattern.exec(title)
    if (!match) continue
    used.add(match[1] !== undefined ? parseInt(match[1], 10) : 1)
  }
  let n = 2
  while (used.has(n)) n++
  return titleWithBranchSuffix(base, n)
}

/**
 * The plain fork: copy the main-conversation records into a new session
 * file (with rewritten identities and carried content replacements) and
 * synthesise the in-memory resume descriptor.
 */
async function forkSession(title: string | undefined): Promise<ForkOutcome> {
  const newSessionId = randomUUID()
  mkdirSync(getProjectsDir(), { recursive: true, mode: 0o700 })

  const transcriptPath = getTranscriptPath()
  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    throw new Error('No conversation to branch yet.')
  }
  if (raw.length === 0) {
    throw new Error('No conversation to branch yet.')
  }
  const records = parseTranscriptLines(raw)

  const kept = records.filter(isMainConversationMessage)
  if (kept.length === 0) {
    throw new Error('No messages to branch.')
  }

  // The original session's replacement records, flattened. Without them the
  // fork resumes with an empty replacement map: every already-replaced tool
  // result reads as un-replaceable and is re-sent whole — the prompt cache
  // misses and the token cost stays inflated for the life of that session.
  const originalSessionId = String(getSessionId())
  const carriedReplacements = records
    .filter(
      record =>
        record.type === 'content-replacement' && record.sessionId === originalSessionId,
    )
    .flatMap(record => (Array.isArray(record.replacements) ? record.replacements : []))

  // File lines: new session id, re-chained parents, main-lane, fork marker;
  // every other field of the original record is preserved. Progress records
  // never become parents.
  let previousUuid: string | null = null
  const fileLines: string[] = []
  const serializedMessages: TranscriptRecord[] = []
  for (const record of kept) {
    const rewritten: TranscriptRecord = {
      ...record,
      sessionId: newSessionId,
      parentUuid: previousUuid,
      isSidechain: false,
      forkedFrom: { sessionId: originalSessionId, messageUuid: record.uuid },
    }
    if (record.type !== 'progress') {
      previousUuid = record.uuid as string
    }
    fileLines.push(JSON.stringify(rewritten))
    // The in-memory copies rewrite ONLY the session id — original parent
    // pointers and side-chain flags survive, and no fork marker is added.
    serializedMessages.push({ ...record, sessionId: newSessionId })
  }

  if (carriedReplacements.length > 0) {
    // One record, in the shape the normal writer emits.
    fileLines.push(
      JSON.stringify({
        type: 'content-replacement',
        sessionId: newSessionId,
        replacements: carriedReplacements,
      }),
    )
  }

  const forkPath = getTranscriptPathForSession(newSessionId)
  writeFileSync(forkPath, `${fileLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })

  const derivedPrompt = deriveFirstPrompt(firstUserRecord(kept))
  const base = title || derivedPrompt
  const chosenTitle = await chooseBranchTitle(base)
  await saveCustomTitle(newSessionId, chosenTitle, forkPath)

  const now = new Date()
  const descriptor: LogOption = {
    date: now.toISOString().split('T')[0]!,
    messages: serializedMessages as SerializedMessage[],
    fullPath: forkPath,
    value: 0,
    created: now,
    modified: now,
    firstPrompt: derivedPrompt,
    messageCount: kept.length,
    isSidechain: false,
    leafUuid: (previousUuid ?? undefined) as LogOption['leafUuid'],
    customTitle: chosenTitle,
    contentReplacements: carriedReplacements as ContentReplacementRecord[],
  }
  return { newSessionId, forkPath, descriptor, title: chosenTitle }
}

/**
 * Load an EXISTING session as a resume descriptor (the return verb's flip
 * back into the parent). Mirrors the fork's parsing but writes nothing; any
 * failure yields null and the caller falls back to the manual-resume hint.
 */
function loadSessionAsDescriptor(sessionId: string): LogOption | null {
  try {
    const path = getTranscriptPathForSession(sessionId)
    const records = parseTranscriptLines(readFileSync(path, 'utf8'))
    const kept = records.filter(isMainConversationMessage)
    if (kept.length === 0) return null
    const replacements = records
      .filter(record => record.type === 'content-replacement' && record.sessionId === sessionId)
      .flatMap(record => (Array.isArray(record.replacements) ? record.replacements : []))
    const now = new Date()
    const descriptor: LogOption = {
      date: now.toISOString().split('T')[0]!,
      messages: kept as SerializedMessage[],
      fullPath: path,
      value: 0,
      created: now,
      modified: now,
      firstPrompt: deriveFirstPrompt(firstUserRecord(kept)),
      messageCount: kept.length,
      isSidechain: false,
      leafUuid: kept[kept.length - 1]?.uuid as LogOption['leafUuid'],
      contentReplacements: replacements as ContentReplacementRecord[],
    }
    return descriptor
  } catch {
    return null
  }
}

function resumeHint(sessionId: string): string {
  return `${binaryName()} --resume ${sessionId}`
}

async function runLaneVerb(
  verb: string,
  remainder: string,
  context: LocalJSXCommandContext,
  onDone: LocalJSXCommandOnDone,
): Promise<null> {
  if (verb === 'return') {
    const lane = laneForChildSession(String(getSessionId()))
    if (!lane) {
      onDone('`/branch return` only applies inside a lane child session — this session is not one.')
      return null
    }
    const answer = remainder.trim() || `(no answer text — see the lane transcript, mercury://lane/${lane.id})`
    const returned = returnLane({ lane, answer })
    const changedCount = returned.handoff?.changedPaths.length ?? 0
    const summary = `Lane ${lane.id} returned — handoff recorded (${changedCount} observed changed path${changedCount === 1 ? '' : 's'}). Promote it in the parent with \`/branch promote ${lane.id}\`.`
    const parentDescriptor = loadSessionAsDescriptor(lane.parentSessionId)
    if (context.resume && parentDescriptor) {
      await context.resume(lane.parentSessionId as UUID, parentDescriptor, 'fork')
      onDone(summary, { display: 'system' })
      return null
    }
    onDone(`${summary}\nResume the parent manually: ${resumeHint(lane.parentSessionId)}`)
    return null
  }

  if (verb === 'promote') {
    const laneId = remainder.trim()
    if (!laneId) {
      onDone('Usage: /branch promote <laneId> — lane ids are on the lane board (/branches).')
      return null
    }
    const lane = readLane(laneId)
    if (lane && lane.parentSessionId !== String(getSessionId())) {
      onDone(`Lane ${laneId} belongs to parent session ${lane.parentSessionId}, not this one.`)
      return null
    }
    const result = promoteHandoff(laneId)
    if ('error' in result) {
      onDone(`Cannot promote: ${result.error}`)
      return null
    }
    if ('alreadyPromoted' in result) {
      onDone(`Lane ${laneId} was already promoted — a handoff injects exactly once.`)
      return null
    }
    enqueuePendingNotification({ mode: 'task-notification', value: result.handoffText })
    onDone(`Handoff queued — it reaches the model at the next turn, exactly once.`, {
      display: 'system',
    })
    return null
  }

  // drop
  const laneId = remainder.trim()
  if (laneId) {
    const dropped = dropLane(laneId)
    if (dropped) {
      onDone(
        `Lane ${laneId} dropped. Its transcript and any project files it changed are untouched.`,
      )
      return null
    }
  }
  onDone(`No lane '${laneId}'.`)
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const trimmed = args.trim()
  const verbMatch = LANE_VERB_PATTERN.exec(trimmed)
  if (lanesEnabled() && verbMatch) {
    return runLaneVerb(verbMatch[1]!, verbMatch[2] ?? '', context, onDone)
  }

  // The whole trimmed argument is an optional title/goal (with lanes
  // disabled, `/branch return foo` legitimately titles a branch).
  const title = trimmed || undefined
  try {
    const originalSessionId = String(getSessionId())
    const outcome = await forkSession(title)

    // With a goal, the fork additionally becomes a bounded side lane; a bare
    // /branch stays the plain fork exactly.
    let laneClause = ''
    if (lanesEnabled() && title) {
      const lane = createLane({
        parentSessionId: originalSessionId,
        childSessionId: String(outcome.newSessionId),
        goal: title,
      })
      laneClause = ` This branch is a bounded side lane (${lane.id}) — finish with \`/branch return <answer>\`.`
    }

    const titleClause = title ? ` as "${outcome.title}"` : ''
    const message = `Branched the conversation${titleClause} — you are now in the branch.${laneClause}\nResume the original session with: ${resumeHint(originalSessionId)}`
    if (context.resume) {
      await context.resume(outcome.newSessionId, outcome.descriptor, 'fork')
      onDone(message, { display: 'system' })
      return null
    }
    onDone(
      `Branched the conversation${titleClause}. Resume it with: ${resumeHint(String(outcome.newSessionId))}`,
    )
    return null
  } catch (error) {
    logError(error)
    onDone(
      `Failed to branch: ${error instanceof Error ? errorMessage(error) : 'unknown error'}`,
    )
    return null
  }
}
