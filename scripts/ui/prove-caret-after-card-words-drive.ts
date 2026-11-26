#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

const NEEDLE = 'Do you want to proceed'
const HINT = '↵ is off while words wait — 1 approves · 2 declines · ⌫ edits'
const ANSWER = 'The words arrived in the order typed.'
const FIX = 'words typed while a card waits reach the draft through append in src/screen/composer/input-core/pending-input.ts (the seeder src/screen/chat/useChatDraft.ts registers); the composer that mounts once the card is answered takes its caret from that draft (src/screen/composer/useComposerDraft.ts), so the draft must hold its caret after the words'

type Check = (label: string, cond: boolean, detail?: string) => void

function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const r of rows) console.log(`│${r.replace(/\s+$/, '')}`)
  console.log('└──')
}
const composerRows = (rows: string[]): string => rows.filter(r => /^│?❯/.test(r.trim())).map(r => r.trim()).join(' | ') || '(no composer row)'
const screenAt = (run: ArenaRun, step: number): string[] => run.sendLog.find(s => s.step === step)?.screen ?? []
const carried = (run: ArenaRun, text: string): number => run.fixture.requests.filter(r => r.path.includes('/messages') && r.raw.includes(JSON.stringify(text))).length
const bash = (marker: string, description: string): ScriptedTurn => ({ kind: 'tool_use', preText: 'Touching the file.\n', name: 'Bash', input: { command: `touch ${marker}`, description } })

function walked(run: ArenaRun, check: Check, tag: string, steps: string): void {
  const unfired = run.outcome.report?.unfired ?? []
  check(`${tag}: the capture ran to its deadline and every step of the walk fired (${steps})`, run.outcome.complete && unfired.length === 0, `${run.outcome.reason ?? ''} · unfired: ${unfired.join('; ')} · ${run.driverOut.slice(-300)}`)
}

function typedInOrder(run: ArenaRun, check: Check, tag: string, rows: string[], want: string, glued: string, answered: string[]): void {
  if (rows.length > 0) printFrame(`${tag}: the composer after the last letters`, rows.slice(-8))
  check(`${tag}: the letters typed after the answer land after the words: the composer reads "❯ ${want}"`, rows.some(r => r.includes(`❯ ${want}`)), composerRows(rows))
  check(`${tag}: the letters never land in front of the words ("❯ ${glued}")`, rows.length > 0 && !rows.some(r => r.includes(`❯ ${glued}`)), composerRows(rows))
  check(`${tag}: ↵ sends the words in the order typed: the model receives "${want}", never "${glued}"`, carried(run, want) > 0 && carried(run, glued) === 0, `${carried(run, want)} request(s) carried "${want}", ${carried(run, glued)} carried "${glued}"`)
  check(`${tag}: the model answered that message`, answered.some(r => r.includes(ANSWER)), composerRows(answered))
}

async function oneCard(check: Check): Promise<void> {
  const marker = 'caret-marker.txt'
  const closing = 'The marker is in place.'
  const run = await runArtifactArena({
    cols: 120,
    rows: 40,
    turns: () => [bash(marker, 'Create an empty marker file'), { kind: 'text', text: closing }, { kind: 'text', text: ANSWER }],
    sends: [
      { awaitText: 'Type a prompt', text: 'hello' },
      { awaitText: '❯ hello', text: '\r', afterPrevMs: 300 },
      { awaitText: NEEDLE, text: 'abc', afterPrevMs: 800 },
      { awaitText: [NEEDLE, '❯ abc', HINT], text: '1', afterPrevMs: 2500 },
      { awaitText: [closing, '❯ abc'], awaitAbsent: NEEDLE, text: 'd', afterPrevMs: 800 },
      { awaitText: closing, text: 'e', afterPrevMs: 500 },
      { awaitText: closing, text: '', afterPrevMs: 1500 },
      { awaitText: closing, text: '\r', afterPrevMs: 300 },
      { awaitText: ANSWER, text: '', afterPrevMs: 800 },
    ],
    seconds: 36,
    keep: true,
  })
  try {
    walked(run, check, '§1', 'prompt · card · abc · 1 · d · e · ↵')
    const under = screenAt(run, 3)
    check('§1: while the card waits the typed words stand under it with the hint ("❯ abc")', under.some(r => r.includes(NEEDLE)) && under.some(r => r.includes('❯ abc')) && under.some(r => r.includes(HINT)), composerRows(under))
    const back = screenAt(run, 4)
    check('§1: once 1 answers the card the turn settles and the composer holds the words ("❯ abc")', back.some(r => r.includes(closing)) && !back.some(r => r.includes(NEEDLE)) && back.some(r => r.includes('❯ abc')), composerRows(back))
    typedInOrder(run, check, '§1', screenAt(run, 6), 'abcde', 'deabc', screenAt(run, 8))
    check('§1: the approved command ran (the marker exists)', existsSync(join(run.paths.cwd, marker)))
  } finally {
    run.cleanup()
  }
}

async function twoCards(check: Check): Promise<void> {
  const first = 'first-marker.txt'
  const second = 'second-marker.txt'
  const closing = 'Both markers are in place.'
  const run = await runArtifactArena({
    cols: 120,
    rows: 40,
    turns: () => [bash(first, 'Create the first marker'), bash(second, 'Create the second marker'), { kind: 'text', text: closing }, { kind: 'text', text: ANSWER }],
    sends: [
      { awaitText: 'Type a prompt', text: 'hello' },
      { awaitText: '❯ hello', text: '\r', afterPrevMs: 300 },
      { awaitText: [NEEDLE, `touch ${first}`], text: 'abc', afterPrevMs: 800 },
      { awaitText: [NEEDLE, `touch ${first}`, '❯ abc', HINT], text: '1', afterPrevMs: 2500 },
      { awaitText: [NEEDLE, `touch ${second}`], text: 'def', afterPrevMs: 800 },
      { awaitText: [NEEDLE, `touch ${second}`, '❯ abcdef', HINT], text: '1', afterPrevMs: 2500 },
      { awaitText: [closing, '❯ abcdef'], awaitAbsent: NEEDLE, text: 'g', afterPrevMs: 800 },
      { awaitText: closing, text: 'h', afterPrevMs: 500 },
      { awaitText: closing, text: 'i', afterPrevMs: 500 },
      { awaitText: closing, text: '', afterPrevMs: 1500 },
      { awaitText: closing, text: '\r', afterPrevMs: 300 },
      { awaitText: ANSWER, text: '', afterPrevMs: 800 },
    ],
    seconds: 48,
    keep: true,
  })
  try {
    walked(run, check, '§2', 'prompt · card 1 · abc · 1 · card 2 · def · 1 · g · h · i · ↵')
    const underFirst = screenAt(run, 3)
    check('§2: while the first card waits the typed words stand under it ("❯ abc")', underFirst.some(r => r.includes(`touch ${first}`)) && underFirst.some(r => r.includes('❯ abc')) && underFirst.some(r => r.includes(HINT)), composerRows(underFirst))
    const underSecond = screenAt(run, 5)
    check('§2: while the second card of the same turn waits, the new words stand after the first ones ("❯ abcdef")', underSecond.some(r => r.includes(`touch ${second}`)) && underSecond.some(r => r.includes('❯ abcdef')) && underSecond.some(r => r.includes(HINT)), composerRows(underSecond))
    const back = screenAt(run, 6)
    check('§2: once 1 answers the second card the turn settles and the composer holds both words ("❯ abcdef")', back.some(r => r.includes(closing)) && !back.some(r => r.includes(NEEDLE)) && back.some(r => r.includes('❯ abcdef')), composerRows(back))
    typedInOrder(run, check, '§2', screenAt(run, 9), 'abcdefghi', 'ghiabcdef', screenAt(run, 11))
    check('§2: both approved commands ran (both markers exist)', existsSync(join(run.paths.cwd, first)) && existsSync(join(run.paths.cwd, second)))
  } finally {
    run.cleanup()
  }
}

async function main(): Promise<number> {
  requireDist()
  const results: boolean[] = []
  const check: Check = (label, cond, detail = '') => {
    results.push(cond)
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
    if (!cond) console.log(`    to fix: ${FIX}`)
  }
  console.log('prove-caret-after-card-words-drive: the built product, Bash cards, words typed while they wait, the cards answered, then more letters: everything must read in typing order, in the composer and on the wire')
  section('§1 one card: abc typed while it waits, 1, then d and e, then ↵')
  await oneCard(check)
  section('§2 two cards in one turn: abc while the first waits, 1, def while the second waits, 1, then g, h and i, then ↵')
  await twoCards(check)
  const failures = results.filter(ok => !ok).length
  console.log(`\n${results.length} checks, ${failures} failures`)
  console.log(failures === 0 ? 'prove-caret-after-card-words-drive: ALL LAWS HOLD' : `prove-caret-after-card-words-drive: ${failures} FAILURE(S)`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
