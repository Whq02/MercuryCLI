#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
{
  const { setIsInteractive } = await import('../../src/bootstrap/state.js')
  setIsInteractive(true)
}

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const HOME = mkdtempSync(join(tmpdir(), 'vigil-pause-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { parseOperatorPauseDirective } = await import('../../src/services/run/operatorPause.js')

console.log('\n=== A. directive grammar (precision over recall) ===')
const PAUSE: string[] = [
  'stop the workflow rq lets pause here',
  'pause',
  'stop',
  'lets pause here',
  "let's pause for now",
  'stop for now',
  'hold off',
  'hold on a sec',
  'ok stop',
  'please pause the run',
  'stop everything',
  'stop it',
  'I want you to stop',
  'pause the agents please',
]
const NONE: string[] = [
  "don't stop now, keep going",
  'do not stop',
  'never stop improving',
  'stop worrying about lint',
  'stop the leak in parser.ts',
  'we can stop polling the api',
  'implement the pause menu',
  'add a pause button to the game',
  'the workflow should stop retrying failed agents',
  'make the game support pause and resume',
  'fix the stop button styling',
  'after you finish the region generator, add a pause capability to the batch runner so long runs can be suspended and resumed from the manifest without losing agent state',
  '',
]
for (const t of PAUSE) {
  const v = parseOperatorPauseDirective(t)
  check(`PAUSE: ${JSON.stringify(t)}`, v.kind === 'pause', v.kind)
}
for (const t of NONE) {
  const v = parseOperatorPauseDirective(t)
  check(`none : ${JSON.stringify(t)}`, v.kind === 'none', v.kind)
}

console.log('\n=== B. the pause settles BEFORE completion evaluation ===')
{
  const ok = await import('../../src/services/run/ownerKey.js')
  const coord = await import('../../src/services/run/runCoordinator.js')
  const { evaluateStopAttempt } = await import('../../src/utils/hooks/runStopAdapter.js')
  type Message = import('../../src/types/message.js').Message

  const owner = ok.makeOwnerKey({ workspace: '/tmp/vigil-pause', sessionId: 'vp1', lane: 'main' })
  const at = Date.now()
  await import('../../src/tasks.js')
  const tasksStore = await import('../../src/utils/tasks.js')
  const t1 = await tasksStore.createTask('vigil-pause-proof', {
    subject: 'Author the three large remaining regions (63 villages)',
    description: 'pause-prover fixture deliverable',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  } as never)
  coord.acceptUserRequest(owner, { objective: 'author regions', rootMessageId: 'u1' })
  coord.noteRunEvent(owner, { type: 'substantive', at: at + 1, reason: 'created tasks' })
  coord.noteRunEvent(owner, {
    type: 'task-transition',
    at: at + 2,
    taskId: String(t1),
    title: 'Author the three large remaining regions (63 villages)',
    state: 'open',
  })

  const mkUser = (text: string): Message =>
    ({ type: 'user', message: { role: 'user', content: text } }) as unknown as Message
  const mkAssistant = (text: string): Message =>
    ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) as unknown as Message

  const messages: readonly Message[] = [
    mkUser('stop the workflow rq lets pause here'),
    mkAssistant('Stopped the workflow run. Standing by.'),
  ]
  const verdict = await evaluateStopAttempt(messages, {
    maxBlocks: 3,
    wordingUnfinished: false,
    owner,
  })
  check('decision is PAUSE (not the open-deliverable continue)', verdict.decision.kind === 'pause', verdict.decision.kind)
  check('the stop is allowed (no re-prompt against the operator)', verdict.allowStop === true)
  check('the run lifecycle settled to paused', coord.getRunSnapshot(owner)?.lifecycle === 'paused')
  check(
    'the pause reason quotes the operator directive',
    (coord.getRunSnapshot(owner)?.phaseReason ?? '').includes('stop the workflow rq'),
  )

  const again = await evaluateStopAttempt(messages, { maxBlocks: 3, wordingUnfinished: false, owner })
  check('a later evaluation stays paused (no auto-resume, no re-arm)', again.decision.kind === 'pause' && again.allowStop === true)
  check('lifecycle still paused', coord.getRunSnapshot(owner)?.lifecycle === 'paused')

  coord.noteRunEvent(owner, { type: 'request-accepted', at: at + 10, objective: 'resume authoring', rootMessageId: 'u2' })
  check('a NEW operator request reactivates (kernel law intact)', coord.getRunSnapshot(owner)?.lifecycle === 'active')

  const unrelated: readonly Message[] = [
    mkUser('add a pause button to the game'),
    mkAssistant('Added the button. All done.'),
  ]
  const live = await evaluateStopAttempt(unrelated, { maxBlocks: 3, wordingUnfinished: false, owner })
  check('unrelated wording never pauses (deliverable pressure intact)', live.decision.kind === 'continue', live.decision.kind)
  check('lifecycle stayed active', coord.getRunSnapshot(owner)?.lifecycle === 'active')
}

console.log(`\n${failures === 0 ? '✅ ALL PASS — operator pause settles honestly' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
