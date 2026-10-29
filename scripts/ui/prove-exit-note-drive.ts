#!/usr/bin/env bun
// gate-watch: src/commands/exit/exit.tsx src/components/ExitHandoff.tsx src/mneme/exitHandoff.ts src/mneme/handoffAsk.ts src/mneme/journal.ts
// gate-watch: src/mneme/lineageSession.ts src/mneme/ledger.ts src/mneme/sessionClose.ts src/utils/gracefulShutdown.ts src/cli/run.ts
// gate-watch: src/daemon/main.ts src/daemon/sessionSeat.ts src/daemon/protocol.ts src/runner/wire/methods.ts
// gate-watch: src/services/engine-connector/daemonConnector.ts src/services/engine-connector/noSessionConnector.ts src/services/engine-connector/types.ts
// gate-watch: src/services/switchboard/quitParksAll.ts src/utils/processGroup.ts
// gate-watch: scripts/streaming/artifactArena.ts scripts/lib/fixtureApi.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HANDOFF_ASK_MARK, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { firstOutputTs, firstPtyVisibility, grabScreens, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

requireDist()

const REPLY = 'Settled and quiet.'
const NOTE = 'The project is a throwaway for the exit proof; nothing is decided and nothing is still to do.'
const ENTRY = 'One question answered, kept short; nothing to get wrong this time.'
const WRITING = 'writing the handoff for the next session'
const COLS = 120
const ROWS = 40

const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

type LedgerRow = { sessionId: string; endedAt: string | null; outcome: string | null; handoff: { text: string; at: string } | null }

const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}
const ledgerRows = (configDir: string): LedgerRow[] => {
  const files = walk(join(configDir, 'projects')).filter(p => p.endsWith(`${'lineage'}/ledger.jsonl`))
  const rows: LedgerRow[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        rows.push(JSON.parse(line) as LedgerRow)
      } catch {
        continue
      }
    }
  }
  return rows
}
const lastRowOf = (rows: LedgerRow[]): LedgerRow | null => {
  const last = new Map<string, LedgerRow>()
  for (const row of rows) last.set(row.sessionId, row)
  const all = [...last.values()]
  return all.length === 0 ? null : all[all.length - 1]!
}
const journalFiles = (configDir: string): string[] => walk(join(configDir, 'projects')).filter(p => p.endsWith(`${'journal'}/journal.md`))

const squash = (s: string): string => s.replace(/\s+/g, '')
const painted = (run: ArenaRun, words: string): { ts: number; text: string } | undefined => firstPtyVisibility(run.ptyReads, squash(words), 0)

const steady = (row: string): string => row.replace(/flux-arena-cwd-[A-Za-z0-9]+/g, 'the-project').replace(/\b\d\d:\d\d:\d\d\b/g, 'hh:mm:ss').replace(/\s+$/, '')
const saveFrame = (name: string, rows: string[]): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), rows.map(steady).join('\n') + '\n')
}

async function leg(tag: string, opts: { journal: boolean; turn: boolean }): Promise<void> {
  const turns: ScriptedTurn[] = [
    { kind: 'text', text: REPLY, whenBody: 'say something settled' },
    ...(opts.journal
      ? [
          { kind: 'tool_use', name: 'Journal', input: { entry: ENTRY }, whenBody: HANDOFF_ASK_MARK } as ScriptedTurn,
          { kind: 'text', text: NOTE, whenBody: 'journal entry staged' } as ScriptedTurn,
        ]
      : [handoffTurn(NOTE)]),
  ]
  const sends = opts.turn
    ? ['after:Type a prompt:1200:say something settled', 'after:Type a prompt:2200:\\r', `after:${REPLY}:1500:/exit`, `after:${REPLY}:2600:\\r`]
    : ['after:Type a prompt:1200:/exit', 'after:Type a prompt:2200:\\r']
  let configDir = ''
  const run = await runArtifactArena({
    turns,
    sends,
    seconds: 75,
    cols: COLS,
    rows: ROWS,
    keep: true,
    anchor: null,
    seedHome: dir => {
      configDir = dir
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ memory: { journal: opts.journal } }, null, 2) + '\n')
    },
  })
  try {
    const report = run.outcome.report
    const asks = run.fixture.messageRequests().filter(isHandoffRequest)
    const answers = run.fixture.messageRequests().filter(r => JSON.stringify(r.body).includes('say something settled'))
    const rows = ledgerRows(configDir)
    const last = lastRowOf(rows)
    const lastRead = run.ptyReads[run.ptyReads.length - 1]
    const writing = painted(run, WRITING)
    check(`${tag}: the cockpit handed the terminal back (/exit ended the pty before the deadline)`, report !== null && report.ended === 'eof', run.outcome.reason ?? JSON.stringify(report))
    if (!opts.turn) {
      check(`${tag}: no turn ran, so no note was asked for (the .32 law)`, asks.length === 0 && answers.length === 0, `${asks.length} asks · ${answers.length} answers`)
      check(`${tag}: nothing was written for the next session`, last === null || last.handoff === null, JSON.stringify(last))
      return
    }
    check(`${tag}: the one turn ran and was answered`, answers.length >= 1 && painted(run, REPLY) !== undefined, `${answers.length} answer requests`)
    check(`${tag}: the screen said it was writing the handoff while the cockpit waited`, writing !== undefined, `no pty read carried "${WRITING}"`)
    if (writing !== undefined) {
      const at = Math.max(0, writing.ts - firstOutputTs(run))
      const [frame] = grabScreens(run, COLS, ROWS, [at])
      const text = frame ? frame.rows.join('\n') : ''
      check(`${tag}: the frame carries the handoff line whole, with its skip hint`, text.includes(`${WRITING}… (ctrl-c skips)`), text.split('\n').filter(l => l.trim()).slice(-8).join(' | '))
      if (frame) saveFrame(`exit-note-writing-${opts.journal ? 'journal-' : ''}${COLS}x${ROWS}`, frame.rows)
    }
    check(`${tag}: the close ask reached the model once, after the answer`, asks.length === (opts.journal ? 2 : 1) && run.fixture.messageRequests().indexOf(asks[0]!) > run.fixture.messageRequests().indexOf(answers[0]!), `${asks.length} handoff requests of ${run.fixture.messageRequests().length}`)
    check(`${tag}: the ledger row is closed with its end and its outcome`, last !== null && last.endedAt !== null && last.outcome !== null, JSON.stringify(last))
    check(`${tag}: the note is in the ledger exactly as the model wrote it`, last?.handoff?.text === NOTE, JSON.stringify(last?.handoff ?? null))
    check(`${tag}: the close was written by the exit itself, not by the signal that ends the runner (the road a Windows taskkill never walks)`, last?.outcome === 'quit', `outcome ${JSON.stringify(last?.outcome)}`)
    check(`${tag}: the note landed before the terminal came back`, last?.handoff !== null && last?.handoff !== undefined && lastRead !== undefined && Date.parse(last.handoff.at) <= lastRead.ts, `note at ${last?.handoff?.at} · last output ${lastRead ? new Date(lastRead.ts).toISOString() : '-'}`)
    const journals = journalFiles(configDir)
    if (opts.journal) {
      const body = journals[0] ? readFileSync(journals[0], 'utf8') : ''
      check(`${tag}: the journal entry the model staged in the close ask is in the home`, journals.length === 1 && body.includes(ENTRY), journals.length === 0 ? 'no journal.md under the home' : body.slice(0, 300))
      check(`${tag}: the note went to the ledger and the entry to the journal, each alone`, !body.includes(NOTE) && rows.every(row => row.handoff?.text !== ENTRY))
    } else {
      check(`${tag}: the journal is off, so no journal file exists`, journals.length === 0, journals.join(', '))
    }
  } finally {
    run.cleanup()
  }
}

section('§1 one turn, journal off: /exit shows the handoff line, asks once, stores the note, closes the ledger, then hands the terminal back')
await leg('note', { journal: false, turn: true })

section('§2 one turn, memory.journal on: the close ask carries the journal line; the entry is written at the close')
await leg('journal', { journal: true, turn: true })

section('§3 no turn: /exit asks nothing and leaves as before')
await leg('no-turn', { journal: false, turn: false })

console.log(`\nprove-exit-note-drive: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
