import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { ledgerClock } from './ledger.js'
import { isMnemeEnabled, mnemeProjectKey, projectRecordsDir } from './paths.js'
import { registerSessionCloseAsk, registerSessionCloser, type SessionCloseAsk, type SessionCloseContext } from './sessionClose.js'
import { JOURNAL_TOOL_NAME } from '../tools/JournalTool/prompt.js'

export const JOURNAL_ENTRY_CAP = 4000
export const JOURNAL_FILE = 'journal.md'

const ENTRY_MARK = /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$/

export interface JournalEntry {
  at: string
  text: string
}

export type JournalStageOutcome = { staged: true; chars: number; replaced: boolean } | { staged: false; reason: string }

export function journalEnabled(): boolean {
  if (!isMnemeEnabled()) return false
  return getInitialSettings().memory?.journal === true
}

export function journalOnEntryPage(): boolean {
  return journalEnabled() && getInitialSettings().memory?.journalOnEntryPage === true
}

export function journalPath(projectKey: string = mnemeProjectKey()): string {
  return join(projectRecordsDir(projectKey), 'journal', JOURNAL_FILE)
}

function shieldMarks(text: string): string {
  return text
    .split('\n')
    .map(line => (ENTRY_MARK.test(line) ? ` ${line}` : line))
    .join('\n')
}

export function serializeJournalEntry(entry: JournalEntry): string {
  return `## ${entry.at}\n\n${shieldMarks(entry.text.trim())}\n\n`
}

export function parseJournal(raw: string): JournalEntry[] {
  const out: JournalEntry[] = []
  let current: { at: string; lines: string[] } | null = null
  const flush = (): void => {
    if (current === null) return
    const text = current.lines.join('\n').trim()
    if (text !== '') out.push({ at: current.at, text })
    current = null
  }
  for (const line of raw.replaceAll('\r\n', '\n').split('\n')) {
    const mark = ENTRY_MARK.exec(line)
    if (mark) {
      flush()
      current = { at: mark[1]!, lines: [] }
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  flush()
  return out
}

export function readJournal(projectKey: string = mnemeProjectKey()): JournalEntry[] {
  let raw: string
  try {
    raw = readFileSync(journalPath(projectKey), 'utf8')
  } catch {
    return []
  }
  return parseJournal(raw)
}

export function lastJournalEntry(projectKey: string = mnemeProjectKey()): JournalEntry | null {
  let newest: JournalEntry | null = null
  for (const entry of readJournal(projectKey)) {
    if (newest === null || entry.at >= newest.at) newest = entry
  }
  return newest
}

export function appendJournalEntry(projectKey: string, text: string): JournalEntry | null {
  const body = text.trim()
  if (body === '') return null
  const entry: JournalEntry = { at: ledgerClock(), text: body }
  const path = journalPath(projectKey)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, serializeJournalEntry(entry), 'utf8')
  return entry
}

const staged = new Map<string, string>()
let closerInstalled: (() => void) | null = null

export function journalStageRefusal(text: string): string | null {
  if (!journalEnabled()) return 'the session journal is off (memory.journal in /config)'
  const body = text.trim()
  if (body === '') return 'the entry is empty'
  if (body.length > JOURNAL_ENTRY_CAP) return `the entry is ${body.length} characters; the journal keeps an entry under ${JOURNAL_ENTRY_CAP} — say less`
  return null
}

export function stageJournalEntry(sessionId: string, text: string): JournalStageOutcome {
  const refusal = journalStageRefusal(text)
  if (refusal !== null) return { staged: false, reason: refusal }
  const body = text.trim()
  const replaced = staged.has(sessionId)
  staged.set(sessionId, body)
  installJournalCloser()
  return { staged: true, chars: body.length, replaced }
}

export function stagedJournalEntry(sessionId: string): string | null {
  return staged.get(sessionId) ?? null
}

export async function journalCloser(ctx: SessionCloseContext): Promise<void> {
  const text = staged.get(ctx.sessionId)
  staged.delete(ctx.sessionId)
  if (text === undefined || !journalEnabled()) return
  try {
    appendJournalEntry(ctx.projectKey, text)
  } catch (error) {
    logForDebugging(`journal write failed for ${ctx.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function installJournalCloser(): void {
  if (closerInstalled !== null) return
  closerInstalled = registerSessionCloser(journalCloser)
}

export const JOURNAL_ASK = `Before the session ends, write a brief entry into the journal with the ${JOURNAL_TOOL_NAME} tool: where the project is, what the queued backlog is, and constraints set by the operator. Plain words, concise, no longer than a sentence.`

export function journalAsk(sessionId: string): SessionCloseAsk | null {
  if (!journalEnabled() || staged.has(sessionId)) return null
  return { line: JOURNAL_ASK, tools: [JOURNAL_TOOL_NAME] }
}

let askInstalled: (() => void) | null = null

export function installJournalAsk(): void {
  if (askInstalled !== null) return
  askInstalled = registerSessionCloseAsk(journalAsk)
}

export function _resetJournalForTesting(): void {
  staged.clear()
  if (closerInstalled !== null) closerInstalled()
  closerInstalled = null
  if (askInstalled !== null) askInstalled()
  askInstalled = null
}

installJournalAsk()
