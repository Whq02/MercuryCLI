#!/usr/bin/env bun
// ============================================================================
//  prove-no-runner-line — the resume's no-live-runner notification.
//
//  The incident this closes: a durable session painted from its transcript
//  while the daemon admission failed behind the paint, and the one line
//  conflated every case into an error the operator was told to fix by hand
//  (run the daemon themselves). The ratified wording leads with what is
//  true and what happens next, gives the reason in plain words per case,
//  and closes with the one action — the daemon heals on the next message.
//
//  POISON: the conflated copy ("painted from its transcript, but the daemon
//  did not admit it … retries") and the by-hand imperative are pinned
//  ABSENT — a registry that speaks either fails here.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-no-runner-line.ts
// ============================================================================
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { composeNoRunnerLine } = await import('../../src/services/switchboard/hopIntoSession.ts')

console.log('============================================================')
console.log(' no-runner line — the ratified lead, the reason, the action')
console.log('============================================================')

const LEAD = 'the session has no live runner — a replay revives it and delivers into the same chat'
const ACTION = '↵ revives it'
// The retired spellings, composed at runtime (never quoted as live copy).
const RETIRED_IMPERATIVE = ['run `mercury', ' daemon`'].join('')
const RETIRED_CONFLATION = ['painted from its transcript, but the daemon did not', ' admit it'].join('')

{
  const line = composeNoRunnerLine('auth-fix', 'the daemon did not start')
  check('the line leads with the ratified sentence (title named)', line.startsWith(`auth-fix: ${LEAD}`), line)
  check('…the did-not-start reason follows in plain words', line.includes('the daemon did not start'), line)
  check('…and the action closes it', line.endsWith(ACTION), line)
}
{
  const line = composeNoRunnerLine('auth-fix', 'daemon roster not ready')
  check('a not-ready admission reads as the daemon STARTING', line.includes('the daemon is starting'), line)
  check('…with the wire spelling folded away', !line.includes('roster not ready'), line)
}
{
  const refusal = 'model refused (no-credential:openai) — the openai family holds no credential on this account (got "gpt-5.6-sol") · ask the operator to run /logins'
  const line = composeNoRunnerLine('auth-fix', refusal)
  check('a refused-model resume carries the daemon’s own sentence NAMING the model', line.includes('gpt-5.6-sol'), line)
  check('…behind the same ratified lead', line.startsWith(`auth-fix: ${LEAD}`), line)
}
{
  const everyCase = [
    composeNoRunnerLine('t', 'the daemon did not start'),
    composeNoRunnerLine('t', 'daemon roster not ready'),
    composeNoRunnerLine('t', 'model refused (no-credential:openrouter) · ask the operator to run /logins'),
  ]
  check('no case orders the operator to run the daemon by hand', everyCase.every(l => !l.includes(RETIRED_IMPERATIVE)), everyCase.join(' | '))
  check('no case speaks the conflated copy', everyCase.every(l => !l.includes(RETIRED_CONFLATION)))
  check('every case closes with the one action', everyCase.every(l => l.endsWith(ACTION)))
}

{
  // THE ACTION LEADS in the admission refusal (the
  // 100-column drive): the face paints the refusal on ONE truncate-end row,
  // and with the action trailing the "(got …)" tail the operator read
  // "…on this account (got…" and no way out. The composer's order is
  // reason · action · detail · (got …) — pinned as source structure
  // (poison = the action appended after the (got …) close). The verdict is
  // spelled `admission` since f273075.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const sup = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'concourseSupervisor.ts'), 'utf8')
  const tpl = sup.slice(sup.indexOf('error: `model refused ('), sup.indexOf('error: `model refused (') + 500)
  const actionAt = tpl.indexOf('admission.action')
  const detailAt = tpl.indexOf('admission.detail')
  const gotAt = tpl.indexOf('(got ${')
  check('the refusal composer orders reason · action · detail · (got …)', actionAt > 0 && detailAt > 0 && gotAt > 0 && actionAt < detailAt && detailAt < gotAt, `action@${actionAt} detail@${detailAt} got@${gotAt}`)
  check('POISON: no action segment after the (got …) close', tpl.indexOf('admission.action', gotAt) === -1)
}

console.log(failures === 0 ? '\n✅ prove-no-runner-line — all checks pass' : '\n❌ prove-no-runner-line — check(s) failed')
process.exit(failures)
