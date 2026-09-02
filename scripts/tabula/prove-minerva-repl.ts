#!/usr/bin/env bun
// ============================================================================
//  scripts/tabula/prove-minerva-repl.ts
//  PROOF: the TABULA card's MINERVA ask line store (the cockpit mini-REPL).
//
//  Locks (the prove-console-store pattern — usage honesty is the invariant):
//  gate rides MERCURY_TABULA · compose lifecycle + focus-leave suspension ·
//  edit ops (insert/backspace/cursor/kill-line, one-line paste discipline,
//  buffer cap) · the runner fires EXACTLY once per explicit ↵ and NEVER
//  otherwise (idle/composing costs zero) · one exchange in flight · abort
//  rewinds the buffer + aborts the controller (the stream stops billing) ·
//  settle lands reply/counts vs honest error · stale settles ignored ·
//  session-digest builder (tail, caps, meta rows skipped, data-only).
//
//  Run: ~/.bun/bin/bun run scripts/tabula/prove-minerva-repl.ts
// ============================================================================

;(globalThis as any).MACRO = { VERSION: '1.0.0' }

const repl = await import('../../src/utils/cockpit/minervaRepl.ts')
const focus = await import('../../src/utils/cockpit/helmFocus.ts')
const minerva = await import('../../src/utils/tabula/minerva.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' MINERVA ask line — store honesty (API-free)')
console.log('============================================================')

const prevTabula = process.env.MERCURY_TABULA
delete process.env.MERCURY_TABULA

try {
  // ── (1) gate ─────────────────────────────────────────────────────────────
  section('(1) gate rides MERCURY_TABULA')
  check('enabled by default', repl.minervaReplEnabled() === true)
  process.env.MERCURY_TABULA = '0'
  check('=0 kills the ask line', repl.minervaReplEnabled() === false)
  delete process.env.MERCURY_TABULA

  // ── (2) compose + edit ops ───────────────────────────────────────────────
  section('(2) compose lifecycle + edit ops')
  repl.resetMinervaReplForTest()
  check('starts idle', !repl.isMinervaComposing())
  repl.beginMinervaCompose()
  check('compose begins', repl.isMinervaComposing())
  repl.minervaInsert('close the relay note')
  check('insert lands', repl.getMinervaBuffer() === 'close the relay note')
  repl.minervaBackspace()
  check('backspace', repl.getMinervaBuffer() === 'close the relay not')
  repl.minervaCursorHome()
  repl.minervaDeleteForward()
  check('home + del-forward', repl.getMinervaBuffer() === 'lose the relay not')
  repl.minervaCursorEnd()
  check('cursor end', repl.getMinervaCursor() === repl.getMinervaBuffer().length)
  repl.minervaMoveCursor(-4)
  repl.minervaInsert('X')
  check('mid-line insert at cursor', repl.getMinervaBuffer() === 'lose the relayX not')
  repl.minervaKillLine()
  check('ctrl+u starts over', repl.getMinervaBuffer() === '')
  repl.minervaInsert('line one\nline\ttwo')
  check('paste discipline: newlines/tabs → spaces, controls dropped', repl.getMinervaBuffer() === 'line one line two')
  repl.exitMinervaCompose()
  check('exit compose', !repl.isMinervaComposing())
  repl.minervaInsert('never lands')
  check('edits outside compose are no-ops', repl.getMinervaBuffer() === 'line one line two')

  // ── (3) usage honesty — the runner fires ONLY on ↵ ──────────────────────
  section('(3) runner counting (the invariant)')
  repl.resetMinervaReplForTest()
  let runnerCalls = 0
  let lastMsg = ''
  let resolveRun: ((r: unknown) => void) | null = null
  const runner = (m: string, _c: AbortController) => {
    runnerCalls++
    lastMsg = m
    return new Promise<any>(res => {
      resolveRun = res
    })
  }
  repl.beginMinervaCompose()
  repl.minervaInsert('add a benchmark note')
  check('composing costs zero runner calls', runnerCalls === 0)
  check('empty-buffer submit refuses', (repl.minervaKillLine(), repl.minervaSubmitBuffer(runner as never)) === false && runnerCalls === 0)
  repl.minervaInsert('add a benchmark note')
  check('↵ fires the runner exactly once', repl.minervaSubmitBuffer(runner as never) === true && runnerCalls === 1)
  check('message passed verbatim', lastMsg === 'add a benchmark note')
  check('buffer cleared + pending visible', repl.getMinervaBuffer() === '' && repl.getMinervaPending()?.message === 'add a benchmark note')
  check('second submit while in flight refuses', repl.minervaSubmitBuffer(runner as never) === false && runnerCalls === 1)
  resolveRun!({ ran: true, ok: true, reply: 'added 1', added: 1, closed: 0, refined: 0, repri: 0 })
  await new Promise(r => setTimeout(r, 10))
  check('settle lands the reply + counts', repl.getMinervaPending() === null && repl.getMinervaLastExchange()?.reply === 'added 1' && repl.getMinervaLastExchange()?.counts?.added === 1)
  check('ask count honest', repl.getMinervaAskCount() === 1)

  // ── (4) abort semantics ──────────────────────────────────────────────────
  section('(4) esc abort — stream stops billing, message returns')
  repl.resetMinervaReplForTest()
  let aborted = false
  const hangingRunner = (_m: string, c: AbortController) => {
    c.signal.addEventListener('abort', () => {
      aborted = true
    })
    return new Promise<any>(() => {})
  }
  repl.beginMinervaCompose()
  repl.minervaInsert('slow ask')
  repl.minervaSubmitBuffer(hangingRunner as never)
  check('in flight', repl.getMinervaPending() !== null)
  check('abort returns true', repl.minervaAbortAsk() === true)
  check('controller aborted (billing stops)', aborted === true)
  check('message handed back to the buffer', repl.getMinervaBuffer() === 'slow ask' && repl.isMinervaComposing())
  check('no exchange recorded for an abort', repl.getMinervaLastExchange() === null)

  // ── (5) error + refusal settles ──────────────────────────────────────────
  section('(5) honest error settles')
  repl.resetMinervaReplForTest()
  repl.beginMinervaCompose()
  repl.minervaInsert('bad ask')
  repl.minervaSubmitBuffer(((/* m */) => Promise.resolve({ ran: true, ok: false, reason: 'plan refused' })) as never)
  await new Promise(r => setTimeout(r, 10))
  check('refusal reason lands as the error', repl.getMinervaLastExchange()?.error === 'plan refused')
  repl.beginMinervaCompose()
  repl.minervaInsert('throwing ask')
  repl.minervaSubmitBuffer((() => Promise.reject(new Error('network down'))) as never)
  await new Promise(r => setTimeout(r, 10))
  check('a thrown runner lands as the error', repl.getMinervaLastExchange()?.error?.includes('network down') === true)

  // ── (6) focus-leave suspension ───────────────────────────────────────────
  section('(6) focus suspension (the console contract)')
  repl.resetMinervaReplForTest()
  focus.setHelmFocus('lanes')
  repl.beginMinervaCompose()
  repl.minervaInsert('draft survives')
  focus.setHelmFocus('prompt')
  check('leaving the lanes pane suspends compose', !repl.isMinervaComposing())
  check('the draft survives suspension', repl.getMinervaBuffer() === 'draft survives')
  focus.setHelmFocus('prompt')

  // ── (7) session digest builder ───────────────────────────────────────────
  section('(7) read-only session digest')
  const digest = minerva.buildMinervaSessionDigest([
    { type: 'user', message: { content: 'fix the flaky ui gate' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Investigating the contention now.' }] } },
    { type: 'user', message: { content: '<system-reminder>meta row</system-reminder>' } },
    { type: 'progress' as never, message: { content: 'not a turn' } },
    { type: 'user', message: { content: 'x'.repeat(500) } },
  ] as never)
  check('turns land oldest-first with role tags', digest.startsWith('operator: fix the flaky ui gate') && digest.includes('mercury: Investigating'))
  check('meta/system rows skipped', !digest.includes('meta row'))
  check('non-turn rows skipped', !digest.includes('not a turn'))
  check('per-turn cap truncates with an ellipsis', digest.includes('…'))
  const big = minerva.buildMinervaSessionDigest(
    Array.from({ length: 300 }, (_, i) => ({ type: 'user', message: { content: `turn ${i} ${'y'.repeat(200)}` } })) as never,
  )
  check('total cap holds (tail wins)', big.length <= 7000 && big.includes('turn 299'))
  check('oldest turns fall off the front under the cap', !big.includes('turn 0 '))

  // ── (8) relief verbs (chat-relief) ───────────────────────────────────────
  section('(8) /clear and /compact settle locally — zero runner invocations')
  repl.resetMinervaReplForTest()
  focus.setHelmFocus('lanes')
  let reliefRuns = 0
  const reliefRunner = async () => {
    reliefRuns++
    return { ran: true, ok: true, reply: 'never' }
  }
  repl.beginMinervaCompose()
  repl.minervaInsert('/compact')
  check('/compact is consumed by the store', repl.minervaSubmitBuffer(reliefRunner) === true)
  check(
    '…answering the one-shot truth (nothing accumulates; the notepad is operator territory)',
    repl.getMinervaLastExchange()?.reply === repl.MINERVA_COMPACT_TRUTH,
    JSON.stringify(repl.getMinervaLastExchange()),
  )
  check('…with zero runner invocations and zero billed asks', reliefRuns === 0 && repl.getMinervaAskCount() === 0)
  repl.minervaInsert('/clear')
  check('/clear is consumed too', repl.minervaSubmitBuffer(reliefRunner) === true)
  check('…and resets the line to its fresh birth', repl.getMinervaLastExchange() === null && repl.getMinervaBuffer() === '')
  check('…still zero runner invocations', reliefRuns === 0)
  focus.setHelmFocus('prompt')
} finally {
  if (prevTabula === undefined) delete process.env.MERCURY_TABULA
  else process.env.MERCURY_TABULA = prevTabula
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ MINERVA ASK LINE PASS' : ` ❌ MINERVA ASK LINE — ${failures} failure(s)`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
