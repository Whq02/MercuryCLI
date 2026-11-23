#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'typing-rekey-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

let failures = 0
const P = 'src/screen/composer/input-core/pending-input.ts'
const Q = 'src/screen/composer/input-core/command-queue.ts'
const U = 'src/screen/chat/useChatSession.ts'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}

const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
const queue = await import('../../src/screen/composer/input-core/command-queue.ts')

console.log('§1 the draft: typing during a re-key wins; a quiet hop restores the page')
{
  pending.resetPendingInputForTests()
  pending.initSession('session-a', '')
  pending.edit('words for a')
  await pending.flushDrafts()
  check('the first session holds its words', pending.text() === 'words for a', `edit() or flushDrafts() in ${P} did not keep the session's draft`)

  await pending.rekeyToSession('session-b')
  check('a quiet hop to a page-less session seeds an empty composer', pending.text() === '', `rekeyToSession in ${P} must seed an empty draft when the target session has none; got ${JSON.stringify(pending.text())}`)

  await pending.rekeyToSession('session-a')
  check("a hop back restores the session's own page", pending.text() === 'words for a', `rekeyToSession in ${P} must reload the saved draft of the session it returns to; got ${JSON.stringify(pending.text())}`)

  const inflight = pending.rekeyToSession('session-b')
  pending.edit('typed into the new view')
  await inflight
  check('typing during the re-key beats the target page (the edit fence)', pending.text() === 'typed into the new view', `${pending.text()} — rekeyToSession in ${P} must drop its page load when edit() ran during the re-key (the editSeq fence)`)
  await pending.flushDrafts()
}

console.log('§2 the command queue: a hop parks and restores; a landing keeps what was queued')
{
  queue.resetCommandQueue()
  queue.rekeyCommandQueueToSession('session-a')
  queue.enqueue({ value: 'queued for a', mode: 'prompt' })
  queue.rekeyCommandQueueToSession('session-b')
  check("a hop parks the outgoing session's entries (the live queue empties)", queue.getCommandQueueSnapshot().length === 0, `rekeyCommandQueueToSession in ${Q} must park the outgoing session's entries; live queue holds ${queue.getCommandQueueSnapshot().length}`)
  queue.enqueue({ value: 'queued for b', mode: 'prompt' })
  queue.rekeyCommandQueueToSession('session-a')
  const backOnA = queue.getCommandQueueSnapshot().map(c => c.value)
  check("a hop back restores the session's own entries, identities intact", JSON.stringify(backOnA) === JSON.stringify(['queued for a']), `${JSON.stringify(backOnA)} — rekeyCommandQueueToSession in ${Q} must restore the parked entries of the session it returns to`)

  queue.resetCommandQueue()
  queue.rekeyCommandQueueToSession(null)
  queue.enqueue({ value: 'sent while landing', mode: 'prompt' })
  queue.rekeyCommandQueueToSession('session-born', { landing: true })
  const landed = queue.getCommandQueueSnapshot().map(c => c.value)
  check('a landing keeps the entries queued while it landed', JSON.stringify(landed) === JSON.stringify(['sent while landing']), `${JSON.stringify(landed)} — rekeyCommandQueueToSession in ${Q} must keep the live entries when opts.landing is true`)

  queue.resetCommandQueue()
  queue.rekeyCommandQueueToSession(null)
  queue.enqueue({ value: 'sent while landing (control)', mode: 'prompt' })
  queue.rekeyCommandQueueToSession('session-born-2')
  check('control: the same re-point without the landing word parks them away', queue.getCommandQueueSnapshot().length === 0, `rekeyCommandQueueToSession in ${Q} must park the live entries when opts.landing is not set; live queue holds ${queue.getCommandQueueSnapshot().length}`)
}

console.log('§3 the Chat names the landing to both owners')
{
  const { sessionRekeys } = await import('../ui/chatScenarios.ts')
  const rekeys = await sessionRekeys('typing-rekey-session')
  check('the draft store hears the landing word', rekeys.landing.split(' · ')[0] === 'draft typing-rekey-session-c landing=true', `${rekeys.landing} — the rekey effect in ${U} must pass { landing } to pendingInput.rekeyToSession`)
  check('the command queue hears the same landing word', rekeys.landing.split(' · ')[1] === 'queue typing-rekey-session-c landing=true', `${rekeys.landing} — the rekey effect in ${U} must pass { landing } to rekeyCommandQueueToSession`)
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n ❌ typing-survives-rekey — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ typing-survives-rekey — the draft fence and the queue landing keep what the operator typed while the screen was wiring')
