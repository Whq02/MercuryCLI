#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-compact-vs-running-turn.ts — /compact typed while a
//  turn runs answers HONESTLY at once (compact-frontier part 5: the operator
//  typed /compact behind a turn that had stood an hour, and it waited in
//  silence).
//
//  THE RULED SHAPE, from the estate's own laws: the delivery law stands (a
//  sent message delivers whatever the turn is doing — no queued/steered
//  fork, no refusal door), so the honest immediate answer is QUEUE WITH
//  WORDS — a session-side command submitted while the focused turn is in
//  flight speaks at once: it queues behind the turn, it runs when the turn
//  ends, and esc is the way past a wedged one. Plain words stay quiet (the
//  ordinary mid-turn steer must not nag). The adjacent stall honesty: the
//  long-turn tip now names esc — the only interactive brake — beside its
//  fresh-conversation advice.
//
//  These are screen-wiring laws; the pins are structural (the sentence, its
//  gate, and the delivery law's survival), with the driven journey named to
//  the operator drills. Cheap, and they red the moment the wiring drifts.
//
//  Run:  ~/.bun/bin/bun run scripts/compact/prove-compact-vs-running-turn.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const root = join(import.meta.dir, '..', '..')
const repl = readFileSync(join(root, 'src/screens/REPL.tsx'), 'utf8')
const spinner = readFileSync(join(root, 'src/components/Spinner.tsx'), 'utf8')

console.log('compact vs the running turn — the honest immediate answer')

console.log('\nV1 the queued sentence exists and speaks at submit')
check(
  'the session-seat branch speaks the queued sentence',
  repl.includes('queued — runs when the current turn ends (esc interrupts the turn)'),
)
check(
  'the sentence is gated on a session-side COMMAND while the turn is in flight',
  /seatCommand !== undefined && isLoadingRef\.current/.test(repl),
)
check(
  'plain words stay quiet (the gate requires a command, never bare words)',
  !/isLoadingRef\.current\s*&&\s*seatCommand === undefined[\s\S]{0,200}session-command-queued/.test(repl),
)

console.log('\nV2 the delivery law survives — the words still deliver, no refusal fork')
{
  const branch = repl.slice(repl.indexOf("if (seat === 'session')"), repl.indexOf("const spaceAt = text.indexOf(' ')"))
  check('the branch was found', branch.length > 200)
  check('sendWords is still called unconditionally after the note', branch.includes('.sendWords(text'))
  check(
    'no busy-refusal return precedes the delivery',
    !/isLoadingRef\.current[\s\S]{0,400}return;[\s\S]{0,200}\.sendWords/.test(branch),
  )
}

console.log('\nV3 the stall belt names the interactive brake')
check(
  'the long-turn tip names esc beside the fresh-conversation advice',
  spinner.includes('esc interrupts it; a fresh conversation keeps context sharp'),
)

console.log(failures === 0 ? '\n ✅ COMPACT VS RUNNING TURN GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
