#!/usr/bin/env bun
// gate-watch: src/mneme/entryPage.ts src/mneme/ledger.ts src/mneme/journal.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'entry-page-journal-label-'))
const configDir = join(HOME, '.mercury')
mkdirSync(configDir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = configDir
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const entryPage = await import('../../src/mneme/entryPage.ts')
const { composeEntryPage, NO_NOTE_LEFT } = entryPage
const sessionOfJournalEntry: (entries: Array<{ ordinal: number; startedAt: string; endedAt: string | null }>, at: string) => { ordinal: number } | null = (entryPage as { sessionOfJournalEntry?: typeof sessionOfJournalEntry }).sessionOfJournalEntry ?? (() => null)
const { openEntry, closeEntry, readLedger } = await import('../../src/mneme/ledger.ts')

const key = 'journal-label-project'
const realNow = Date.now
const T = Date.UTC(2026, 9, 12, 9, 30, 0)
Date.now = () => T
openEntry(key, { sessionId: 'noted-1', model: 'claude-fable-5-1' })
Date.now = () => T + 60_000
closeEntry(key, 'noted-1', { outcome: 'closed', handoff: 'The note session one left.' })
Date.now = () => T + 120_000
openEntry(key, { sessionId: 'quiet-2', model: 'claude-fable-5-1' })
Date.now = () => T + 180_000
closeEntry(key, 'quiet-2', { outcome: 'closed' })
Date.now = realNow
const entries = readLedger(key)
check('two sessions in the ledger: one noted, the last one without a note', entries.length === 2 && entries[0]!.handoff !== null && entries[1]!.handoff === null, JSON.stringify(entries.map(e => [e.ordinal, e.handoff !== null])))

console.log("\nthe journal entry written at the quiet session's close is attributed to it")
const atClose = new Date(T + 180_000 + 40).toISOString()
check('the attribution reads the session whose span holds the entry time (the close writes it a few milliseconds after endedAt)', sessionOfJournalEntry(entries, atClose)?.ordinal === 2, JSON.stringify(sessionOfJournalEntry(entries, atClose)))
check('an entry written long after every session is attributed to none', sessionOfJournalEntry(entries, new Date(T + 900_000).toISOString()) === null)
check('an entry inside the noted session\'s span is attributed to it', sessionOfJournalEntry(entries, new Date(T + 30_000).toISOString())?.ordinal === 1)

const page = composeEntryPage(key, 'next-3', { journal: () => ({ at: atClose, text: 'Session two tidied the memory centre; nothing is queued.' }) }) ?? ''
check('the page still says the last session left no note in the ledger', page.includes(`The last session (2, ended `) && page.includes(NO_NOTE_LEFT), page)
check("…and says in the same sentence that the session's journal entry is below, so the two lines never read as a contradiction", page.includes(`${NO_NOTE_LEFT}; its journal entry is below.`), page)
check("the journal heading names the session the entry came from and says it is that session's own account, not a note left for the reader", /## The journal's last entry \(.* session 2's own account — not a note left for you\)/.test(page), page.split('\n').find(l => l.startsWith('## The journal')) ?? '')
check('the last note that exists still rides under its own heading', page.includes('## The last note left (session 1, ') && page.includes('The note session one left.'), page)

console.log('\nan entry no session can claim is labelled as the model\'s own account')
const orphan = composeEntryPage(key, 'next-3', { journal: () => ({ at: new Date(T + 900_000).toISOString(), text: 'An entry from a session the ledger does not hold.' }) }) ?? ''
check("the heading says the model's own account, not a note left for you, with no session named", /## The journal's last entry \(.* — the model's own account, not a note left for you\)/.test(orphan) && !orphan.includes("session 2's own account"), orphan.split('\n').find(l => l.startsWith('## The journal')) ?? '')
check('the no-note line stays plain when the entry is not the last session\'s', orphan.includes(`${NO_NOTE_LEFT}.`) && !orphan.includes('its journal entry is below'), orphan)

console.log('\nno journal: the page is as before')
const plain = composeEntryPage(key, 'next-3') ?? ''
check('no journal section, the no-note line plain', !plain.includes("The journal's last entry") && plain.includes(`${NO_NOTE_LEFT}.`), plain)

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ ENTRY PAGE JOURNAL LABEL GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ENTRY PAGE JOURNAL LABEL RED (${failures} of ${checks} checks failed)`)
process.exit(1)
